import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { testEnv } from './env.js';

const prodBase = () =>
  testEnv({
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://karamay.example',
    DATABASE_SSL: 'verify-full',
    MAILER: 'none',
    PAYMENTS_PROVIDER: 'none',
    IP_HASH_KEY: 'p'.repeat(40),
  });

function problems(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

describe('production configuration guards', () => {
  it('accepts a complete production configuration', () => {
    const cfg = loadConfig(prodBase());
    expect(cfg.isProd).toBe(true);
    expect(cfg.cookieSecure).toBe(true);
    expect(cfg.accountsEnabled).toBe(false); // no mailer -> guest-only
  });

  it.each([
    ['PUBLIC_ORIGIN', { PUBLIC_ORIGIN: '' }, /PUBLIC_ORIGIN is required/],
    ['http origin', { PUBLIC_ORIGIN: 'http://karamay.example' }, /must use https/],
    ['wildcard CORS', { CORS_ORIGINS: '*' }, /must not contain "\*"/],
    ['missing Redis', { REDIS_URL: '' }, /REDIS_URL is required/],
    ['missing migration role', { DATABASE_MIGRATION_URL: '' }, /DATABASE_MIGRATION_URL is required/],
    ['short IP hash key', { IP_HASH_KEY: 'short' }, /IP_HASH_KEY/],
    ['missing encryption keys', { DATA_ENCRYPTION_KEYS: '' }, /DATA_ENCRYPTION_KEYS is required/],
    ['bad encryption key size', { DATA_ENCRYPTION_KEYS: `1:${Buffer.alloc(16).toString('base64')}` }, /32 bytes/],
    ['dev mailer', { MAILER: 'dev-outbox' }, /dev-outbox is not allowed/],
    ['community', { COMMUNITY_ENABLED: 'true' }, /COMMUNITY_ENABLED=true is refused/],
    ['short admin token', { ADMIN_API_TOKEN: 'abc' }, /ADMIN_API_TOKEN/],
  ])('refuses: %s', (_name, override, pattern) => {
    expect(problems({ ...prodBase(), ...override }).join('\n')).toMatch(pattern);
  });

  it('requires model, prices, budgets and key when AI is enabled', () => {
    const p = problems({ ...prodBase(), AI_ENABLED: 'true', GEMINI_API_KEY: '', GEMINI_MODEL: '', GEMINI_PRICE_INPUT_USD_PER_MTOK: '', GEMINI_PRICE_OUTPUT_USD_PER_MTOK: '', AI_BUDGET_DAILY_USD: '', AI_BUDGET_MONTHLY_USD: '' }).join('\n');
    for (const v of ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_PRICE_INPUT_USD_PER_MTOK', 'GEMINI_PRICE_OUTPUT_USD_PER_MTOK', 'AI_BUDGET_DAILY_USD', 'AI_BUDGET_MONTHLY_USD']) {
      expect(p).toContain(v);
    }
  });

  it('rejects a daily budget above the monthly budget', () => {
    expect(problems({ ...prodBase(), AI_BUDGET_DAILY_USD: '50', AI_BUDGET_MONTHLY_USD: '10' }).join()).toMatch(/cannot exceed/);
  });

  it('never echoes secret values in configuration errors', () => {
    const secret = 'SUPER-SECRET-VALUE-123';
    const p = problems({ ...prodBase(), ADMIN_API_TOKEN: 'x', GEMINI_API_KEY: secret, DATA_ENCRYPTION_KEYS: `1:${secret}` }).join('\n');
    expect(p).not.toContain(secret);
  });

  it('validates LIMITS_JSON overrides', () => {
    expect(problems({ ...prodBase(), LIMITS_JSON: '{not json' }).join()).toMatch(/not valid JSON/);
    expect(problems({ ...prodBase(), LIMITS_JSON: JSON.stringify({ ai: { perDay: { guest: -1 } } }) }).join()).toMatch(/LIMITS_JSON\.ai\.perDay\.guest/);
    const cfg = loadConfig({ ...prodBase(), LIMITS_JSON: JSON.stringify({ ai: { perDay: { guest: 5 } } }) });
    expect(cfg.limits.ai.perDay).toEqual({ guest: 5, user: 30, premium: 120 });
  });
});
