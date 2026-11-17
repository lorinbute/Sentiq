// FD-PAPER §7: the bots still simulating (`exec: paper`) move onto a Paper Trading profile of their own: "Paper · <name>",
// their market, 100.000 USD, their commission; their open simulated positions go into it at their entry, and the bot
// trades there from then on (`exec: real` on that account). Without room for a profile, the bot ends. Once per bot, under
// the write lock (a second pass, or a second instance, finds nothing left to move). A bot moving from a real account to
// a simulation (a transition not finished) keeps its real positions with their account: only its settings move.
import type { Db } from '../db/database.ts';
import type { Logger } from '../log.ts';
import { perpetualOf, type BotInput } from '../../shared/bot.ts';
import { commissionText, PAPER_DEFAULT_BUDGET } from '../../shared/paper.ts';
import type { PaperService } from '../paper/service.ts';
import { parseInput, type BotRow } from './engine.ts';
import { basisOf, parseState, type BotState } from './state.ts';

interface Held {
  side: 'long' | 'short';
  qty: number;
  entry: number;
  lev: number;
  mm: 'isolated' | 'cross';
  margin: number;
  fees: number;
  openedAt: number;
}

/** The simulated bot's open positions, per symbol (a grid's filled lines netted into one). */
function heldOf(input: BotInput, st: BotState): Map<string, Held> {
  const out = new Map<string, Held>();
  const mm = (m: string | undefined) => (m === 'cross' ? 'cross' : 'isolated') as 'isolated' | 'cross';
  for (const p of st.premium?.positions ?? []) {
    out.set(p.symbol, { side: p.side, qty: p.qty, entry: p.entry, lev: p.lev, mm: mm(p.mm ?? input.marginMode), margin: p.margin, fees: p.fees, openedAt: p.openedAt });
  }
  const d = st.dca?.deal;
  if (d && d.qty > 0) {
    const lev = d.lev ?? input.leverage;
    out.set(input.symbols[0] as string, { side: d.side, qty: d.qty, entry: d.cost / d.qty, lev, mm: mm(d.mm ?? input.marginMode), margin: d.margin, fees: d.fees, openedAt: d.openedAt });
  }
  const g = st.grid;
  if (g) {
    const filled = g.slots.filter((s) => s.entry !== null);
    const long = filled.filter((s) => s.side === 'long');
    const short = filled.filter((s) => s.side === 'short');
    const net = (long.length - short.length) * g.qty;
    if (Math.abs(net) > 0) {
      const side = net > 0 ? 'long' : 'short';
      const mine = side === 'long' ? long : short;
      const entry = mine.reduce((a, s) => a + (s.entry as number), 0) / mine.length;
      const qty = Math.abs(net);
      out.set(input.symbols[0] as string, { side, qty, entry, lev: g.lev, mm: mm(g.mm ?? input.marginMode), margin: (qty * entry) / g.lev, fees: mine.reduce((a, s) => a + s.fees, 0), openedAt: Math.min(...mine.map((s) => s.openedAt ?? Date.now())) });
    }
  }
  return out;
}

/** Moves every simulating bot not yet ended: how many moved, how many could not be (tried again at the next run). */
export async function migrateSimulatedBots(d: { db: Db; paper: PaperService; log: Logger; maxAccounts: number; now?: () => number }): Promise<{ moved: number; failed: number }> {
  const now = d.now ?? Date.now;
  const ids = await d.db.all<{ id: number }>("SELECT id FROM bots WHERE execution = N'paper' AND status <> N'ended' ORDER BY id");
  let moved = 0;
  let failed = 0;
  for (const { id } of ids) {
    try {
      const done = await d.db.tx(async () => {
        const row = await d.db.get<BotRow>("SELECT * FROM bots WHERE id = ? AND execution = N'paper' AND status <> N'ended'", [id]);
        if (!row) return false;
        const input = parseInput(row);
        const at = now();
        const end = async (reason: string) => {
          await d.db.run("UPDATE bots SET status = N'ended', status_reason = ?, updated_at = ? WHERE id = ?", [reason, at, id]);
          await d.db.run("INSERT INTO bot_events(bot_id, at, kind, symbol, message, detail) VALUES (?, ?, N'end', NULL, ?, NULL)", [id, at, reason]);
          return false;
        };
        if (!input) return end('Simularea se face acum doar cu un cont Paper Trading: fă unul și pornește botul din nou.');
        const n = (await d.db.get<{ n: number }>('SELECT count(*) AS n FROM exchange_accounts WHERE user_id = ?', [row.user_id]))?.n ?? 0;
        if (n >= d.maxAccounts) return end('Simularea se face acum doar cu un cont Paper Trading: fă unul și pornește botul din nou.');
        const label = `Paper · ${row.name}`.slice(0, 60);
        const commission = Math.min(10, Math.max(0, input.fee));
        const accountId = await d.paper.create(row.user_id, { label, kind: input.market === 'stock' ? 'stocks' : 'crypto', budget: PAPER_DEFAULT_BUDGET, commissionType: 'percent', commissionValue: commission }, d.maxAccounts);
        const st = parseState(row.state);
        // The positions open now are the simulation's, unless they run with a real account's settings (state.basis).
        const simulated = !st.basis || st.basis.exec !== 'real';
        // They are held with the settings they opened with (a transition: the old symbol, market, leverage).
        const held = basisOf(st) ?? input;
        // Without SL / TP on the profile: the bot watches its levels and closes by itself, as on any account. A position
        // holds its margin (FIX-PAPERLEV: spot too, its cost at 1×), the money is not spent.
        for (const [sym, h] of simulated ? heldOf(held, st) : []) {
          const symbol = held.market === 'futures' ? perpetualOf(sym) : sym;
          await d.db.run(
            'INSERT INTO paper_positions(account_id, market, symbol, side, qty, entry, leverage, margin_mode, margin, sl, tp, fees, opened_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [accountId, held.market, symbol, h.side, h.qty, h.entry, h.lev, h.mm, h.margin, null, null, h.fees, h.openedAt, at],
          );
        }
        const next = { ...input, exec: 'real' as const, accountId };
        if (st.basis && simulated) st.basis = { ...st.basis, exec: 'real', accountId };
        await d.db.run('UPDATE bots SET execution = N\'real\', account_id = ?, config = ?, state = ?, updated_at = ? WHERE id = ?', [accountId, JSON.stringify(next), JSON.stringify(st), at, id]);
        await d.db.run("INSERT INTO bot_events(bot_id, at, kind, symbol, message, detail) VALUES (?, ?, N'info', NULL, ?, NULL)", [id, at, `Simularea a trecut pe contul Paper Trading „${label}” (100.000 USD, ${commission > 0 ? `comision ${commissionText('percent', commission)}` : 'fără comision'}).`]);
        return true;
      });
      if (done) moved++;
    } catch (err) {
      failed++;
      d.log.warn(`bots: moving bot ${id} to Paper Trading failed (${(err as Error).message})`);
    }
  }
  return { moved, failed };
}
