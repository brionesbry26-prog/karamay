import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from '../config.js';
import { createPool } from './pool.js';

const MIGRATION_LOCK_ID = 727_272_001;

export function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'db/migrations');
}

/**
 * Applies pending SQL migrations in order, each in its own transaction, under
 * an advisory lock so concurrent deploys cannot race. Must run with the owner
 * (migrator) role; the runtime app role only receives DML grants.
 */
export async function migrate(cfg: Config, opts: { appRole?: string; log?: (msg: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const pool = createPool(cfg, 'migration');
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(migrationsDir())).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir(), file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }

    if (opts.appRole) {
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(opts.appRole)) throw new Error('DATABASE_APP_ROLE must be a plain lower-case identifier');
      // Least privilege: the runtime role can read/write rows but cannot change
      // schema, disable RLS, or touch the migrations ledger.
      await client.query(`GRANT USAGE ON SCHEMA public TO ${opts.appRole}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON subjects, users, sessions, auth_tokens, journal_entries, mood_entries,
           entitlements, payment_events, ai_usage_daily, audit_log TO ${opts.appRole}`,
      );
      await client.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO ${opts.appRole}`);
      await client.query(`REVOKE ALL ON schema_migrations FROM ${opts.appRole}`);
      log(`granted runtime privileges to ${opts.appRole}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
    await pool.end();
  }
  return applied;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = loadConfig();
  migrate(cfg, { appRole: process.env.DATABASE_APP_ROLE, log: (m) => console.log(`[migrate] ${m}`) })
    .then((applied) => console.log(`[migrate] done (${applied.length} applied)`))
    .catch((err: Error) => {
      console.error(`[migrate] ${err.message}`);
      process.exit(1);
    });
}
