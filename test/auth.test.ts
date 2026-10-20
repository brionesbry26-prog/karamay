import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, makeApp, makeUser, safeJson, uniqueEmail, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  // All test traffic comes from one IP, so per-IP limits are raised here (they are covered elsewhere);
  // the per-account login limit stays low because this file tests it.
  const wide = { limit: 10000, windowSec: 3600 };
  t = await makeApp({
    LIMITS_JSON: JSON.stringify({
      login: { perAccount: { limit: 3, windowSec: 900 }, perIp: wide },
      register: { perIp: wide },
      passwordReset: { perIp: wide },
      abuse: { strikesBeforeCooldown: 10000, strikesBeforeRevoke: 20000 },
    }),
  });
});
afterAll(() => t.close());

const PW = 'correct horse battery 9';
const tokenFrom = (link: string) => new URL(link.replace('/#/', '/')).searchParams.get('token')!;

describe('registration does not reveal whether an email is registered', () => {
  it('returns identical responses for new and existing emails', async () => {
    const email = uniqueEmail('enum');
    await makeUser(t, email);
    const c = new Client(t.app);
    const existing = await c.req('POST', '/api/auth/register', { email, password: 'another password 1' });
    const fresh = await c.req('POST', '/api/auth/register', { email: uniqueEmail('fresh'), password: 'another password 1' });
    expect(existing.statusCode).toBe(202);
    expect(fresh.statusCode).toBe(202);
    expect(existing.body).toBe(fresh.body);
    expect(t.mailer.lastFor(email)?.kind).toBe('already_registered');
  });

  it('login errors are the same for unknown emails and wrong passwords', async () => {
    const email = uniqueEmail('login');
    await makeUser(t, email);
    const unknown = await new Client(t.app).req('POST', '/api/auth/login', { email: uniqueEmail('nobody'), password: PW });
    const wrong = await new Client(t.app).req('POST', '/api/auth/login', { email, password: 'wrong password!!' });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(safeJson(unknown).error).toEqual(safeJson(wrong).error);
  });

  it('password reset requests answer the same way for any email', async () => {
    const email = uniqueEmail('reset-enum');
    await makeUser(t, email);
    const a = await new Client(t.app).req('POST', '/api/auth/password-reset/request', { email });
    const b = await new Client(t.app).req('POST', '/api/auth/password-reset/request', { email: uniqueEmail('ghost') });
    expect(a.statusCode).toBe(202);
    expect(a.body).toBe(b.body);
  });
});

describe('verification tokens', () => {
  it('cannot log in before verifying, and a verification link works once', async () => {
    const email = uniqueEmail('verify');
    const c = new Client(t.app);
    await c.req('POST', '/api/auth/register', { email, password: PW });
    expect((await c.req('POST', '/api/auth/login', { email, password: PW })).statusCode).toBe(401);
    const token = tokenFrom(t.mailer.lastFor(email, 'verify_registration')!.link!);
    expect((await c.req('POST', '/api/auth/verify', { token })).statusCode).toBe(200);
    expect((await c.req('POST', '/api/auth/verify', { token })).statusCode).toBe(400);
    expect((await c.req('POST', '/api/auth/login', { email, password: PW })).statusCode).toBe(200);
  });

  it('each sign-up attempt activates only its own password', async () => {
    const email = uniqueEmail('race');
    const victim = new Client(t.app);
    await victim.req('POST', '/api/auth/register', { email, password: PW });
    const victimToken = tokenFrom(t.mailer.lastFor(email, 'verify_registration')!.link!);
    // An attacker who does not control the inbox re-registers with their own password.
    await new Client(t.app).req('POST', '/api/auth/register', { email, password: 'attacker password 1' });
    expect((await victim.req('POST', '/api/auth/verify', { token: victimToken })).statusCode).toBe(200);
    expect((await victim.req('POST', '/api/auth/login', { email, password: PW })).statusCode).toBe(200);
    expect((await new Client(t.app).req('POST', '/api/auth/login', { email, password: 'attacker password 1' })).statusCode).toBe(401);
  });

  it('never stores raw tokens', async () => {
    const email = uniqueEmail('rawtok');
    await new Client(t.app).req('POST', '/api/auth/register', { email, password: PW });
    const raw = tokenFrom(t.mailer.lastFor(email, 'verify_registration')!.link!);
    const { rows } = await t.ctx.db.query("SELECT count(*)::int AS n FROM auth_tokens WHERE encode(token_hash, 'hex') = encode(convert_to($1, 'UTF8'), 'hex')", [raw]);
    expect(rows[0].n).toBe(0);
  });

  it('rejects weak passwords and passwords containing the email name', async () => {
    const c = new Client(t.app);
    expect((await c.req('POST', '/api/auth/register', { email: uniqueEmail('weak'), password: 'short' })).statusCode).toBe(400);
    expect((await c.req('POST', '/api/auth/register', { email: 'mariaclara@example.test', password: 'mariaclara-2026!' })).statusCode).toBe(400);
  });
});

