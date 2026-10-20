import pg from 'pg';
import type { Config } from '../config.js';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(cfg: Config, which: 'app' | 'migration' = 'app'): Db {
  const { database } = cfg;
  let ssl: pg.PoolConfig['ssl'] = false;
  if (database.ssl === 'verify-full') ssl = { rejectUnauthorized: true, ...(database.sslCa ? { ca: database.sslCa } : {}) };
  else if (database.ssl === 'require') ssl = { rejectUnauthorized: false };

  const pool = new pg.Pool({
    connectionString: which === 'app' ? database.url : database.migrationUrl,
    max: which === 'app' ? database.poolMax : 1,
    ssl,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 15_000,
    application_name: which === 'app' ? 'karamay-api' : 'karamay-migrate',
  });
  // Pool-level errors (e.g. a dropped idle connection) must not crash the process
  // or leak connection strings into logs.
  pool.on('error', () => {});
  return pool;
}

export async function tx<T>(db: Db, fn: (c: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs fn in a transaction bound to one subject. Row-level security on
 * private tables then limits every statement to that subject's rows, in
 * addition to the explicit owner_id filters in each query.
 */
export async function withSubject<T>(
  db: Db,
  subjectId: string,
  fn: (c: DbClient) => Promise<T>,
  opts: { mergeFrom?: string } = {},
): Promise<T> {
  return tx(db, async (c) => {
    await c.query("SELECT set_config('app.subject_id', $1, true)", [subjectId]);
    if (opts.mergeFrom) await c.query("SELECT set_config('app.merge_from', $1, true)", [opts.mergeFrom]);
    return fn(c);
  });
}
