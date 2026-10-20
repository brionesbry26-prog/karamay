import { randomUUID } from 'node:crypto';
import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { GeminiProvider } from './ai/gemini.js';
import type { AiProvider } from './ai/provider.js';
import { AiService } from './ai/service.js';
import { UsageRecorder } from './ai/usage.js';
import type { Config } from './config.js';
import { enforce, strike, subjectActor, type Ctx } from './context.js';
import { createPool, type Db } from './db/pool.js';
import { DataCipher, safeEqual } from './lib/crypto.js';
import { AppError, errors } from './lib/errors.js';
import { DevOutboxMailer, DisabledMailer, type Mailer } from './lib/mailer.js';
import { createRedis, type RedisClient } from './lib/redis.js';
import { Alerts } from './ops/alerts.js';
import { Flags } from './ops/flags.js';
import { TestHmacAdapter, type PaymentAdapter } from './payments/adapter.js';
import { adminRoutes } from './routes/admin.js';
import { aiRoutes } from './routes/ai.js';
import { authRoutes } from './routes/auth.js';
import { dataRoutes } from './routes/data.js';
import { paymentRoutes } from './routes/payments.js';
import { publicRoutes } from './routes/public.js';
import { sessionRoutes } from './routes/session.js';
import { AbuseMonitor } from './security/abuse.js';
import { Limiter } from './security/limiter.js';
import { SessionService } from './security/sessions.js';

export interface BuildOptions {
  cfg: Config;
  db?: Db;
  redis?: RedisClient;
  aiProvider?: AiProvider | null;
  mailer?: Mailer;
  payments?: PaymentAdapter | null;
  logStream?: NodeJS.WritableStream;
  alertFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  webRoot?: string;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Routes authenticated by something other than the session cookie.
const CSRF_EXEMPT = [/^\/api\/payments\/webhook$/, /^\/api\/admin\//];
// Always reachable, even during an abuse cooldown.
const COOLDOWN_EXEMPT = new Set(['/api/session', '/api/crisis-resources', '/api/config', '/api/health', '/api/me/export', '/api/me']);

function routePath(req: FastifyRequest): string {
  return req.url.split('?')[0] ?? '/';
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const { cfg } = opts;
  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      // Never log credentials or bodies. Request logs carry method, path and request id only.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
          '*.password',
          '*.token',
          '*.apiKey',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({ method: req.method, path: req.url.split('?')[0], id: req.id }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
    // Trust exactly N proxy hops, so clients cannot spoof their IP with X-Forwarded-For.
    trustProxy: (_addr: string, hop: number) => hop < cfg.trustProxyHops,
    bodyLimit: cfg.limits.body.maxBytes,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    return503OnClosing: true,
  });

  const ownDb = !opts.db;
  const ownRedis = !opts.redis;
  const db = opts.db ?? createPool(cfg);
  const redis = opts.redis ?? createRedis(cfg);
  const limiter = new Limiter(redis);
  const alerts = new Alerts(app.log, redis, cfg.alertWebhookUrl, opts.alertFetch);
  const flags = new Flags(cfg, redis);
  const usage = new UsageRecorder(db);
  const sessions = new SessionService(db, cfg);
  const abuse = new AbuseMonitor(limiter, cfg.limits.abuse, app.log, alerts);
  const aiProvider = opts.aiProvider !== undefined ? opts.aiProvider : cfg.ai.enabled ? new GeminiProvider(cfg.ai) : null;
  const mailer = opts.mailer ?? (cfg.mailer === 'dev-outbox' ? new DevOutboxMailer(cfg.env === 'development') : new DisabledMailer());
  const payments =
    opts.payments !== undefined
      ? opts.payments
      : cfg.payments.provider === 'test-hmac'
        ? new TestHmacAdapter(cfg.payments.webhookSecret!, cfg.payments.toleranceSec)
        : null;

  const ctx: Ctx = {
    cfg,
    db,
    redis,
    limiter,
    sessions,
    abuse,
    alerts,
    flags,
    cipher: new DataCipher(cfg.encryption.keys, cfg.encryption.activeKeyId),
    mailer,
    ai: new AiService(cfg, aiProvider, limiter, flags, usage, alerts, app.log, opts.sleep),
    usage,
    payments,
    log: app.log,
  };

  app.addHook('onClose', async () => {
    if (ownDb) await db.end();
    if (ownRedis) redis.disconnect();
  });

  // ---- Security headers --------------------------------------------------------
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        ...(cfg.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: cfg.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    if (routePath(req).startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  if (cfg.corsOrigins.length) {
    await app.register(cors, {
      origin: cfg.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['content-type', 'x-csrf-token', 'authorization'],
      maxAge: 600,
    });
  }
  await app.register(cookie);

  // ---- Identity -------------------------------------------------------------------
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req) => {
    req.principal = null;
    if (!routePath(req).startsWith('/api/') || routePath(req).startsWith('/api/admin/')) return;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      req.principal = await sessions.validate(auth.slice(7).trim(), 'bearer');
      return;
    }
    const token = req.cookies[sessions.cookieName()];
    if (token) req.principal = await sessions.validate(token, 'cookie');
  });