describe('login throttling', () => {
  it('locks an account after repeated failures, regardless of the caller IP', async () => {
    const email = uniqueEmail('brute');
    await makeUser(t, email);
    const attacker = new Client(t.app);
    // makeUser already used 1 login attempt for this account.
    for (let i = 0; i < 2; i++) await attacker.req('POST', '/api/auth/login', { email, password: `guess-${i}-xxxxxxx` });
    const throttled = await attacker.req('POST', '/api/auth/login', { email, password: PW });
    expect(throttled.statusCode).toBe(429);
  });
});

describe('password reset', () => {
  it('resets once, revokes all sessions and voids other reset links', async () => {
    const email = uniqueEmail('reset');
    const device = await makeUser(t, email);
    const c = new Client(t.app);
    await c.req('POST', '/api/auth/password-reset/request', { email });
    const first = tokenFrom(t.mailer.lastFor(email, 'password_reset')!.link!);
    await c.req('POST', '/api/auth/password-reset/request', { email });
    const second = tokenFrom(t.mailer.lastFor(email, 'password_reset')!.link!);

    expect((await c.req('POST', '/api/auth/password-reset/confirm', { token: second, newPassword: 'brand new password 2' })).statusCode).toBe(200);
    expect((await c.req('POST', '/api/auth/password-reset/confirm', { token: second, newPassword: 'again new password 3' })).statusCode).toBe(400);
    expect((await c.req('POST', '/api/auth/password-reset/confirm', { token: first, newPassword: 'again new password 3' })).statusCode).toBe(400);
    expect((await device.req('GET', '/api/journal')).statusCode).toBe(401);
    expect((await new Client(t.app).req('POST', '/api/auth/login', { email, password: 'brand new password 2' })).statusCode).toBe(200);
    expect(t.mailer.lastFor(email)?.kind).toBe('password_changed');
  });

  it('expired reset links do not work', async () => {
    const email = uniqueEmail('expire');
    await makeUser(t, email);
    const c = new Client(t.app);
    await c.req('POST', '/api/auth/password-reset/request', { email });
    const token = tokenFrom(t.mailer.lastFor(email, 'password_reset')!.link!);
    await t.ctx.db.query("UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE purpose = 'password_reset' AND used_at IS NULL");
    expect((await c.req('POST', '/api/auth/password-reset/confirm', { token, newPassword: 'brand new password 2' })).statusCode).toBe(400);
  });
});

describe('guest to account upgrade', () => {
  it('moves guest data into the account (re-encrypted) and ends the guest identity', async () => {
    const email = uniqueEmail('upgrade');
    await makeUser(t, email);
    const guest = await new Client(t.app).guest();
    const guestId = await guest.subjectId(t.ctx);
    const guestCookie = guest.cookie!;
    await guest.req('POST', '/api/journal', { title: 'guest', body: 'isinulat ko bilang guest' });
    await guest.req('POST', '/api/mood', { mood: 2, note: 'malungkot' });

    const login = safeJson(await guest.req('POST', '/api/auth/login', { email, password: PW, guestData: 'merge' }));
    expect(login.guestData).toBe('merge');
    expect(guest.cookie).not.toBe(guestCookie); // fresh session id at the privilege change

    const journal = safeJson(await guest.req('GET', '/api/journal')).entries;
    expect(journal.map((e: { body: string }) => e.body)).toContain('isinulat ko bilang guest');
    expect(safeJson(await guest.req('GET', '/api/mood')).entries[0].note).toBe('malungkot');
    const gone = await t.ctx.db.query('SELECT 1 FROM subjects WHERE id = $1', [guestId]);
    expect(gone.rowCount).toBe(0);
    expect((await t.app.inject({ method: 'GET', url: '/api/journal', headers: { cookie: guestCookie } })).statusCode).toBe(401);
  });

  it('can discard guest data instead', async () => {
    const email = uniqueEmail('discard');
    await makeUser(t, email);
    const guest = await new Client(t.app).guest();
    await guest.req('POST', '/api/journal', { title: 'tmp', body: 'itapon mo na ito' });
    await guest.req('POST', '/api/auth/login', { email, password: PW, guestData: 'discard' });
    const bodies = safeJson(await guest.req('GET', '/api/journal')).entries.map((e: { body: string }) => e.body);
    expect(bodies).not.toContain('itapon mo na ito');
  });
});

describe('accounts without a mailer', () => {
  it('stays in guest-only mode instead of shipping unverifiable accounts', async () => {
    const t2 = await makeApp({ MAILER: 'none' });
    try {
      const res = await new Client(t2.app).req('POST', '/api/auth/register', { email: uniqueEmail('x'), password: PW });
      expect(res.statusCode).toBe(503);
      expect(safeJson(await t2.app.inject({ method: 'GET', url: '/api/config' })).accountsEnabled).toBe(false);
      expect((await new Client(t2.app).guest()).cookie).toBeTruthy();
    } finally {
      await t2.close();
    }
  });
});
