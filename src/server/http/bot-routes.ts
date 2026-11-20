// The trading bots' API (FD-BOT, TD-BOT §5): each user's own bots only (anybody else's are "not found").
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { botEditSchema, botInputSchema, botLevelMoveSchema, botPatchSchema, botStopSchema } from '../../shared/bot.ts';
import type { AppContext } from '../context.ts';
import { formatIssues, ValidationError } from '../settings.ts';
import { me } from './auth.ts';

const idParam = z.object({ id: z.coerce.number().int().positive() });

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError(`Cerere invalidă: ${formatIssues(r.error.issues)}`, r.error.issues);
  return r.data;
}

/**
 * FIX-BOTORDER: the user's order (settings `bots.order`) inside each section, the running then the ended (as the list
 * groups them); the bots it does not name after, as the server lists them (newest first). Pure: tested.
 */
export function orderBots<T extends { id: number; status: string }>(list: readonly T[], order: readonly number[]): T[] {
  const at = new Map<number, number>();
  order.forEach((id, i) => {
    if (!at.has(id)) at.set(id, i);
  });
  const rank = (b: T) => at.get(b.id) ?? order.length;
  return list
    .map((b, i) => ({ b, i }))
    .sort((x, y) => Number(x.b.status === 'ended') - Number(y.b.status === 'ended') || rank(x.b) - rank(y.b) || x.i - y.i)
    .map((x) => x.b);
}

export async function registerBotRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const bots = ctx.bots;
  app.get('/api/bots', async (req) => {
    const id = me(req).id;
    const [list, prefs] = await Promise.all([bots.list(id), ctx.settings.forUser(id)]);
    return orderBots(list, prefs.bots.order);
  });
  // FIX-BOTLEVELS: the levels the real bots keep for their open positions (the chart draws them).
  app.get('/api/bots/levels', async (req) => bots.levels(me(req).id));
  app.get('/api/bots/:id', async (req) => bots.detail(me(req).id, parse(idParam, req.params).id));
  app.post('/api/bots/check', async (req) => bots.check(me(req).id, parse(botInputSchema, req.body)));
  app.post('/api/bots', async (req) => bots.create(me(req).id, parse(botInputSchema, req.body)));
  // FD-BOTEDIT: every setting ({ input, positions }); a page from before it sends the old patch (no `input`).
  const editBody = (body: unknown) => (body && typeof body === 'object' && 'input' in body ? parse(botEditSchema, body) : parse(botPatchSchema, body));
  app.post('/api/bots/:id/check', async (req) => bots.checkEdit(me(req).id, parse(idParam, req.params).id, parse(botEditSchema, req.body)));
  app.put('/api/bots/:id', async (req) => bots.edit(me(req).id, parse(idParam, req.params).id, editBody(req.body)));
  app.post('/api/bots/:id/pause', async (req) => bots.pause(me(req).id, parse(idParam, req.params).id));
  app.post('/api/bots/:id/resume', async (req) => bots.resume(me(req).id, parse(idParam, req.params).id));
  // FIX-BOTDRAG: a stop loss / take profit of the bot's position dragged on the chart.
  app.post('/api/bots/:id/levels', async (req) => bots.moveLevel(me(req).id, parse(idParam, req.params).id, parse(botLevelMoveSchema, req.body)));
  app.post('/api/bots/:id/stop', async (req) => bots.stop(me(req).id, parse(idParam, req.params).id, parse(botStopSchema, req.body).action));
  app.delete('/api/bots/:id', async (req) => {
    await bots.remove(me(req).id, parse(idParam, req.params).id);
    return { ok: true };
  });
}
