import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { noStore, parse, requirePrincipal, strike, type Ctx } from '../context.js';
import { AppError } from '../lib/errors.js';
import { CHAT_MODES } from '../ai/prompts.js';

export async function aiRoutes(app: FastifyInstance, ctx: Ctx) {
  const L = ctx.cfg.limits.ai;
  const turn = z.object({ role: z.enum(['user', 'model']), text: z.string().min(1).max(L.maxMessageChars) }).strict();
  const chatBody = z
    .object({
      mode: z.enum(CHAT_MODES),
      message: z.string().trim().min(1).max(L.maxMessageChars),
      // Clients send only recent turns; the server trims further to the configured context budget.
      history: z.array(turn).max(40).default([]),
    })
    .strict();

  app.post('/api/ai/chat', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    const body = await parse(ctx, req, chatBody, req.body);
    try {
      return await ctx.ai.chat(p, body);
    } catch (err) {
      // Hammering the AI endpoint or pushing past quotas feeds the abuse monitor.
      if (err instanceof AppError && (err.code === 'rate_limited' || err.code === 'quota_exceeded')) {
        await strike(ctx, req, err.code);
      }
      throw err;
    }
  });

  app.get('/api/ai/status', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    const status = await ctx.flags.aiStatus();
    return {
      available: status.available,
      reason: status.available ? null : status.reason === 'kill_switch' ? 'paused' : 'unavailable',
      quota: await ctx.ai.quota(p),
    };
  });
}
