# KARAMAY

An anonymous, privacy-conscious emotional wellness and journaling app for Filipino, English and Taglish speakers. You can talk with an AI companion (Google Gemini) in three modes:

- **Makikinig Muna:** listen first
- **Tulungan Mo Ako:** help me with practical steps
- **Kuwento Muna:** help me tell my story

There is also a private journal with guided prompts, mood check-ins, grounding exercises, and the **Pakawalan** letting-go ritual.

> KARAMAY is a wellness-support tool, not a substitute for professional mental health care or emergency services. In the Philippines, call **911** for emergencies or the **NCMH Crisis Hotline 1553** (24/7).

## Stack

| Layer | Choice |
|---|---|
| API | Node.js 22, TypeScript, Fastify 5 |
| Data | PostgreSQL 16 (row-level security, app-level AES-256-GCM for private text) |
| Shared state | Redis (rate limits, quotas, budget, kill switch) |
| AI | Google Gemini via the official `@google/genai` SDK, server-side only |
| Web client | Static HTML, CSS and ES modules in `web/` (no build step, strict CSP, self-hosted Montserrat) |
| Tests | Vitest against real Postgres and Redis; the Gemini SDK is exercised via injected fetch |

## Quick start

```bash
docker compose up -d                  # local Postgres + Redis (or use local installs)
cp .env.example .env                  # fill in local values
npm ci
npm run migrate
npm run dev                           # http://localhost:8080
```

To run the tests, see `docs/TESTING.md`. The short version: `npm run typecheck && npm test`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server with reload |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run migrate` / `migrate:prod` | Apply SQL migrations (owner role) and grant the runtime role |
| `npm run purge` / `purge:prod` | Daily retention job |
| `npm test` | Full test suite (needs Postgres and Redis) |
| `npm run audit` | Dependency audit (production dependencies) |
| `npm run check:secrets` | Fail if tracked files contain credential-like strings |

## Layout

```
src/
  app.ts               Fastify assembly: headers, identity, CSRF, cooldowns, errors, routes
  config.ts            Validated configuration and every tunable limit (DEFAULT_LIMITS)
  ai/                  Gemini provider, prompts, AiService (quotas, budget, retries), usage accounting
  safety/crisis.ts     Deterministic EN/FIL/Taglish risk check, safe templates, resources
  security/            Sessions, Redis limiter, abuse monitor
  services/            Private journal/mood data (owner-scoped, RLS, encrypted)
  payments/            Provider-neutral webhook verification and entitlements
  ops/                 Alerts, kill switch flags, retention purge
  routes/              HTTP routes
db/migrations/         SQL schema (RLS policies)
web/                   Client app; web/data/crisis-resources.json
test/                  Security and regression tests (30 required scenarios mapped in docs/TESTING.md)
docs/                  Audit, deployment, runbooks, privacy, AI safety, community, launch checklist
```

## Documentation

- [Security audit and threat model](docs/SECURITY_AUDIT.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Operational runbooks](docs/RUNBOOKS.md): kill switch, secret rotation, backups, breach response
- [Privacy and data flows](docs/PRIVACY.md)
- [AI safety](docs/AI_SAFETY.md)
- [Testing](docs/TESTING.md)
- [Community requirements](docs/COMMUNITY.md)
- [Launch checklist](docs/LAUNCH_CHECKLIST.md)
