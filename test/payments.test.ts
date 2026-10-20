import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { TestHmacAdapter } from '../src/payments/adapter.js';
import { testEnv } from './env.js';
import { Client, makeApp, makeUser, safeJson, uniqueEmail, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(() => t.close());

const now = () => Math.floor(Date.now() / 1000);

function event(subjectId: string, type: string, opts: { id?: string; created?: number; periodEnd?: number | null; livemode?: boolean } = {}) {
  return JSON.stringify({
    id: opts.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    type,
    created: opts.created ?? now(),
    livemode: opts.livemode ?? false,
    data: { subject_id: subjectId, subscription_id: `sub_${subjectId.slice(0, 8)}`, period_end: opts.periodEnd === undefined ? now() + 30 * 86400 : opts.periodEnd },
  });
}

async function send(raw: string, opts: { secret?: string; t?: number; signature?: string } = {}) {
  const sig = opts.signature ?? TestHmacAdapter.sign(opts.secret ?? t.cfg.payments.webhookSecret!, raw, opts.t ?? now());
  return t.app.inject({ method: 'POST', url: '/api/payments/webhook', headers: { 'content-type': 'application/json', 'x-karamay-signature': sig }, payload: raw });
}

async function premium(c: Client) {
  return safeJson(await c.req('GET', '/api/me/entitlement')).premium as boolean;
}

describe('Scenario 16: webhook signatures', () => {
  it('rejects missing, forged, wrong-secret and tampered signatures', async () => {
    const u = await makeUser(t, uniqueEmail('sig'));
    const id = await u.subjectId(t.ctx);
    const raw = event(id, 'subscription.activated');
    const noSig = await t.app.inject({ method: 'POST', url: '/api/payments/webhook', headers: { 'content-type': 'application/json' }, payload: raw });
    expect(noSig.statusCode).toBe(400);
    expect((await send(raw, { secret: 'not-the-real-secret-xxxxxxxxxxxx' })).statusCode).toBe(400);
    expect((await send(raw, { signature: `t=${now()},v1=${'0'.repeat(64)}` })).statusCode).toBe(400);
    // Signed body, then tampered in transit.
    const sig = TestHmacAdapter.sign(t.cfg.payments.webhookSecret!, raw, now());
    const tampered = raw.replace('subscription.activated', 'subscription.renewed');
    const res = await t.app.inject({ method: 'POST', url: '/api/payments/webhook', headers: { 'content-type': 'application/json', 'x-karamay-signature': sig }, payload: tampered });
    expect(res.statusCode).toBe(400);
    expect(await premium(u)).toBe(false);
  });

  it('rejects live-mode events on a test-mode adapter (credential separation, scenario 20)', async () => {
    const u = await makeUser(t, uniqueEmail('mode'));
    const res = await send(event(await u.subjectId(t.ctx), 'subscription.activated', { livemode: true }));
    expect(res.statusCode).toBe(400);
    expect(await premium(u)).toBe(false);
  });
});

describe('Scenarios 17 and 18: duplicates, replays and out-of-order events', () => {
  it('processes a duplicate delivery only once', async () => {
    const u = await makeUser(t, uniqueEmail('dup'));
    const raw = event(await u.subjectId(t.ctx), 'subscription.activated', { id: `evt_dup_${Date.now()}` });
    expect(safeJson(await send(raw)).outcome).toBe('applied');
    expect(safeJson(await send(raw)).outcome).toBe('duplicate');
    expect(await premium(u)).toBe(true);
  });

  it('rejects a validly signed event replayed outside the tolerance window', async () => {
    const u = await makeUser(t, uniqueEmail('replay'));
    const raw = event(await u.subjectId(t.ctx), 'subscription.activated');
    const res = await send(raw, { t: now() - t.cfg.payments.toleranceSec - 60 });
    expect(res.statusCode).toBe(400);
    expect(await premium(u)).toBe(false);
  });

  it('ignores an older event that arrives after a newer one', async () => {
    const u = await makeUser(t, uniqueEmail('order'));
    const id = await u.subjectId(t.ctx);
    expect(safeJson(await send(event(id, 'subscription.activated', { created: now() - 100 }))).outcome).toBe('applied');
    expect(safeJson(await send(event(id, 'payment.refunded', { created: now() - 10 }))).outcome).toBe('applied');
    // A delayed renewal from before the refund must not restore access.
    expect(safeJson(await send(event(id, 'subscription.renewed', { created: now() - 50 }))).outcome).toBe('stale');
    expect(await premium(u)).toBe(false);
  });

  it('never grants entitlements to guests or unknown subjects', async () => {
    const guest = await new Client(t.app).guest();
    const gid = await guest.subjectId(t.ctx);
    expect(safeJson(await send(event(gid, 'subscription.activated'))).outcome).toBe('unknown_subject');
    expect(safeJson(await send(event('00000000-0000-4000-8000-000000000000', 'subscription.activated'))).outcome).toBe('unknown_subject');
    expect(safeJson(await guest.req('GET', '/api/session')).session.tier).toBe('guest');
  });
});

describe('Scenario 19: refunds and cancellations', () => {
  it('cancellation keeps access until the paid period ends; expiry ends it', async () => {
    const u = await makeUser(t, uniqueEmail('cancel'));
    const id = await u.subjectId(t.ctx);
    await send(event(id, 'subscription.activated', { created: now() - 30 }));
    await send(event(id, 'subscription.canceled', { created: now() - 20, periodEnd: null }));
    expect(await premium(u)).toBe(true);
    await send(event(id, 'subscription.expired', { created: now() - 10, periodEnd: null }));
    expect(await premium(u)).toBe(false);
  });

  it('a refund ends access immediately; failed payments suspend it', async () => {
    const u = await makeUser(t, uniqueEmail('refund'));
    const id = await u.subjectId(t.ctx);
    await send(event(id, 'subscription.activated', { created: now() - 30 }));
    await send(event(id, 'payment.failed', { created: now() - 20, periodEnd: null }));
    expect(await premium(u)).toBe(false);
    await send(event(id, 'subscription.renewed', { created: now() - 15 }));
    expect(await premium(u)).toBe(true);
    await send(event(id, 'payment.refunded', { created: now() - 5, periodEnd: null }));
    expect(await premium(u)).toBe(false);
  });

  it('expired subscriptions never lock users out of their journal', async () => {
    const u = await makeUser(t, uniqueEmail('lockout'));
    const id = await u.subjectId(t.ctx);
    await send(event(id, 'subscription.activated', { created: now() - 30 }));
    const e = safeJson(await u.req('POST', '/api/journal', { title: 'p', body: 'written while premium' })).entry;
    await send(event(id, 'subscription.expired', { created: now() - 10, periodEnd: null }));
    expect(safeJson(await u.req('GET', `/api/journal/${e.id}`)).entry.body).toBe('written while premium');
    expect((await u.req('GET', '/api/me/export')).statusCode).toBe(200);
  });
});

describe('Scenario 20: test and production payment configuration stay separate', () => {
  it('refuses the test adapter in production and requires a webhook secret', () => {
    const prod = testEnv({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://karamay.example',
      DATABASE_SSL: 'verify-full',
      MAILER: 'none',
      PAYMENTS_PROVIDER: 'test-hmac',
    });
    expect(() => loadConfig(prod)).toThrow(/test-hmac is a test adapter/);
    expect(() => loadConfig(testEnv({ PAYMENTS_WEBHOOK_SECRET: '' }))).toThrow(ConfigError);
  });

  it('answers 503 when no provider is configured', async () => {
    const t2 = await makeApp({ PAYMENTS_PROVIDER: 'none' });
    try {
      const res = await t2.app.inject({ method: 'POST', url: '/api/payments/webhook', headers: { 'content-type': 'application/json' }, payload: '{}' });
      expect(res.statusCode).toBe(503);
    } finally {
      await t2.close();
    }
  });
});
