/**
 * Upload validation - the highest-risk surface in the system.
 *
 * `ai/context/security-guidelines.md` sets five requirements for employee-document upload, and
 * this module implements the four that are pure functions of the bytes. The fifth (re-encoding
 * images through `sharp` to strip EXIF and destroy polyglot payloads) needs a native dependency
 * and is recorded as outstanding rather than pretended away.
 *
 * WHY THIS LIVES IN `packages/authz` RATHER THAN IN THE API
 *
 * Because it is a security control with no framework dependency, and because putting it here
 * makes it testable without booting NestJS or touching MinIO. It is imported by the upload
 * handler; it never imports one.
 *
 * THE CENTRAL RULE, restated because it is the one people implement halfway:
 *
 *   The MAGIC BYTES must agree with the DECLARED content type **and** with the EXTENSION.
 *   A mismatch is rejected AND ALERTED - a polyglot attempt is an attack signal, not a user
 *   error, and treating it as a validation message loses the detection.
 *
 * Checking only the declared type trusts the client. Checking only the extension trusts the
 * filename. Checking only magic bytes misses the case where a genuine PNG is uploaded as
 * `.docx` to smuggle it past a downstream consumer that dispatches on extension.
 */

/** The allowlist. Mirrors ck_dv_content_type in migration 0018 - both must agree. */
export const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/** 25 MiB, matching ck_dv_size. Enforced BEFORE the stream is consumed. */
export const MAX_UPLOAD_BYTES = 26_214_400;

/**
 * A DOCX/XLSX is a ZIP. A 25 MiB archive that expands to gigabytes is a decompression bomb, so
 * the declared uncompressed size is capped as a RATIO of the compressed size as well as
 * absolutely. 200:1 is generous for real Office documents (text compresses well) and far below
 * what a bomb needs.
 */
export const MAX_DECOMPRESSION_RATIO = 200;
export const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

export const EXTENSION_FOR: Record<AllowedContentType, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
};

export type SniffedType =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'application/zip'      // DOCX and XLSX are both ZIP containers at the byte level
  | 'image/svg+xml'        // sniffed only so it can be refused by name
  | 'text/html'
  | 'application/x-msdownload'
  | 'application/x-elf'
  | 'unknown';

const startsWith = (buf: Uint8Array, sig: readonly number[], offset = 0): boolean => {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[offset + i] !== sig[i]) return false;
  return true;
};

/**
 * Identify a file from its leading bytes. Never trusts the caller's declaration.
 *
 * Note that several dangerous formats are recognised on purpose. Returning 'unknown' for an ELF
 * binary would be a worse outcome than naming it: an alert that says "an ELF executable was
 * uploaded as a PDF" is actionable, and "unrecognised content" is not.
 */
export function sniffContentType(buf: Uint8Array): SniffedType {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';          // %PDF
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWith(buf, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWith(buf, [0x50, 0x4b, 0x07, 0x08])) return 'application/zip';
  if (startsWith(buf, [0x4d, 0x5a])) return 'application/x-msdownload';             // MZ
  if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return 'application/x-elf';        // .ELF

  // Text formats need a windowed look rather than a fixed offset, because whitespace, a BOM or
  // an XML prolog can precede the marker.
  const head = Buffer.from(buf.subarray(0, Math.min(buf.length, 1024)))
    .toString('latin1').replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || /<\?xml[^>]*\?>\s*(<!--.*?-->\s*)*<svg/s.test(head)) {
    return 'image/svg+xml';
  }
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'text/html';

  return 'unknown';
}

export interface UploadCandidate {
  readonly filename: string;
  readonly declaredContentType: string;
  readonly sizeBytes: number;
  /** The first few KiB is enough; the whole buffer is accepted too. */
  readonly head: Uint8Array;
  /** For DOCX/XLSX, the declared uncompressed size if the caller could determine it. */
  readonly uncompressedBytes?: number | undefined;
}

export interface UploadRejection {
  readonly code:
    | 'empty'
    | 'too_large'
    | 'type_not_allowed'
    | 'extension_missing'
    | 'extension_mismatch'
    | 'magic_byte_mismatch'
    | 'decompression_ratio';
  /** Safe to show a user. Never echoes the filename - that is attacker-controlled text. */
  readonly message: string;
  /**
   * True when this rejection is an ATTACK SIGNAL rather than a mistake, and must be alerted on
   * rather than merely counted. security-guidelines: "a polyglot attempt is an attack signal,
   * not a user error".
   */
  readonly alert: boolean;
  /** For the audit row. Contains no content and no filename. */
  readonly detail: string;
}

