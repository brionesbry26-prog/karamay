import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, makeApp, makeUser, safeJson, uniqueEmail, type TestApp } from './helpers.js';
import { TEST_DB } from './env.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

const entry = { title: 'Lihim', body: 'Ang bigat ng araw ko ngayon, pero kinaya ko.', mood: 2 };

describe('Scenario 1: users cannot read each other’s journals by changing ids', () => {
  it('returns 404 for another user’s entry on read, update and delete', async () => {
    const alice = await makeUser(t, uniqueEmail('alice'));
    const bob = await makeUser(t, uniqueEmail('bob'));
    const created = safeJson(await alice.req('POST', '/api/journal', entry));
    const id = created.entry.id;

    expect((await bob.req('GET', `/api/journal/${id}`)).statusCode).toBe(404);
    expect((await bob.req('PUT', `/api/journal/${id}`, { ...entry, body: 'overwritten' })).statusCode).toBe(404);
    expect((await bob.req('DELETE', `/api/journal/${id}`)).statusCode).toBe(404);
    const list = safeJson(await bob.req('GET', '/api/journal'));
    expect(list.entries.find((e: { id: string }) => e.id === id)).toBeUndefined();

    // Owner still sees the untouched entry.
    const mine = safeJson(await alice.req('GET', `/api/journal/${id}`));
    expect(mine.entry.body).toBe(entry.body);
  });

  it('cannot reach foreign mood entries either', async () => {
    const a = await new Client(t.app).guest();
    const b = await new Client(t.app).guest();
    const m = safeJson(await a.req('POST', '/api/mood', { mood: 4, note: 'medyo okay' }));
    expect((await b.req('DELETE', `/api/mood/${m.entry.id}`)).statusCode).toBe(404);
    expect(safeJson(await a.req('GET', '/api/mood')).entries).toHaveLength(1);
  });

  it('rejects malformed ids without touching the database', async () => {
    const a = await new Client(t.app).guest();
    expect((await a.req('GET', `/api/journal/1%20OR%201=1`)).statusCode).toBe(400);
    expect((await a.req('GET', `/api/journal/..%2F..%2Fetc%2Fpasswd`)).statusCode).toBe(400);
  });
});

describe('Scenario 2: guests cannot access other guests’ records', () => {
  it('isolates guest journals', async () => {
    const g1 = await new Client(t.app).guest();
    const g2 = await new Client(t.app).guest();
    const id = safeJson(await g1.req('POST', '/api/journal', entry)).entry.id;
    expect((await g2.req('GET', `/api/journal/${id}`)).statusCode).toBe(404);
    expect(safeJson(await g2.req('GET', '/api/journal')).entries).toEqual([]);
  });

  it('a client-supplied guest id has no effect (identity comes only from the session)', async () => {
    const g1 = await new Client(t.app).guest();
    const g1Id = await g1.subjectId(t.ctx);
    await g1.req('POST', '/api/journal', entry);
    const g2 = await new Client(t.app).guest();
    const res = await g2.req('GET', `/api/journal?owner=${g1Id}&subjectId=${g1Id}`, undefined, { 'x-guest-id': g1Id });
    expect(res.statusCode).toBe(400); // unknown query parameters are rejected outright
    expect(safeJson(await g2.req('GET', '/api/journal', undefined, { 'x-guest-id': g1Id })).entries).toEqual([]);
  });
});

