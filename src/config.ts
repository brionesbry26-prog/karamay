import { z } from 'zod';

/**
 * Central, validated configuration. Every tunable limit lives here (or in
 * LIMITS_JSON overrides) — never hardcode limits in route handlers.
 *
 * Production refuses to start when a security-relevant setting is missing or
 * unsafe, instead of silently falling back to a weaker default.
 */

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const optionalNonEmpty = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const positiveNumber = z.coerce.number().positive();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** The single public origin that serves the web client, e.g. https://karamay.example */
  PUBLIC_ORIGIN: optionalNonEmpty,
  /** Extra origins allowed to call the API with credentials (comma-separated). Empty = same-origin only. */
  CORS_ORIGINS: csv,
  /** Number of trusted reverse-proxy hops in front of the app (0 = none). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  DATABASE_URL: optionalNonEmpty,
  /** Owner/migrator connection. Falls back to DATABASE_URL for local development only. */
  DATABASE_MIGRATION_URL: optionalNonEmpty,
  DATABASE_SSL: z.enum(['verify-full', 'require', 'disable']).optional(),
  DATABASE_SSL_CA: optionalNonEmpty,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: optionalNonEmpty,
  REDIS_KEY_PREFIX: z.string().default('kmy:'),

  /** HMAC key used to pseudonymise IP addresses before they touch Redis. */
  IP_HASH_KEY: optionalNonEmpty,

  /** "1:<base64 32 bytes>,2:<base64 32 bytes>" — AES-256-GCM keys for journal/mood text at rest. */
  DATA_ENCRYPTION_KEYS: optionalNonEmpty,
  DATA_ENCRYPTION_ACTIVE_KEY_ID: z.coerce.number().int().min(1).optional(),

  AI_ENABLED: bool(false),
  GEMINI_API_KEY: optionalNonEmpty,
  GEMINI_MODEL: optionalNonEmpty,
  /** USD per 1M input tokens for GEMINI_MODEL. Verify against the official pricing page. */
  GEMINI_PRICE_INPUT_USD_PER_MTOK: positiveNumber.optional(),
  /** USD per 1M output tokens (thinking tokens are billed as output). */
  GEMINI_PRICE_OUTPUT_USD_PER_MTOK: positiveNumber.optional(),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(20000),
  GEMINI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(4096).default(700),
  /** Optional thinking budget in tokens; leave unset to use the model default. 0 disables thinking where supported. */
  GEMINI_THINKING_BUDGET: z.coerce.number().int().min(0).max(8192).optional(),
  /** Worst-case thinking tokens assumed when reserving budget before a call. */
  GEMINI_THINKING_RESERVE_TOKENS: z.coerce.number().int().min(0).max(32768).default(1024),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  AI_BUDGET_DAILY_USD: positiveNumber.optional(),
  AI_BUDGET_MONTHLY_USD: positiveNumber.optional(),
  AI_BUDGET_ALERT_THRESHOLDS: z
    .string()
    .default('50,75,90')
    .transform((v) =>
      v
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n < 100)
        .sort((a, b) => a - b),
    ),
  ALERT_WEBHOOK_URL: optionalNonEmpty,

  ADMIN_API_TOKEN: optionalNonEmpty,

  ACCOUNTS_ENABLED: bool(true),
  MAILER: z.enum(['none', 'dev-outbox']).default('none'),

  PAYMENTS_PROVIDER: z.enum(['none', 'test-hmac']).default('none'),
  PAYMENTS_WEBHOOK_SECRET: optionalNonEmpty,
  PAYMENTS_WEBHOOK_TOLERANCE_SEC: z.coerce.number().int().min(30).max(3600).default(300),

  COMMUNITY_ENABLED: bool(false),

  /** Optional JSON object deep-merged over DEFAULT_LIMITS. */
  LIMITS_JSON: optionalNonEmpty,
});

// ---------------------------------------------------------------------------
// Limits. Units: counts per window; windowSec in seconds.
// Initial values assume a small launch on a Flash-class model; tune them using
// the usage report (/api/admin/ai/usage) once real traffic is measured.
// ---------------------------------------------------------------------------

const window = z.object({ limit: z.number().int().min(1), windowSec: z.number().int().min(1) });
const tiered = z.object({ guest: z.number().int().min(0), user: z.number().int().min(0), premium: z.number().int().min(0) });

