# Privacy and data flows

This is the engineering source of truth behind the in-app Privacy Center (`web/index.html`, `#/privacy`). If you change a data flow, update both. `privacy.test.ts › Scenario 25` checks key claims automatically.

## Where data lives

| Data | Device (browser storage) | KARAMAY server | Google Gemini |
|---|---|---|---|
| Journal entries | Default (`localStorage`, `kmy.journal.v1`) | Only for accounts that choose "Cloud". AES-256-GCM at rest, RLS-protected. | Never |
| Mood check-ins | Default | Only for "Cloud" accounts (note encrypted) | Never |
| Chat messages | In memory while the page is open | **Never stored.** Processed in memory to call Gemini. | The current message plus up to 8 recent turns (≤ 6,000 chars), with the system instructions |
| Pakawalan text | Not stored anywhere | Never sent | Never |
| Session | HttpOnly cookie (web) or secure storage (mobile) | SHA-256 hash of the token, subject id, expiry | Never |
| Account | — | Email (normalised), argon2id password hash, verification time | Never |
| Subscription | — | Plan, status, period end, provider subscription id. **No card data.** | Never |
| AI usage | — | Daily aggregates by model, feature and tier. No subject ids, no content. | — |
| Rate-limit state | — | Redis counters keyed by subject id or HMAC(IP), with short TTLs | — |
| Logs | — | Method, path, status, request id, security event codes. No bodies, no raw IPs. | — |

## What is sent to Gemini, and why

To generate a reply, `AiService` sends:
- the mode-specific system instruction
- the user's recent turns (trimmed to `limits.ai.maxHistoryTurns` and `maxHistoryChars`)
- the new message

It never sends email, subject or session ids, journal or mood content, or another user's data (`privacy.test.ts` verifies this). The frontend shows a consent notice before the first chat.

**Gemini terms by tier (must be re-verified before launch).** According to the Gemini API Additional Terms as found by search on 2026-10-20 (the live page could not be fetched from the build environment):
- On **unpaid** services, Google may use prompts and responses to improve its products, and human reviewers may read them. Google advises not to submit sensitive or personal information.
- On **paid** services (an active Cloud Billing account), Google states it does not use prompts or responses to improve its products. It processes them under its data processing terms and may log them for a limited period for abuse detection and legal requirements.
- Users in the EEA, Switzerland and the UK get the paid-service data terms even on free features.

KARAMAY must run on the **paid tier** in every environment that handles real user content. The Privacy Center deliberately does not promise "never used to improve services". It tells users their data is governed by the Gemini API terms for the tier in use, and that Google may retain it for abuse monitoring.

## Legal basis and consent (requires human review)

The app collects explicit acknowledgement before the first AI chat, and all core wellness tools work without the AI. Under the Philippine Data Privacy Act (RA 10173), health-related information about mental state is likely **sensitive personal information**. Before launch, have counsel confirm:
- the consent wording and lawful basis
- registration requirements with the NPC
- the privacy notice
- cross-border transfer disclosure (Gemini processing outside the PH)
- age requirements (the Gemini terms restrict use by minors; KARAMAY has no age gate yet)

## Rights

- **Export:** device data via "Export device data". Server data via `GET /api/me/export`, only the caller's own data, JSON download.
- **Delete:**
  - device data via "Delete device data"
  - server data and account via `DELETE /api/me` (password required for accounts), which cascades to sessions, journal, mood, entitlements and tokens
- **Retention:**
  - inactive guests are purged after 30 days
  - account data is kept until deletion
  - usage aggregates are kept about 400 days
  - logs are kept 30 days (platform setting)
- A deleted account's active subscription must also be cancelled with the payment provider. The API returns a notice saying so.

## End-to-end encryption

Not implemented, and not claimed. The server can decrypt cloud journals in order to show them to their owner, and Gemini must read chat text to reply. Local-only journals never leave the device.
