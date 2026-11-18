// FD-PUSH: the devices that get the user's notifications, and a bot's bell.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { formatIssues, ValidationError } from '../settings.ts';
import { me } from './auth.ts';

const deviceSchema = z.object({ token: z.string().trim().min(32).max(200), env: z.enum(['production', 'sandbox']) }).strict();
const idParam = z.object({ id: z.coerce.number().int().positive() });
const notifySchema = z.object({ on: z.boolean() }).strict();
const level = z.number().positive().finite().nullable();
const positionSchema = z
  .object({ accountId: z.number().int().positive(), market: z.enum(['spot', 'futures', 'stock']), symbol: z.string().trim().min(1).max(80), side: z.enum(['long', 'short']), sl: level, tp: level })
  .strict();
const unwatchSchema = z.object({ accountId: z.number().int().positive(), symbol: z.string().trim().min(1).max(80), side: z.enum(['long', 'short']) }).strict();
const accountQuery = z.object({ accountId: z.coerce.number().int().positive() });

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError(`Cerere invalidă: ${formatIssues(r.error.issues)}`, r.error.issues);
  return r.data;
}

export async function registerPushRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // The app's token after iOS gave it (each launch: a token can change).
  app.post('/api/push/devices', async (req) => {
    const b = parse(deviceSchema, req.body);
    await ctx.push.register(me(req).id, b.token, b.env);
    return { ok: true };
  });
  // Signing out on the device.
  app.post('/api/push/devices/remove', async (req) => {
    const b = parse(z.object({ token: z.string().trim().min(32).max(200) }).strict(), req.body);
    await ctx.push.unregister(me(req).id, b.token);
    return { ok: true };
  });
  // An open position's bell (after its order): watched until its stop loss / take profit closes it.
  const own = async (userId: number, accountId: number) => {
    if (!(await ctx.accounts.owns(userId, accountId))) throw new ValidationError('Contul nu există.');
  };
  app.get('/api/push/watches', async (req) => {
    const { accountId } = parse(accountQuery, req.query);
    await own(me(req).id, accountId);
    return ctx.push.watches(me(req).id, accountId);
  });
  app.post('/api/push/watches', async (req) => {
    const b = parse(positionSchema, req.body);
    await own(me(req).id, b.accountId);
    await ctx.push.watchPosition(me(req).id, b);
    return { ok: true };
  });
  app.post('/api/push/watches/remove', async (req) => {
    const b = parse(unwatchSchema, req.body);
    await own(me(req).id, b.accountId);
    await ctx.push.unwatchPosition(me(req).id, b.accountId, b.symbol, b.side);
    return { ok: true };
  });
  // A bot's bell: its trades opened and closed on the owner's devices.
  app.post('/api/bots/:id/notify', async (req) => ctx.push.setBotNotify(me(req).id, parse(idParam, req.params).id, parse(notifySchema, req.body).on));
}
