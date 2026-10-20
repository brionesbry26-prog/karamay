import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataCipher } from '../src/lib/crypto.js';
import { purgeExpired } from '../src/ops/retention.js';
import { TEST_DB } from './env.js';
import { Client, makeApp, makeUser, safeJson, uniqueEmail, type TestApp } from './helpers.js';

const run = promisify(execFile);
let t: TestApp;
beforeAll(async () => {
  const wide = { limit: 10000, windowSec: 3600 };
  t = await makeApp({ LIMITS_JSON: JSON.stringify({ register: { perIp: wide }, login: { perIp: wide } }) });
});
afterAll(() => t.close());

const PW = 'correct horse battery 9';

/** Searches every text-like column of every table (as superuser, bypassing RLS) for a marker. */
async function findInDatabase(marker: string): Promise<string[]> {
  const su = new pg.Client({ connectionString: TEST_DB.superuserUrl.replace(/\/postgres$/, `/${TEST_DB.name}`) });
  await su.connect();
  try {
    const cols = await su.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('text', 'jsonb', 'bytea', 'character varying')`,
    );
    const hits: string[] = [];
    for (const c of cols.rows) {
      const expr = c.data_type === 'bytea' ? `encode("${c.column_name}", 'escape')` : `"${c.column_name}"::text`;
      const r = await su.query(`SELECT count(*)::int AS n FROM "${c.table_name}" WHERE ${expr} LIKE '%' || $1 || '%'`, [marker]);
      if (r.rows[0].n > 0) hits.push(`${c.table_name}.${c.column_name}`);
    }
    return hits;
  } finally {
    await su.end();
  }
}

describe('Scenario 21: logs contain no private content or credentials', () => {
  it('keeps journals, chat text, passwords, tokens and keys out of logs', async () => {
    const email = uniqueEmail('logs');
    const secretJournal = `JOURNAL-SECRET-${Date.now()}`;
    const secretChat = `CHAT-SECRET-${Date.now()}`;
    const secretMood = `MOOD-SECRET-${Date.now()}`;
    const u = await makeUser(t, email, PW);
    await u.req('POST', '/api/journal', { title: 'private', body: secretJournal });
    await u.req('POST', '/api/mood', { mood: 1, note: secretMood });
    await u.req('POST', '/api/ai/chat', { mode: 'kuwento', message: secretChat });
    await u.req('POST', '/api/journal', { title: secretJournal, body: secretJournal, bogus: secretJournal }); // invalid -> 400
    await u.req('GET', '/api/me/export');
    await new Client(t.app).req('POST', '/api/auth/login', { email, password: `${PW}-wrong` });
    await t.app.inject({ method: 'GET', url: '/api/admin/ai/usage', headers: { authorization: `Bearer ${t.cfg.adminApiToken}` } });
    t.ai.handler = () => {
      throw new Error(`provider exploded with key ${t.cfg.ai.apiKey}`);
    };
    await u.req('POST', '/api/ai/chat', { mode: 'kuwento', message: secretChat });

    const logs = t.logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    const sessionToken = u.cookie!.split('=')[1]!;
    for (const forbidden of [secretJournal, secretChat, secretMood, PW, email, sessionToken, u.csrf!, t.cfg.adminApiToken!, t.cfg.ai.apiKey!]) {
      expect(logs, `log leak: ${forbidden.slice(0, 12)}…`).not.toContain(forbidden);
    }
    expect(logs).not.toMatch(/"remoteAddress"|127\.0\.0\.1/);
  });
});

describe('Scenario 22: export only returns the caller’s own data', () => {
  it('ignores attempts to name another subject', async () => {
    const a = await new Client(t.app).guest();
    const b = await new Client(t.app).guest();
    await a.req('POST', '/api/journal', { title: 'A', body: 'only-for-a' });
    await b.req('POST', '/api/journal', { title: 'B', body: 'only-for-b' });
    const bId = await b.subjectId(t.ctx);
    const res = await a.req('GET', `/api/me/export?subjectId=${bId}&owner=${bId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('only-for-a');
    expect(res.body).not.toContain('only-for-b');
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('Scenario 23: users can delete their own data', () => {
  it('guest deletion removes journal, mood and sessions', async () => {
    const g = await new Client(t.app).guest();
    const id = await g.subjectId(t.ctx);
    await g.req('POST', '/api/journal', { title: 'x', body: 'to be deleted' });
    await g.req('POST', '/api/mood', { mood: 3 });
    expect((await g.req('DELETE', '/api/me', { confirm: 'nope' })).statusCode).toBe(400);
    expect((await g.req('DELETE', '/api/me', { confirm: 'DELETE' })).statusCode).toBe(200);
    expect((await g.req('GET', '/api/journal')).statusCode).toBe(401);
    for (const table of ['subjects', 'sessions']) {
      const col = table === 'subjects' ? 'id' : 'subject_id';
      expect((await t.ctx.db.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [id])).rowCount).toBe(0);
    }
    const owner = new pg.Client({ connectionString: t.cfg.database.migrationUrl });
    await owner.connect();
    await owner.query('BEGIN');
    await owner.query("SELECT set_config('app.subject_id', $1, true)", [id]);
    expect((await owner.query('SELECT 1 FROM journal_entries WHERE owner_id = $1', [id])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM mood_entries WHERE owner_id = $1', [id])).rowCount).toBe(0);
    await owner.query('ROLLBACK');
    await owner.end();
  });

  it('account deletion requires the password', async () => {
    const email = uniqueEmail('del');
    const u = await makeUser(t, email, PW);
    await u.req('POST', '/api/journal', { title: 'x', body: 'keep me unless confirmed' });
    expect((await u.req('DELETE', '/api/me', { confirm: 'DELETE', password: 'wrong password' })).statusCode).toBe(403);
    expect(safeJson(await u.req('GET', '/api/journal')).entries).toHaveLength(1);
    expect((await u.req('DELETE', '/api/me', { confirm: 'DELETE', password: PW })).statusCode).toBe(200);
    expect((await new Client(t.app).req('POST', '/api/auth/login', { email, password: PW })).statusCode).toBe(401);
  });
});

describe('Retention', () => {
  it('purges inactive guests together with their private data', async () => {
    const g = await new Client(t.app).guest();
    const id = await g.subjectId(t.ctx);
    await g.req('POST', '/api/journal', { title: 'old', body: 'old guest entry' });
    await t.ctx.db.query("UPDATE subjects SET last_active_at = now() - interval '31 days' WHERE id = $1", [id]);
    const counts = await purgeExpired(t.ctx.db, t.cfg.limits.retention);
    expect(counts.inactiveGuests).toBeGreaterThanOrEqual(1);
    expect((await t.ctx.db.query('SELECT 1 FROM subjects WHERE id = $1', [id])).rowCount).toBe(0);
  });
});

describe('Scenario 24: backup and restore can be rehearsed without production data', () => {
  it('restores a dump into a scratch database with RLS and encryption intact', async () => {
    const g = await new Client(t.app).guest();
    const id = await g.subjectId(t.ctx);
    await g.req('POST', '/api/journal', { title: 'backup', body: 'synthetic backup rehearsal entry' });

    const dir = await mkdtemp(path.join(tmpdir(), 'kmy-backup-'));
    const scratch = `karamay_restore_${process.pid}`;
    const su = TEST_DB.superuserUrl;
    const dbUrl = su.replace(/\/postgres$/, `/${TEST_DB.name}`);
    const scratchUrl = su.replace(/\/postgres$/, `/${scratch}`);
    const admin = new pg.Client({ connectionString: su });
    await admin.connect();
    try {
      await run('pg_dump', ['--format=custom', '--no-owner', `--file=${path.join(dir, 'k.dump')}`, dbUrl]);
      await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
      await admin.query(`CREATE DATABASE ${scratch} OWNER ${TEST_DB.ownerRole}`);
      await run('pg_restore', ['--no-owner', `--role=${TEST_DB.ownerRole}`, `--dbname=${scratchUrl}`, path.join(dir, 'k.dump')]);

      const restored = new pg.Client({ connectionString: scratchUrl.replace('postgres:postgres@', `${TEST_DB.ownerRole}:${TEST_DB.ownerPassword}@`) });
      await restored.connect();
      try {
        // RLS survives the restore: nothing visible without a bound subject.
        expect((await restored.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n).toBe(0);
        await restored.query('BEGIN');
        await restored.query("SELECT set_config('app.subject_id', $1, true)", [id]);
        const row = (await restored.query('SELECT * FROM journal_entries WHERE owner_id = $1', [id])).rows[0];
        await restored.query('COMMIT');
        // Ciphertext is useless without the key, and decrypts with it.
        expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('synthetic backup');
        const cipher = new DataCipher(t.cfg.encryption.keys, t.cfg.encryption.activeKeyId);
        expect(JSON.parse(cipher.decrypt(row.key_id, row.ciphertext, `journal:${id}:${row.id}`)).body).toBe('synthetic backup rehearsal entry');
      } finally {
        await restored.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Scenario 25: privacy disclosures match the actual data flows', () => {
  it('chat messages are never written to the database (as the Privacy Center states)', async () => {
    const g = await new Client(t.app).guest();
    const marker = `CHAT-NOT-STORED-${Date.now()}`;
    t.ai.handler = () => ({ text: `reply mentioning ${marker}`, blocked: null, finishReason: 'STOP', usage: { inputTokens: 10, outputTokens: 10 } });
    const res = await g.req('POST', '/api/ai/chat', { mode: 'makikinig', message: `hello ${marker}`, history: [{ role: 'user', text: `earlier ${marker}` }] });
    expect(res.statusCode).toBe(200);
    expect(await findInDatabase(marker)).toEqual([]);
  });

  it('journal text is only stored encrypted (no plaintext anywhere in the database)', async () => {
    const g = await new Client(t.app).guest();
    const marker = `JOURNAL-PLAINTEXT-${Date.now()}`;
    await g.req('POST', '/api/journal', { title: marker, body: marker });
    await g.req('POST', '/api/mood', { mood: 2, note: marker });
    expect(await findInDatabase(marker)).toEqual([]);
  });

  it('the model receives no account identifiers or unrelated data', async () => {
    const email = uniqueEmail('minimal');
    const u = await makeUser(t, email, PW);
    await u.req('POST', '/api/journal', { title: 'unrelated', body: 'UNRELATED-JOURNAL-TEXT' });
    t.ai.calls = [];
    t.ai.handler = () => ({ text: 'ok', blocked: null, finishReason: 'STOP', usage: { inputTokens: 1, outputTokens: 1 } });
    await u.req('POST', '/api/ai/chat', { mode: 'tulungan', message: 'Paano ako makakatulog nang maayos?' });
    const sent = JSON.stringify(t.ai.calls[0]);
    expect(sent).not.toContain(email);
    expect(sent).not.toContain(await u.subjectId(t.ctx));
    expect(sent).not.toContain('UNRELATED-JOURNAL-TEXT');
  });

  it('the Privacy Center states the configured retention and the real processors', async () => {
    const { readFile } = await import('node:fs/promises');
    const html = await readFile('web/index.html', 'utf8');
    expect(html).toContain(`${t.cfg.limits.retention.inactiveGuestDays} araw`);
    expect(html).toContain(`${t.cfg.limits.retention.inactiveGuestDays} days`);
    expect(html).toMatch(/Google Gemini/);
    expect(html).toMatch(/not stored on KARAMAY servers/i);
    expect(html).not.toMatch(/end-to-end encrypt/i);
  });
});

describe('Pre-session per-IP limits', () => {
  it('limits account creation attempts per IP', async () => {
    const t2 = await makeApp({ LIMITS_JSON: JSON.stringify({ register: { perIp: { limit: 2, windowSec: 3600 } } }) });
    try {
      const c = new Client(t2.app);
      expect((await c.req('POST', '/api/auth/register', { email: uniqueEmail('r1'), password: PW })).statusCode).toBe(202);
      expect((await c.req('POST', '/api/auth/register', { email: uniqueEmail('r2'), password: PW })).statusCode).toBe(202);
      expect((await c.req('POST', '/api/auth/register', { email: uniqueEmail('r3'), password: PW })).statusCode).toBe(429);
    } finally {
      await t2.close();
    }
  });
});
