# Deployment guide

KARAMAY runs as one stateless Node.js container. It needs:

- **PostgreSQL 16+**, with TLS and encryption at rest provided by the database host
- **Redis 6.2+**, which is required whenever more than one instance runs and is always required in production
- an **HTTPS** reverse proxy or load balancer in front of the container

No hosting provider has been chosen yet. These steps work on any container platform, such as Cloud Run, Fly.io, Render or Railway, or Kubernetes. Use **separate development, staging and production projects**, each with its own database, Redis, Gemini key and secrets.

## 1. Environment variables

`.env.example` documents every variable. Production refuses to start when a required or unsafe value is detected (`src/config.ts`), and the error names the variable without printing its value.

| Variable | Production requirement |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_ORIGIN` | `https://your-domain` |
| `CORS_ORIGINS` | Empty unless a separate web origin calls the API. Never `*`. |
| `TRUST_PROXY_HOPS` | Number of proxies in front of the app, usually `1`. |
| `DATABASE_URL` | Runtime role (see §3), with `sslmode` handled by `DATABASE_SSL`. |
| `DATABASE_MIGRATION_URL` | Owner role, used only by the migration job. |
| `DATABASE_SSL` | `verify-full` (default), plus `DATABASE_SSL_CA` if the provider uses a private CA. |
| `REDIS_URL` | `rediss://` (TLS) with a password. |
| `IP_HASH_KEY` | `openssl rand -hex 32` |
| `DATA_ENCRYPTION_KEYS` | `1:$(openssl rand -base64 32)`. **Back this up separately from the database.** Losing it makes cloud journals unrecoverable. |
| `ADMIN_API_TOKEN` | `openssl rand -base64 48`, or leave empty to disable admin routes. |
| `AI_ENABLED` and `GEMINI_*`, `AI_BUDGET_*` | See §4. |
| `ALERT_WEBHOOK_URL` | HTTPS endpoint for ops alerts. |
| `MAILER` | `none` until a mail adapter exists. Accounts then stay disabled. |
| `PAYMENTS_PROVIDER` | `none` until a provider adapter exists. |

## 2. Secret management

- Store every secret in the platform's secret manager (e.g. Google Secret Manager, Fly secrets, Render environment groups). Never put one in the image, the repository, CI logs or `docker-compose.yml`.
- Grant the runtime service account read access only to its own environment's secrets.
- Enable GitHub secret scanning and push protection on the repository. CI also runs `npm run check:secrets`.
- To rotate a secret, see `docs/RUNBOOKS.md` §2.

## 3. Database setup (least privilege)

As a database administrator, create two roles. Neither may be a superuser or have BYPASSRLS:

```sql
CREATE ROLE karamay_owner LOGIN PASSWORD '<generated>' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE karamay_app   LOGIN PASSWORD '<generated>' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE DATABASE karamay OWNER karamay_owner;
REVOKE ALL ON DATABASE karamay FROM PUBLIC;
GRANT CONNECT ON DATABASE karamay TO karamay_app;
```

Then run migrations as a one-off job before each release:

```bash
DATABASE_MIGRATION_URL=... DATABASE_APP_ROLE=karamay_app npm run migrate:prod   # node dist/src/db/migrate.js
```

The migration takes an advisory lock, so concurrent deploys are safe, and grants the app role DML only. The app role cannot alter tables, disable row-level security or read `schema_migrations`. A test verifies this (`authz.test.ts`).

Turn on the provider's encryption at rest, automated backups with point-in-time recovery, and TLS-only connections.

## 4. Gemini configuration

1. Create a Google Cloud project for each environment and enable the Gemini API.
2. **Attach a Cloud Billing account (paid tier).** Under the Gemini API terms, unpaid-tier prompts and responses may be used to improve Google products and can be read by human reviewers. A wellness app must not send user content on the unpaid tier. Re-read the current terms at <https://ai.google.dev/gemini-api/terms> before launch.
3. Create an API key **restricted to the Generative Language API** and store it as `GEMINI_API_KEY` in the secret manager.
4. Choose a current, stable model from <https://ai.google.dev/gemini-api/docs/models> and set `GEMINI_MODEL`. Do not use a preview model in production. Third-party sources in October 2026 mention `gemini-3.8-flash` and `gemini-3.5-flash-lite`, but **these were not verified against Google's pages**.
5. Copy that model's paid-tier per-1M-token prices from <https://ai.google.dev/gemini-api/docs/pricing> into `GEMINI_PRICE_INPUT_USD_PER_MTOK` and `GEMINI_PRICE_OUTPUT_USD_PER_MTOK`. Thinking tokens are billed as output. If the model supports it, consider `GEMINI_THINKING_BUDGET=0` for short supportive replies.
6. Set `AI_BUDGET_DAILY_USD` and `AI_BUDGET_MONTHLY_USD`. These are the app's own **hard caps**: once the estimated spend reaches them, AI calls stop.
7. In addition, create a Google Cloud **budget alert** on the billing account. It is a second signal only: it can lag and does not cap spend.
8. Check the project's rate limits (<https://ai.google.dev/gemini-api/docs/rate-limits>) against `limits.ai.globalConcurrency`.
9. Set `AI_ENABLED=true`. Verify with one staging chat, then compare `/api/admin/ai/usage` with the billing report after 24 hours.

