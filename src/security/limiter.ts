import type { RedisClient } from '../lib/redis.js';

/**
 * Shared, Redis-backed counters. All instances of the API see the same state,
 * so quotas cannot be bypassed by spreading requests over several servers.
 */

export interface Window {
  limit: number;
  windowSec: number;
}

export interface HitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfterSec: number;
}

const HIT_SCRIPT = `
local c = redis.call('INCRBY', KEYS[1], ARGV[2])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {c, ttl}
`;

const ACQUIRE_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if c > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
`;

const RELEASE_SCRIPT = `
local c = tonumber(redis.call('GET', KEYS[1]) or '0')
if c > 0 then return redis.call('DECR', KEYS[1]) end
return 0
`;

// Reserve against both the daily and monthly budget atomically.
const BUDGET_RESERVE_SCRIPT = `
local d = tonumber(redis.call('GET', KEYS[1]) or '0')
local m = tonumber(redis.call('GET', KEYS[2]) or '0')
local r = tonumber(ARGV[1])
if d + r > tonumber(ARGV[2]) or m + r > tonumber(ARGV[3]) then
  return {0, d, m}
end
redis.call('INCRBY', KEYS[1], r)
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('INCRBY', KEYS[2], r)
redis.call('EXPIRE', KEYS[2], ARGV[5])
return {1, d + r, m + r}
`;

interface LimiterCommands {
  kmyHit(key: string, windowMs: number, by: number): Promise<[number, number]>;
  kmyAcquire(key: string, limit: number, ttlMs: number): Promise<number>;
  kmyRelease(key: string): Promise<number>;
  kmyBudgetReserve(
    dayKey: string,
    monthKey: string,
    reserve: number,
    dayLimit: number,
    monthLimit: number,
    dayTtl: number,
    monthTtl: number,
  ): Promise<[number, number, number]>;
}

export class Limiter {
  private readonly r: RedisClient & LimiterCommands;

  constructor(redis: RedisClient) {
    redis.defineCommand('kmyHit', { numberOfKeys: 1, lua: HIT_SCRIPT });
    redis.defineCommand('kmyAcquire', { numberOfKeys: 1, lua: ACQUIRE_SCRIPT });
    redis.defineCommand('kmyRelease', { numberOfKeys: 1, lua: RELEASE_SCRIPT });
    redis.defineCommand('kmyBudgetReserve', { numberOfKeys: 2, lua: BUDGET_RESERVE_SCRIPT });
    this.r = redis as RedisClient & LimiterCommands;
  }

  get redis(): RedisClient {
    return this.r;
  }

  /** Fixed-window counter. The hit is counted even when it is over the limit. */
  async hit(key: string, w: Window, by = 1): Promise<HitResult> {
    const [count, ttlMs] = await this.r.kmyHit(`rl:${key}`, w.windowSec * 1000, by);
    return {
      allowed: count <= w.limit,
      count,
      remaining: Math.max(0, w.limit - count),
      retryAfterSec: Math.max(1, Math.ceil(ttlMs / 1000)),
    };
  }

  /** Counter keyed to an explicit period (e.g. a calendar day) with its own expiry. */
  async hitPeriod(key: string, limit: number, ttlSec: number, by = 1): Promise<HitResult> {
    return this.hit(key, { limit, windowSec: ttlSec }, by);
  }

  async peek(key: string): Promise<number> {
    return Number((await this.r.get(`rl:${key}`)) ?? 0);
  }

  async refund(key: string, by = 1): Promise<void> {
    await this.r.decrby(`rl:${key}`, by);
  }

  async reset(key: string): Promise<void> {
    await this.r.del(`rl:${key}`);
  }

  /** Concurrency slot. ttlMs bounds how long a crashed holder can keep a slot. */
  async acquire(key: string, limit: number, ttlMs: number): Promise<boolean> {
    return (await this.r.kmyAcquire(`cc:${key}`, limit, ttlMs)) === 1;
  }

  async release(key: string): Promise<void> {
    await this.r.kmyRelease(`cc:${key}`);
  }

  async budgetReserve(args: {
    dayKey: string;
    monthKey: string;
    reserveMicros: number;
    dayLimitMicros: number;
    monthLimitMicros: number;
  }): Promise<{ ok: boolean; dayMicros: number; monthMicros: number }> {
    const [ok, d, m] = await this.r.kmyBudgetReserve(
      `budget:{ai}:${args.dayKey}`,
      `budget:{ai}:${args.monthKey}`,
      args.reserveMicros,
      args.dayLimitMicros,
      args.monthLimitMicros,
      3 * 86400,
      40 * 86400,
    );
    return { ok: ok === 1, dayMicros: d, monthMicros: m };
  }

  /** Adjusts a reservation to the actual cost (delta may be negative). */
  async budgetSettle(dayKey: string, monthKey: string, deltaMicros: number): Promise<{ dayMicros: number; monthMicros: number }> {
    const p = this.r.multi();
    p.incrby(`budget:{ai}:${dayKey}`, deltaMicros);
    p.incrby(`budget:{ai}:${monthKey}`, deltaMicros);
    const res = (await p.exec()) ?? [];
    return { dayMicros: Number(res[0]?.[1] ?? 0), monthMicros: Number(res[1]?.[1] ?? 0) };
  }

  async budgetSpent(dayKey: string, monthKey: string): Promise<{ dayMicros: number; monthMicros: number }> {
    const [d, m] = await this.r.mget(`budget:{ai}:${dayKey}`, `budget:{ai}:${monthKey}`);
    return { dayMicros: Number(d ?? 0), monthMicros: Number(m ?? 0) };
  }
}

/** Calendar periods in Philippine time (UTC+8, no DST), which is when users experience "today". */
export function manilaPeriods(now = new Date()): { day: string; month: string; secondsToNextDay: number; nextDayIso: string } {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  const day = shifted.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const nextMidnightShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1);
  const nextMidnightUtc = nextMidnightShifted - 8 * 3600_000;
  return {
    day,
    month,
    secondsToNextDay: Math.max(1, Math.ceil((nextMidnightUtc - now.getTime()) / 1000)),
    nextDayIso: new Date(nextMidnightUtc).toISOString(),
  };
}
