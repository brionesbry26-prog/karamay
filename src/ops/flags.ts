import type { Config } from '../config.js';
import type { RedisClient } from '../lib/redis.js';

const AI_KILL_KEY = 'flag:ai_disabled';

/**
 * Runtime feature flags. AI_ENABLED=false in the environment is a hard off
 * switch; the Redis kill switch lets operators pause AI instantly across all
 * instances without a redeploy. If Redis cannot be read, AI fails closed.
 */
export class Flags {
  constructor(
    private readonly cfg: Config,
    private readonly redis: RedisClient,
  ) {}

  async aiStatus(): Promise<{ available: boolean; reason: 'ok' | 'not_configured' | 'kill_switch' | 'flag_store_unavailable' }> {
    if (!this.cfg.ai.enabled) return { available: false, reason: 'not_configured' };
    try {
      const killed = await this.redis.get(AI_KILL_KEY);
      return killed ? { available: false, reason: 'kill_switch' } : { available: true, reason: 'ok' };
    } catch {
      return { available: false, reason: 'flag_store_unavailable' };
    }
  }

  async setAiKillSwitch(disabled: boolean, reason: string): Promise<void> {
    if (disabled) await this.redis.set(AI_KILL_KEY, JSON.stringify({ reason, at: new Date().toISOString() }));
    else await this.redis.del(AI_KILL_KEY);
  }

  async aiKillSwitchState(): Promise<{ disabled: boolean; reason?: string; at?: string }> {
    const raw = await this.redis.get(AI_KILL_KEY);
    if (!raw) return { disabled: false };
    try {
      return { disabled: true, ...(JSON.parse(raw) as { reason?: string; at?: string }) };
    } catch {
      return { disabled: true };
    }
  }
}