const limitsSchema = z.object({
  ai: z.object({
    perMinute: tiered,
    perDay: tiered,
    perMonth: tiered,
    concurrentPerSubject: tiered,
    globalConcurrency: z.number().int().min(1),
    maxMessageChars: z.number().int().min(50).max(8000),
    maxHistoryTurns: z.number().int().min(0).max(40),
    maxHistoryChars: z.number().int().min(0).max(40000),
    /** Requests/minute across the whole app that triggers an anomaly alert. */
    anomalyRequestsPerMinute: z.number().int().min(1),
  }),
  api: z.object({ perSubjectPerMinute: z.number().int().min(1) }),
  guestSessionCreatePerIp: window,
  register: z.object({ perIp: window }),
  login: z.object({ perAccount: window, perIp: window }),
  passwordReset: z.object({ perEmail: window, perIp: window }),
  journalWrite: window,
  moodWrite: window,
  export: window,
  deleteAccount: window,
  admin: z.object({ perIp: window }),
  abuse: z.object({
    strikeWindowSec: z.number().int().min(60),
    strikesBeforeCooldown: z.number().int().min(1),
    /** Escalating cooldown durations in seconds; the last value repeats. */
    cooldownsSec: z.array(z.number().int().min(1)).min(1),
    /** Strikes within the window after which the session is revoked outright. */
    strikesBeforeRevoke: z.number().int().min(1),
  }),
  body: z.object({ maxBytes: z.number().int().min(1024).max(1_048_576) }),
  journal: z.object({
    maxTitleChars: z.number().int().min(1),
    maxBodyChars: z.number().int().min(1),
    maxEntriesPerSubject: z.number().int().min(1),
  }),
  session: z.object({
    guestAbsoluteDays: z.number().int().min(1),
    guestIdleDays: z.number().int().min(1),
    userAbsoluteDays: z.number().int().min(1),
    userIdleDays: z.number().int().min(1),
  }),
  retention: z.object({
    /** Guests inactive this long are purged together with their server-side data. */
    inactiveGuestDays: z.number().int().min(1),
    usageAggregateDays: z.number().int().min(1),
    paymentEventDays: z.number().int().min(1),
    auditLogDays: z.number().int().min(1),
  }),
});

export type Limits = z.infer<typeof limitsSchema>;

export const DEFAULT_LIMITS: Limits = {
  ai: {
    perMinute: { guest: 4, user: 6, premium: 10 },
    perDay: { guest: 15, user: 30, premium: 120 },
    perMonth: { guest: 150, user: 400, premium: 2000 },
    concurrentPerSubject: { guest: 1, user: 1, premium: 2 },
    globalConcurrency: 25,
    maxMessageChars: 2000,
    maxHistoryTurns: 8,
    maxHistoryChars: 6000,
    anomalyRequestsPerMinute: 300,
  },
  api: { perSubjectPerMinute: 120 },
  guestSessionCreatePerIp: { limit: 30, windowSec: 3600 },
  register: { perIp: { limit: 10, windowSec: 3600 } },
  login: { perAccount: { limit: 5, windowSec: 900 }, perIp: { limit: 40, windowSec: 900 } },
  passwordReset: { perEmail: { limit: 3, windowSec: 3600 }, perIp: { limit: 15, windowSec: 3600 } },
  journalWrite: { limit: 60, windowSec: 3600 },
  moodWrite: { limit: 30, windowSec: 3600 },
  export: { limit: 5, windowSec: 3600 },
  deleteAccount: { limit: 5, windowSec: 3600 },
  admin: { perIp: { limit: 30, windowSec: 300 } },
  abuse: {
    strikeWindowSec: 600,
    strikesBeforeCooldown: 10,
    cooldownsSec: [300, 1800, 21600],
    strikesBeforeRevoke: 60,
  },
  body: { maxBytes: 64 * 1024 },
  journal: { maxTitleChars: 200, maxBodyChars: 20000, maxEntriesPerSubject: 5000 },
  session: { guestAbsoluteDays: 30, guestIdleDays: 14, userAbsoluteDays: 30, userIdleDays: 7 },
  retention: { inactiveGuestDays: 30, usageAggregateDays: 400, paymentEventDays: 400, auditLogDays: 365 },
};

function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export interface AiConfig {
  enabled: boolean;
  apiKey: string | undefined;
  model: string | undefined;
  priceInputPerMTok: number;
  priceOutputPerMTok: number;
  timeoutMs: number;
  maxOutputTokens: number;
  thinkingBudget: number | undefined;
  thinkingReserveTokens: number;
  maxRetries: number;
  budgetDailyUsd: number;
  budgetMonthlyUsd: number;
  alertThresholds: number[];
}