export type UploadVerdict =
  | { readonly ok: true; readonly contentType: AllowedContentType; readonly extension: string }
  | { readonly ok: false; readonly rejection: UploadRejection };

const extensionOf = (filename: string): string | null => {
  // Take the LAST dot segment. `payload.pdf.exe` therefore reads as `exe`, which is the whole
  // point - a double extension must not be resolved in the uploader's favour.
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(filename.trim());
  return m ? m[1]!.toLowerCase() : null;
};

/**
 * Validate an upload. Order matters: cheap structural checks first, so a 25 MiB bomb is refused
 * on its declared size before anything reads it.
 */
export function validateUpload(c: UploadCandidate): UploadVerdict {
  if (c.sizeBytes <= 0) {
    return {
      ok: false,
      rejection: { code: 'empty', message: 'That file is empty.', alert: false, detail: 'size=0' },
    };
  }

  if (c.sizeBytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      rejection: {
        code: 'too_large',
        message: `That file is larger than the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`,
        alert: false,
        detail: `size=${c.sizeBytes} limit=${MAX_UPLOAD_BYTES}`,
      },
    };
  }

  const declared = c.declaredContentType.split(';')[0]!.trim().toLowerCase();
  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(declared)) {
    return {
      ok: false,
      rejection: {
        code: 'type_not_allowed',
        message: 'Only PDF, JPEG, PNG, DOCX and XLSX files can be uploaded.',
        // An SVG upload is not an innocent mistake - it has no HR use case and is an
        // HTML-equivalent stored-XSS vector. Worth alerting on by itself.
        alert: declared === 'image/svg+xml',
        detail: `declared=${declared}`,
      },
    };
  }
  const contentType = declared as AllowedContentType;

  const ext = extensionOf(c.filename);
  if (!ext) {
    return {
      ok: false,
      rejection: {
        code: 'extension_missing',
        message: 'That file has no extension, so its type cannot be confirmed.',
        alert: false,
        detail: 'no extension',
      },
    };
  }

  if (!EXTENSION_FOR[contentType].includes(ext)) {
    return {
      ok: false,
      rejection: {
        code: 'extension_mismatch',
        message: 'The file extension does not match the file type.',
        // Declared type and extension disagreeing is a deliberate act far more often than a slip.
        alert: true,
        detail: `declared=${contentType} ext=${ext}`,
      },
    };
  }

  // THE MAGIC BYTES. Everything above trusted the client; this does not.
  const sniffed = sniffContentType(c.head);
  const expectedSniff: SniffedType =
    contentType === 'application/pdf' ? 'application/pdf'
      : contentType === 'image/jpeg' ? 'image/jpeg'
        : contentType === 'image/png' ? 'image/png'
          : 'application/zip';

  if (sniffed !== expectedSniff) {
    return {
      ok: false,
      rejection: {
        code: 'magic_byte_mismatch',
        message: 'That file is not the type it claims to be.',
        alert: true,
        detail: `declared=${contentType} sniffed=${sniffed} ext=${ext}`,
      },
    };
  }

  // Decompression-ratio cap for the ZIP-backed formats.
  if (expectedSniff === 'application/zip' && c.uncompressedBytes !== undefined) {
    const ratio = c.uncompressedBytes / c.sizeBytes;
    if (c.uncompressedBytes > MAX_UNCOMPRESSED_BYTES || ratio > MAX_DECOMPRESSION_RATIO) {
      return {
        ok: false,
        rejection: {
          code: 'decompression_ratio',
          message: 'That document expands to an unreasonable size and was refused.',
          alert: true,
          detail: `compressed=${c.sizeBytes} uncompressed=${c.uncompressedBytes} ratio=${ratio.toFixed(1)}`,
        },
      };
    }
  }

  return { ok: true, contentType, extension: ext };
}

/**
 * The object key for a document version. TWO UUIDs AND NOTHING ELSE.
 *
 * No employee name, number or id, and no original filename. Object storage backups, bucket
 * listings and access logs all travel differently from the database, so a key is a disclosure
 * channel in its own right. The original filename is kept in the database column
 * `original_name`, where the field registry governs it.
 */
export function objectKeyFor(documentId: string, versionId: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(documentId) || !uuid.test(versionId)) {
    throw new Error('objectKeyFor requires two UUIDs - a key must carry no personal data');
  }
  return `${documentId}/${versionId}`;
}
