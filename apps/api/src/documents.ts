import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query,
  Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  AuthzDeniedError, objectKeyFor, validateUpload, type DataClass,
} from '@panasa/authz';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Authenticated, currentActor } from './auth';
import { Authz, authContext } from './authz';
import { Db } from './db';
import { DOCUMENT_BUCKET, DocumentStorage, StorageModule } from './storage';

/**
 * Employee documents.
 *
 * THIS IS THE FIRST MODULE THAT ACTUALLY ENFORCES `packages/authz`.
 *
 * Every other controller still carries `@Authenticated('manager','hr_admin')` and a role
 * comparison in the guard (OR-19). Here the decision goes through `AuthorizationService`:
 * `assertCan` for the act, `scope()` composed into the list query, and the document type's data
 * class travelling on the ref because a field mask cannot reach inside a PDF.
 *
 * `@Authenticated()` is still present with NO roles - it is what establishes the session and
 * populates the actor. It grants nothing on its own.
 */

/** Minimal shape of a multer file. `@types/multer` is absent and not worth adding for this. */
interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const MAX_MULTIPART_BYTES = 26 * 1024 * 1024;   // a shade over the 25 MiB document cap

const clientIp = (req: Request): string | null => {
  const raw = (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  return raw && raw !== '::1' ? raw : null;
};

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly db: Db,
    private readonly authz: Authz,
    private readonly storage: DocumentStorage,
  ) {}

  /** Translate an authz denial into the status rbac-rules.md requires (404, usually). */
  private static rethrow(e: unknown): never {
    if (e instanceof AuthzDeniedError) {
      throw e.httpStatus === 404
        ? new NotFoundException('Not found')
        : new BadRequestException(e.message);
    }
    throw e;
  }

  private async audit(
    eventType: string, documentId: string, req: Request,
    opts: { reason?: string | null; versionId?: string | null } = {},
  ): Promise<void> {
    const me = currentActor(req);
    try {
      await this.db.rows(
        `SELECT fn_audit_document($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9)`,
        [eventType, documentId, me.userId, me.employeeId, me.sessionId,
          clientIp(req), opts.reason ?? null, me.roles, opts.versionId ?? null]);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('DOCUMENT AUDIT WRITE FAILED', eventType, (e as Error).message);
    }
  }

  private async docTypeClass(code: string): Promise<{ dataClass: DataClass; selfUploadable: boolean } | null> {
    const r = await this.db.one(
      `SELECT data_class, self_uploadable FROM document_type
        WHERE code = $1 AND archived_at IS NULL`, [code]);
    return r ? { dataClass: r.data_class as DataClass, selfUploadable: r.self_uploadable } : null;
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------
  /**
   * `scope()` is composed INTO the query rather than filtering afterwards. `rbac-rules.md` is
   * explicit about why: a post-fetch filter still leaks through counts, pagination totals and
   * timing even though the rows are gone from the response.
   */
  @Get()
  @Authenticated()
  async list(@Req() req: Request, @Query('employeeId') employeeId?: string) {
    const ctx = authContext(req);
    const me = currentActor(req);
    const subject = employeeId ?? me.employeeId;

    try {
      await this.authz.assertCan(ctx, 'documents.document.list', {
        type: 'employee_document',
        subjectEmployeeId: subject,
        // The list spans types, so the narrowest class is asserted here and each ROW is then
        // filtered by its own class below. Asserting PERSONAL up front would let a caller with
        // no document access at all reach the query.
        dataClass: 'PERSONAL',
      });
    } catch (e) { DocumentsController.rethrow(e); }

    const predicate = this.authz.scope(ctx, 'documents.document.list', {
      type: 'employee_document', subjectEmployeeId: subject,
    });
    if (predicate.kind === 'none') return { documents: [] };
    const { sql: scopeSql, params } = predicate.render('d', 3);

    /*
     * TWO version joins, and the distinction is the whole correctness of this screen.
     *
     * The first draft joined only on `d.current_version_id`. But a document awaiting a scan has
     * NO current version - that is the quarantine gate doing its job - so every version column
     * came back NULL: no filename, no size, no scan status. The UI showed "no version", could
     * not offer a download (correct) and could not offer HR the CLEAR action either (a bug), so
     * a pending document was stuck permanently.
     *
     *   `cv` - the promoted version. Its presence IS availability.
     *   `lv` - the LATEST version, promoted or not. This is what the screen describes.
     *
     * They are genuinely different rows: v1 can be clean and current while v2 sits pending, in
     * which case the document IS available and ALSO has something awaiting a scan. One column
     * cannot express that, so the response carries both.
     */
    const rows = await this.db.rows(
      `SELECT d.id, d.employee_id, d.document_type_code, t.name AS document_type_name,
              t.data_class, d.title, d.issued_on, d.expires_on, d.issuing_authority,
              d.withdrawn_at, d.withdrawn_reason, d.created_at AS uploaded_at,
              u.full_name AS uploaded_by_name,

              (d.current_version_id IS NOT NULL) AS available,
              cv.version_no  AS current_version_no,
              lv.version_no  AS latest_version_no,
              lv.scan_status AS latest_scan_status,

              -- Describe the file the user is looking at: the served one if there is one,
              -- otherwise the one they just uploaded and are waiting on.
              COALESCE(cv.original_name, lv.original_name) AS original_name,
              COALESCE(cv.size_bytes,    lv.size_bytes)    AS size_bytes,
              COALESCE(cv.content_type,  lv.content_type)  AS content_type,

              (SELECT count(*) FROM employee_document_version vv WHERE vv.document_id = d.id)
                AS version_count
         FROM employee_document d
         JOIN document_type t ON t.code = d.document_type_code
         LEFT JOIN employee_document_version cv ON cv.id = d.current_version_id
         LEFT JOIN LATERAL (
              SELECT v.* FROM employee_document_version v
               WHERE v.document_id = d.id
               ORDER BY v.version_no DESC
               LIMIT 1
         ) lv ON true
         LEFT JOIN employee u ON u.id = d.uploaded_by
        WHERE ($1::uuid IS NULL OR d.employee_id = $1::uuid)
          AND ($2::boolean OR d.withdrawn_at IS NULL)
          AND ${scopeSql}
        ORDER BY t.display_order, d.created_at DESC`,
      [subject ?? null, false, ...params]);

    // RESTRICTED types drop out for anyone the policy does not admit to them. Done per row
    // because a list spans classes - the row filter cannot express "except the restricted ones".
    const visible = [];
    for (const row of rows) {
      const decision = await this.authz.can(ctx, 'documents.document.read', {
        type: 'employee_document',
        id: row.id,
        subjectEmployeeId: row.employee_id,
        dataClass: row.data_class as DataClass,
      });
      if (decision.allowed) {
        visible.push(this.authz.maskRow(ctx, 'employee_document', row, {
          isSubject: row.employee_id === me.employeeId,
          inList: true,
        }));
      }
    }

    return { documents: visible, types: await this.types() };
  }

  private async types() {
    return this.db.rows(
      `SELECT code, name, data_class, tracks_expiry, self_uploadable, description
         FROM document_type WHERE archived_at IS NULL ORDER BY display_order`);
  }

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------
  @Post()
  @Authenticated()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_MULTIPART_BYTES } }))
  async upload(
    @Req() req: Request,
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body() body: { employeeId?: string; documentTypeCode?: string; title?: string;
      issuedOn?: string; expiresOn?: string; issuingAuthority?: string; note?: string },
  ) {
    const ctx = authContext(req);
    const me = currentActor(req);

    if (!file) throw new BadRequestException('No file was uploaded');
    const typeCode = (body.documentTypeCode ?? '').trim();
    const subject = (body.employeeId ?? me.employeeId ?? '').trim();
    const title = (body.title ?? '').trim() || file.originalname;

    const dt = await this.docTypeClass(typeCode);
    if (!dt) throw new BadRequestException('Unknown document type');

    try {
      await this.authz.assertCan(ctx, 'documents.document.upload', {
        type: 'employee_document', subjectEmployeeId: subject, dataClass: dt.dataClass,
      });
    } catch (e) { DocumentsController.rethrow(e); }

    // A type HR reserves to itself cannot be self-uploaded even by somebody the policy admits.
    if (!dt.selfUploadable && subject === me.employeeId
        && !me.roles.some((r) => r === 'hr_admin' || r === 'hr_ops')) {
      throw new BadRequestException('That document type is uploaded by HR, not by you');
    }

    // VALIDATION BEFORE ANYTHING IS STORED. Magic bytes, extension, declared type, size.
    const verdict = validateUpload({
      filename: file.originalname,
      declaredContentType: file.mimetype,
      sizeBytes: file.size,
      head: file.buffer.subarray(0, 4096),
    });

    if (!verdict.ok) {
      // An attack signal is audited as one. A polyglot attempt is not a validation message.
      await this.db.rows(
        `SELECT fn_audit_security($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
        [verdict.rejection.alert
          ? 'documents.upload.rejected.alert'
          : 'documents.upload.rejected',
          me.userId, me.employeeId, subject || null, me.sessionId,
          clientIp(req), verdict.rejection.detail, me.roles]).catch(() => undefined);

      throw new BadRequestException(verdict.rejection.message);
    }

    if (!this.storage.isReady()) {
      try { await this.storage.ensureBucket(); }
      catch { throw new BadRequestException('Document storage is unavailable. Try again shortly.'); }
    }

    const documentId = randomUUID();
    const versionId = randomUUID();
    const key = objectKeyFor(documentId, versionId);
    const sha = DocumentStorage.sha256(file.buffer);

    // Object first, then the row. If the row fails the object is orphaned and removed; if the
    // object failed there would be a row pointing at nothing, which is worse - a download that
    // 500s on a document the UI says exists.
    await this.storage.put(key, file.buffer, verdict.contentType);

    try {
      await this.db.tx(async (q) => {
        await q(
          `INSERT INTO employee_document
             (id, employee_id, document_type_code, title, issued_on, expires_on,
              issuing_authority, note, uploaded_by)
           VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9)`,
          [documentId, subject, typeCode, title,
            body.issuedOn || null, body.expiresOn || null,
            body.issuingAuthority || null, body.note || null, me.employeeId]);

        await q(
          `INSERT INTO employee_document_version
             (id, document_id, bucket, object_key, content_type, size_bytes, sha256_hex,
              original_name, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [versionId, documentId, DOCUMENT_BUCKET, key, verdict.contentType,
            file.size, sha, file.originalname, me.employeeId]);
      });
    } catch (e) {
      await this.storage.removeOrphan(key);
      throw e;
    }

    await this.audit('documents.document.uploaded', documentId, req,
      { reason: `type=${typeCode}`, versionId });

    return {
      id: documentId,
      versionId,
      scanStatus: 'pending',
      // Said plainly, because the UI must not present a pending document as available.
      message: 'Uploaded and queued for scanning. It becomes available once it is cleared.',
    };
  }

  // -------------------------------------------------------------------------
  // Scan verdict
  // -------------------------------------------------------------------------
  /**
   * Advance the quarantine verdict and, when clean, promote the version.
   *
   * There is no virus scanner (OR-24). This is the administrative path that a scanner will drive,
   * and it is HR-only precisely so the uploader cannot certify their own upload.
   */
  @Post(':id/scan')
  @Authenticated()
  async scan(
    @Req() req: Request, @Param('id') id: string,
    @Body() body: { versionId?: string; verdict?: string; detail?: string },
  ) {
    const ctx = authContext(req);
    const doc = await this.db.one(
      `SELECT d.id, d.employee_id, t.data_class FROM employee_document d
         JOIN document_type t ON t.code = d.document_type_code WHERE d.id = $1`, [id]);
    if (!doc) throw new NotFoundException('No such document');

    try {
      await this.authz.assertCan(ctx, 'documents.document.scan', {
        type: 'employee_document', id, subjectEmployeeId: doc.employee_id,
        dataClass: doc.data_class as DataClass,
      });
    } catch (e) { DocumentsController.rethrow(e); }

    const verdict = body.verdict ?? '';
    if (!['clean', 'infected', 'failed'].includes(verdict)) {
      throw new BadRequestException('verdict must be clean, infected or failed');
    }

    const version = await this.db.one(
      `SELECT id FROM employee_document_version
        WHERE document_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)
        ORDER BY version_no DESC LIMIT 1`, [id, body.versionId || null]);
    if (!version) throw new NotFoundException('No such version');

    await this.db.tx(async (q) => {
      await q(
        `UPDATE employee_document_version
            SET scan_status = $2, scanned_at = now(), scan_detail = $3
          WHERE id = $1`,
        [version.id, verdict, body.detail ?? (verdict === 'clean' ? null : 'no detail given')]);

      // The promotion. The database refuses this if the version is not clean, so the check here
      // is an optimisation, not the control.
      if (verdict === 'clean') {
        await q(`UPDATE employee_document SET current_version_id = $2 WHERE id = $1`,
          [id, version.id]);
      }
    });

    await this.audit(`documents.document.scan.${verdict}`, id, req,
      { reason: body.detail ?? null, versionId: version.id });

    return { id, versionId: version.id, scanStatus: verdict };
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------
  /**
   * Streams the content through the API. Deliberately not a presigned URL - see storage.ts.
   * Audited on EVERY call, because for a document the read IS the disclosure.
   */
  @Get(':id/download')
  @Authenticated()
  async download(
    @Req() req: Request, @Param('id') id: string, @Res() res: Response,
    @Query('mode') mode?: string,
  ) {
    const ctx = authContext(req);
    const me = currentActor(req);

    const row = await this.db.one(
      `SELECT d.id, d.employee_id, d.withdrawn_at, t.data_class,
              v.id AS version_id, v.bucket, v.object_key, v.content_type, v.original_name,
              v.size_bytes, v.scan_status, v.sha256_hex
         FROM employee_document d
         JOIN document_type t ON t.code = d.document_type_code
         LEFT JOIN employee_document_version v ON v.id = d.current_version_id
        WHERE d.id = $1`, [id]);
    if (!row) throw new NotFoundException('No such document');

    try {
      await this.authz.assertCan(ctx, 'documents.document.download', {
        type: 'employee_document', id, subjectEmployeeId: row.employee_id,
        dataClass: row.data_class as DataClass,
      });
    } catch (e) { DocumentsController.rethrow(e); }

    if (row.withdrawn_at) throw new NotFoundException('That document has been withdrawn');
    // No current version means nothing has cleared quarantine. Not an error the user caused.
    if (!row.version_id) {
      throw new NotFoundException('That document has no cleared version available yet');
    }

    const body = await this.storage.get(row.object_key);

    // INTEGRITY CHECK on the way out (OWASP A08). If the object store returns bytes whose hash
    // does not match what was recorded, the content has been substituted or corrupted - serving
    // it would be worse than failing, so it fails and alerts.
    const actual = DocumentStorage.sha256(body);
    if (actual !== row.sha256_hex) {
      await this.db.rows(
        `SELECT fn_audit_security($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
        ['documents.integrity.mismatch.alert', me.userId, me.employeeId, row.employee_id,
          me.sessionId, clientIp(req),
          `document=${id} expected=${row.sha256_hex.slice(0, 12)} actual=${actual.slice(0, 12)}`,
          me.roles]).catch(() => undefined);
      throw new BadRequestException('That file failed its integrity check and was not served.');
    }

    /*
     * A VIEW and a DOWNLOAD are the same disclosure and get the same authorization, but they are
     * audited distinctly - "opened the appraisal in the browser" and "took a copy" are different
     * facts about the same person, and collapsing them loses information an auditor wants.
     * `mode` changes ONLY the audit event type. It does not relax a single header.
     */
    await this.audit(
      mode === 'view' ? 'documents.document.viewed' : 'documents.document.downloaded',
      id, req, { versionId: row.version_id });

    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Length', String(body.length));

    /*
     * ALWAYS `attachment`, including for a view.
     *
     * Inline disposition would let a scripted PDF or a polyglot execute in this origin, which
     * holds the session cookie. The client renders previews from a `blob:` URL it builds after
     * fetching these bytes with JS - so the browser never NAVIGATES to this response, the header
     * never has to be relaxed, and direct navigation stays safe for anybody who pastes the URL.
     */
    res.setHeader('Content-Disposition',
      `attachment; filename="${encodeURIComponent(row.original_name ?? 'document')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    // Belt: if some future change ever does serve this inline, the response can still do nothing.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(body);
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------
  @Get(':id/versions')
  @Authenticated()
  async versions(@Req() req: Request, @Param('id') id: string) {
    const ctx = authContext(req);
    const doc = await this.db.one(
      `SELECT d.id, d.employee_id, d.current_version_id, t.data_class
         FROM employee_document d JOIN document_type t ON t.code = d.document_type_code
        WHERE d.id = $1`, [id]);
    if (!doc) throw new NotFoundException('No such document');

    try {
      await this.authz.assertCan(ctx, 'documents.document.read', {
        type: 'employee_document', id, subjectEmployeeId: doc.employee_id,
        dataClass: doc.data_class as DataClass,
      });
    } catch (e) { DocumentsController.rethrow(e); }

    // Storage coordinates are NOT returned: they are unregistered in the field registry, and
    // handing them out invites a caller to try the object store directly.
    const rows = await this.db.rows(
      `SELECT v.id, v.version_no, v.content_type, v.size_bytes, v.original_name,
              v.scan_status, v.scanned_at, v.created_at, u.full_name AS uploaded_by_name,
              (v.id = $2::uuid) AS is_current
         FROM employee_document_version v
         LEFT JOIN employee u ON u.id = v.uploaded_by
        WHERE v.document_id = $1
        ORDER BY v.version_no DESC`, [id, doc.current_version_id]);

    return { versions: rows };
  }

  // -------------------------------------------------------------------------
  // Withdraw
  // -------------------------------------------------------------------------
  @Post(':id/withdraw')
  @Authenticated()
  async withdraw(
    @Req() req: Request, @Param('id') id: string, @Body() body: { reason?: string },
  ) {
    const ctx = authContext(req);
    const doc = await this.db.one(
      `SELECT d.id, d.employee_id, d.withdrawn_at, t.data_class
         FROM employee_document d JOIN document_type t ON t.code = d.document_type_code
        WHERE d.id = $1`, [id]);
    if (!doc) throw new NotFoundException('No such document');

    try {
      await this.authz.assertCan(ctx, 'documents.document.withdraw', {
        type: 'employee_document', id, subjectEmployeeId: doc.employee_id,
        dataClass: doc.data_class as DataClass,
      });
    } catch (e) { DocumentsController.rethrow(e); }

    const reason = (body.reason ?? '').trim();
    if (!reason) throw new BadRequestException('A withdrawal needs a reason');
    if (doc.withdrawn_at) throw new BadRequestException('Already withdrawn');

    const me = currentActor(req);
    // The document is withdrawn, never deleted, and the version rows and objects stay - a
    // statutory record outlives somebody's wish to remove it.
    await this.db.rows(
      `UPDATE employee_document
          SET withdrawn_at = now(), withdrawn_by = $2, withdrawn_reason = $3
        WHERE id = $1`, [id, me.employeeId, reason]);

    await this.audit('documents.document.withdrawn', id, req, { reason });
    return { id, withdrawn: true };
  }
}

// StorageModule is imported explicitly: DbModule and AuthzModule are @Global(), object storage
// deliberately is not - only this module should be able to reach the document bucket.
@Module({ imports: [StorageModule], controllers: [DocumentsController] })
export class DocumentsModule {}
