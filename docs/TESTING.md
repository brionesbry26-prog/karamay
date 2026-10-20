# Testing

## How to run

Requirements: Node 22, PostgreSQL 16 (with `pg_dump` and `pg_restore` for the backup test), and Redis 7.

```bash
# local services (or use docker compose up -d postgres redis)
export TEST_SUPERUSER_URL=postgres://postgres:<password>@localhost:5432/postgres   # default: postgres:postgres
export TEST_REDIS_URL=redis://localhost:6379/15                                     # default
npm ci
node scripts/copy-fonts.mjs
npm run typecheck && npm test
```

The global setup (`test/global-setup.ts`) recreates a `karamay_test` database. A non-superuser **owner** role runs the migrations. The API connects as a separate non-superuser, non-BYPASSRLS **app** role, the same split production needs. If the tests connected as a superuser, row-level security would be silently bypassed and the RLS tests would prove nothing.

The Gemini API is never called in tests:
- API-level tests inject a scriptable `FakeProvider` (`test/helpers.ts`).
- `test/gemini.test.ts` drives the real `GeminiProvider` and `@google/genai` SDK through an injected `fetch`, so request shape, timeouts, error mapping and safety-block parsing are exercised without network access.

## Results (2026-10-20, executed in the build environment)

`npm test`: **9 files, 167 tests, all passed.** `npm run typecheck`: clean. `npm audit`: 0 vulnerabilities. `npm run check:secrets`: clean.

A browser end-to-end check was also executed manually with Playwright and Chromium against the running server, using a fake AI provider. It confirmed:
- no console errors or CSP violations
- the guest cookie is HttpOnly and SameSite=Strict, and is not created until the AI is used
- AI consent gating
- the concern path shows crisis resources and the urgent path uses the template reply
- an `<img onerror>` payload renders as inert text
- the journal stays local
- dark mode
- no horizontal overflow at 375px
- the skip link is first in tab order
- crisis numbers are visible with JavaScript disabled

That script is not committed; it lived in a scratch directory. Adding it as a Playwright test is a follow-up.

## Required scenarios

Status key: **Executed** = automated test ran and passed. **Partial** = covered, with the gap stated. **Needs external setup** = cannot be tested without credentials or services that do not exist yet.

| # | Scenario | Status | Test |
|---|---|---|---|
| 1 | User cannot read another user's journal by changing an id | Executed | `authz.test.ts` › Scenario 1 (read/update/delete, list, malformed ids) |
| 2 | Guest cannot access another guest's records | Executed | `authz.test.ts` › Scenario 2, plus the RLS defence-in-depth tests |
| 3 | Logged-out user cannot access protected endpoints | Executed | `authz.test.ts` › Scenario 3 (7 endpoints, forged bearer) |
| 4 | Expired or revoked sessions are rejected | Executed | `authz.test.ts` › Scenario 4 (logout, absolute expiry, idle expiry, logout-all, hashes only) |
| 5 | Users cannot modify premium status via frontend | Executed | `authz.test.ts` › Scenario 5 |
| 6 | Admin endpoints reject unauthorized users | Executed | `authz.test.ts` › Scenario 6 |
| 7 | Gemini key absent from frontend bundles and responses | Executed | `ai.test.ts` › Scenario 7, `gemini.test.ts` (key in header, not URL) |
| 8 | Invalid or oversized requests rejected | Executed | `ai.test.ts` › Scenarios 8 and 11 (modes, empty, oversize, extra fields, 64 KB body limit) |
| 9 | Rate limits apply on the backend | Executed | `ai.test.ts` › Scenarios 9 and 26 |
| 10 | Multiple instances cannot bypass shared quotas | Executed | `ai.test.ts` › Scenario 10 (two app instances, one Redis) |
| 11 | Requests exceeding token or usage limits are blocked | Executed | `ai.test.ts` › history trimming, daily/monthly quota, budget breaker |
| 12 | Timeouts and provider errors do not expose secrets | Executed | `ai.test.ts` › Scenarios 12–13, `gemini.test.ts`, `privacy.test.ts` › Scenario 21 |
| 13 | Retries are bounded | Executed | `ai.test.ts` (1 + `AI_MAX_RETRIES` calls, no retry on timeout or auth), `gemini.test.ts` (one HTTP attempt per call) |
| 14 | Prompt injection cannot grant privileged access | Executed | `ai.test.ts` › Scenarios 14–15 |
| 15 | AI output cannot execute operations | Executed | Same test, plus `gemini.test.ts` (no tools) and the browser check (text-only rendering) |
| 16 | Invalid webhook signatures rejected | Executed | `payments.test.ts` › Scenario 16 |
| 17 | Duplicate webhooks do not duplicate entitlements | Executed | `payments.test.ts` › duplicate delivery |
| 18 | Replayed or outdated events handled safely | Executed | `payments.test.ts` › replay window and out-of-order |
| 19 | Refunds and cancellations update entitlements | Executed | `payments.test.ts` › Scenario 19 |
| 20 | Test-mode and production credentials separate | Partial | `payments.test.ts` › Scenario 20 (test adapter refused in prod, live/test mode check). A real provider's credential split needs the provider. |
| 21 | Logs contain no journals or credentials | Executed | `privacy.test.ts` › Scenario 21 |
| 22 | Users export only their own data | Executed | `privacy.test.ts` › Scenario 22 |
| 23 | Users can delete their own data | Executed | `privacy.test.ts` › Scenario 23, plus the retention purge test |
| 24 | Backup restoration testable without production data | Executed | `privacy.test.ts` › Scenario 24 (`pg_dump`/`pg_restore` into a scratch DB, RLS and encryption verified) |
| 25 | Privacy disclosures match data flows | Executed | `privacy.test.ts` › Scenario 25 (chat never in DB, no plaintext, minimal Gemini payload, Privacy Center text matches config) |
| 26 | Automated requests trigger defences | Executed | `ai.test.ts` › throttle → cooldown → revocation |
| 27 | Budget limits stop expensive requests | Executed | `ai.test.ts` › Scenario 27 (including premium users) |
| 28 | Kill switch works | Executed | `ai.test.ts` › Scenarios 28–30 |
| 29 | Wellness features work when Gemini is unavailable | Executed | `ai.test.ts` (kill switch and `AI_ENABLED=false`) |
| 30 | Crisis resources available when quotas are exhausted | Executed | `ai.test.ts` › crisis after quota and kill switch, `crisis.test.ts` |

## Not tested (requires external setup)

- Calls to the real Gemini API: no key in the build environment. After configuring staging, send one request through `/api/ai/chat` and compare `/api/admin/ai/usage` with the Google Cloud billing report.
- Real payment provider webhooks and checkout: no provider chosen.
- Real email delivery: no mailer adapter.
- Building and running the Docker image: no Docker daemon in the build environment.
- Load testing.
- Accessibility audit with a screen reader. Only automated keyboard and focus checks and visual review were done.
