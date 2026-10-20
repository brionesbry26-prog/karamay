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

## Quick start (local)

Requirements: Node 22.12+, plus PostgreSQL 16 and Redis 7 (via Docker, or installed locally).

```bash
npm ci                 # installs dev dependencies too; NODE_ENV must not be "production"

# 1. Start Postgres + Redis. Docker creates the local roles and database automatically:
docker compose up -d
#    Without Docker, run as a Postgres superuser instead:  psql -U postgres -f db/local-init.sql

# 2. Configure (.env is git-ignored and loaded automatically by the npm scripts)
cp .env.example .env   # PowerShell: Copy-Item .env.example .env
#    then generate two secrets and paste the printed lines over the placeholders in .env:
npm run secrets

# 3. Create the schema, then start the app
npm run migrate
npm run dev            # open http://localhost:8080
```

What works out of the box: journal, mood, grounding, Pakawalan, Privacy Center, crisis page, and accounts. Account verification and reset links are printed in the terminal as `[dev-mail] ... link=...`; open that link in the browser.

**AI chat** stays off ("the AI companion is resting") until you add a Gemini key. To enable it, set these in `.env`, then restart `npm run dev`:

```
AI_ENABLED=true
GEMINI_API_KEY=<your key from Google AI Studio / Cloud console>
GEMINI_MODEL=<a current model id from ai.google.dev/gemini-api/docs/models>
GEMINI_PRICE_INPUT_USD_PER_MTOK=<price from ai.google.dev/gemini-api/docs/pricing>
GEMINI_PRICE_OUTPUT_USD_PER_MTOK=<price>
AI_BUDGET_DAILY_USD=1
AI_BUDGET_MONTHLY_USD=10
```

Use a billing-enabled (paid tier) project for anything beyond your own test messages; see `docs/PRIVACY.md`.

**Tests:** `npm run typecheck && npm test`. These need a Postgres superuser login to create a throwaway `karamay_test` database (default `postgres:postgres@localhost`; override with `TEST_SUPERUSER_URL`). See `docs/TESTING.md`.

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