describe('Database row-level security (defence in depth)', () => {
  it('hides rows from a transaction bound to another subject even without a WHERE owner filter', async () => {
    const g1 = await new Client(t.app).guest();
    const g2 = await new Client(t.app).guest();
    await g1.req('POST', '/api/journal', entry);
    const g2Id = await g2.subjectId(t.ctx);
    const client = await t.ctx.db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.subject_id', $1, true)", [g2Id]);
      const rows = await client.query('SELECT * FROM journal_entries'); // deliberately unfiltered
      expect(rows.rowCount).toBe(0);
      await client.query('ROLLBACK');
      // No subject bound at all: nothing is visible.
      const none = await client.query('SELECT count(*)::int AS n FROM journal_entries');
      expect(none.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  it('the runtime role cannot disable RLS or change schema', async () => {
    const c = new pg.Client({ connectionString: t.cfg.database.url });
    await c.connect();
    try {
      await expect(c.query('ALTER TABLE journal_entries DISABLE ROW LEVEL SECURITY')).rejects.toThrow(/owner/);
      await expect(c.query('DROP TABLE journal_entries')).rejects.toThrow(/owner/);
      await expect(c.query('SELECT * FROM schema_migrations')).rejects.toThrow(/permission denied/);
      const role = await c.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      expect(TEST_DB.appRole).toBe((await c.query('SELECT current_user AS u')).rows[0].u);
    } finally {
      await c.end();
    }
  });

  it('stores journal text encrypted at rest', async () => {
    const g = await new Client(t.app).guest();
    const secret = `walang-makakaalam-${Date.now()}`;
    await g.req('POST', '/api/journal', { title: 't', body: secret });
    const owner = new pg.Client({ connectionString: t.cfg.database.migrationUrl });
    await owner.connect();
    try {
      // The owner role is also subject to FORCE RLS, so bind the subject to read the raw row.
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('app.subject_id', $1, true)", [await g.subjectId(t.ctx)]);
      const raw = await owner.query('SELECT ciphertext FROM journal_entries');
      await owner.query('COMMIT');
      expect(raw.rowCount).toBe(1);
      expect(Buffer.from(raw.rows[0].ciphertext).toString('utf8')).not.toContain(secret);
    } finally {
      await owner.end();
    }
  });
});

describe('Scenario 3: logged-out users cannot access protected endpoints', () => {
  it.each([
    ['GET', '/api/journal'],
    ['POST', '/api/journal'],
    ['GET', '/api/mood'],
    ['GET', '/api/me/export'],
    ['DELETE', '/api/me'],
    ['POST', '/api/ai/chat'],
    ['GET', '/api/ai/status'],
  ])('%s %s -> 401', async (method, url) => {
    const res = await new Client(t.app).req(method, url, method === 'GET' ? undefined : {});
    expect(res.statusCode).toBe(401);
  });

  it('a forged or random bearer token is rejected', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/journal', headers: { authorization: 'Bearer ' + 'A'.repeat(43) } });
    expect(res.statusCode).toBe(401);
  });
});

describe('Scenario 4: expired or revoked sessions are rejected', () => {
  it('rejects a session after logout', async () => {
    const g = await new Client(t.app).guest();
    const cookie = g.cookie!;
    expect((await g.req('POST', '/api/session/logout', {})).statusCode).toBe(200);
    const res = await t.app.inject({ method: 'GET', url: '/api/journal', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a session past its absolute expiry', async () => {
    const g = await new Client(t.app).guest();
    const id = await g.subjectId(t.ctx);
    await t.ctx.db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE subject_id = $1", [id]);
    expect((await g.req('GET', '/api/journal')).statusCode).toBe(401);
  });

  it('rejects a session past its idle timeout', async () => {
    const g = await new Client(t.app).guest();
    const id = await g.subjectId(t.ctx);
    await t.ctx.db.query("UPDATE sessions SET last_seen_at = now() - interval '15 days' WHERE subject_id = $1", [id]);
    expect((await g.req('GET', '/api/journal')).statusCode).toBe(401);
  });

  it('logout-all revokes every session of an account', async () => {
    const email = uniqueEmail('multi');
    const phone = await makeUser(t, email);
    const laptop = new Client(t.app);
    await laptop.req('POST', '/api/auth/login', { email, password: 'correct horse battery 9' });
    expect((await phone.req('GET', '/api/journal')).statusCode).toBe(200);
    expect((await laptop.req('POST', '/api/session/logout-all', {})).statusCode).toBe(200);
    expect((await phone.req('GET', '/api/journal')).statusCode).toBe(401);
  });

  it('stores only token hashes, never raw session tokens', async () => {
    const g = await new Client(t.app).guest();
    const raw = g.cookie!.split('=')[1]!;
    const { rows } = await t.ctx.db.query("SELECT count(*)::int AS n FROM sessions WHERE encode(token_hash, 'escape') LIKE '%' || $1 || '%'", [raw]);
    expect(rows[0].n).toBe(0);
  });
});

describe('Scenario 5: premium status cannot be set from the client', () => {
  it('has no route that accepts entitlement changes', async () => {
    const u = await makeUser(t, uniqueEmail('free'));
    for (const [m, url] of [
      ['POST', '/api/me/entitlement'],
      ['PUT', '/api/me/entitlement'],
      ['POST', '/api/me'],
      ['PUT', '/api/me'],
    ]) {
      const res = await u.req(m!, url!, { premium: true, tier: 'premium', plan: 'premium' });
      expect([404, 405]).toContain(res.statusCode);
    }
    const ent = safeJson(await u.req('GET', '/api/me/entitlement'));
    expect(ent.premium).toBe(false);
    expect(ent.tier).toBe('user');
  });

  it('ignores premium flags smuggled into other requests', async () => {
    const u = await makeUser(t, uniqueEmail('smuggle'));
    const res = await u.req('POST', '/api/ai/chat', { mode: 'makikinig', message: 'hi', premium: true });
    expect(res.statusCode).toBe(400);
    expect(safeJson(await u.req('GET', '/api/session')).session.tier).toBe('user');
  });
});

describe('Scenario 6: administrative endpoints reject unauthorized users', () => {
  it('rejects anonymous, guest, user, and wrong-token requests', async () => {
    const u = await makeUser(t, uniqueEmail('notadmin'));
    expect((await u.req('GET', '/api/admin/ai/usage')).statusCode).toBe(401);
    expect((await u.req('POST', '/api/admin/ai/kill-switch', { disabled: true, reason: 'test' })).statusCode).toBe(401);
    const wrong = await t.app.inject({ method: 'GET', url: '/api/admin/ai/usage', headers: { authorization: 'Bearer wrong-token' } });
    expect(wrong.statusCode).toBe(401);
    const ok = await t.app.inject({ method: 'GET', url: '/api/admin/ai/usage', headers: { authorization: `Bearer ${t.cfg.adminApiToken}` } });
    expect(ok.statusCode).toBe(200);
  });

  it('hides admin routes entirely when no admin token is configured', async () => {
    const t2 = await makeApp({ ADMIN_API_TOKEN: '' });
    try {
      const res = await t2.app.inject({ method: 'GET', url: '/api/admin/ai/usage', headers: { authorization: 'Bearer anything' } });
      expect(res.statusCode).toBe(404);
    } finally {
      await t2.close();
    }
  });
});

describe('CSRF and origin protection', () => {
  it('rejects cookie-authenticated writes without the CSRF token', async () => {
    const g = await new Client(t.app).guest();
    const res = await g.req('POST', '/api/journal', entry, { 'x-csrf-token': 'wrong' });
    expect(res.statusCode).toBe(403);
    expect(safeJson(res).error.code).toBe('csrf_failed');
  });

  it('rejects cross-origin writes even with a valid CSRF token', async () => {
    const g = await new Client(t.app).guest();
    const res = await g.req('POST', '/api/journal', entry, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
  });

  it('bearer-token (mobile) clients do not need a CSRF token', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/session/guest', payload: { client: 'mobile' } });
    const token = safeJson(res).session.token;
    expect(token).toBeTruthy();
    expect(res.headers['set-cookie']).toBeUndefined();
    const m = new Client(t.app);
    m.bearer = token;
    expect((await m.req('POST', '/api/journal', entry)).statusCode).toBe(201);
  });
});
