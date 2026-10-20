import type { Limits } from '../config.js';
import type { Db } from '../db/pool.js';

/**
 * Enforces retention rules. Run daily (see docs/RUNBOOKS.md). Deleting an
 * inactive guest cascades to its sessions, journal and mood rows.
 */
export async function purgeExpired(db: Db, r: Limits['retention']) {
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rowCount ?? 0;
  return {
    sessions: await q("DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'"),
    authTokens: await q("DELETE FROM auth_tokens WHERE expires_at < now() - interval '1 day'"),
    inactiveGuests: await q("DELETE FROM subjects WHERE kind = 'guest' AND last_active_at < now() - make_interval(days => $1)", [r.inactiveGuestDays]),
    usage: await q('DELETE FROM ai_usage_daily WHERE day < current_date - $1::int', [r.usageAggregateDays]),
    paymentEvents: await q('DELETE FROM payment_events WHERE received_at < now() - make_interval(days => $1)', [r.paymentEventDays]),
    auditLog: await q('DELETE FROM audit_log WHERE at < now() - make_interval(days => $1)', [r.auditLogDays]),
  };
}
