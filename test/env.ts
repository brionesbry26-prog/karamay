import { randomBytes } from 'node:crypto';

const host = process.env.TEST_PG_HOST ?? 'localhost';
const port = process.env.TEST_PG_PORT ?? '5432';

export const TEST_DB = {
  name: 'karamay_test',
  superuserUrl: process.env.TEST_SUPERUSER_URL ?? `postgres://postgres:postgres@${host}:${port}/postgres`,
  ownerRole: 'karamay_test_owner',
  ownerPassword: 'owner_test_pw',
  appRole: 'karamay_test_app',
  appPassword: 'app_test_pw',
};

// Fixed test-only key so the global setup and every test file agree.
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: `postgres://${TEST_DB.appRole}:${TEST_DB.appPassword}@${host}:${port}/${TEST_DB.name}`,
    DATABASE_MIGRATION_URL: `postgres://${TEST_DB.ownerRole}:${TEST_DB.ownerPassword}@${host}:${port}/${TEST_DB.name}`,
    DATABASE_SSL: 'disable',
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
    REDIS_KEY_PREFIX: `kmytest:${randomBytes(6).toString('hex')}:`,
    IP_HASH_KEY: 'test-ip-hash-key-0123456789abcdef0123456789',
    DATA_ENCRYPTION_KEYS: `1:${TEST_KEY}`,
    MAILER: 'dev-outbox',
    ACCOUNTS_ENABLED: 'true',
    AI_ENABLED: 'true',
    GEMINI_API_KEY: 'test-gemini-key-SHOULD-NEVER-LEAK-9f8e7d6c',
    GEMINI_MODEL: 'test-model',
    GEMINI_PRICE_INPUT_USD_PER_MTOK: '1',
    GEMINI_PRICE_OUTPUT_USD_PER_MTOK: '4',
    AI_BUDGET_DAILY_USD: '5',
    AI_BUDGET_MONTHLY_USD: '100',
    AI_MAX_RETRIES: '1',
    ADMIN_API_TOKEN: 'test-admin-token-0123456789abcdef-XYZ',
    PAYMENTS_PROVIDER: 'test-hmac',
    PAYMENTS_WEBHOOK_SECRET: 'whsec_test_0123456789abcdef0123',
    ...overrides,
  };
}
