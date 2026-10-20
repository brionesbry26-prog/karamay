# KARAMAY security audit and threat model

_Date: 2026-10-20. Scope: repository `brionesbry26-prog/karamay`._

## 1. Phase 0 finding: there was no code to audit

| Severity | Evidence | Consequence |
|---|---|---|
| Blocker (informational) | `git log` on the working branch: "No commits yet". The GitHub API for the repository returned `409 Git Repository is empty`. `list_branches` returned `[]`. None of the owner's other accessible repositories (`adventure-app`, `adventure-admin`, `4R-Bakery`, `adventure`, `bryanbrionesportfolio`, `adminadventure`) are named for KARAMAY. | No existing architecture, secrets, endpoints, dependencies or data stores could be inspected. There were no existing vulnerabilities to report, because there was no existing code. |

The owner chose to **build a secure foundation from scratch** rather than supply existing code. If an earlier KARAMAY codebase exists elsewhere, this audit does not cover it. Before merging the two, audit that codebase against the controls below.

## 2. Architecture that was built

```
Browser (web/, static, CSP 'self')            Mobile client (future)
   │ HttpOnly SameSite=Strict cookie + CSRF       │ Bearer token in secure storage
   ▼                                              ▼
Fastify API (src/app.ts) ── request id, log redaction, helmet/CSP, CORS allowlist, body limit
   │  identity hook ─ SessionService (hashed tokens, absolute + idle expiry, revocation)
   │  preHandler   ─ Origin + CSRF check, abuse cooldown, per-subject API rate limit
   ├─ /api/journal, /api/mood ─► services/private-data.ts ─► PostgreSQL (FORCE RLS, AES-256-GCM text)
   ├─ /api/ai/chat ─► AiService ─► crisis layer ─► kill switch ─► quotas ─► concurrency
   │                               ─► budget reservation ─► GeminiProvider (@google/genai) ─► Gemini API
   ├─ /api/payments/webhook ─► PaymentAdapter (signature, replay window) ─► entitlements (idempotent, ordered)
   └─ /api/admin/* (bearer ADMIN_API_TOKEN only) ─► usage report, kill switch, audit_log
Redis: rate limits, quotas, concurrency slots, budget counters, cooldowns, kill switch, alert de-duplication
```

## 3. Threats and controls

Every row was verified by an automated test that **was executed** (see `docs/TESTING.md`). "Limitation" lists what the control does not cover.

