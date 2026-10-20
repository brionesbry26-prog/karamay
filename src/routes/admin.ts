import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { enforce, ipActor, noStore, parse, strike, type Ctx } from '../context.js';
import { safeEqual } from '../lib/crypto.js';
import { errors } from '../lib/errors.js';
import { manilaPeriods } from '../security/limiter.js';

/**
 * Operator endpoints. Authenticated only with ADMIN_API_TOKEN (bearer); user
 * sessions never grant admin access. When no token is configured the routes
 * answer 404 as if they did not exist. Expose them only on a private network
 * or behind an access proxy (see docs/RUNBOOKS.md).
 */
export async function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const authorize = async (req: FastifyRequest) => {
    if (!ctx.cfg.adminApiToken) throw errors.notFound();
    const actor = ipActor(ctx, req);
    const cooldown = await ctx.abuse.cooldownRemaining(actor);
    if (cooldown > 0) throw errors.tooMany(cooldown);
    await enforce(ctx, req, `admin:${actor}`, ctx.cfg.limits.admin.perIp, actor);
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!given || !safeEqual(given, ctx.cfg.adminApiToken)) {
      await strike(ctx, req, 'admin_auth_failed', actor);
      const fails = await ctx.limiter.hit('admin:failures', { limit: 10, windowSec: 600 });
      if (fails.count === 11) await ctx.alerts.emit('admin_auth_failures', { failuresIn10Min: fails.count });
      throw errors.unauthorized('Unauthorized.');
    }
  };
  const audit = (action: string, detail: Record<string, unknown>) =>
    ctx.db.query('INSERT INTO audit_log (actor, action, detail) VALUES ($1, $2, $3)', ['admin', action, JSON.stringify(detail)]);

  app.get('/api/admin/ai/usage', async (req, reply) => {
    noStore(reply);
    await authorize(req);
    const q = await parse(ctx, req, z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), req.query);
    const per = manilaPeriods();
    const spent = await ctx.limiter.budgetSpent(`d:${per.day}`, `m:${per.month}`);
    return {
      model: ctx.cfg.ai.model ?? null,
      budget: {
        dayUsd: spent.dayMicros / 1e6,
        dayLimitUsd: ctx.cfg.ai.budgetDailyUsd,
        monthUsd: spent.monthMicros / 1e6,
        monthLimitUsd: ctx.cfg.ai.budgetMonthlyUsd,
        alertThresholdsPct: ctx.cfg.ai.alertThresholds,
        note: 'Estimates from token usage and configured prices; reconcile with Google Cloud billing.',
      },
      killSwitch: await ctx.flags.aiKillSwitchState(),
      daily: await ctx.usage.report(q.days),
    };
  });

  app.get('/api/admin/ai/kill-switch', async (req, reply) => {
    noStore(reply);
    await authorize(req);
    return ctx.flags.aiKillSwitchState();
  });

  app.post('/api/admin/ai/kill-switch', async (req, reply) => {
    noStore(reply);
    await authorize(req);
    const body = await parse(ctx, req, z.object({ disabled: z.boolean(), reason: z.string().trim().min(3).max(200) }).strict(), req.body);
    await ctx.flags.setAiKillSwitch(body.disabled, body.reason);
    await audit('ai_kill_switch', { disabled: body.disabled, reason: body.reason });
    await ctx.alerts.emit('ai_kill_switch_changed', { disabled: body.disabled }, { dedupeKey: String(Date.now()), dedupeSec: 1 });
    return ctx.flags.aiKillSwitchState();
  });
}
