import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { AppError, errors } from '../lib/errors.js';
import type { Alerts } from '../ops/alerts.js';
import type { Flags } from '../ops/flags.js';
import { crisisResources, guessLanguage, safetyReply, assessRisk, type RiskAssessment } from '../safety/crisis.js';
import { manilaPeriods, type Limiter } from '../security/limiter.js';
import type { Principal, Tier } from '../security/sessions.js';
import { fallbackReply, systemInstruction, type ChatMode } from './prompts.js';
import { AiProviderError, type AiProvider, type AiResult, type AiTurn } from './provider.js';
import type { UsageRecorder } from './usage.js';

export interface ChatInput {
  mode: ChatMode;
  message: string;
  history: AiTurn[];
}

export interface ChatResponse {
  reply: string;
  source: 'ai' | 'safety' | 'fallback';
  safety: { level: RiskAssessment['level']; categories: RiskAssessment['categories']; showResources: boolean };
  quota: QuotaStatus | null;
}

export interface QuotaStatus {
  limitToday: number;
  usedToday: number;
  remainingToday: number;
  resetAt: string;
}

/** Conservative token estimate (~2.5 chars per token covers Filipino/Taglish, which tokenises less efficiently than English). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 2.5);
}

export class AiService {
  constructor(
    private readonly cfg: Config,
    private readonly provider: AiProvider | null,
    private readonly limiter: Limiter,
    private readonly flags: Flags,
    private readonly usage: UsageRecorder,
    private readonly alerts: Alerts,
    private readonly log: FastifyBaseLogger,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private dayKey(p: Principal, day: string) {
    return `ai:day:${p.subjectId}:${day}`;
  }
  private monthKey(p: Principal, month: string) {
    return `ai:month:${p.subjectId}:${month}`;
  }

  async quota(p: Principal): Promise<QuotaStatus> {
    const per = manilaPeriods();
    const limit = this.cfg.limits.ai.perDay[p.tier];
    const used = Math.min(limit, await this.limiter.peek(this.dayKey(p, per.day)));
    return { limitToday: limit, usedToday: used, remainingToday: Math.max(0, limit - used), resetAt: per.nextDayIso };
  }

  /** Micro-USD cost for a token count at the configured prices. */
  costMicros(inputTokens: number, outputTokens: number): number {
    const ai = this.cfg.ai;
    return Math.ceil(inputTokens * ai.priceInputPerMTok + outputTokens * ai.priceOutputPerMTok);
  }

  /** Keeps only the most recent turns that fit the configured limits. */
  trimHistory(history: AiTurn[]): AiTurn[] {
    const { maxHistoryTurns, maxHistoryChars } = this.cfg.limits.ai;
    const out: AiTurn[] = [];
    let chars = 0;
    for (let i = history.length - 1; i >= 0 && out.length < maxHistoryTurns; i--) {
      const t = history[i]!;
      if (chars + t.text.length > maxHistoryChars) break;
      chars += t.text.length;
      out.unshift(t);
    }
    // Gemini expects the conversation to start with a user turn.
    while (out.length && out[0]!.role !== 'user') out.shift();
    return out;
  }

  private safetyResponse(risk: RiskAssessment, message: string, quota: QuotaStatus | null): ChatResponse {
    const level = risk.level === 'none' ? 'concern' : risk.level;
    return {
      reply: safetyReply(level, risk.categories, guessLanguage(message)),
      source: 'safety',
      safety: { level: risk.level, categories: risk.categories, showResources: true },
      quota,
    };
  }

  async chat(p: Principal, input: ChatInput): Promise<ChatResponse> {
    const message = input.message.trim();
    const risk = assessRisk(message);
    const lang = guessLanguage(message);

    // Layer 1: explicit, immediate risk never waits on (or is blocked by) the AI provider or quotas.
    if (risk.level === 'urgent') {
      this.log.warn({ evt: 'safety', level: 'urgent', categories: risk.categories }, 'urgent risk response served');
      return this.safetyResponse(risk, message, null);
    }

    const status = await this.flags.aiStatus();
    if (!status.available) {
      if (risk.level === 'concern') return this.safetyResponse(risk, message, null);
      throw errors.unavailable('ai_unavailable', 'The AI companion is resting right now. Your journal, mood check-in and grounding tools still work.', {
        reason: status.reason === 'kill_switch' ? 'paused' : 'unavailable',
      });
    }
    if (!this.provider) throw errors.unavailable('ai_unavailable', 'The AI companion is not available.');

    // Layer 2: per-subject quotas (minute / day / month) by tier.
    const limits = this.cfg.limits.ai;
    const per = manilaPeriods();
    const minute = await this.limiter.hit(`ai:min:${p.subjectId}`, { limit: limits.perMinute[p.tier], windowSec: 60 });
    if (!minute.allowed) {
      if (risk.level === 'concern') return this.safetyResponse(risk, message, null);
      throw new AppError(429, 'rate_limited', 'You are sending messages very quickly. Please take a breath and try again in a moment.', { retryAfterSec: minute.retryAfterSec }, minute.retryAfterSec);
    }
    const dayKey = this.dayKey(p, per.day);
    const monthKey = this.monthKey(p, per.month);
    const day = await this.limiter.hitPeriod(dayKey, limits.perDay[p.tier], per.secondsToNextDay + 3600);
    const month = await this.limiter.hitPeriod(monthKey, limits.perMonth[p.tier], 32 * 86400);
    if (!day.allowed || !month.allowed) {
      await this.limiter.refund(dayKey);
      await this.limiter.refund(monthKey);
      const quota = await this.quota(p);
      if (risk.level === 'concern') return this.safetyResponse(risk, message, quota);
      throw new AppError(
        429,
        'quota_exceeded',
        lang === 'fil'
          ? 'Naabot mo na ang libreng limit ng AI para sa ngayon. Bukas na ulit puwede. Habang hinihintay, bukas pa rin ang journal, mood check-in at grounding exercises.'
          : "You've reached today's AI message limit. It resets tomorrow. Your journal, mood check-in and grounding exercises are still available.",
        { resetAt: quota.resetAt, scope: day.allowed ? 'month' : 'day' },
        Math.max(1, Math.ceil((Date.parse(quota.resetAt) - Date.now()) / 1000)),
      );
    }
    const refundQuota = async () => {
      await this.limiter.refund(dayKey).catch(() => {});
      await this.limiter.refund(monthKey).catch(() => {});
    };

    // Layer 3: concurrency (per subject and global).
    const slotTtl = this.cfg.ai.timeoutMs * (this.cfg.ai.maxRetries + 1) + 5000;
    const subjectSlot = `ai:${p.subjectId}`;
    if (!(await this.limiter.acquire(subjectSlot, limits.concurrentPerSubject[p.tier], slotTtl))) {
      await refundQuota();
      throw new AppError(429, 'busy', 'Still working on your previous message. Please wait for it to finish.', { retryAfterSec: 3 }, 3);
    }
    let globalHeld = false;
    try {
      if (!(await this.limiter.acquire('ai:global', limits.globalConcurrency, slotTtl))) {
        await refundQuota();
        throw new AppError(429, 'busy', 'KARAMAY is very busy right now. Please try again in a few seconds.', { retryAfterSec: 5 }, 5);
      }
      globalHeld = true;
      return await this.callWithBudget(p, input, message, risk, lang, refundQuota, per);
    } finally {
      await this.limiter.release(subjectSlot).catch(() => {});
      if (globalHeld) await this.limiter.release('ai:global').catch(() => {});
    }
  }

  private async callWithBudget(
    p: Principal,
    input: ChatInput,
    message: string,
    risk: RiskAssessment,
    lang: 'fil' | 'en',
    refundQuota: () => Promise<void>,
    per: ReturnType<typeof manilaPeriods>,
  ): Promise<ChatResponse> {
    const ai = this.cfg.ai;
    const provider = this.provider!;
    const system = systemInstruction(input.mode, { concern: risk.level === 'concern' });
    const turns: AiTurn[] = [...this.trimHistory(input.history), { role: 'user', text: message }];
    const inputChars = system.length + turns.reduce((n, t) => n + t.text.length, 0);
    const estInput = estimateTokens(inputChars);
    const attempts = ai.maxRetries + 1;
    // Reserve the worst case for one attempt; each retry re-reserves.
    const reserveMicros = this.costMicros(estInput, ai.maxOutputTokens + ai.thinkingReserveTokens);
    const budget = { dayLimitMicros: Math.floor(ai.budgetDailyUsd * 1e6), monthLimitMicros: Math.floor(ai.budgetMonthlyUsd * 1e6) };

    await this.trackTraffic();

    let lastErr: AiProviderError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const reserved = await this.limiter.budgetReserve({ dayKey: `d:${per.day}`, monthKey: `m:${per.month}`, reserveMicros, ...budget });
      if (!reserved.ok) {
        await refundQuota();
        await this.alerts.emit(
          'ai_budget_exhausted',
          { dayUsd: reserved.dayMicros / 1e6, monthUsd: reserved.monthMicros / 1e6, dayLimitUsd: ai.budgetDailyUsd, monthLimitUsd: ai.budgetMonthlyUsd },
          { dedupeKey: per.day, dedupeSec: 3600 },
        );
        await this.usage.record({ day: per.day, model: provider.model, feature: 'chat', tier: p.tier, outcome: 'blocked', inputTokens: 0, outputTokens: 0, costMicros: 0 }).catch(() => {});
        if (risk.level === 'concern') return this.safetyResponse(risk, message, null);
        throw errors.unavailable('ai_budget_paused', 'The AI companion is paused for now to keep KARAMAY sustainable. Your journal and wellness tools still work.');
      }

      let result: AiResult;
      try {
        result = await provider.generate({ system, turns, maxOutputTokens: ai.maxOutputTokens });
      } catch (e) {
        const err = e instanceof AiProviderError ? e : new AiProviderError('unknown');
        lastErr = err;
        // A timed-out call may still be billed, so its reservation is kept; other failures are released.
        if (err.kind !== 'timeout') await this.settle(per, -reserveMicros);
        await this.onProviderError(err, p.tier, per.day);
        if (err.retryable && attempt < attempts) {
          await this.sleep(Math.min(4000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
          continue;
        }
        break;
      }

      const usage = result.usage;
      const actual = usage ? this.costMicros(usage.inputTokens, usage.outputTokens) : reserveMicros;
      await this.settle(per, actual - reserveMicros);
      const blocked = result.blocked !== null || !result.text;
      await this.usage
        .record({
          day: per.day,
          model: provider.model,
          feature: 'chat',
          tier: p.tier,
          outcome: blocked ? 'blocked' : 'ok',
          inputTokens: usage?.inputTokens ?? estInput,
          outputTokens: usage?.outputTokens ?? ai.maxOutputTokens,
          costMicros: actual,
        })
        .catch((err: Error) => this.log.error({ evt: 'usage_record_failed', err: err.message }, 'usage record failed'));

      const quota = await this.quota(p);
      if (blocked) {
        if (risk.level === 'concern') return this.safetyResponse(risk, message, quota);
        return { reply: fallbackReply(lang), source: 'fallback', safety: { level: risk.level, categories: risk.categories, showResources: false }, quota };
      }
      return {
        reply: result.text!.slice(0, 4000),
        source: 'ai',
        safety: { level: risk.level, categories: risk.categories, showResources: risk.level !== 'none' },
        quota,
      };
    }

    // All attempts failed: the user did not get an AI reply, so their quota is returned.
    await refundQuota();
    if (risk.level === 'concern') return this.safetyResponse(risk, message, null);
    const kind = lastErr?.kind ?? 'unknown';
    if (kind === 'timeout') {
      throw errors.unavailable('ai_timeout', 'The AI companion took too long to answer. Please try again.', { retryable: true });
    }
    throw errors.unavailable('ai_unavailable', 'The AI companion is having trouble right now. Please try again later. Your journal and wellness tools still work.', {
      retryable: kind === 'rate_limited' || kind === 'unavailable',
    });
  }

  private async settle(per: ReturnType<typeof manilaPeriods>, deltaMicros: number) {
    const ai = this.cfg.ai;
    const spent = await this.limiter.budgetSettle(`d:${per.day}`, `m:${per.month}`, deltaMicros);
    const checks: Array<['day' | 'month', number, number, string]> = [
      ['day', spent.dayMicros, ai.budgetDailyUsd * 1e6, per.day],
      ['month', spent.monthMicros, ai.budgetMonthlyUsd * 1e6, per.month],
    ];
    for (const [period, micros, limit, periodKey] of checks) {
      if (limit <= 0) continue;
      const pct = (micros / limit) * 100;
      for (const t of ai.alertThresholds) {
        if (pct >= t) {
          await this.alerts.emit(
            'ai_budget_threshold',
            { period, thresholdPct: t, spentUsd: Math.round(micros) / 1e6, limitUsd: limit / 1e6 },
            { dedupeKey: `${period}:${periodKey}:${t}`, dedupeSec: period === 'day' ? 2 * 86400 : 40 * 86400 },
          );
        }
      }
    }
  }

  private async trackTraffic() {
    const threshold = this.cfg.limits.ai.anomalyRequestsPerMinute;
    const res = await this.limiter.hit('ai:global:rpm', { limit: threshold, windowSec: 60 });
    if (res.count === threshold + 1) {
      await this.alerts.emit('ai_traffic_anomaly', { requestsPerMinute: res.count, threshold }, { dedupeSec: 600 });
    }
  }

  private async onProviderError(err: AiProviderError, tier: Tier, day: string) {
    this.log.error({ evt: 'ai_provider_error', kind: err.kind, status: err.status }, 'ai provider error');
    await this.usage
      .record({ day, model: this.provider!.model, feature: 'chat', tier, outcome: 'error', inputTokens: 0, outputTokens: 0, costMicros: 0 })
      .catch(() => {});
    if (err.kind === 'auth') await this.alerts.emit('ai_provider_auth_failure', { status: err.status ?? 0 }, { dedupeSec: 600 });
    if (err.kind === 'model_not_found') await this.alerts.emit('ai_model_unavailable', { status: err.status ?? 0 }, { dedupeSec: 600 });
    const errs = await this.limiter.hit('ai:errors:5min', { limit: 20, windowSec: 300 });
    if (errs.count === 21) await this.alerts.emit('ai_provider_errors', { errorsIn5Min: errs.count }, { dedupeSec: 900 });
  }

  resources() {
    return crisisResources();
  }
}