export interface Config {
  env: 'development' | 'test' | 'production';
  isProd: boolean;
  host: string;
  port: number;
  logLevel: string;
  publicOrigin: string | undefined;
  corsOrigins: string[];
  trustProxyHops: number;
  database: {
    url: string;
    migrationUrl: string;
    ssl: 'verify-full' | 'require' | 'disable';
    sslCa: string | undefined;
    poolMax: number;
  };
  redis: { url: string; keyPrefix: string };
  ipHashKey: string;
  encryption: { keys: Map<number, Buffer>; activeKeyId: number };
  ai: AiConfig;
  alertWebhookUrl: string | undefined;
  adminApiToken: string | undefined;
  accountsEnabled: boolean;
  mailer: 'none' | 'dev-outbox';
  payments: { provider: 'none' | 'test-hmac'; webhookSecret: string | undefined; toleranceSec: number };
  communityEnabled: boolean;
  limits: Limits;
  cookieSecure: boolean;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

function parseEncryptionKeys(raw: string | undefined, problems: string[]): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  if (!raw) return keys;
  for (const part of raw.split(',')) {
    const [idStr, b64] = part.split(':');
    const id = Number(idStr);
    if (!Number.isInteger(id) || id < 1 || !b64) {
      problems.push('DATA_ENCRYPTION_KEYS must look like "1:<base64>,2:<base64>"');
      continue;
    }
    const key = Buffer.from(b64.trim(), 'base64');
    if (key.length !== 32) {
      problems.push(`DATA_ENCRYPTION_KEYS key ${id} must decode to exactly 32 bytes`);
      continue;
    }
    keys.set(id, key);
  }
  return keys;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty variable (e.g. "GEMINI_API_KEY=") means "unset", never 0 or "".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const problems: string[] = [];
  const need = (name: string, value: unknown) => {
    if (value === undefined || value === '') problems.push(`${name} is required`);
  };

  // --- limits -------------------------------------------------------------
  let limits = DEFAULT_LIMITS;
  if (e.LIMITS_JSON) {
    try {
      const merged = deepMerge(DEFAULT_LIMITS, JSON.parse(e.LIMITS_JSON));
      const res = limitsSchema.safeParse(merged);
      if (res.success) limits = res.data;
      else problems.push(...res.error.issues.map((i) => `LIMITS_JSON.${i.path.join('.')}: ${i.message}`));
    } catch {
      problems.push('LIMITS_JSON is not valid JSON');
    }
  }

  // --- core infrastructure ---------------------------------------------------
  need('DATABASE_URL', e.DATABASE_URL);
  need('REDIS_URL', e.REDIS_URL);
  if (isProd) {
    need('PUBLIC_ORIGIN', e.PUBLIC_ORIGIN);
    if (e.PUBLIC_ORIGIN && !e.PUBLIC_ORIGIN.startsWith('https://')) problems.push('PUBLIC_ORIGIN must use https in production');
    for (const o of e.CORS_ORIGINS) {
      if (o === '*') problems.push('CORS_ORIGINS must not contain "*"');
      else if (!o.startsWith('https://')) problems.push(`CORS origin ${o} must use https in production`);
    }
    if (!e.DATABASE_MIGRATION_URL) problems.push('DATABASE_MIGRATION_URL is required in production (use a separate owner role)');
  }
  if (e.CORS_ORIGINS.includes('*')) problems.push('CORS_ORIGINS must not contain "*" (credentialed requests)');

  const ipHashKey = e.IP_HASH_KEY ?? (isProd ? undefined : 'dev-only-ip-hash-key-not-for-production');
  if (!ipHashKey || ipHashKey.length < 32) {
    if (isProd) problems.push('IP_HASH_KEY must be at least 32 characters');
  }

  const keys = parseEncryptionKeys(e.DATA_ENCRYPTION_KEYS, problems);
  if (keys.size === 0) problems.push('DATA_ENCRYPTION_KEYS is required (generate with: openssl rand -base64 32)');
  const activeKeyId = e.DATA_ENCRYPTION_ACTIVE_KEY_ID ?? Math.max(0, ...keys.keys());
  if (keys.size > 0 && !keys.has(activeKeyId)) problems.push('DATA_ENCRYPTION_ACTIVE_KEY_ID does not match any key');

  // --- AI ------------------------------------------------------------------------
  if (e.AI_ENABLED) {
    need('GEMINI_API_KEY', e.GEMINI_API_KEY);
    need('GEMINI_MODEL', e.GEMINI_MODEL);
    need('GEMINI_PRICE_INPUT_USD_PER_MTOK', e.GEMINI_PRICE_INPUT_USD_PER_MTOK);
    need('GEMINI_PRICE_OUTPUT_USD_PER_MTOK', e.GEMINI_PRICE_OUTPUT_USD_PER_MTOK);
    need('AI_BUDGET_DAILY_USD', e.AI_BUDGET_DAILY_USD);
    need('AI_BUDGET_MONTHLY_USD', e.AI_BUDGET_MONTHLY_USD);
    if (e.GEMINI_MODEL && !/^[a-z0-9][a-z0-9.\-]{2,63}$/.test(e.GEMINI_MODEL)) {
      problems.push('GEMINI_MODEL must be a bare model id such as "gemini-x.y-flash"');
    }
    if (e.AI_BUDGET_DAILY_USD && e.AI_BUDGET_MONTHLY_USD && e.AI_BUDGET_DAILY_USD > e.AI_BUDGET_MONTHLY_USD) {
      problems.push('AI_BUDGET_DAILY_USD cannot exceed AI_BUDGET_MONTHLY_USD');
    }
  }

