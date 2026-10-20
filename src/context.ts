import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { AiService } from './ai/service.js';
import type { UsageRecorder } from './ai/usage.js';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { hmacHex, type DataCipher } from './lib/crypto.js';
import { errors } from './lib/errors.js';
import type { Mailer } from './lib/mailer.js';
import type { RedisClient } from './lib/redis.js';
import type { Alerts } from './ops/alerts.js';
import type { Flags } from './ops/flags.js';
import type { PaymentAdapter } from './payments/adapter.js';
import type { AbuseMonitor, StrikeKind } from './security/abuse.js';
import type { Limiter, Window } from './security/limiter.js';
import type { Principal, SessionService } from './security/sessions.js';

export interface Ctx {
  cfg: Config;
  db: Db;
  redis: RedisClient;
  limiter: Limiter;
  sessions: SessionService;
  abuse: AbuseMonitor;
  alerts: Alerts;
  flags: Flags;
  cipher: DataCipher;
  mailer: Mailer;
  ai: AiService;
  usage: UsageRecorder;
  payments: PaymentAdapter | null;
  log: FastifyBaseLogger;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

/** Pseudonymous actor key for an IP address (HMAC, never the raw IP). */
export function ipActor(ctx: Ctx, req: FastifyRequest): string {
  return `ip:${hmacHex(ctx.cfg.ipHashKey, req.ip).slice(0, 32)}`;
}

export function subjectActor(p: Principal): string {
  return `s:${p.subjectId}`;
}

export function requirePrincipal(req: FastifyRequest, kind?: 'user'): Principal {
  const p = req.principal;
  if (!p) throw errors.unauthorized();
  if (kind === 'user' && p.kind !== 'user') throw errors.forbidden('This needs a KARAMAY account.');
  return p;
}

/**
 * Validates untrusted input. Error details name the failing fields but never
 * echo the submitted values back (they may be private text).
 */
export async function parse<T>(ctx: Ctx, req: FastifyRequest, schema: ZodType<T>, data: unknown): Promise<T> {
  const res = schema.safeParse(data);
  if (res.success) return res.data;
  await strike(ctx, req, 'invalid_request');
  throw errors.badRequest('Some fields are missing or invalid.', {
    fields: [...new Set(res.error.issues.map((i) => i.path.join('.') || '(body)'))].slice(0, 10),
  });
}

/** Applies a rate-limit window and records a strike when it is exceeded. */
export async function enforce(ctx: Ctx, req: FastifyRequest, key: string, w: Window, actor?: string): Promise<void> {
  const res = await ctx.limiter.hit(key, w);
  if (res.allowed) return;
  await strike(ctx, req, 'rate_limited', actor);
  throw errors.tooMany(res.retryAfterSec);
}

/** Records a security strike; revokes the caller's sessions when the abuse monitor says so. */
export async function strike(ctx: Ctx, req: FastifyRequest, kind: StrikeKind, actor?: string): Promise<void> {
  const p = req.principal;
  const a = actor ?? (p ? subjectActor(p) : ipActor(ctx, req));
  try {
    const outcome = await ctx.abuse.strike(a, kind);
    if (outcome === 'revoke' && p && a === subjectActor(p)) await ctx.sessions.revokeAll(ctx.db, p.subjectId);
  } catch (err) {
    ctx.log.error({ evt: 'strike_failed', err: (err as Error).message }, 'failed to record strike');
  }
}

export function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}
