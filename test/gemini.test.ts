import { describe, expect, it } from 'vitest';
import { GeminiProvider } from '../src/ai/gemini.js';
import { AiProviderError } from '../src/ai/provider.js';
import { loadConfig } from '../src/config.js';
import { testEnv } from './env.js';

/**
 * Exercises the real @google/genai SDK path with an injected fetch, so request
 * shape, error classification and response parsing are tested without network.
 */
const cfg = loadConfig(testEnv({ GEMINI_TIMEOUT_MS: '1000' })).ai;
const KEY = cfg.apiKey!;

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function providerWith(respond: (call: number) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
    return respond(calls.length);
  }) as typeof fetch;
  return { provider: new GeminiProvider(cfg, fetchImpl), calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const req = { system: 'SYSTEM RULES', turns: [{ role: 'user' as const, text: 'Kumusta?' }], maxOutputTokens: 300 };

describe('GeminiProvider request shape', () => {
  it('sends system instructions separately, sets limits and safety settings, and enables no tools', async () => {
    const { provider, calls } = providerWith(() =>
      json(200, {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Mabuti naman.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 7, thoughtsTokenCount: 5 },
      }),
    );
    const res = await provider.generate(req);
    expect(res).toEqual({ text: 'Mabuti naman.', blocked: null, finishReason: 'STOP', usage: { inputTokens: 42, outputTokens: 12 } });
    const call = calls[0]!;
    expect(call.url).toContain(`models/${cfg.model}:generateContent`);
    expect(call.url).not.toContain(KEY); // key travels in a header, not the URL
    expect(call.headers.get('x-goog-api-key')).toBe(KEY);
    expect(JSON.stringify(call.body.contents)).not.toContain('SYSTEM RULES');
    expect(JSON.stringify(call.body.systemInstruction)).toContain('SYSTEM RULES');
    const gen = call.body.generationConfig as Record<string, unknown>;
    expect(gen.maxOutputTokens).toBe(300);
    expect(call.body.tools).toBeUndefined();
    expect(call.body.toolConfig).toBeUndefined();
    expect((call.body.safetySettings as unknown[]).length).toBe(4);
  });
});

describe('GeminiProvider error handling', () => {
  it.each([
    [429, 'rate_limited', true],
    [500, 'unavailable', true],
    [503, 'unavailable', true],
    [401, 'auth', false],
    [403, 'auth', false],
    [404, 'model_not_found', false],
  ])('HTTP %i -> %s (retryable=%s)', async (status, kind, retryable) => {
    const { provider } = providerWith(() => json(status, { error: { code: status, message: `upstream says key ${KEY} is bad`, status: 'X' } }));
    const err = await provider.generate(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).kind).toBe(kind);
    expect((err as AiProviderError).retryable).toBe(retryable);
    expect((err as Error).message).not.toContain(KEY);
  });

  it('classifies an invalid API key reported as HTTP 400', async () => {
    const { provider } = providerWith(() => json(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }));
    const err = (await provider.generate(req).catch((e: unknown) => e)) as AiProviderError;
    expect(err.kind).toBe('auth');
  });

  it('makes exactly one HTTP attempt per call (no hidden SDK retries)', async () => {
    const { provider, calls } = providerWith(() => json(503, { error: { code: 503, message: 'overloaded' } }));
    await provider.generate(req).catch(() => {});
    expect(calls).toHaveLength(1);
  });

  it('times out instead of hanging', async () => {
    // A fetch that never answers on its own; it only rejects when the SDK's timeout signal fires.
    const hanging = new GeminiProvider(cfg, ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as typeof fetch);
    const started = Date.now();
    const err = (await hanging.generate(req).catch((e: unknown) => e)) as AiProviderError;
    expect(err.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('flags malformed responses', async () => {
    const { provider } = providerWith(() => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'application/json' } }));
    const err = (await provider.generate(req).catch((e: unknown) => e)) as AiProviderError;
    expect(err).toBeInstanceOf(AiProviderError);
    expect(['malformed_response', 'unknown']).toContain(err.kind);
  });

  it('treats a response with no candidates as malformed', async () => {
    const { provider } = providerWith(() => json(200, { usageMetadata: { promptTokenCount: 3 } }));
    const err = (await provider.generate(req).catch((e: unknown) => e)) as AiProviderError;
    expect(err.kind).toBe('malformed_response');
  });
});

describe('GeminiProvider safety blocks', () => {
  it('reports prompt-level blocks', async () => {
    const { provider } = providerWith(() => json(200, { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 9 } }));
    const res = await provider.generate(req);
    expect(res.blocked).toBe('prompt');
    expect(res.text).toBeNull();
    expect(res.usage).toEqual({ inputTokens: 9, outputTokens: 0 });
  });

  it('reports response-level blocks and drops partial text', async () => {
    const { provider } = providerWith(() =>
      json(200, { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } }),
    );
    const res = await provider.generate(req);
    expect(res.blocked).toBe('response');
    expect(res.text).toBeNull();
  });

  it('never returns thought parts as reply text', async () => {
    const { provider } = providerWith(() =>
      json(200, {
        candidates: [{ content: { parts: [{ text: 'internal reasoning', thought: true }, { text: 'Visible reply' }] }, finishReason: 'STOP' }],
      }),
    );
    expect((await provider.generate(req)).text).toBe('Visible reply');
  });
});