  if (e.ADMIN_API_TOKEN !== undefined && e.ADMIN_API_TOKEN.length < 32) {
    problems.push('ADMIN_API_TOKEN must be at least 32 characters (or unset to disable admin endpoints)');
  }
  if (e.ALERT_WEBHOOK_URL && !e.ALERT_WEBHOOK_URL.startsWith('https://') && isProd) {
    problems.push('ALERT_WEBHOOK_URL must use https');
  }

  // --- accounts / mail ---------------------------------------------------------------
  let accountsEnabled = e.ACCOUNTS_ENABLED;
  if (isProd && e.MAILER === 'dev-outbox') problems.push('MAILER=dev-outbox is not allowed in production');
  if (accountsEnabled && e.MAILER === 'none') {
    // Registration and password reset depend on email delivery; without a mailer
    // accounts stay off rather than shipping an unverifiable account system.
    accountsEnabled = false;
  }

  // --- payments ----------------------------------------------------------------------
  if (e.PAYMENTS_PROVIDER === 'test-hmac' && isProd) {
    problems.push('PAYMENTS_PROVIDER=test-hmac is a test adapter and is not allowed in production');
  }
  if (e.PAYMENTS_PROVIDER !== 'none') {
    if (!e.PAYMENTS_WEBHOOK_SECRET || e.PAYMENTS_WEBHOOK_SECRET.length < 24) {
      problems.push('PAYMENTS_WEBHOOK_SECRET (24+ chars) is required when a payment provider is configured');
    }
  }

  // --- community -------------------------------------------------------------------
  if (e.COMMUNITY_ENABLED) {
    problems.push(
      'COMMUNITY_ENABLED=true is refused: moderation, reporting and anti-harassment safeguards are not implemented (see docs/COMMUNITY.md)',
    );
  }

  const dbSsl = e.DATABASE_SSL ?? (isProd ? 'verify-full' : 'disable');

  if (problems.length) throw new ConfigError(problems);

  return {
    env: e.NODE_ENV,
    isProd,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    publicOrigin: e.PUBLIC_ORIGIN,
    corsOrigins: e.CORS_ORIGINS,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    database: {
      url: e.DATABASE_URL!,
      migrationUrl: e.DATABASE_MIGRATION_URL ?? e.DATABASE_URL!,
      ssl: dbSsl,
      sslCa: e.DATABASE_SSL_CA,
      poolMax: e.DATABASE_POOL_MAX,
    },
    redis: { url: e.REDIS_URL!, keyPrefix: e.REDIS_KEY_PREFIX },
    ipHashKey: ipHashKey!,
    encryption: { keys, activeKeyId },
    ai: {
      enabled: e.AI_ENABLED,
      apiKey: e.GEMINI_API_KEY,
      model: e.GEMINI_MODEL,
      priceInputPerMTok: e.GEMINI_PRICE_INPUT_USD_PER_MTOK ?? 0,
      priceOutputPerMTok: e.GEMINI_PRICE_OUTPUT_USD_PER_MTOK ?? 0,
      timeoutMs: e.GEMINI_TIMEOUT_MS,
      maxOutputTokens: e.GEMINI_MAX_OUTPUT_TOKENS,
      thinkingBudget: e.GEMINI_THINKING_BUDGET,
      thinkingReserveTokens: e.GEMINI_THINKING_RESERVE_TOKENS,
      maxRetries: e.AI_MAX_RETRIES,
      budgetDailyUsd: e.AI_BUDGET_DAILY_USD ?? 0,
      budgetMonthlyUsd: e.AI_BUDGET_MONTHLY_USD ?? 0,
      alertThresholds: e.AI_BUDGET_ALERT_THRESHOLDS,
    },
    alertWebhookUrl: e.ALERT_WEBHOOK_URL,
    adminApiToken: e.ADMIN_API_TOKEN,
    accountsEnabled,
    mailer: e.MAILER,
    payments: {
      provider: e.PAYMENTS_PROVIDER,
      webhookSecret: e.PAYMENTS_WEBHOOK_SECRET,
      toleranceSec: e.PAYMENTS_WEBHOOK_TOLERANCE_SEC,
    },
    communityEnabled: false,
    limits,
    cookieSecure: isProd || (e.PUBLIC_ORIGIN?.startsWith('https://') ?? false),
  };
}
