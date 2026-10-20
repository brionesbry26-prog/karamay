import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Provider-neutral payment event. A real provider adapter (PayMongo, Stripe,
 * Google Play, App Store, ...) must verify the provider's signature scheme and
 * translate its events into this shape. None is implemented yet — choosing and
 * configuring a provider is an open launch decision (docs/LAUNCH_CHECKLIST.md).
 */
export type PaymentEventType =
  | 'subscription.activated'
  | 'subscription.renewed'
  | 'subscription.canceled'
  | 'subscription.expired'
  | 'payment.refunded'
  | 'payment.failed';

export interface PaymentEvent {
  id: string;
  type: PaymentEventType;
  createdAt: Date;
  subjectId: string;
  subscriptionId: string;
  periodEnd: Date | null;
  livemode: boolean;
}

export class WebhookVerificationError extends Error {
  constructor(public readonly reason: 'missing_signature' | 'bad_signature' | 'stale_timestamp' | 'malformed' | 'mode_mismatch') {
    super(`webhook rejected: ${reason}`);
  }
}

export interface PaymentAdapter {
  readonly provider: string;
  verifyAndParse(raw: Buffer, headers: Record<string, string | string[] | undefined>, now?: Date): PaymentEvent;
}

const testPayload = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(['subscription.activated', 'subscription.renewed', 'subscription.canceled', 'subscription.expired', 'payment.refunded', 'payment.failed']),
  created: z.number().int().positive(),
  livemode: z.boolean(),
  data: z.object({
    subject_id: z.uuid(),
    subscription_id: z.string().min(1).max(200),
    period_end: z.number().int().positive().nullable().optional(),
  }),
});

/**
 * Test-only adapter (refused in production by config). Signature header:
 *   x-karamay-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
 * This mirrors the timestamped-HMAC scheme most payment providers use, so the
 * idempotency/replay/order logic is exercised exactly as it will be in production.
 */
export class TestHmacAdapter implements PaymentAdapter {
  readonly provider = 'test-hmac';

  constructor(
    private readonly secret: string,
    private readonly toleranceSec: number,
    private readonly expectLive = false,
  ) {}

  static sign(secret: string, raw: string, t: number): string {
    const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    return `t=${t},v1=${v1}`;
  }

  verifyAndParse(raw: Buffer, headers: Record<string, string | string[] | undefined>, now = new Date()): PaymentEvent {
    const header = headers['x-karamay-signature'];
    if (typeof header !== 'string' || !header) throw new WebhookVerificationError('missing_signature');
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=', 2) as [string, string]));
    const t = Number(parts.t);
    const sig = parts.v1;
    if (!Number.isInteger(t) || !sig || !/^[0-9a-f]{64}$/.test(sig)) throw new WebhookVerificationError('bad_signature');

    const expected = createHmac('sha256', this.secret).update(`${t}.`).update(raw).digest();
    const given = Buffer.from(sig, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookVerificationError('bad_signature');
    // Replay window: a captured, validly signed request cannot be re-sent later.
    if (Math.abs(now.getTime() / 1000 - t) > this.toleranceSec) throw new WebhookVerificationError('stale_timestamp');

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new WebhookVerificationError('malformed');
    }
    const p = testPayload.safeParse(json);
    if (!p.success) throw new WebhookVerificationError('malformed');
    if (p.data.livemode !== this.expectLive) throw new WebhookVerificationError('mode_mismatch');
    return {
      id: p.data.id,
      type: p.data.type,
      createdAt: new Date(p.data.created * 1000),
      subjectId: p.data.data.subject_id,
      subscriptionId: p.data.data.subscription_id,
      periodEnd: p.data.data.period_end ? new Date(p.data.data.period_end * 1000) : null,
      livemode: p.data.livemode,
    };
  }
}
