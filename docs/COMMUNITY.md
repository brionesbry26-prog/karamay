# Anonymous community ("Bulong sa Hangin"): status and requirements

**Status: not built and disabled.** `COMMUNITY_ENABLED=true` is refused at startup (`src/config.ts`), and no posting endpoints exist.

Before any public posting is enabled, all of the following must exist and be tested:

- Server-side validation and length limits for posts and comments. Text-only at first: no links or attachments.
- Rate limits and anti-spam (reuse `Limiter` and `AbuseMonitor`), plus account age or verified-email requirements for posting.
- Report, block and mute flows. A moderation queue with trained human moderators and defined response times.
- Published community rules in Filipino and English.
- Detection and removal of personal information (names, numbers, addresses, school or workplace).
- Harassment and targeted-abuse handling, with escalation paths.
- Crisis-content workflow: run posts through `assessRisk`, hold urgent ones for review, show resources to the author, and never leave them public without review.
- Moderation audit log (actions only, minimal content).
- Retention and deletion rules for posts and reports.
- An honest anonymity statement. Posts are pseudonymous to other users, but the server retains the subject id and rate-limit metadata. Do not claim "fully anonymous".

A finished posting UI is not a reason to launch.
