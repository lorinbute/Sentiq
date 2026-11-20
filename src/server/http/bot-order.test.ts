// FIX-BOTORDER: the bots in the user's order, inside each section (the running, then the ended).
import { describe, expect, it } from 'vitest';
import { orderBots } from './bot-routes.ts';
import { settingsSchema } from '../../shared/settings.ts';

const bot = (id: number, status = 'running') => ({ id, status });

describe('the bots in the user order (FIX-BOTORDER)', () => {
  // As the server lists them: the running first, newest first; the ended after.
  const listed = [bot(5), bot(4, 'paused'), bot(3), bot(2, 'ended'), bot(1, 'ended')];

  it('keeps the server order without one', () => {
    expect(orderBots(listed, []).map((b) => b.id)).toEqual([5, 4, 3, 2, 1]);
  });

  it('puts the named ones first in their order, inside each section; the others after, as listed', () => {
    expect(orderBots(listed, [3]).map((b) => b.id)).toEqual([3, 5, 4, 2, 1]);
    expect(orderBots(listed, [1, 3, 5]).map((b) => b.id)).toEqual([3, 5, 4, 1, 2]);
    // An ended bot named first stays among the ended; a deleted id and a repeated one change nothing.
    expect(orderBots(listed, [1, 99, 4, 1]).map((b) => b.id)).toEqual([4, 5, 3, 1, 2]);
  });

  it('is a setting of its own: empty by default, ids only', () => {
    expect(settingsSchema.parse({}).bots).toEqual({ order: [] });
    expect(settingsSchema.parse({ bots: { order: [3, 1] } }).bots.order).toEqual([3, 1]);
    expect(settingsSchema.safeParse({ bots: { order: ['x'] } }).success).toBe(false);
    expect(settingsSchema.safeParse({ bots: { order: [0] } }).success).toBe(false);
  });
});
