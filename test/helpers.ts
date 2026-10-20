import { Writable } from 'node:stream';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildOptions } from '../src/app.js';
import type { AiProvider, AiRequest, AiResult } from '../src/ai/provider.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Ctx } from '../src/context.js';
import { DevOutboxMailer } from '../src/lib/mailer.js';
import { testEnv } from './env.js';

export class FakeProvider implements AiProvider {
  model = 'test-model';
  calls: AiRequest[] = [];
  handler: (req: AiRequest, n: number) => Promise<AiResult> | AiResult = () => okResult('Nandito ako para makinig.');

  async generate(req: AiRequest): Promise<AiResult> {
    this.calls.push(req);
    return this.handler(req, this.calls.length);
  }
}

export function okResult(text: string, inputTokens = 300, outputTokens = 80): AiResult {
  return { text, blocked: null, finishReason: 'STOP', usage: { inputTokens, outputTokens } };
}

export interface TestApp {
  app: FastifyInstance;
  ctx: Ctx;
  cfg: Config;
  ai: FakeProvider;
  mailer: DevOutboxMailer;
  logs: string[];
  close(): Promise<void>;
}

export async function makeApp(
  envOverrides: Record<string, string> = {},
  opts: Partial<BuildOptions> & { sharedEnv?: NodeJS.ProcessEnv } = {},
): Promise<TestApp> {
  const env = opts.sharedEnv ?? testEnv(envOverrides);
  const cfg = loadConfig({ ...env, ...envOverrides });
  const ai = new FakeProvider();
  const mailer = new DevOutboxMailer();
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const { app, ctx } = await buildApp({
    cfg: { ...cfg, logLevel: 'info' },
    aiProvider: ai,
    mailer,
    logStream,
    sleep: async () => {},
    ...opts,
  });
  await app.ready();
  return {
    app,
    ctx,
    cfg,
    ai,
    mailer,
    logs,
    close: async () => {
      await app.close();
    },
  };
}

/** Minimal browser-like client: keeps the session cookie and sends the CSRF token on writes. */
export class Client {
  cookie: string | null = null;
  csrf: string | null = null;
  bearer: string | null = null;

  constructor(
    private readonly app: FastifyInstance,
    private readonly origin = 'http://localhost:80',
  ) {}

  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    if (method !== 'GET') {
      h.origin ??= this.origin;
      if (this.csrf && !('x-csrf-token' in h)) h['x-csrf-token'] = this.csrf;
    }
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      headers: h,
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const c of cookies) {
      const [pair] = c.split(';');
      if (pair && /kmy_sid=/.test(pair)) this.cookie = pair.endsWith('=') ? null : pair;
    }
    const json = safeJson(res);
    if (json?.session?.csrfToken) this.csrf = json.session.csrfToken;
    if (json?.csrfToken) this.csrf = json.csrfToken;
    return res;
  }

  async guest(): Promise<this> {
    const res = await this.req('POST', '/api/session/guest', {});
    if (res.statusCode !== 201) throw new Error(`guest session failed: ${res.statusCode} ${res.body}`);
    return this;
  }

  async subjectId(ctx: Ctx): Promise<string> {
    const token = this.bearer ?? this.cookie!.split('=')[1]!;
    const p = await ctx.sessions.validate(token, this.bearer ? 'bearer' : 'cookie');
    return p!.subjectId;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeJson(res: LightMyRequestResponse): any {
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/** Registers, verifies and logs in a user. Returns a client holding the user session. */
export async function makeUser(t: TestApp, email: string, password = 'correct horse battery 9', opts: { from?: Client } = {}): Promise<Client> {
  const c = opts.from ?? new Client(t.app);
  const reg = await c.req('POST', '/api/auth/register', { email, password });
  if (reg.statusCode !== 202) throw new Error(`register failed ${reg.statusCode} ${reg.body}`);
  const link = t.mailer.lastFor(email, 'verify_registration')?.link;
  if (!link) throw new Error('no verification mail');
  const token = new URL(link.replace('/#/', '/')).searchParams.get('token')!;
  const v = await c.req('POST', '/api/auth/verify', { token });
  if (v.statusCode !== 200) throw new Error(`verify failed ${v.statusCode} ${v.body}`);
  const login = await c.req('POST', '/api/auth/login', { email, password });
  if (login.statusCode !== 200) throw new Error(`login failed ${login.statusCode} ${login.body}`);
  return c;
}

export function uniqueEmail(tag = 'u'): string {
  return `${tag}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.test`;
}
