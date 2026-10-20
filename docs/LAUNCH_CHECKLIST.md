# Launch checklist

## Done in this repository (verified by executed tests)

- [x] Server-only Gemini integration with no key in the client (official `@google/genai` SDK)
- [x] Secure guest sessions (hashed tokens, HttpOnly/SameSite cookies, expiry, revocation); CSRF and Origin checks
- [x] Ownership checks on every private-data query, plus Postgres FORCE RLS and a least-privilege runtime role
- [x] Journal and mood text encrypted at rest (AES-256-GCM, key rotation by id)
- [x] Redis-backed shared rate limits, quotas, concurrency caps, and graduated abuse responses
- [x] AI budget circuit breaker, threshold alerts, usage report, and kill switch
- [x] Crisis layer that works without AI, quota or JavaScript
- [x] Export and deletion, retention purge job, privacy-safe logging
- [x] Payment entitlement core (signature, idempotency, ordering, refunds) behind an adapter interface
- [x] Production config guards, security headers and CSP, CI workflow

## Blockers before a public launch

- [ ] **Gemini:**
  - paid-tier billing account
  - restricted API key in the secret manager
  - model id and prices verified on Google's pages (`DEPLOYMENT.md` §4)
  - budgets set
  - one staging call reconciled with billing
- [ ] **Re-read the Gemini API terms** for the tier in use, and adjust the Privacy Center wording if needed
- [ ] **Crisis numbers verified directly** with NCMH (`RUNBOOKS.md` §8). Mental-health professional review of templates and prompts (`AI_SAFETY.md`).
- [ ] **Human support channel** staffed and listed in the app
- [ ] **Legal review:**
  - Data Privacy Act consent and notice
  - sensitive personal information handling
  - cross-border transfer disclosure
  - NPC registration if required
  - age policy (no age gate yet)
  - terms of service
- [ ] **Hosting chosen:**
  - separate dev, staging and prod
  - managed Postgres with TLS, PITR and encryption at rest
  - managed Redis with TLS
  - HTTPS
- [ ] Docker image built and deployed in CI or CD (not built in the build environment)
- [ ] Database roles created as in `DEPLOYMENT.md` §3; migrations run with the owner role only
- [ ] Secrets generated per environment; `DATA_ENCRYPTION_KEYS` backed up separately; GitHub secret scanning and push protection on
- [ ] Alert webhook connected and tested; log retention set to 30 days; admin routes behind a private network or an identity proxy
- [ ] Daily `purge:prod` scheduled job
- [ ] Backup restore rehearsed on the real provider (`RUNBOOKS.md` §3)
- [ ] Fill in the "Other providers" section of the Privacy Center with the real host, database and payment providers

## Needed for accounts and premium (can launch guest-only without them)

- [ ] Email adapter, SPF/DKIM/DMARC, and templates (`DEPLOYMENT.md` §10). Until then accounts stay off automatically.
- [ ] Payment provider chosen, adapter written, provider-specific tests, separate test and live keys, checkout flow (`DEPLOYMENT.md` §11)
- [ ] Data re-encryption job before retiring an old encryption key

## Recommended next

- [ ] Bot challenge (e.g. Cloudflare Turnstile) on guest creation and registration if abuse appears
- [ ] Commit the Playwright browser checks as an automated e2e suite
- [ ] Screen-reader accessibility review (VoiceOver, TalkBack)
- [ ] Load test of `/api/ai/chat` with the fake provider to size `globalConcurrency`
- [ ] Mobile client using bearer tokens in Keychain or Keystore
- [ ] Community features stay disabled until `COMMUNITY.md` is satisfied
