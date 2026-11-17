// FD-TRADES: the „Istoric tranzacții” panel: its rows, its notes; the two panels it replaces are gone from Trades.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { TradeHistory, TradeHistoryRow } from '../shared/api-types.ts';
import { FROM_JOURNAL, HistoryCards, HistoryTable, historyNotes, marketText } from './components/TradeHistory.tsx';

const T = Date.parse('2026-11-09T10:00:00Z');
const row = (r: Partial<TradeHistoryRow> & Pick<TradeHistoryRow, 'key'>): TradeHistoryRow => ({
  source: 'bot',
  bot: { id: 2, name: 'Crypto' },
  open: false,
  symbol: 'LTC/USDT',
  market: 'futures',
  side: 'short',
  qty: 17.6,
  leverage: 3,
  entry: 51.07,
  exit: 50.49,
  sl: 52.1122,
  tp: 50.5678,
  pnl: 8.42,
  pnlPct: 2.81,
  margin: 299.61,
  currency: 'USDT',
  openedAt: T - 4 * 3_600_000,
  closedAt: T,
  reason: 'take profit',
  ...r,
});
const render = (rows: TradeHistoryRow[], kind: 'crypto' | 'stocks' = 'crypto') =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HistoryTable, { rows, account: { kind }, tz: 'Europe/Bucharest' })));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('FIX-HISTAMOUNT: „Sumă” instead of „Mărime” on a crypto account; a broker keeps „Mărime”', () => {
  it('the table and the phone card: the margin in dollars (or the coin), a dash when unknown; the shares as before', () => {
    const t = text(render([row({ key: 'b|7' }), row({ key: 'b|8', margin: null }), row({ key: 'a|9', symbol: 'BTC/USD', currency: 'BTC', margin: 0.0001 })]));
    expect(render([row({ key: 'b|7' })])).toContain('>Sumă</th>');
    expect(render([row({ key: 'b|7' })])).not.toContain('>Mărime</th>');
    expect(t).toContain('299,61');
    expect(t).toContain('0,0001 BTC');
    expect(t).not.toContain('17,6 ');
    const stocks = render([row({ key: 'a|1', symbol: 'NVDA', market: 'stock', qty: 3, margin: 540, currency: 'USD' })], 'stocks');
    expect(stocks).toContain('>Mărime</th>');
    expect(text(stocks)).toContain(' 3 ');
    const card = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HistoryCards, { rows: [row({ key: 'b|7' })], account: { kind: 'crypto' }, tz: 'Europe/Bucharest' })));
    expect(text(card)).toContain('Sumă 299,61');
    expect(card).toContain('title="Banii luați din disponibil de tranzacție: marja, fără levier."');
  });
});