**Cost estimate with the default limits:** a typical turn uses about 1,500 input and 300 output tokens. At a price of P_in and P_out per 1M tokens, that is about (1500·P_in + 300·P_out)/10⁶ USD per turn. Multiply by the expected daily turns, capped by `limits.ai.perDay` × active users, to size `AI_BUDGET_DAILY_USD`. Re-tune after a week of real usage.

## 5. Rate limits and Redis

Every limit is in `DEFAULT_LIMITS` in `src/config.ts`. Override them per environment with `LIMITS_JSON`, which is deep-merged and validated at startup. Redis holds all counters, so every instance shares them. Use a managed Redis with TLS and AUTH. If Redis is unreachable, AI requests fail closed and the rest of the app reports not-ready (`/api/ready`).

## 6. Domain, HTTPS, CORS

- Terminate TLS at the load balancer and redirect HTTP to HTTPS. The app sends HSTS in production.
- Serve the web client and the API from the same origin (default). That makes CORS unnecessary and keeps cookies `SameSite=Strict`.
- Set `TRUST_PROXY_HOPS` correctly. Too high lets clients spoof their IP and dodge per-IP limits.

## 7. Monitoring and alerts

- **Logs:** JSON on stdout. Ship them to the platform's logging with **30-day retention**. They contain no bodies or private text. IPs appear only as HMACs, and request ids are random.
- **Alerts:** `ALERT_WEBHOOK_URL` receives content-free JSON for:
  - budget thresholds and exhaustion
  - traffic anomalies
  - Gemini auth, model or error spikes
  - kill-switch changes
  - abuse revocations
  - payment signature failures
  - admin auth failures
- **Health:** `/api/health` (liveness) and `/api/ready` (DB and Redis).
- **Usage report:** `GET /api/admin/ai/usage?days=7` with the admin token. Do not expose it publicly (see `RUNBOOKS.md`).

## 8. Scheduled jobs

Run `npm run purge:prod` daily (`node dist/src/ops/purge-cli.js`) as a cron or scheduled job with the runtime credentials. It enforces retention by deleting:
- expired sessions and tokens
- guests inactive for 30 days, with their data
- usage aggregates older than about 13 months
- payment events and audit log entries past retention

## 9. Build, deploy, rollback

```bash
docker build -t karamay:$(git rev-parse --short HEAD) .
# 1. run migrations (one-off job, owner credentials)
# 2. deploy the new image with runtime credentials
# 3. verify /api/ready, one chat in staging, /api/admin/ai/usage
```

Rollback means redeploying the previous image tag. Migrations are additive. Write any destructive migration as a separate, later release so the previous image keeps working. Note that the Dockerfile has not yet been built in CI (see `TESTING.md`).

## 10. Email delivery (blocker for accounts)

`src/lib/mailer.ts` defines the `Mailer` interface. To enable accounts in production:
1. Implement an adapter for your chosen provider (SMTP or an HTTP email API).
2. Add it to the `MAILER` enum and to `buildApp`.
3. Configure SPF, DKIM and DMARC for the sending domain.
4. Write email templates that tell recipients to ignore links they did not request.

## 11. Payments (blocker for premium)

Implement `PaymentAdapter` (`src/payments/adapter.ts`) for the chosen provider, for example PayMongo, Stripe, Google Play Billing or App Store Server Notifications. The adapter must:
- verify the provider's signature over the raw body
- enforce a timestamp or replay window
- reject events whose live/test mode does not match the environment
- map provider events to `PaymentEvent`, carrying our subject id via the provider's client reference field set at checkout

Then copy `test/payments.test.ts` for the new adapter. Keep test and live keys in different environments.

## 12. Local development

```bash
docker compose up -d                 # postgres + redis on localhost (or use local installs)
cp .env.example .env                 # then set DATABASE_URL to karamay_app / app_local_dev_only, etc.
npm ci
npm run migrate                      # uses DATABASE_MIGRATION_URL + DATABASE_APP_ROLE
npm run dev                          # http://localhost:8080
```

For local accounts, set `MAILER=dev-outbox`. Mail then goes to an in-memory outbox (used by tests) and is never logged.
