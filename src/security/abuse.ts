import type { FastifyBaseLogger } from 'fastify';
import type { Limits } from '../config.js';
import type { Alerts } from '../ops/alerts.js';
import type { Limiter } from './limiter.js';

export type StrikeKind =
  | 'rate_limited'
  | 'quota_exceeded'
  | 'cooldown_ignored'
  | 'invalid_request'
  | 'auth_failed'
  | 'forbidden_access'
  | 'csrf_failed'
  | 'payment_signature_failed'
  | 'admin_auth_failed';

export type StrikeOutcome = 'ok' | 'cooldown' | 'revoke';

/**
 * Graduated responses to suspicious behaviour, keyed by a pseudonymous actor
 * key ("s:<subject>" for sessions, "ip:<hmac>" for pre-session endpoints).
 * Strikes -> temporary cooldown (escalating) -> session revocation.
 * Cooldowns keyed by IP only gate pre-session endpoints, so one person on a
 * shared or carrier-grade NAT IP cannot lock out everyone else's sessions.
 */
export class AbuseMonitor {
  constructor(
    private readonly limiter: Limiter,
    private readonly limits: Limits['abuse'],
    private readonly log: FastifyBaseLogger,
    private readonly alerts: Alerts,
  ) {}

  async cooldownRemaining(actorKey: string): Promise<number> {
    const ttl = await this.limiter.redis.ttl(`abuse:cooldown:${actorKey}`);
    return ttl > 0 ? ttl : 0;
  }

  async strike(actorKey: string, kind: StrikeKind, weight = 1): Promise<StrikeOutcome> {
    const l = this.limits;
    const res = await this.limiter.hit(`abuse:strikes:${actorKey}`, { limit: l.strikesBeforeRevoke, windowSec: l.strikeWindowSec }, weight);
    this.log.warn({ evt: 'security', kind, actor: actorKey, strikes: res.count }, 'security event');

    if (res.count >= l.strikesBeforeRevoke && actorKey.startsWith('s:')) {
      await this.alerts.emit('abuse_session_revoked', { strikes: res.count, lastKind: kind }, { dedupeKey: actorKey });
      return 'revoke';
    }
    const before = res.count - weight;
    const crossed = Math.floor(res.count / l.strikesBeforeCooldown) > Math.floor(before / l.strikesBeforeCooldown);
    if (res.count >= l.strikesBeforeCooldown && crossed) {
      const level = await this.limiter.redis.incr(`abuse:level:${actorKey}`);
      await this.limiter.redis.expire(`abuse:level:${actorKey}`, 86400);
      const duration = l.cooldownsSec[Math.min(level - 1, l.cooldownsSec.length - 1)]!;
      await this.limiter.redis.set(`abuse:cooldown:${actorKey}`, kind, 'EX', duration);
      this.log.warn({ evt: 'security', kind: 'cooldown_applied', actor: actorKey, level, durationSec: duration }, 'cooldown applied');
      return 'cooldown';
    }
    return 'ok';
  }
}
