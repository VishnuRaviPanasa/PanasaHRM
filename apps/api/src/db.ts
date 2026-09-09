import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool, types, type QueryResultRow } from 'pg';

/**
 * MUST-KNOW RULE 5, at the driver boundary.
 *
 * `pg` parses a DATE column into a JS Date at LOCAL midnight, and JSON.stringify then emits UTC -
 * so 2026-09-14 leaves the API as "2026-09-13T18:30:00.000Z" in IST and every date-only value
 * silently shifts back a day. Caught by the demo reporting Ganesh Chaturthi on the 13th.
 *
 * This is the exact corruption Rule 5 exists to prevent ("timezone drift on these silently
 * corrupts payroll and attendance"), and the database side was already correct - joined_on,
 * work_date, business_date, valid_from and leave dates are all DATE. The bug was entirely in the
 * driver's helpfulness. DATE (oid 1082) is therefore returned as the plain string it is.
 */
types.setTypeParser(1082, (v) => v);          // date
types.setTypeParser(1700, (v) => v);          // numeric: keep exact, never a JS float (Rule 4)

/**
 * The only place that talks to PostgreSQL.
 *
 * TRACK B, recorded rather than pretended away:
 *   * ADR-0003 permits Drizzle only inside `infrastructure/repositories/`, with SQL as the source
 *     of truth. This demo uses parameterised `pg` directly - the migrations are still the source
 *     of truth, but the typed Drizzle mirror (task T7b) does not exist, so there is nothing to
 *     mirror against and no drift detection.
 *   * Every query here runs as the OWNER role. Migration 0008 created `hrm_app` precisely so the
 *     application would NOT be the owner, and pass-3 finding P3-7 showed the leave flow cannot
 *     currently run as `hrm_app` at all (the ledger trigger needs a grant the role lacks).
 *     Switching this connection to `hrm_app` is a Track B task and needs P3-7 fixed first.
 */
@Injectable()
export class Db implements OnModuleDestroy {
  private readonly pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 55432),
    user: process.env.PGUSER ?? 'hrm',
    password: process.env.PGPASSWORD ?? 'hrm_dev_only',
    database: process.env.PGDATABASE ?? 'hrm',
    max: 10,
  });

  async rows<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(sql, params as any[]);
    return res.rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.rows<T>(sql, params);
    return rows[0] ?? null;
  }

  /** A transaction. The leave flow needs one: the ledger trigger and its CHECK must share it. */
  async tx<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(async (sql, params = []) => (await client.query(sql, params as any[])).rows);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

@Global()
@Module({ providers: [Db], exports: [Db] })
export class DbModule {}
