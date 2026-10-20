import argon2 from 'argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { enforce, ipActor, noStore, parse, strike, type Ctx } from '../context.js';
import { tx } from '../db/pool.js';
import { hmacHex, randomToken, sha256 } from '../lib/crypto.js';
import { errors } from '../lib/errors.js';
import { reencryptForNewOwner } from '../services/private-data.js';
import { deliverSession } from './session.js';

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1).
const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const TOKEN_TTL_SEC = { register: 24 * 3600, password_reset: 30 * 60 } as const;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email());
const password = z.string().min(10, 'Use at least 10 characters.').max(256);
const client = z.enum(['web', 'mobile']).default('web');
const token = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/);

let dummyHash: Promise<string> | null = null;
/** Hash used to keep login timing uniform for unknown emails. */
function getDummyHash() {
  dummyHash ??= argon2.hash(randomToken(16), ARGON);
  return dummyHash;
}

function publicBase(ctx: Ctx, req: FastifyRequest): string {
  return ctx.cfg.publicOrigin ?? `${req.protocol}://${req.host}`;
}

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const ensureEnabled = () => {
    if (!ctx.cfg.accountsEnabled) {
      throw errors.unavailable('accounts_unavailable', 'Accounts are not available yet. You can keep using KARAMAY as a guest.');
    }
  };
  const ipWindow = (key: string, w: { limit: number; windowSec: number }, req: FastifyRequest) =>
    enforce(ctx, req, `${key}:${ipActor(ctx, req)}`, w, ipActor(ctx, req));
  const ipCooldown = async (req: FastifyRequest) => {
    const s = await ctx.abuse.cooldownRemaining(ipActor(ctx, req));
    if (s > 0) throw errors.tooMany(s);
  };

  /**
   * Always answers 202 so the response never reveals whether an email is
   * registered. New emails get a verification link; existing ones get a notice.
   */
  app.post('/api/auth/register', async (req, reply) => {
    noStore(reply);
    ensureEnabled();
    await ipCooldown(req);
    await ipWindow('register', ctx.cfg.limits.register.perIp, req);
    const body = await parse(ctx, req, z.object({ email, password }).strict(), req.body);
    if (body.password.toLowerCase().includes(body.email.split('@')[0]!)) {
      throw errors.badRequest('Please choose a password that does not contain your email.', { fields: ['password'] });
    }

    const passwordHash = await argon2.hash(body.password, ARGON);
    const existing = await ctx.db.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (existing.rowCount) {
      await ctx.mailer.send({ to: body.email, kind: 'already_registered' }).catch(() => {});
    } else {
      const raw = randomToken(32);
      await ctx.db.query(
        `INSERT INTO auth_tokens (token_hash, purpose, email, password_hash, expires_at)
         VALUES ($1, 'register', $2, $3, now() + make_interval(secs => $4))`,
        [sha256(raw), body.email, passwordHash, TOKEN_TTL_SEC.register],
      );
      // The token travels in the URL fragment, which browsers never send to servers or in Referer headers.
      await ctx.mailer
        .send({ to: body.email, kind: 'verify_registration', link: `${publicBase(ctx, req)}/#/verify?token=${raw}` })
        .catch((err: Error) => ctx.log.error({ evt: 'mail_failed', kind: 'verify_registration', err: err.message }, 'mail failed'));
    }
    reply.code(202);
    return { status: 'check_email' };
  });

  app.post('/api/auth/verify', async (req, reply) => {
    noStore(reply);
    ensureEnabled();
    await ipCooldown(req);
    const body = await parse(ctx, req, z.object({ token }).strict(), req.body);
    const ok = await tx(ctx.db, async (c) => {
      const t = await c.query<{ email: string; password_hash: string }>(
        `UPDATE auth_tokens SET used_at = now()
          WHERE token_hash = $1 AND purpose = 'register' AND used_at IS NULL AND expires_at > now()
          RETURNING email, password_hash`,
        [sha256(body.token)],
      );
      const row = t.rows[0];
      if (!row) return false;
      const taken = await c.query('SELECT 1 FROM users WHERE email = $1', [row.email]);
      if (taken.rowCount) return false;
      const s = await c.query<{ id: string }>("INSERT INTO subjects (kind) VALUES ('user') RETURNING id");
      await c.query('INSERT INTO users (subject_id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, now())', [
        s.rows[0]!.id,
        row.email,
        row.password_hash,
      ]);
      // Other pending sign-up links for the same email become useless.
      await c.query("UPDATE auth_tokens SET used_at = now() WHERE purpose = 'register' AND email = $1 AND used_at IS NULL", [row.email]);
      return true;
    });
    if (!ok) {
      await strike(ctx, req, 'auth_failed', ipActor(ctx, req));
      throw errors.badRequest('This link is invalid or has expired.');
    }
    return { verified: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    noStore(reply);
    ensureEnabled();
    await ipCooldown(req);
    const body = await parse(ctx, req, z
        .object({ email, password: z.string().min(1).max(256), guestData: z.enum(['merge', 'discard']).default('merge'), client })
        .strict(), req.body);
    await ipWindow('login-ip', ctx.cfg.limits.login.perIp, req);
    // Per-account throttle keyed by an HMAC of the email, applied whether or not the account exists.
    await enforce(ctx, req, `login-acct:${hmacHex(ctx.cfg.ipHashKey, body.email).slice(0, 32)}`, ctx.cfg.limits.login.perAccount, ipActor(ctx, req));

    const { rows } = await ctx.db.query<{ subject_id: string; password_hash: string }>('SELECT subject_id, password_hash FROM users WHERE email = $1', [
      body.email,
    ]);
    const user = rows[0];
    const valid = user ? await argon2.verify(user.password_hash, body.password) : (await argon2.verify(await getDummyHash(), body.password), false);
    if (!user || !valid) {
      await strike(ctx, req, 'auth_failed', ipActor(ctx, req));
      throw errors.unauthorized('Email or password is incorrect.');
    }

    const guest = req.principal?.kind === 'guest' ? req.principal : null;
    const issued = await tx(ctx.db, async (c) => {
      if (req.principal) await c.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [req.principal.tokenHash]);
      if (guest) {
        // The guest identity ends at login: its server-side data either moves to
        // the account (re-encrypted for the new owner) or is deleted, never orphaned.
        if (body.guestData === 'merge') {
          await c.query("SELECT set_config('app.subject_id', $1, true), set_config('app.merge_from', $2, true)", [user.subject_id, guest.subjectId]);
          await reencryptForNewOwner(ctx, c, guest.subjectId, user.subject_id);
        }
        await c.query("DELETE FROM subjects WHERE id = $1 AND kind = 'guest'", [guest.subjectId]);
      }
      // A brand-new session id at the privilege change prevents session fixation.
      return ctx.sessions.issue(c, user.subject_id, 'user');
    });
    return {
      session: { kind: 'user', ...deliverSession(ctx, reply, issued, body.client) },
      guestData: guest ? body.guestData : null,
    };
  });

  app.post('/api/auth/password-reset/request', async (req, reply) => {
    noStore(reply);
    ensureEnabled();
    await ipCooldown(req);
    await ipWindow('reset-ip', ctx.cfg.limits.passwordReset.perIp, req);
    const body = await parse(ctx, req, z.object({ email }).strict(), req.body);
    const perEmail = await ctx.limiter.hit(`reset-email:${hmacHex(ctx.cfg.ipHashKey, body.email).slice(0, 32)}`, ctx.cfg.limits.passwordReset.perEmail);
    if (perEmail.allowed) {
      const { rows } = await ctx.db.query<{ subject_id: string }>('SELECT subject_id FROM users WHERE email = $1', [body.email]);
      if (rows[0]) {
        const raw = randomToken(32);
        await ctx.db.query(
          `INSERT INTO auth_tokens (token_hash, purpose, subject_id, expires_at)
           VALUES ($1, 'password_reset', $2, now() + make_interval(secs => $3))`,
          [sha256(raw), rows[0].subject_id, TOKEN_TTL_SEC.password_reset],
        );
        await ctx.mailer
          .send({ to: body.email, kind: 'password_reset', link: `${publicBase(ctx, req)}/#/reset?token=${raw}` })
          .catch((err: Error) => ctx.log.error({ evt: 'mail_failed', kind: 'password_reset', err: err.message }, 'mail failed'));
      }
    }
    reply.code(202);
    return { status: 'check_email' };
  });

  app.post('/api/auth/password-reset/confirm', async (req, reply) => {
    noStore(reply);
    ensureEnabled();
    await ipCooldown(req);
    const body = await parse(ctx, req, z.object({ token, newPassword: password }).strict(), req.body);
    const newHash = await argon2.hash(body.newPassword, ARGON);
    const emailTo = await tx(ctx.db, async (c) => {
      const t = await c.query<{ subject_id: string }>(
        `UPDATE auth_tokens SET used_at = now()
          WHERE token_hash = $1 AND purpose = 'password_reset' AND used_at IS NULL AND expires_at > now()
          RETURNING subject_id`,
        [sha256(body.token)],
      );
      const subjectId = t.rows[0]?.subject_id;
      if (!subjectId) return null;
      const u = await c.query<{ email: string }>(
        'UPDATE users SET password_hash = $2, password_changed_at = now() WHERE subject_id = $1 RETURNING email',
        [subjectId, newHash],
      );
      // A reset signs out every device and voids any other outstanding reset links.
      await ctx.sessions.revokeAll(c, subjectId);
      await c.query("UPDATE auth_tokens SET used_at = now() WHERE purpose = 'password_reset' AND subject_id = $1 AND used_at IS NULL", [subjectId]);
      return u.rows[0]?.email ?? null;
    });
    if (!emailTo) {
      await strike(ctx, req, 'auth_failed', ipActor(ctx, req));
      throw errors.badRequest('This link is invalid or has expired.');
    }
    await ctx.mailer.send({ to: emailTo, kind: 'password_changed' }).catch(() => {});
    return { ok: true };
  });
}
