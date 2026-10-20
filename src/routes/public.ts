import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { crisisResources } from '../safety/crisis.js';

export async function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/health', async () => ({ ok: true }));

  /** Readiness: reports only up/down, never connection details. */
  app.get('/api/ready', async (_req, reply) => {
    const checks = await Promise.allSettled([ctx.db.query('SELECT 1'), ctx.redis.ping()]);
    const ok = checks.every((c) => c.status === 'fulfilled');
    reply.code(ok ? 200 : 503);
    return { ok };
  });

  app.get('/api/config', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const ai = await ctx.flags.aiStatus();
    return {
      aiAvailable: ai.available,
      accountsEnabled: ctx.cfg.accountsEnabled,
      paymentsAvailable: ctx.payments !== null,
      communityEnabled: false,
      limits: { maxMessageChars: ctx.cfg.limits.ai.maxMessageChars, maxJournalChars: ctx.cfg.limits.journal.maxBodyChars },
    };
  });

  /** Always available: no session, quota, AI or database dependency. */
  app.get('/api/crisis-resources', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return crisisResources();
  });
}
