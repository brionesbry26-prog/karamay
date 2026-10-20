import type { Db } from '../db/pool.js';
import type { Tier } from '../security/sessions.js';

export interface UsageRecord {
  day: string;
  model: string;
  feature: string;
  tier: Tier;
  outcome: 'ok' | 'blocked' | 'error';
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

/** Aggregated, content-free usage accounting by day, model, feature and tier. */
export class UsageRecorder {
  constructor(private readonly db: Db) {}

  async record(r: UsageRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_usage_daily (day, model, feature, tier, requests, blocked, errors, input_tokens, output_tokens, cost_micros)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9)
       ON CONFLICT (day, model, feature, tier) DO UPDATE SET
         requests = ai_usage_daily.requests + 1,
         blocked = ai_usage_daily.blocked + EXCLUDED.blocked,
         errors = ai_usage_daily.errors + EXCLUDED.errors,
         input_tokens = ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
         output_tokens = ai_usage_daily.output_tokens + EXCLUDED.output_tokens,
         cost_micros = ai_usage_daily.cost_micros + EXCLUDED.cost_micros`,
      [
        r.day,
        r.model,
        r.feature,
        r.tier,
        r.outcome === 'blocked' ? 1 : 0,
        r.outcome === 'error' ? 1 : 0,
        r.inputTokens,
        r.outputTokens,
        r.costMicros,
      ],
    );
  }

  async report(days: number) {
    const { rows } = await this.db.query(
      `SELECT day::text, model, feature, tier, requests, blocked, errors,
              input_tokens::text, output_tokens::text, cost_micros::text
         FROM ai_usage_daily
        WHERE day >= (now() AT TIME ZONE 'Asia/Manila')::date - $1::int
        ORDER BY day DESC, model, feature, tier`,
      [days],
    );
    return rows.map((r) => ({
      day: r.day as string,
      model: r.model as string,
      feature: r.feature as string,
      tier: r.tier as string,
      requests: Number(r.requests),
      blocked: Number(r.blocked),
      errors: Number(r.errors),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      estimatedCostUsd: Number(r.cost_micros) / 1e6,
    }));
  }
}
