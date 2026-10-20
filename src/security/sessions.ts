import type { Config } from '../config.js';
import type { Db, DbClient } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export type SubjectKind = 'guest' | 'user';
export type Tier = 'guest' | 'user' | 'premium';

export interface Principal {
  subjectId: string;
  kind: SubjectKind;
  tier: Tier;
  premium: boolean;
  premiumUntil: string | null;
  tokenHash: Buffer;
  csrfToken: string;
  via: 'cookie' | 'bearer';
  expiresAt: string;
}

export interface IssuedSession {
  token: string;
  csrfToken: string;
  subjectId: string;
  expiresAt: Date;
}

const TOUCH_INTERVAL_MS = 60_000;

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {}

  cookieName(): string {
    // __Host- prefix forces Secure, Path=/ and no Domain attribute in browsers.
    return this.cfg.cookieSecure ? '__Host-kmy_sid' : 'kmy_sid';
  }

  private lifetimes(kind: SubjectKind) {
    const s = this.cfg.limits.session;
    return kind === 'guest'
      ? { absoluteSec: s.guestAbsoluteDays * 86400, idleSec: s.guestIdleDays * 86400 }
      : { absoluteSec: s.userAbsoluteDays * 86400, idleSec: s.userIdleDays * 86400 };
  }

  async createGuest(): Promise<IssuedSession> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>("INSERT INTO subjects (kind) VALUES ('guest') RETURNING id");
      const issued = await this.issue(client, rows[0]!.id, 'guest');
      await client.query('COMMIT');
      return issued;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Issues a brand-new session token (never reuses an existing one: prevents fixation). */
  async issue(client: DbClient | Db, subjectId: string, kind: SubjectKind): Promise<IssuedSession> {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const { absoluteSec, idleSec } = this.lifetimes(kind);
    const { rows } = await client.query<{ expires_at: Date }>(
      `INSERT INTO sessions (token_hash, subject_id, csrf_token, expires_at, idle_timeout_sec)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5)
       RETURNING expires_at`,
      [sha256(token), subjectId, csrfToken, absoluteSec, idleSec],
    );
    return { token, csrfToken, subjectId, expiresAt: rows[0]!.expires_at };
  }

  /** Returns the principal for a raw token, or null if unknown, revoked, expired or idle-timed-out. */
  async validate(token: string, via: 'cookie' | 'bearer'): Promise<Principal | null> {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
    const tokenHash = sha256(token);
    const { rows } = await this.db.query<{
      subject_id: string;
      kind: SubjectKind;
      csrf_token: string;
      expires_at: Date;
      last_seen_at: Date;
      premium_until: Date | null;
    }>(
      `SELECT s.subject_id, sub.kind, s.csrf_token, s.expires_at, s.last_seen_at,
              CASE WHEN e.plan = 'premium' AND e.status IN ('active', 'canceled') AND e.current_period_end > now()
                   THEN e.current_period_end END AS premium_until
         FROM sessions s
         JOIN subjects sub ON sub.id = s.subject_id
         LEFT JOIN entitlements e ON e.subject_id = s.subject_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.last_seen_at + make_interval(secs => s.idle_timeout_sec) > now()`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;

    if (Date.now() - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.query(
        `WITH t AS (UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1 RETURNING subject_id)
         UPDATE subjects SET last_active_at = now() WHERE id = (SELECT subject_id FROM t)`,
        [tokenHash],
      );
    }

    const premium = row.kind === 'user' && row.premium_until !== null;
    return {
      subjectId: row.subject_id,
      kind: row.kind,
      tier: premium ? 'premium' : row.kind,
      premium,
      premiumUntil: row.premium_until?.toISOString() ?? null,
      tokenHash,
      csrfToken: row.csrf_token,
      via,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async revoke(tokenHash: Buffer): Promise<void> {
    await this.db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash]);
  }

  async revokeAll(client: DbClient | Db, subjectId: string): Promise<void> {
    await client.query('UPDATE sessions SET revoked_at = now() WHERE subject_id = $1 AND revoked_at IS NULL', [subjectId]);
  }
}
