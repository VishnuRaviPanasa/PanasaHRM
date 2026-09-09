import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { Client } from 'minio';
import { createHash } from 'node:crypto';

/**
 * Object storage for employee documents (MinIO / S3).
 *
 * WHY THE CONTENT STREAMS THROUGH THE API RATHER THAN VIA A PRESIGNED URL
 *
 * A presigned URL is the conventional, scalable answer and it is the wrong one here. It is a
 * bearer token for the object that:
 *
 *   * cannot be revoked once issued - an employee who is offboarded mid-download keeps it, and
 *     ADR-0009's whole offboarding argument is that revocation must take effect locally and
 *     immediately;
 *   * produces no audit row per access, so the individual accesses that make a bulk export
 *     visible never exist;
 *   * ends up in logs. `security-guidelines.md` bans presigned-URL query strings from logs
 *     precisely because they are credentials in a URL, and the surest way to keep them out is
 *     not to mint them.
 *
 * The cost is that document bytes traverse the API process. On a single-VM deployment serving a
 * few hundred employees that is a non-issue, and it is recorded as the deliberate trade it is.
 *
 * WHAT IS NOT HERE
 *
 * The two-bucket quarantine SPLIT. `security-guidelines.md` wants an upload to land in a
 * quarantine bucket and be promoted to a clean one. What exists instead is the DATABASE gate:
 * `employee_document.current_version_id` cannot point at a version that is not `clean`
 * (migration 0018), so an unscanned file is unreachable through the data model. The physical
 * bucket split is defence in depth on top of that, and it is not built - OR-24.
 */

export const DOCUMENT_BUCKET = process.env.HRM_DOC_BUCKET ?? 'hrm-documents';

@Injectable()
export class DocumentStorage implements OnModuleInit {
  private readonly client = new Client({
    endPoint: process.env.HRM_MINIO_HOST ?? '127.0.0.1',
    port: Number(process.env.HRM_MINIO_PORT ?? 59000),
    useSSL: (process.env.HRM_MINIO_SSL ?? 'false') === 'true',
    accessKey: process.env.HRM_MINIO_ACCESS_KEY ?? 'hrm_minio',
    secretKey: process.env.HRM_MINIO_SECRET_KEY ?? 'minio_dev_only',
  });

  private ready = false;

  async onModuleInit(): Promise<void> {
    // Failing to reach object storage at boot must not stop the API: every other module works
    // without it, and Rule 12's reasoning applies - an outage in one dependency should degrade
    // one feature. Upload and download report the outage; the rest of the app does not care.
    try {
      await this.ensureBucket();
      this.ready = true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `object storage unavailable at boot (${(e as Error).message}) - document upload and ` +
        'download will fail until it returns; nothing else is affected');
    }
  }

  async ensureBucket(): Promise<void> {
    if (!(await this.client.bucketExists(DOCUMENT_BUCKET))) {
      await this.client.makeBucket(DOCUMENT_BUCKET, '');
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /** SHA-256 of the bytes, hex. Stored on the version row for integrity (OWASP A08). */
  static sha256(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  /**
   * Store an object. The key must already be `<document_id>/<version_id>` - `objectKeyFor` in
   * packages/authz enforces that it carries no personal data, and this method does not build
   * keys itself so there is one place that rule lives.
   */
  async put(key: string, body: Buffer, contentType: string): Promise<{ etag: string }> {
    if (!this.ready) await this.ensureBucket().then(() => { this.ready = true; });
    const res = await this.client.putObject(DOCUMENT_BUCKET, key, body, body.length, {
      'Content-Type': contentType,
      // Nothing identifying goes into object metadata either - it travels with the object into
      // backups and bucket listings, same as the key.
      'x-amz-meta-sha256': DocumentStorage.sha256(body),
    });
    return { etag: res.etag };
  }

  async get(key: string): Promise<Buffer> {
    if (!this.ready) await this.ensureBucket().then(() => { this.ready = true; });
    const stream = await this.client.getObject(DOCUMENT_BUCKET, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.statObject(DOCUMENT_BUCKET, key);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove an object. Used ONLY to roll back a failed upload - the database row and the object
   * must not diverge. It is never a document deletion: `employee_document_version` is
   * append-only and a document is withdrawn, never removed.
   */
  async removeOrphan(key: string): Promise<void> {
    try {
      await this.client.removeObject(DOCUMENT_BUCKET, key);
    } catch {
      // An orphaned object is a storage-cost problem, not a correctness one. Swallowing it here
      // is deliberate: the upload has already failed and the caller needs that error, not this.
    }
  }
}

@Module({ providers: [DocumentStorage], exports: [DocumentStorage] })
export class StorageModule {}
