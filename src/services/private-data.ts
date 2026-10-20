import type { Ctx } from '../context.js';
import { withSubject, type DbClient } from '../db/pool.js';

/**
 * All access to private journal and mood data goes through this module.
 * Every statement is (1) scoped by an explicit owner_id parameter and
 * (2) executed inside withSubject(), so row-level security enforces the same
 * boundary in the database. Text is encrypted with an AAD that binds it to
 * its owner and row id.
 */

export interface JournalInput {
  title: string;
  body: string;
  promptId: string | null;
  mood: number | null;
}

export interface JournalEntry extends JournalInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface MoodEntry {
  id: string;
  mood: number;
  note: string | null;
  createdAt: string;
}

const journalAad = (owner: string, id: string) => `journal:${owner}:${id}`;
const moodAad = (owner: string, id: string) => `mood:${owner}:${id}`;

interface JournalRow {
  id: string;
  owner_id: string;
  key_id: number;
  ciphertext: Buffer;
  prompt_id: string | null;
  mood: number | null;
  created_at: Date;
  updated_at: Date;
}

function decryptJournal(ctx: Ctx, r: JournalRow): JournalEntry {
  const { title, body } = JSON.parse(ctx.cipher.decrypt(r.key_id, r.ciphertext, journalAad(r.owner_id, r.id))) as { title: string; body: string };
  return {
    id: r.id,
    title,
    body,
    promptId: r.prompt_id,
    mood: r.mood,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function countJournal(ctx: Ctx, owner: string): Promise<number> {
  return withSubject(ctx.db, owner, async (c) => {
    const r = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM journal_entries WHERE owner_id = $1', [owner]);
    return Number(r.rows[0]!.n);
  });
}

export async function createJournal(ctx: Ctx, owner: string, input: JournalInput): Promise<JournalEntry> {
  return withSubject(ctx.db, owner, async (c) => {
    const id = (await c.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
    const enc = ctx.cipher.encrypt(JSON.stringify({ title: input.title, body: input.body }), journalAad(owner, id));
    const { rows } = await c.query<JournalRow>(
      `INSERT INTO journal_entries (id, owner_id, key_id, ciphertext, prompt_id, mood)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, owner, enc.keyId, enc.ciphertext, input.promptId, input.mood],
    );
    return decryptJournal(ctx, rows[0]!);
  });
}

export async function listJournal(ctx: Ctx, owner: string, opts: { limit: number; before?: string }): Promise<JournalEntry[]> {
  return withSubject(ctx.db, owner, async (c) => {
    const { rows } = await c.query<JournalRow>(
      `SELECT * FROM journal_entries
        WHERE owner_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
        ORDER BY created_at DESC LIMIT $3`,
      [owner, opts.before ?? null, opts.limit],
    );
    return rows.map((r) => decryptJournal(ctx, r));
  });
}

export async function getJournal(ctx: Ctx, owner: string, id: string): Promise<JournalEntry | null> {
  return withSubject(ctx.db, owner, async (c) => {
    const { rows } = await c.query<JournalRow>('SELECT * FROM journal_entries WHERE id = $1 AND owner_id = $2', [id, owner]);
    return rows[0] ? decryptJournal(ctx, rows[0]) : null;
  });
}

export async function updateJournal(ctx: Ctx, owner: string, id: string, input: JournalInput): Promise<JournalEntry | null> {
  return withSubject(ctx.db, owner, async (c) => {
    const enc = ctx.cipher.encrypt(JSON.stringify({ title: input.title, body: input.body }), journalAad(owner, id));
    const { rows } = await c.query<JournalRow>(
      `UPDATE journal_entries SET key_id = $3, ciphertext = $4, prompt_id = $5, mood = $6, updated_at = now()
        WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [id, owner, enc.keyId, enc.ciphertext, input.promptId, input.mood],
    );
    return rows[0] ? decryptJournal(ctx, rows[0]) : null;
  });
}

export async function deleteJournal(ctx: Ctx, owner: string, id: string): Promise<boolean> {
  return withSubject(ctx.db, owner, async (c) => {
    const r = await c.query('DELETE FROM journal_entries WHERE id = $1 AND owner_id = $2', [id, owner]);
    return (r.rowCount ?? 0) > 0;
  });
}

interface MoodRow {
  id: string;
  owner_id: string;
  mood: number;
  key_id: number | null;
  note_ciphertext: Buffer | null;
  created_at: Date;
}

function decryptMood(ctx: Ctx, r: MoodRow): MoodEntry {
  return {
    id: r.id,
    mood: r.mood,
    note: r.note_ciphertext && r.key_id ? ctx.cipher.decrypt(r.key_id, r.note_ciphertext, moodAad(r.owner_id, r.id)) : null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function createMood(ctx: Ctx, owner: string, mood: number, note: string | null): Promise<MoodEntry> {
  return withSubject(ctx.db, owner, async (c) => {
    const id = (await c.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
    const enc = note ? ctx.cipher.encrypt(note, moodAad(owner, id)) : null;
    const { rows } = await c.query<MoodRow>(
      'INSERT INTO mood_entries (id, owner_id, mood, key_id, note_ciphertext) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, owner, mood, enc?.keyId ?? null, enc?.ciphertext ?? null],
    );
    return decryptMood(ctx, rows[0]!);
  });
}

export async function listMood(ctx: Ctx, owner: string, limit: number): Promise<MoodEntry[]> {
  return withSubject(ctx.db, owner, async (c) => {
    const { rows } = await c.query<MoodRow>('SELECT * FROM mood_entries WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2', [owner, limit]);
    return rows.map((r) => decryptMood(ctx, r));
  });
}

export async function deleteMood(ctx: Ctx, owner: string, id: string): Promise<boolean> {
  return withSubject(ctx.db, owner, async (c) => {
    const r = await c.query('DELETE FROM mood_entries WHERE id = $1 AND owner_id = $2', [id, owner]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** Full export of one subject's data. Ownership comes only from the authenticated principal. */
export async function exportAll(ctx: Ctx, owner: string) {
  return withSubject(ctx.db, owner, async (c) => {
    const journal = await c.query<JournalRow>('SELECT * FROM journal_entries WHERE owner_id = $1 ORDER BY created_at', [owner]);
    const mood = await c.query<MoodRow>('SELECT * FROM mood_entries WHERE owner_id = $1 ORDER BY created_at', [owner]);
    const subject = await c.query<{ kind: string; created_at: Date }>('SELECT kind, created_at FROM subjects WHERE id = $1', [owner]);
    const user = await c.query<{ email: string; email_verified_at: Date; created_at: Date }>(
      'SELECT email, email_verified_at, created_at FROM users WHERE subject_id = $1',
      [owner],
    );
    const ent = await c.query<{ plan: string; status: string; current_period_end: Date | null; provider: string }>(
      'SELECT plan, status, current_period_end, provider FROM entitlements WHERE subject_id = $1',
      [owner],
    );
    return {
      exportedAt: new Date().toISOString(),
      format: 'karamay-export-v1',
      account: {
        kind: subject.rows[0]?.kind ?? null,
        createdAt: subject.rows[0]?.created_at.toISOString() ?? null,
        email: user.rows[0]?.email ?? null,
        emailVerifiedAt: user.rows[0]?.email_verified_at.toISOString() ?? null,
      },
      subscription: ent.rows[0]
        ? { plan: ent.rows[0].plan, status: ent.rows[0].status, currentPeriodEnd: ent.rows[0].current_period_end?.toISOString() ?? null, provider: ent.rows[0].provider }
        : null,
      journal: journal.rows.map((r) => decryptJournal(ctx, r)),
      mood: mood.rows.map((r) => decryptMood(ctx, r)),
      notes: [
        'Chat conversations are not stored on KARAMAY servers, so they are not part of this export.',
        'Entries kept only on your device (local journal) are exported from the app on that device.',
      ],
    };
  });
}

/**
 * Re-encrypts a guest's rows for a new owner. Must run on a client whose
 * transaction has app.subject_id = newOwner and app.merge_from = oldOwner.
 */
export async function reencryptForNewOwner(ctx: Ctx, c: DbClient, oldOwner: string, newOwner: string): Promise<void> {
  const journal = await c.query<JournalRow>('SELECT * FROM journal_entries WHERE owner_id = $1', [oldOwner]);
  for (const r of journal.rows) {
    const plain = ctx.cipher.decrypt(r.key_id, r.ciphertext, journalAad(oldOwner, r.id));
    const enc = ctx.cipher.encrypt(plain, journalAad(newOwner, r.id));
    await c.query('UPDATE journal_entries SET owner_id = $2, key_id = $3, ciphertext = $4 WHERE id = $1 AND owner_id = $5', [
      r.id,
      newOwner,
      enc.keyId,
      enc.ciphertext,
      oldOwner,
    ]);
  }
  const mood = await c.query<MoodRow>('SELECT * FROM mood_entries WHERE owner_id = $1', [oldOwner]);
  for (const r of mood.rows) {
    let keyId: number | null = null;
    let ct: Buffer | null = null;
    if (r.note_ciphertext && r.key_id) {
      const enc = ctx.cipher.encrypt(ctx.cipher.decrypt(r.key_id, r.note_ciphertext, moodAad(oldOwner, r.id)), moodAad(newOwner, r.id));
      keyId = enc.keyId;
      ct = enc.ciphertext;
    }
    await c.query('UPDATE mood_entries SET owner_id = $2, key_id = $3, note_ciphertext = $4 WHERE id = $1 AND owner_id = $5', [
      r.id,
      newOwner,
      keyId,
      ct,
      oldOwner,
    ]);
  }
}
