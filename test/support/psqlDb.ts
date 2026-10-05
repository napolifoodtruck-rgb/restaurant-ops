/**
 * A throwaway PostgreSQL for tests, driven through psql (no driver needed). Parameters are
 * inlined as quoted literals: fine for tests, never for production (db.ts uses `pg`).
 * Needs PostgreSQL binaries and a non-root user; returns undefined when either is missing.
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../../src/server/db.ts';

function pgBin(): string | undefined {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const base = '/usr/lib/postgresql';
  if (!existsSync(base)) return undefined;
  const versions = readdirSync(base).sort((a, b) => Number(b) - Number(a));
  return versions.length ? join(base, versions[0]!, 'bin') : undefined;
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function startTestDb(): Db | undefined {
  const bin = pgBin();
  if (!bin || process.getuid?.() === 0) return undefined;
  const work = mkdtempSync(join(tmpdir(), 'ops-pg-'));
  execFileSync(join(bin, 'initdb'), ['-D', join(work, 'data'), '-U', 'postgres', '-A', 'trust'], { stdio: 'ignore' });
  execFileSync(join(bin, 'pg_ctl'), ['-D', join(work, 'data'), '-o', `-k ${work} -c listen_addresses=''`, '-l', join(work, 'log'), '-w', 'start'], { stdio: 'ignore' });
  const psql = (args: string[], input?: string) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(join(bin, 'psql'), ['-h', work, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...args]);
      let out = '', err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim()))));
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  return {
    async query(sql, params = []) {
      const text = sql.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1]));
      const returns = /^\s*(select|with)\b/i.test(text) || /\breturning\b/i.test(text);
      if (!returns) {
        await psql(['-c', text]);
        return { rows: [] };
      }
      const out = await psql(['-c', `WITH q AS (${text}) SELECT coalesce(json_agg(q), '[]') FROM q`]);
      return { rows: JSON.parse(out.trim() || '[]') };
    },
    async script(sql) {
      await psql(['-1', '-f', '-'], sql);
    },
    async close() {
      await new Promise((r) => execFile(join(bin, 'pg_ctl'), ['-D', join(work, 'data'), '-m', 'immediate', 'stop'], () => r(undefined)));
      rmSync(work, { recursive: true, force: true });
    },
  };
}
