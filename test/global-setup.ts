import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { TEST_DB, testEnv } from './env.js';

/**
 * Builds a throwaway database the way production should be set up:
 * a non-superuser owner role runs migrations, and the API connects as a
 * separate non-superuser role that cannot bypass row-level security.
 */
export default async function setup() {
  const su = new pg.Client({ connectionString: TEST_DB.superuserUrl });
  await su.connect();
  try {
    await su.query(`DROP DATABASE IF EXISTS ${TEST_DB.name} WITH (FORCE)`);
    for (const [role, pw] of [
      [TEST_DB.ownerRole, TEST_DB.ownerPassword],
      [TEST_DB.appRole, TEST_DB.appPassword],
    ] as const) {
      const exists = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (!exists.rowCount) await su.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    }
    await su.query(`CREATE DATABASE ${TEST_DB.name} OWNER ${TEST_DB.ownerRole}`);
  } finally {
    await su.end();
  }
  await migrate(loadConfig(testEnv()), { appRole: TEST_DB.appRole });
}