  // ---- CSRF / origin, cooldowns, general API rate limit ------------------------------
  const allowedOrigins = new Set([cfg.publicOrigin, ...cfg.corsOrigins].filter((o): o is string => Boolean(o)));
  app.addHook('preHandler', async (req) => {
    const p = routePath(req);
    if (!p.startsWith('/api/')) return;

    if (UNSAFE.has(req.method) && !CSRF_EXEMPT.some((re) => re.test(p))) {
      const origin = req.headers.origin;
      const selfOrigin = `${req.protocol}://${req.host}`;
      // Without a configured PUBLIC_ORIGIN (local development only) the serving origin is accepted.
      const originOk = !origin || allowedOrigins.has(origin) || (!cfg.publicOrigin && origin === selfOrigin);
      const crossSite = req.headers['sec-fetch-site'] === 'cross-site';
      if (!originOk || (crossSite && !(origin && allowedOrigins.has(origin)))) {
        await strike(ctx, req, 'csrf_failed');
        throw errors.csrf();
      }
      // Cookie-authenticated writes also need the per-session synchronizer token.
      if (req.principal?.via === 'cookie') {
        const sent = req.headers['x-csrf-token'];
        if (typeof sent !== 'string' || !safeEqual(sent, req.principal.csrfToken)) {
          await strike(ctx, req, 'csrf_failed');
          throw errors.csrf();
        }
      }
    }

    const principal = req.principal;
    if (principal && !COOLDOWN_EXEMPT.has(p)) {
      const cooldown = await abuse.cooldownRemaining(subjectActor(principal));
      if (cooldown > 0) {
        // Ignoring a cooldown keeps escalating: longer cooldowns, then session revocation.
        await strike(ctx, req, 'cooldown_ignored');
        throw errors.tooMany(cooldown, 'Please take a short break and try again later.', 'cooldown');
      }
      await enforce(ctx, req, `api:${principal.subjectId}`, { limit: cfg.limits.api.perSubjectPerMinute, windowSec: 60 });
    }
  });

  // ---- Errors -----------------------------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfterSec) reply.header('retry-after', String(err.retryAfterSec));
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    const e = err as { statusCode?: number; code?: string; name?: string; message?: string; stack?: string };
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
    if (status === 500) {
      req.log.error({ evt: 'unhandled_error', errName: e.name, errCode: e.code, errMessage: e.message, stack: cfg.isProd ? undefined : e.stack }, 'unhandled error');
      return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong. Please try again.' } });
    }
    const code = status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : 'bad_request';
    return reply.code(status).send({ error: { code, message: status === 413 ? 'That is too long to send.' : 'The request is invalid.' } });
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(routePath(req).startsWith('/api/') ? { error: { code: 'not_found', message: 'Not found.' } } : 'Not found');
  });

  // ---- Routes ---------------------------------------------------------------------------
  await publicRoutes(app, ctx);
  await sessionRoutes(app, ctx);
  await authRoutes(app, ctx);
  await dataRoutes(app, ctx);
  await aiRoutes(app, ctx);
  await paymentRoutes(app, ctx);
  await adminRoutes(app, ctx);

  // ---- Web client ----------------------------------------------------------------------
  await app.register(fastifyStatic, {
    root: opts.webRoot ?? path.resolve(process.cwd(), 'web'),
    prefix: '/',
    index: ['index.html'],
    dotfiles: 'deny',
    setHeaders: (res, filePath) => {
      res.header('cache-control', filePath.endsWith('.html') || filePath.endsWith('.json') ? 'no-cache' : 'public, max-age=3600');
    },
  });

  return { app, ctx };
}
