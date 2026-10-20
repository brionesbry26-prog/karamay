# Operational runbooks

These procedures assume an operator holds `ADMIN_API_TOKEN` and access to the hosting platform. Expose admin endpoints only on a private network, a VPN, or behind an identity-aware proxy (e.g. Cloud IAP, Cloudflare Access). The token alone is not meant to protect them on the public internet.

## 1. Emergency: disable AI immediately

Use this for a cost spike, abuse wave, harmful outputs, a provider incident, or a suspected key leak.

```bash
curl -X POST https://<host>/api/admin/ai/kill-switch \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'content-type: application/json' \
  -d '{"disabled": true, "reason": "cost spike 2026-10-20"}'
```

- Takes effect on all instances on their next request (Redis flag), with no redeploy.
- The action is audited (`audit_log`) and raises an alert.
- Users see a calm "the AI companion is resting" message. Journal, mood, grounding, Pakawalan, export, deletion and crisis resources keep working. Urgent and concern messages still get the safety template.
- Hard off (survives a Redis wipe): set `AI_ENABLED=false` and redeploy.
- Re-enable with `{"disabled": false, "reason": "..."}` after the cause is fixed.

## 2. Rotating secrets

| Secret | Procedure |
|---|---|
| `GEMINI_API_KEY` | 1. Create a new key in Google Cloud, restricted to the Generative Language API. 2. Update the secret and redeploy. 3. Verify one chat works. 4. Delete the old key. If you suspect a leak: kill switch first (§1), then delete the old key immediately, then check billing. |
| `ADMIN_API_TOKEN` | Generate a new one, update the secret, redeploy. The old token stops working on deploy. |
| `PAYMENTS_WEBHOOK_SECRET` | Rotate in the provider dashboard. Most providers allow two active secrets during rotation. Keep the old one active until the deploy finishes. |
| `IP_HASH_KEY` | Rotate freely. Only effect: per-IP counters and cooldowns reset. |
| DB / Redis passwords | Create the new credential, update the secret, redeploy, then revoke the old one. |
| `DATA_ENCRYPTION_KEYS` | 1. Append a new key (`1:<old>,2:<new>`) and set `DATA_ENCRYPTION_ACTIVE_KEY_ID=2`. New writes use key 2, existing rows still decrypt with key 1. 2. **Never remove a key while rows still reference it** (`SELECT key_id, count(*) FROM journal_entries GROUP BY 1` run as the owner role with RLS context, or by a DBA). A bulk re-encryption job is not implemented yet. Until it exists, old keys must stay listed. |

After any suspected compromise, also revoke sessions if needed. Every session can be ended with `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;`, which forces everyone to start a new session.

## 3. Backup and restore

- Use the database provider's automated backups with point-in-time recovery. Keep `DATA_ENCRYPTION_KEYS` in a separate secure store: a backup without the keys cannot decrypt journals, and the keys without the backup are useless.
- **Quarterly restore rehearsal (no production data needed):** the automated test `privacy.test.ts › Scenario 24` shows the procedure on synthetic data:
  ```bash
  pg_dump --format=custom --no-owner --file=karamay.dump "$SOURCE_URL"
  createdb -O karamay_owner karamay_restore_check
  pg_restore --no-owner --role=karamay_owner --dbname="$RESTORE_URL" karamay.dump
  ```
  Then confirm:
  - row-level security is still enabled (`\d+ journal_entries`)
  - the row counts match
  - one synthetic entry decrypts with the key
  - the restore database is dropped afterwards
- To restore real production data, do it into a **new** database, verify, then point `DATABASE_URL` at it. Do not restore over the live database. Restored data stays production data: same access controls, never copied to dev or staging.

## 4. Suspected data breach

1. **Contain:**
   - turn on the kill switch if AI is involved
   - rotate exposed secrets (§2)
   - revoke sessions if session tokens may be exposed
   - block offending IPs at the edge
2. **Preserve evidence:** export the relevant logs, `audit_log` and provider audit logs. Do not delete anything.
3. **Assess scope:** which tables, which subjects, whether ciphertext only or also the keys. Encrypted journal text is exposed only if `DATA_ENCRYPTION_KEYS` was also compromised.
4. **Notify:** under the Philippine Data Privacy Act (RA 10173) and NPC Circular 16-03, personal data breaches that meet the criteria must be reported to the National Privacy Commission and affected data subjects **within 72 hours** of knowledge. Confirm current obligations with counsel. Notify Google or other processors if their systems are involved.
5. **Recover and review:** fix the root cause, add a regression test, and write a blameless post-incident review.

## 5. Reviewing suspicious activity

Logs carry `evt` fields. Useful queries in your log tool:
- `evt="security"`: strikes by `kind` (`rate_limited`, `auth_failed`, `csrf_failed`, `forbidden_access`, `payment_signature_failed`, `admin_auth_failed`, `cooldown_ignored`). The `actor` field is `s:<subject uuid>` or `ip:<hmac>`, never a raw IP.
- `evt="security" kind="cooldown_applied"`: graduated responses.
- `evt="ops_alert"`: everything sent to the alert webhook.
- `evt="ai_provider_error"`: Gemini failures by `kind`.

The response ladder is automatic: throttle, then escalating cooldowns (5 min, 30 min, 6 h), then session revocation. For manual review:
- revoke a subject's sessions: `UPDATE sessions SET revoked_at = now() WHERE subject_id = '<uuid>'`
- tune `LIMITS_JSON`
- add an edge rule

Never read private journal content during an investigation. It is not needed, and it is encrypted.

## 6. Log retention

Keep application logs for **30 days** in the platform's log store, with access limited to operators. `audit_log` is kept 365 days, AI usage aggregates about 400 days, and payment events 400 days. The daily purge job enforces these.

## 7. Dependency updates

Monthly, and immediately for security advisories:
```bash
npm outdated
npm update            # or targeted major upgrades with changelog review
npm audit --omit=dev
npm test && npm run build
```
Commit `package-lock.json`. CI runs `npm ci`, so the lockfile is enforced, and `npm audit`. Consider enabling Dependabot.

## 8. Verifying crisis resources

At least quarterly, and before launch, call or check each number in `web/data/crisis-resources.json` against its source (ncmh.gov.ph). Then update:
- the JSON file (`lastVerified`)
- the static numbers in `web/index.html`, which `crisis.test.ts` keeps in sync with the JSON
- the template text in `src/safety/crisis.ts` if a number changes

Add another organisation only after confirming its number directly with that organisation.
