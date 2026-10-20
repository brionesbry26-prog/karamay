import type { FastifyInstance } from 'fastify';
import { ipActor, noStore, requirePrincipal, strike, type Ctx } from '../context.js';
import { errors } from '../lib/errors.js';
import { WebhookVerificationError } from '../payments/adapter.js';
import { applyPaymentEvent } from '../payments/entitlements.js';

export async function paymentRoutes(app: FastifyInstance, ctx: Ctx) {
  /** Entitlements are read from the server; there is deliberately no route that lets a client set them. */
  app.get('/api/me/entitlement', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    return { tier: p.tier, premium: p.premium, premiumUntil: p.premiumUntil, paymentsAvailable: ctx.payments !== null };
  });

  // The webhook needs the exact raw bytes for signature verification.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));

    scope.post('/api/payments/webhook', async (req, reply) => {
      noStore(reply);
      const adapter = ctx.payments;
      if (!adapter) throw errors.unavailable('payments_unavailable', 'Payments are not configured.');
      if (!Buffer.isBuffer(req.body)) throw errors.badRequest();

      let event;
      try {
        event = adapter.verifyAndParse(req.body, req.headers);
      } catch (err) {
        if (err instanceof WebhookVerificationError) {
          ctx.log.warn({ evt: 'security', kind: 'payment_webhook_rejected', reason: err.reason }, 'payment webhook rejected');
          await strike(ctx, req, 'payment_signature_failed', ipActor(ctx, req));
          const fails = await ctx.limiter.hit('payments:sigfail', { limit: 20, windowSec: 600 });
          if (fails.count === 21) await ctx.alerts.emit('payment_signature_failures', { failuresIn10Min: fails.count });
          throw errors.badRequest('Webhook rejected.');
        }
        throw err;
      }
      const outcome = await applyPaymentEvent(ctx.db, adapter.provider, event);
      ctx.log.info({ evt: 'payment_event', type: event.type, outcome }, 'payment event processed');
      return { received: true, outcome };
    });
  });
}
