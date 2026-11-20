// FD-PUSH: a position closed by its own take profit, told on the user's devices: what the notification says and where a
// tap leads (18 Nov 2026, the user: the trade's notification opened the app and went nowhere).
import { describe, expect, it } from 'vitest';
import { testDb } from '../test/db.ts';
import { silentLogger } from '../log.ts';
import type { AccountsService } from '../exchange/accounts.ts';
import type { Apns } from './apns.ts';
import { PushService, tradeHistoryLink } from './service.ts';

describe('a watched position closed (FD-PUSH)', () => {
  it("a tap opens the trade: its account's history; a share's picture is its company's logo", async () => {
    const db = await testDb();
    let now = 1_800_000_000_000;
    const sent: Record<string, unknown>[] = [];
    const apns = { send: async (_env: string, _token: string, payload: Record<string, unknown>) => (sent.push(payload), { ok: true, status: 200, reason: '' }) } as unknown as Apns;
    const account = Number(
      (await db.run("INSERT INTO exchange_accounts(user_id, exchange, label, api_key, secret, key_hint, env, created_at) VALUES (1, N'etoro', N'eToro', N'x', N'x', N'x', N'live', 1)")).lastInsertRowid,
    );
    const history = {
      supported: true,
      error: null,
      rows: [{ open: false, source: 'account', symbol: 'AAPL', closedAt: now + 4 * 60_000, exit: 200, pnl: 12.4, pnlPct: 2.5, currency: 'USD', reason: null, side: 'long' }],
    };
    const accounts = { tradeHistory: async () => history } as unknown as AccountsService;
    const push = new PushService({ db, log: silentLogger, apns, accounts, now: () => now });
    await push.register(1, 'ab'.repeat(32), 'sandbox');
    await push.watchPosition(1, { accountId: account, market: 'stock', symbol: 'AAPL', side: 'long', sl: 180, tp: 200 });
    now += 5 * 60_000;
    await push.checkWatches();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ link: `/trades#history-${account}`, logo: 'AAPL', logoKind: 'stock' });
    expect((sent[0]!.aps as { alert: { title: string } }).alert.title).toBe('Take profit · AAPL');
    expect(tradeHistoryLink(12)).toBe('/trades#history-12');
  });
});

describe("FIX-PUSHMARGIN: a bot's opening says the sum taken from its budget and the leverage, not the position's value", () => {
  it('„SHORT SPCX · 130,00 USD · levier 5× · la 129,49”', async () => {
    const db = await testDb();
    const sent: Record<string, unknown>[] = [];
    const apns = { send: async (_env: string, _token: string, payload: Record<string, unknown>) => (sent.push(payload), { ok: true, status: 200, reason: '' }) } as unknown as Apns;
    const push = new PushService({ db, log: silentLogger, apns, accounts: {} as unknown as AccountsService, now: () => 1_800_000_000_000 });
    await push.register(1, 'cd'.repeat(32), 'sandbox');
    const row = { id: 4, user_id: 1, name: 'Acțiuni', area: 'stocks', notify: true, config: JSON.stringify({ maxAmount: 1000 }) } as never;
    await push.botRan(row, [{ kind: 'enter', symbol: 'SPCX', message: '', detail: { side: 'short', price: 129.49, qty: 5.0197, leverage: 5, margin: 130 } as never }], []);
    const body = (sent[0]!.aps as { alert: { body: string } }).alert.body;
    expect(body).toBe('SHORT SPCX · 130,00 USD · levier 5× · la 129,49');
    expect(body).not.toMatch(/valoare|650|buget/);
  });
});