describe('FD-TRADES: the history panel', () => {
  it('a row has every column of the request: the symbol and who made it, the market, the side, the size, entry, SL, TP, exit and why, PnL, the times', () => {
    const html = render([row({ key: 'b|7' })]);
    const t = text(html);
    // FIX-HISTAMOUNT: „Sumă” (the margin) on a crypto account.
    for (const h of ['Simbol', 'Piață', 'Direcție', 'Sumă', 'Intrare', 'SL', 'TP', 'Ieșire', 'PnL', 'Intrat', 'Ieșit']) expect(html).toContain(`>${h}</th>`);
    expect(t).toContain('LTC/USDT');
    expect(t).toContain('Bot Crypto');
    expect(t).toContain('Futures 3×');
    expect(t).toContain('Short');
    expect(t).toContain('299,61');
    expect(t).toContain('51,0700');
    expect(t).toContain('52,1122');
    expect(t).toContain('50,5678');
    expect(t).toContain('50,4900');
    expect(t).toContain('take profit');
    expect(t).toContain('+8,42 USDT');
    expect(t).toContain('+2,81%');
    // In the user's zone: 10:00 UTC is 12:00 in Bucharest.
    expect(t).toContain('09 nov., 12:00');
    expect(t).toContain('09 nov., 08:00');
    expect(html).toContain('href="/charts/LTC/USDT"');
  });

  it('an open trade: „deschisă”, the PnL „nerealizat”, no exit time; a platform row: „din cont”, a dash that says why', () => {
    const t = text(render([row({ key: 'o|2|0', open: true, exit: null, closedAt: null, reason: null, pnl: -1.5, pnlPct: -0.5 })]));
    expect(t).toContain('deschisă');
    expect(t).toContain('−1,50 USDT');
    expect(t).toContain('−0,50% · nerealizat');
    const html = render([row({ key: 'a|1', source: 'account', bot: null, sl: null, tp: null, reason: null, side: null })]);
    expect(text(html)).toContain('din cont');
    expect(html).toContain('title="Exchange-ul nu păstrează SL / TP în istoricul pozițiilor."');
    expect(html).toContain('>—</td>');
  });

  it('shares in cents, without the currency; a CFD with its leverage; an unknown instrument has no chart link', () => {
    const html = render([row({ key: 'a|9', source: 'account', bot: null, symbol: 'NVDA', market: 'cfd', leverage: 5, side: 'long', entry: 171.2, exit: 175.5, sl: 150, tp: null, currency: 'USD' }), row({ key: 'a|10', source: 'account', bot: null, symbol: '#3003', market: 'stock', leverage: 1 })], 'stocks');
    const t = text(html);
    expect(t).toContain('CFD 5×');
    expect(t).toContain('171,20');
    expect(t).toContain('150,00');
    expect(html).toContain('href="/charts/s/NVDA"');
    expect(html).not.toContain('href="/charts/s/%233003"');
    expect(html).toContain('title="Brokerul nu îl dă în istoric."');
  });

  it('on a phone, a card per trade with the same values, none off to the side', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HistoryCards, { rows: [row({ key: 'b|7' }), row({ key: 'o|1', open: true, exit: null, closedAt: null, reason: null })], account: { kind: 'crypto' }, tz: 'Europe/Bucharest' })));
    const t = text(html);
    expect(html.match(/<li /g)).toHaveLength(2);
    for (const label of ['Intrare', 'Ieșire', 'SL', 'TP', 'Intrat', 'Ieșit', 'Sumă', 'Făcută de']) expect(html).toContain(`<dt class="text-[11.5px] text-faint">${label}</dt>`);
    expect(t).toContain('Short · Futures 3×');
    expect(t).toContain('51,0700');
    expect(t).toContain('52,1122');
    expect(t).toContain('50,5678');
    expect(t).toContain('take profit');
    expect(t).toContain('+8,42 USDT');
    expect(t).toContain('Bot Crypto');
    expect(t).toContain('deschisă');
    expect(t).toContain('Intrat 09 nov., 08:00 Ieșit 09 nov., 12:00');
  });

  it('FIX-TRADESOLD: levels taken from the orders sent from Sentiq say so, on the market, the SL and the TP', () => {
    const r = row({ key: 'a|1', source: 'account', bot: null, fromJournal: ['leverage', 'sl', 'tp'] });
    for (const html of [render([r]), renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HistoryCards, { rows: [r], account: { kind: 'crypto' }, tz: 'Europe/Bucharest' })))]) {
      expect(html.split(`title="${FROM_JOURNAL}"`)).toHaveLength(4);
    }
    // Only what came from the journal: the platform's SL says nothing of it.
    const tpOnly = render([row({ key: 'a|3', source: 'account', bot: null, fromJournal: ['tp'] })]);
    expect(tpOnly.split(`title="${FROM_JOURNAL}"`)).toHaveLength(2);
    expect(tpOnly).toContain(`<span class="text-bull" title="${FROM_JOURNAL}">50,5678</span>`);
    expect(render([row({ key: 'a|2', source: 'account', bot: null })])).not.toContain(FROM_JOURNAL);
  });

  it('the market: futures with any leverage, a CFD or a derivative above 1×, the rest plain', () => {
    expect(marketText({ market: 'futures', leverage: 1 })).toBe('Futures 1×');
    expect(marketText({ market: 'futures', leverage: null })).toBe('Futures');
    expect(marketText({ market: 'cfd', leverage: 1 })).toBe('CFD');
    expect(marketText({ market: 'other', leverage: 2 })).toBe('Derivat 2×');
    expect(marketText({ market: 'spot', leverage: 1 })).toBe('Spot');
    expect(marketText({ market: 'stock', leverage: 1 })).toBe('Acțiuni');
    expect(marketText({ market: 'crypto', leverage: 1 })).toBe('Crypto');
  });

  it('the notes: no platform history, an unreadable one, IBKR, a history too long, too many rows', () => {
    const h: TradeHistory = { period: '30d', from: T - 30 * 86_400_000, to: T, rows: [], truncated: false, supported: true, error: null, limited: false, asOf: null, fetchedAt: T };
    expect(historyNotes(h, { exchange: 'kucoin', kind: 'crypto' })).toEqual([]);
    expect(historyNotes({ ...h, supported: false }, { exchange: 'binance', kind: 'crypto' })).toEqual(['Binance nu dă prin API istoricul pozițiilor închise: aici apar doar tranzacțiile boților Sentiq.']);
    expect(historyNotes({ ...h, error: { code: 'NETWORK', message: 'x' } }, { exchange: 'kucoin', kind: 'crypto' })).toEqual(['Istoricul contului nu s-a putut citi (problemă de rețea): se văd doar tranzacțiile boților.']);
    expect(historyNotes({ ...h, error: { code: 'AUTH', message: 'Invalid KC-API-KEY' } }, { exchange: 'kucoin', kind: 'crypto' })[0]).toBe('Istoricul contului nu s-a putut citi (cheia API e invalidă sau a expirat: Invalid KC-API-KEY): se văd doar tranzacțiile boților.');
    expect(historyNotes({ ...h, asOf: Date.parse('2026-11-06T21:00:00Z') }, { exchange: 'ibkr', kind: 'stocks' })).toEqual(['Datele contului: până la închiderea bursei de vineri, 6 noiembrie.']);
    expect(historyNotes({ ...h, from: T, asOf: T - 86_400_000 }, { exchange: 'ibkr', kind: 'stocks' })[0]).toMatch(/^Interactive Brokers trimite tranzacțiile unei zile după închiderea ei/);
    expect(historyNotes({ ...h, limited: true, truncated: true }, { exchange: 'etoro', kind: 'stocks' })).toEqual(['Istoricul contului e prea lung: Sentiq a citit doar o parte din el.', 'Sunt mai multe tranzacții decât se pot afișa: se văd cele mai recente.']);
  });

  it('FIX-TRADESWITCH: no two children of the Trades page share a key (they would stay on screen when the account changes)', () => {
    const page = readFileSync('src/web/pages/Trades.tsx', 'utf8');
    const view = page.slice(page.indexOf('function AccountsView'));
    const keys = [...view.matchAll(/^\s*<[A-Z][A-Za-z]*\b[^>]*?\skey=\{([^}]*(?:\}[^}]*)?)\}/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the Trades page has the history in place of „Tranzacții recente” and „Ordinele trimise din Sentiq”', () => {
    const page = readFileSync('src/web/pages/Trades.tsx', 'utf8');
    expect(page).toContain('<TradeHistoryPanel key={`history-${current.id}`} account={current} period={period} />');
    expect(page).not.toContain('Tranzacții recente');
    expect(page).not.toContain('TradeJournal');
    expect(readFileSync('src/web/components/TradingControls.tsx', 'utf8')).not.toContain('title="Ordinele trimise din Sentiq"');
  });
});
