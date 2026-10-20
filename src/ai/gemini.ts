import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  type GenerateContentConfig,
  type GenerateContentResponse,
} from '@google/genai';
import type { AiConfig } from '../config.js';
import { AiProviderError, type AiProvider, type AiRequest, type AiResult } from './provider.js';

const BLOCKING_FINISH_REASONS = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.RECITATION,
]);

/**
 * Server-side Gemini adapter using the official @google/genai SDK.
 * - The API key is only ever read here, from server configuration.
 * - SDK-level retries are left disabled; bounded retries happen in AiService
 *   so that every attempt is budgeted.
 * - No tools / function calling are configured: model output is plain text and
 *   can never trigger an operation.
 */
export class GeminiProvider implements AiProvider {
  private readonly client: GoogleGenAI;
  readonly model: string;

  constructor(
    private readonly cfg: AiConfig,
    fetchImpl?: typeof fetch,
  ) {
    if (!cfg.apiKey || !cfg.model) throw new Error('Gemini provider requires GEMINI_API_KEY and GEMINI_MODEL');
    this.model = cfg.model;
    this.client = new GoogleGenAI({
      apiKey: cfg.apiKey,
      httpOptions: { timeout: cfg.timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
    });
  }

  async generate(req: AiRequest): Promise<AiResult> {
    const config: GenerateContentConfig = {
      systemInstruction: req.system,
      maxOutputTokens: req.maxOutputTokens,
      temperature: 0.7,
      candidateCount: 1,
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      ],
      ...(this.cfg.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: this.cfg.thinkingBudget } } : {}),
    };

    let res: GenerateContentResponse;
    try {
      res = await this.client.models.generateContent({
        model: this.model,
        contents: req.turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        config,
      });
    } catch (err) {
      throw classifyError(err);
    }
    return parseResponse(res);
  }
}

export function classifyError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  if (err instanceof ApiError) {
    const s = err.status;
    if (s === 429) return new AiProviderError('rate_limited', s);
    if (s === 401 || s === 403) return new AiProviderError('auth', s);
    if (s === 404) return new AiProviderError('model_not_found', s);
    if (s === 400) {
      // An invalid key is reported by the Gemini API as 400 API_KEY_INVALID.
      return /API_KEY_INVALID|API key not valid/i.test(err.message) ? new AiProviderError('auth', s) : new AiProviderError('bad_request', s);
    }
    if (s === 408 || s === 504) return new AiProviderError('timeout', s);
    if (s >= 500) return new AiProviderError('unavailable', s);
    return new AiProviderError('unknown', s);
  }
  const name = (err as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return new AiProviderError('timeout');
  if (err instanceof SyntaxError) return new AiProviderError('malformed_response');
  if (err instanceof TypeError) return new AiProviderError('unavailable'); // network failure from fetch
  return new AiProviderError('unknown');
}

export function parseResponse(res: GenerateContentResponse): AiResult {
  if (!res || typeof res !== 'object') throw new AiProviderError('malformed_response');
  const u = res.usageMetadata;
  const usage = u
    ? {
        inputTokens: nonNeg(u.promptTokenCount),
        outputTokens: nonNeg(u.candidatesTokenCount) + nonNeg(u.thoughtsTokenCount),
      }
    : null;

  if (res.promptFeedback?.blockReason) {
    return { text: null, blocked: 'prompt', finishReason: String(res.promptFeedback.blockReason), usage };
  }
  const candidate = res.candidates?.[0];
  if (!candidate) throw new AiProviderError('malformed_response');
  const finishReason = candidate.finishReason ? String(candidate.finishReason) : null;
  if (finishReason && BLOCKING_FINISH_REASONS.has(finishReason)) {
    return { text: null, blocked: 'response', finishReason, usage };
  }
  // Only visible text parts; never thought summaries.
  const text = (candidate.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text as string)
    .join('')
    .trim();
  return { text: text || null, blocked: null, finishReason, usage };
}

function nonNeg(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
