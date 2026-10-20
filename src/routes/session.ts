import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { enforce, ipActor, noStore, parse, requirePrincipal, type Ctx } from '../context.js';
import { errors } from '../lib/errors.js';
import type { IssuedSession, Principal } from '../security/sessions.js';

const createGuestBody = z
  .object({ client: z.enum(['web', 'mobile']).default('web') })
  .strict()
  .default({ client: 'web' });

export function sessionView(p: Principal) {
  return {
    kind: p.kind,
    tier: p.tier,
    premiumUntil: p.premiumUntil,
    csrfToken: p.via === 'cookie' ? p.csrfToken : null,
    expiresAt: p.expiresAt,
  };
}

/**
 * Delivers a fresh session: an HttpOnly cookie for browsers, or the raw token
 * in the body for mobile clients that keep it in platform secure storage.
 */
export function deliverSession(ctx: Ctx, reply: FastifyReply, issued: IssuedSession, client: 'web' | 'mobile') {
  if (client === 'mobile') return { token: issued.token, expiresAt: issued.expiresAt.toISOString() };
  reply.setCookie(ctx.sessions.cookieName(), issued.token, {
    httpOnly: true,
    secure: ctx.cfg.cookieSecure,
    sameSite: 'strict',
    path: '/',
    expires: issued.expiresAt,
  });
  return { csrfToken: issued.csrfToken, expiresAt: issued.expiresAt.toISOString() };
}

export function clearSessionCookie(ctx: Ctx, reply: FastifyReply) {
  reply.clearCookie(ctx.sessions.cookieName(), { path: '/', httpOnly: true, secure: ctx.cfg.cookieSecure, sameSite: 'strict' });
}

export async function sessionRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/api/session/guest', async (req, reply) => {
    noStore(reply);
    const body = await parse(ctx, req, createGuestBody, req.body ?? undefined);
    // An existing valid session is returned as-is: new guest identities cannot be
    // minted from a live session to reset quotas.
    if (req.principal) return { session: sessionView(req.principal), created: false };

    const actor = ipActor(ctx, req);
    const cooldown = await ctx.abuse.cooldownRemaining(actor);
    if (cooldown > 0) throw errors.tooMany(cooldown);
    await enforce(ctx, req, `guest-create:${actor}`, ctx.cfg.limits.guestSessionCreatePerIp, actor);

    const issued = await ctx.sessions.createGuest();
    reply.code(201);
    return { session: { kind: 'guest', tier: 'guest', premiumUntil: null, ...deliverSession(ctx, reply, issued, body.client) }, created: true };
  });

  /** "No session" is a normal state for a visitor who only uses device-local tools, so it is not an error. */
  app.get('/api/session', async (req, reply) => {
    noStore(reply);
    return { session: req.principal ? sessionView(req.principal) : null };
  });

  app.post('/api/session/logout', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    await ctx.sessions.revoke(p.tokenHash);
    clearSessionCookie(ctx, reply);
    return { ok: true };
  });

  app.post('/api/session/logout-all', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req, 'user');
    await ctx.sessions.revokeAll(ctx.db, p.subjectId);
    clearSessionCookie(ctx, reply);
    return { ok: true };
  });
}