| # | Threat | Severity if unmitigated | Control (where) | Verified by | Limitation |
|---|---|---|---|---|---|
| T1 | Gemini API key exposure | Critical | Key is read only by `src/ai/gemini.ts` from server env. The client calls `/api/ai/chat` only. Config errors never print values. The key travels in the `x-goog-api-key` header, not the URL. | `ai.test.ts` "Scenario 7" scans responses and every file under `web/`. `gemini.test.ts` checks request shape. `config.test.ts` checks that errors never echo secrets. | The key must still be kept out of CI logs and platform dashboards by the operator. |
| T2 | Cross-user journal access (IDOR) | Critical | Every query has an explicit `owner_id` filter. Postgres `FORCE ROW LEVEL SECURITY` is bound per transaction (`withSubject`). Foreign and unknown ids both return 404. The app connects as a non-superuser, non-BYPASSRLS role. | `authz.test.ts` scenarios 1 and 2, plus the RLS tests: an unfiltered query returns 0 rows, and the runtime role cannot disable RLS. | A DB superuser or the table owner without `app.subject_id` set can still read ciphertext. The text stays encrypted (T3). |
| T3 | Database dump or backup leak | High | Journal and mood text is encrypted with AES-256-GCM. The AAD binds each ciphertext to owner and row, and key ids allow rotation. | `authz.test.ts` "stores journal text encrypted". `privacy.test.ts` searches every column for plaintext and runs the backup/restore rehearsal. | Not end-to-end: the server holds the key. If server and key are both compromised, the text is exposed. |
| T4 | Unlimited AI spend / denial of wallet | Critical | Per-tier minute/day/month quotas in Redis. Per-subject and global concurrency caps. Worst-case cost reserved before every call against daily and monthly budgets (atomic Lua script). Alerts at 50/75/90%. Kill switch. No silent model fallback. Bounded retries. | `ai.test.ts` scenarios 9, 10, 13, 26, 27, 28. | Costs are estimates from configured prices; reconcile them with Google billing. Budget accuracy depends on correct `GEMINI_PRICE_*` values. |
| T5 | Quota reset by clearing storage or minting guests | High | Identity comes only from the server-issued session. Guest creation is rate-limited per HMAC'd IP. A live session is returned instead of minting a new one. | `ai.test.ts` "clearing browser storage…" and "limits guest-session minting…". | Someone using many networks or IPs can still mint guests up to the per-IP limit. Add a bot challenge (e.g. Turnstile) if abuse appears. |
| T6 | CSRF / login CSRF | High | SameSite=Strict cookie, per-session synchronizer token (constant-time compare), and an Origin / `Sec-Fetch-Site` allowlist on every unsafe request. | `authz.test.ts` "CSRF and origin protection" and `headers.test.ts` CORS tests. | Clients that send no Origin header (curl, mobile) are allowed. They cannot ride a victim's cookie. |
| T7 | Session theft / fixation | High | 256-bit random tokens stored only as SHA-256. HttpOnly, `__Host-` prefix in production. Absolute and idle expiry. A new token at login. Logout-all. All sessions revoked on password reset. | `authz.test.ts` scenario 4 and `auth.test.ts`. | XSS would still allow actions inside the page. The strict CSP and text-only rendering reduce that risk. |
| T8 | Frontend premium manipulation | High | No route writes entitlements. Premium is computed server-side from `entitlements`, written only by verified webhooks. | `authz.test.ts` scenario 5 and `payments.test.ts`. | A real payment provider adapter is not implemented yet (launch blocker). |
| T9 | Forged, replayed, duplicate or out-of-order payment events | High | HMAC signature with timestamp tolerance and constant-time compare. Idempotency ledger `payment_events`. Events older than `last_event_at` are ignored. Live/test mode check. | `payments.test.ts` scenarios 16–20. | Verified only with the `test-hmac` adapter. Each real provider adapter needs the same tests. |
| T10 | Account enumeration and credential stuffing | Medium | Register and reset always return 202. Login errors are identical. A dummy argon2 verify keeps timing uniform. Per-account and per-IP throttles. Strikes lead to cooldowns. | `auth.test.ts`. | Email delivery timing could still reveal existence to an attacker who can observe the mailbox. |
| T11 | Sign-up hijack (attacker pre-registers the victim's email) | Medium | Each verification token carries its own pending password hash. The account is created only on verification. | `auth.test.ts` "each sign-up attempt activates only its own password". | The victim could click the attacker's link. The email text must tell them to ignore unexpected links. |
| T12 | Prompt injection gaining privileges | High | The model has no tools. Output is returned as text and rendered with `textContent`. System instructions travel in a separate field. No other user's data is ever put in a prompt. | `ai.test.ts` scenarios 14–15. `gemini.test.ts` asserts that no `tools` are sent. | The model can still be talked into saying unhelpful things. The safety layers below address harmful content, not perfectly. |
| T13 | Missed crisis / unavailable crisis help | High | Deterministic EN/FIL/Taglish detection. Urgent messages get a template response without the AI. Concern adds safety instructions and resources. Resources are served even under quota, kill switch or AI off, and are static in HTML (works without JS). | `crisis.test.ts` and `ai.test.ts` scenario 30. Browser check with JS disabled. | Keyword detection misses indirect phrasing (documented false negatives) and can over-trigger. Not a clinical tool. |
| T14 | Private content in logs | High | Pino serializers log only method, path and request id. Redaction of auth headers, cookies and passwords. No body logging. IPs appear only as HMACs. | `privacy.test.ts` scenario 21 searches all log output for every secret. | Platform-level access logs (load balancer, CDN) are outside the app. Configure them separately. |
| T15 | XSS / clickjacking / content sniffing | Medium | CSP `default-src 'self'` with no inline code or styles. `frame-ancestors 'none'`, nosniff, `Referrer-Policy: no-referrer`, Permissions-Policy. All dynamic text inserted via text nodes. | `headers.test.ts` and the browser check (`<img onerror>` stays inert). | — |
| T16 | Unauthorized admin access | High | Separate bearer token, constant-time compare, per-IP limit, strikes, alerts, audit log. Routes 404 when no token is configured. Session cookies are ignored for admin routes. | `authz.test.ts` scenario 6. | One shared admin token. Put admin routes behind a private network or SSO proxy in production. |
| T17 | Misconfiguration in production | High | Production refuses to start on missing or unsafe settings: http origin, wildcard CORS, missing keys, dev mailer, test payment adapter, community flag. | `config.test.ts`. | — |
| T18 | Community abuse | High | `COMMUNITY_ENABLED=true` is refused at startup. No community endpoints exist. | `config.test.ts`. | See `docs/COMMUNITY.md` before building it. |
| T19 | Vulnerable dependencies | Variable | Small dependency set, lockfile, `npm audit` in CI. | `npm audit` on 2026-10-20: 0 vulnerabilities (production and dev). | Re-run regularly. See `RUNBOOKS.md` §7. |

## 4. Residual risks (not fixed)

See `docs/LAUNCH_CHECKLIST.md` for the actionable list. The most important:

1. **Payments:** no real provider adapter (PayMongo, Stripe, Google Play or App Store must be chosen).
2. **Email:** no production mailer, so accounts stay disabled in production until one is added.
3. **Gemini model, prices and data terms** are operator-supplied and must be verified against Google's live documentation. The official docs could not be fetched from the build environment.
4. **Crisis hotline numbers** were verified only through search results quoting ncmh.gov.ph. A human must confirm them directly.
5. **Bot challenge:** none is integrated. Graduated throttling and cooldowns are the current defence.
6. **Single admin token:** use network-level protection.
7. **The Dockerfile was not built** in the sandbox (no Docker daemon).
