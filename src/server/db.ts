/**
 * Database access. The app talks to PostgreSQL through this small interface, so the core
 * never depends on a driver: production uses `pg` (installed at deploy), tests can use any
 * implementation that runs SQL with $1-style parameters.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Db {
  /** One statement with $1, $2… parameters. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  /** A multi-statement script (no parameters), all or nothing. */
  script(sql: string): Promise<void>;
  close(): Promise<void>;
}

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  connect(): Promise<{ query(sql: string): Promise<unknown>; release(): void }>;
  end(): Promise<void>;
}

/** Connects with `pg`. Hosted databases need TLS; a local one usually doesn't. */
export async function connectPg(url: string): Promise<Db> {
  // The specifier is kept out of type resolution: `pg` is a runtime dependency only.
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default: { Pool: new (config: object) => PgPool } };
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || url.includes('host=/');
  const pool = new pg.default.Pool({ connectionString: url, max: 10, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
  return {
    query: async (sql, params = []) => pool.query(sql, [...params]),
    script: async (sql) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * Applies db/migrations/*.sql in name order, each once and each all-or-nothing.
 * Returns the names applied this time.
 */
export async function migrate(db: Db, dir: string): Promise<string[]> {
  await db.script('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = await readFile(join(dir, name), 'utf8');
    await db.script(`${sql}\nINSERT INTO schema_migrations (name) VALUES ('${name.replace(/'/g, "''")}');`);
    applied.push(name);
  }
  return applied;
}
