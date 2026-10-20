import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { enforce, noStore, parse, requirePrincipal, strike, subjectActor, type Ctx } from '../context.js';
import { errors } from '../lib/errors.js';
import * as data from '../services/private-data.js';
import { clearSessionCookie } from './session.js';

const idParam = z.object({ id: z.uuid() });

export async function dataRoutes(app: FastifyInstance, ctx: Ctx) {
  const L = ctx.cfg.limits;
  const journalBody = z
    .object({
      title: z.string().trim().max(L.journal.maxTitleChars).default(''),
      body: z.string().trim().min(1).max(L.journal.maxBodyChars),
      promptId: z.string().regex(/^[a-z0-9-]{1,64}$/).nullable().default(null),
      mood: z.number().int().min(1).max(5).nullable().default(null),
    })
    .strict();

  /** Unknown and foreign ids get the same 404, so ids of other people's entries cannot be probed. */
  const notFound = async (req: Parameters<typeof strike>[1]) => {
    await strike(ctx, req, 'forbidden_access');
    return errors.notFound('Entry not found.');
  };

  // ---- Journal -------------------------------------------------------------
  app.get('/api/journal', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    const q = await parse(ctx, req, z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), before: z.iso.datetime().optional() }).strict(), req.query);
    return { entries: await data.listJournal(ctx, p.subjectId, q) };
  });

  app.post('/api/journal', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    await enforce(ctx, req, `journal-write:${p.subjectId}`, L.journalWrite);
    const body = await parse(ctx, req, journalBody, req.body);
    if ((await data.countJournal(ctx, p.subjectId)) >= L.journal.maxEntriesPerSubject) {
      throw errors.conflict('Your journal has reached its storage limit. Export or delete older entries to add more.');
    }
    reply.code(201);
    return { entry: await data.createJournal(ctx, p.subjectId, body) };
  });

  app.get('/api/journal/:id', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    const { id } = await parse(ctx, req, idParam, req.params);
    const entry = await data.getJournal(ctx, p.subjectId, id);
    if (!entry) throw await notFound(req);
    return { entry };
  });

  app.put('/api/journal/:id', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    await enforce(ctx, req, `journal-write:${p.subjectId}`, L.journalWrite);
    const { id } = await parse(ctx, req, idParam, req.params);
    const body = await parse(ctx, req, journalBody, req.body);
    const entry = await data.updateJournal(ctx, p.subjectId, id, body);
    if (!entry) throw await notFound(req);
    return { entry };
  });

  app.delete('/api/journal/:id', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    const { id } = await parse(ctx, req, idParam, req.params);
    if (!(await data.deleteJournal(ctx, p.subjectId, id))) throw await notFound(req);
    return { deleted: true };
  });

  // ---- Mood ----------------------------------------------------------------
  app.get('/api/mood', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    const q = await parse(ctx, req, z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) }).strict(), req.query);
    return { entries: await data.listMood(ctx, p.subjectId, q.limit) };
  });

  app.post('/api/mood', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    await enforce(ctx, req, `mood-write:${p.subjectId}`, L.moodWrite);
    const body = await parse(ctx, req, z.object({ mood: z.number().int().min(1).max(5), note: z.string().trim().max(500).nullable().default(null) }).strict(), req.body);
    reply.code(201);
    return { entry: await data.createMood(ctx, p.subjectId, body.mood, body.note || null) };
  });

  app.delete('/api/mood/:id', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    const { id } = await parse(ctx, req, idParam, req.params);
    if (!(await data.deleteMood(ctx, p.subjectId, id))) throw await notFound(req);
    return { deleted: true };
  });

  // ---- Data rights ------------------------------------------------------------
  app.get('/api/me/export', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    await enforce(ctx, req, `export:${p.subjectId}`, L.export);
    const payload = await data.exportAll(ctx, p.subjectId);
    reply.header('content-disposition', `attachment; filename="karamay-export-${payload.exportedAt.slice(0, 10)}.json"`);
    return payload;
  });

  /**
   * Permanently deletes the caller's subject and everything that cascades from it
   * (sessions, journal, mood, entitlements, pending tokens). Accounts must
   * re-enter their password; guests confirm with the literal word.
   */
  app.delete('/api/me', async (req, reply) => {
    noStore(reply);
    const p = requirePrincipal(req);
    await enforce(ctx, req, `delete:${p.subjectId}`, L.deleteAccount);
    const body = await parse(ctx, req, z.object({ confirm: z.literal('DELETE'), password: z.string().max(256).optional() }).strict(), req.body);
    let hadSubscription = false;
    if (p.kind === 'user') {
      const u = await ctx.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE subject_id = $1', [p.subjectId]);
      if (!body.password || !u.rows[0] || !(await argon2.verify(u.rows[0].password_hash, body.password))) {
        await strike(ctx, req, 'auth_failed', subjectActor(p));
        throw errors.forbidden('Password is incorrect.');
      }
      const e = await ctx.db.query("SELECT 1 FROM entitlements WHERE subject_id = $1 AND status IN ('active', 'past_due')", [p.subjectId]);
      hadSubscription = (e.rowCount ?? 0) > 0;
    }
    await ctx.db.query('DELETE FROM subjects WHERE id = $1', [p.subjectId]);
    clearSessionCookie(ctx, reply);
    ctx.log.info({ evt: 'account_deleted', kind: p.kind }, 'subject deleted by owner');
    return {
      deleted: true,
      ...(hadSubscription
        ? { subscriptionNotice: 'Your data is deleted. If you had an active subscription, cancel it with the store or payment provider to stop future charges.' }
        : {}),
    };
  });
}
