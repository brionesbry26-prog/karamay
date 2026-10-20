import { tx, type Db } from '../db/pool.js';
import type { PaymentEvent } from './adapter.js';

export type ProcessOutcome = 'applied' | 'duplicate' | 'stale' | 'unknown_subject' | 'invalid';

/**
 * Applies a verified payment event to the entitlements table.
 * - Idempotent: each (provider, event id) is processed at most once.
 * - Order-safe: an event older than the last applied one is recorded but ignored,
 *   so a delayed "activated" cannot undo a later refund or cancellation.
 * - Only registered accounts can hold entitlements.
 */
export async function applyPaymentEvent(db: Db, provider: string, ev: PaymentEvent): Promise<ProcessOutcome> {
  return tx(db, async (c) => {
    const inserted = await c.query(
      `INSERT INTO payment_events (provider, event_id, event_type, event_created_at, outcome)
       VALUES ($1, $2, $3, $4, 'processing')
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING event_id`,
      [provider, ev.id, ev.type, ev.createdAt],
    );
    if (inserted.rowCount === 0) return 'duplicate';

    const finish = async (outcome: ProcessOutcome) => {
      await c.query('UPDATE payment_events SET outcome = $3 WHERE provider = $1 AND event_id = $2', [provider, ev.id, outcome]);
      return outcome;
    };

    const subject = await c.query<{ kind: string }>('SELECT kind FROM subjects WHERE id = $1 FOR UPDATE', [ev.subjectId]);
    if (subject.rows[0]?.kind !== 'user') return finish('unknown_subject');

    const current = await c.query<{ last_event_at: Date; provider_subscription_id: string }>(
      'SELECT last_event_at, provider_subscription_id FROM entitlements WHERE subject_id = $1 FOR UPDATE',
      [ev.subjectId],
    );
    const existing = current.rows[0];
    if (existing && existing.last_event_at.getTime() > ev.createdAt.getTime()) return finish('stale');

    let status: string;
    switch (ev.type) {
      case 'subscription.activated':
      case 'subscription.renewed':
        if (!ev.periodEnd) return finish('invalid');
        status = 'active';
        break;
      case 'subscription.canceled':
        status = 'canceled'; // keeps access until the paid period ends
        break;
      case 'subscription.expired':
        status = 'expired';
        break;
      case 'payment.refunded':
        status = 'refunded'; // access ends immediately
        break;
      case 'payment.failed':
        status = 'past_due';
        break;
    }

    if (!existing) {
      if (status !== 'active') return finish('stale'); // nothing to cancel/refund yet
      await c.query(
        `INSERT INTO entitlements (subject_id, plan, status, provider, provider_subscription_id, current_period_end, last_event_at)
         VALUES ($1, 'premium', 'active', $2, $3, $4, $5)`,
        [ev.subjectId, provider, ev.subscriptionId, ev.periodEnd, ev.createdAt],
      );
    } else {
      await c.query(
        `UPDATE entitlements
            SET status = $2,
                current_period_end = COALESCE($3, current_period_end),
                provider_subscription_id = $4,
                last_event_at = $5,
                updated_at = now()
          WHERE subject_id = $1`,
        [ev.subjectId, status, ev.periodEnd, ev.subscriptionId, ev.createdAt],
      );
    }
    return finish('applied');
  });
}
