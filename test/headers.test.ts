import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, makeApp, safeJson, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp({ CORS_ORIGINS: 'https://app.karamay.example' });
});
afterAll(() => t.close());

describe('security headers', () => {
  it('serves the web client with a strict CSP and hardening headers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('marks API responses as non-cacheable', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/config' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets HttpOnly, SameSite=Strict session cookies', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/session/guest', payload: {} });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it('does not expose stack traces or internals on errors', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/session/guest', headers: { 'content-type': 'application/json' }, payload: '{"broken' });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/at .*\.(js|ts):\d+|node_modules|SyntaxError/);
  });

  it('serves no dotfiles or source files', async () => {
    for (const url of ['/.env', '/../package.json', '/%2e%2e/src/config.ts', '/data/../../src/config.ts']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect([400, 403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain('DATABASE_URL');
    }
  });

  it('has no debug or introspection routes', async () => {
    for (const url of ['/debug', '/api/debug', '/api/routes', '/documentation', '/api/env']) {
      expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
  });
});

describe('CORS', () => {
  it('allows only configured origins', async () => {
    const ok = await t.app.inject({ method: 'OPTIONS', url: '/api/config', headers: { origin: 'https://app.karamay.example', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.karamay.example');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await t.app.inject({ method: 'GET', url: '/api/config', headers: { origin: 'https://evil.example' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows an allowlisted cross-origin client to write with its CSRF token', async () => {
    const c = new Client(t.app, 'https://app.karamay.example');
    await c.guest();
    const res = await c.req('POST', '/api/mood', { mood: 3 });
    expect(res.statusCode).toBe(201);
    expect(safeJson(res).entry.mood).toBe(3);
  });
});
