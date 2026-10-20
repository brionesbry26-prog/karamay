import type { FastifyBaseLogger } from 'fastify';
import type { RedisClient } from '../lib/redis.js';

export type AlertKind =
  | 'ai_budget_threshold'
  | 'ai_budget_exhausted'
  | 'ai_traffic_anomaly'
  | 'ai_provider_auth_failure'
  | 'ai_model_unavailable'
  | 'ai_provider_errors'
  | 'ai_kill_switch_changed'
  | 'abuse_session_revoked'
  | 'payment_signature_failures'
  | 'admin_auth_failures';

/**
 * Operational alerts. Payloads contain only numbers and short codes — never
 * user content, identifiers of private records, secrets or tokens.
 * Each (kind, dedupeKey) fires at most once per dedupe window.
 */
export class Alerts {
  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly redis: RedisClient,
    private readonly webhookUrl: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async emit(kind: AlertKind, data: Record<string, string | number | boolean>, opts: { dedupeKey?: string; dedupeSec?: number } = {}) {
    const dedupe = `alert:${kind}:${opts.dedupeKey ?? 'default'}`;
    const first = await this.redis.set(dedupe, '1', 'EX', opts.dedupeSec ?? 900, 'NX').catch(() => 'OK');
    if (first !== 'OK') return;
    this.log.warn({ evt: 'ops_alert', alert: kind, ...data }, `ops alert: ${kind}`);
    if (!this.webhookUrl) return;
    try {
      await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'karamay', alert: kind, at: new Date().toISOString(), ...data }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      this.log.error({ evt: 'ops_alert_delivery_failed', alert: kind }, 'alert webhook delivery failed');
    }
  }
}
