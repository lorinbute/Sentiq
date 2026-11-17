// Trading bots (FD-BOT, TD-BOT §2): their settings (the same rules on the page and on the server), the plans the form and
// the engine both compute (a grid's lines and quantity, a DCA's orders), and what the API returns.
import { z } from 'zod';
import { TIMEFRAMES, type Timeframe } from './time.ts';

export const BOT_STRATEGIES = ['grid', 'dca', 'premium'] as const;
export type BotStrategy = (typeof BOT_STRATEGIES)[number];
export type BotExec = 'paper' | 'real';
export type BotMarket = 'spot' | 'futures' | 'stock';
export type BotArea = 'crypto' | 'stocks';
export const BOT_STATUSES = ['scheduled', 'running', 'paused', 'problem', 'ending', 'ended'] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];
export type BotEndAction = 'close' | 'finish' | 'leave';
export type BotSide = 'long' | 'short';
export type BotTradeReason = 'tp' | 'sl' | 'tp_signal' | 'flip' | 'opposite' | 'grid' | 'end' | 'stop' | 'liquidation' | 'external' | 'loss_limit' | 'grid_stop' | 'edit';
/** FD-BOTEDIT §3: what becomes of the positions the new settings cannot keep (they finish with the old ones, or close now). */
export type PositionsMode = 'finish' | 'close';
export type BotEventKind = 'start' | 'signal' | 'skip' | 'enter' | 'exit' | 'order' | 'problem' | 'info' | 'end';
/** FIX-BOTMARGIN: the margin of a futures bot's positions (Isolated unless Cross is chosen). */
export const BOT_MARGIN_MODES = ['isolated', 'cross'] as const;
export type BotMarginMode = (typeof BOT_MARGIN_MODES)[number];
export const MARGIN_RO: Record<BotMarginMode, string> = { isolated: 'Isolated', cross: 'Cross' };
export const MARGIN_HINT_RO: Record<BotMarginMode, string> = { isolated: 'Fiecare poziție își riscă doar marja ei.', cross: 'Pozițiile folosesc tot soldul futures al contului.' };
/** FIX-PAPERLEV: on a Paper Trading profile Cross is the profile's money, on every market. */
export const MARGIN_HINT_PAPER_RO: Record<BotMarginMode, string> = { isolated: MARGIN_HINT_RO.isolated, cross: 'Pozițiile folosesc toți banii profilului.' };

/** Bots a user may have that have not ended (FD-BOT §3). */
export const MAX_ACTIVE_BOTS = 10;
export const MAX_BOT_SYMBOLS = 10;
/** How often the engine looks (FD-BOT §8). */
export const BOT_TICK_MS = 30_000;
/** The maintenance margin taken for the liquidation distance (FD-BOT §6). */
export const MAINT_MARGIN = 0.005;
/** The SL must sit within this share of the liquidation distance (FD-BOT §6). */
export const LIQ_SAFETY = 0.8;

export const STRATEGY_RO: Record<BotStrategy, string> = { grid: 'Grid', dca: 'DCA', premium: 'Slingshot' };
export const STATUS_RO: Record<BotStatus, string> = { scheduled: 'Programat', running: 'Rulează', paused: 'Pauză', problem: 'Problemă', ending: 'Se încheie', ended: 'Încheiat' };
export const END_ACTION_RO: Record<BotEndAction, string> = { close: 'Închide pozițiile', finish: 'Termină tranzacțiile deschise', leave: 'Lasă pozițiile deschise' };
export const TRADE_REASON_RO: Record<BotTradeReason, string> = {
  tp: 'take profit',
  sl: 'stop loss',
  tp_signal: 'semnal TP',
  flip: 'invalidare',
  opposite: 'semnal opus',
  grid: 'grilă',
  end: 'sfârșit',
  stop: 'oprire',
  liquidation: 'lichidare',
  external: 'din afară',
  loss_limit: 'pierderea maximă',
  grid_stop: 'oprește sub / peste',
  edit: 'setări noi',
};

export const WEIGHT_KEYS = ['day', 'area', 'general', 'symbol', 'slingshot'] as const;
export type WeightKey = (typeof WEIGHT_KEYS)[number];
export const WEIGHT_RO: Record<WeightKey, string> = { day: 'Scorul zilei', area: 'Aria', general: 'Sentimentul general', symbol: 'Știrile simbolului', slingshot: 'Slingshot' };
export const DEFAULT_WEIGHTS: Record<WeightKey, number> = { day: 20, area: 30, general: 15, symbol: 15, slingshot: 20 };

const number = (label: string, min: number, max: number) =>
  z
    .number({ error: `${label}: lipsește` })
    .finite(`${label}: lipsește`)
    .min(min, `${label}: cel puțin ${String(min).replace('.', ',')}`)
    .max(max, `${label}: cel mult ${String(max).replace('.', ',')}`);
const whole = (label: string, min: number, max: number) => number(label, min, max).int(`${label}: un număr întreg`);
const positive = (label: string) => z.number({ error: `${label}: lipsește` }).finite(`${label}: lipsește`).positive(`${label} trebuie să fie pozitiv`);

/** A coin pair as the charts name it (BTC/USDT), or a share (AAPL). */
export const CRYPTO_PAIR_RE = /^[A-Z0-9][A-Z0-9.-]{0,19}\/[A-Z0-9]{2,10}$/;
export const STOCK_TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

export const gridSchema = z
  .object({
    lower: positive('Limita de jos'),
    upper: positive('Limita de sus'),
    grids: whole('Grilele', 2, 100),
    spacing: z.enum(['arithmetic', 'geometric']),
    direction: z.enum(['long', 'short', 'neutral']),
    stopBelow: positive('Oprește sub').nullable(),
    stopAbove: positive('Oprește peste').nullable(),
    trigger: positive('Prețul de pornire').nullable(),
  })
  .strict();
export type GridConfig = z.infer<typeof gridSchema>;

export const dcaSchema = z
  .object({
    direction: z.enum(['long', 'short']),
    baseOrder: positive('Ordinul de bază'),
    safetyOrders: whole('Ordinele de siguranță', 0, 25),
    safetyOrder: positive('Primul ordin de siguranță'),
    volumeScale: number('Multiplicatorul de volum', 1, 5),
    deviation: number('Abaterea până la primul', 0.1, 50),
    stepScale: number('Multiplicatorul de pas', 0.5, 5),
    takeProfit: number('Take profit', 0.1, 100),
    stopLoss: number('Stop loss', 0.1, 99).nullable(),
    slAction: z.enum(['restart', 'stop']),
    repeat: z.boolean(),
    maxCycles: whole('Ciclurile', 1, 100_000).nullable(),
    cooldownMin: whole('Pauza între cicluri', 0, 10_080),
  })
  .strict();
export type DcaConfig = z.infer<typeof dcaSchema>;

/**
 * Settings saved before, so they still read; the next save writes them the new way.
 * - Before FD-BOTPCT (a stop loss and a take profit chosen apart, a ratio, a minimum R:R): "Risc / câștig" becomes the
 *   stop's percent and the take profit's (the stop's times the ratio, the same levels).
 * - Before FD-BOTDIR (one minimum M of the trade's score): on the market's scale, a long from M up, a short from
 *   100 − M down, the same entries.
 */
const upgradePremium = (v: unknown): unknown => {
  if (!v || typeof v !== 'object') return v;
  let o = v as Record<string, unknown>;
  if (!('levels' in o)) {
    const { sl: _sl, tp, rr, rrRisk, rrReward, minRr: _minRr, ...rest } = o;
    const ratio = typeof rrReward === 'number' && typeof rrRisk === 'number' && rrRisk > 0 ? rrReward / rrRisk : typeof rr === 'number' ? rr : 2;
    const slPct = typeof rest.slPct === 'number' ? rest.slPct : 1;
    o = { ...rest, levels: tp === 'rr' ? 'percent' : 'slingshot', slPct, tpPct: Number((slPct * ratio).toFixed(8)) };
  }
  if ('minScore' in o) {
    const { minScore, ...rest } = o;
    // Both ways at once: the thresholds win. A minimum that is not a number fails as the long's threshold.
    o = 'longMin' in rest ? rest : { ...rest, longMin: minScore, shortMax: typeof minScore === 'number' ? 100 - minScore : minScore };
  }
  // FIX-BOTBUDGET: one maximum a trade. A fixed amount kept as its maximum (the lower of the two when both were set);
  // a risk sizing its maximum, else its amount.
  if ('sizing' in o || 'amount' in o || 'riskPct' in o) {
    const { sizing, amount, riskPct: _riskPct, ...rest } = o;
    const cap = typeof rest.maxPerTrade === 'number' ? rest.maxPerTrade : null;
    const fixed = typeof amount === 'number' ? amount : null;
    const maxPerTrade = sizing === 'risk' ? (cap ?? fixed) : fixed !== null && cap !== null ? Math.min(fixed, cap) : (fixed ?? cap);
    o = { ...rest, maxPerTrade };
  }
  return o;
};

/** FIX-BOTBUDGET: what a trade must bring at its take profit, after the commissions, for the bot to open it (USD). */
export const MIN_TRADE_PROFIT = 10;

/** The currencies counted as dollars: the minimum profit read in them as it is (in another, at its USDT price). */
const USD_QUOTES = new Set(['USD', 'USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDE', 'USDP', 'PYUSD', 'USD1', 'USDD']);
export const isUsdQuote = (c: string): boolean => USD_QUOTES.has(c.toUpperCase());

export const premiumSchema = z.preprocess(
  upgradePremium,
  z.object({
    direction: z.enum(['long', 'short', 'both']),
    /**
     * FIX-BOTSHORTS: at the close of the first bar with Slingshot's setup forming (its levels moved to the signal's at the
     * confirmation), or only on the confirmed signal. Absent in the bots saved before it: the setup.
     */
    entry: z.enum(['setup', 'signal']).default('setup'),
    /** FIX-BOTBUDGET: the most a trade takes from the bot's budget (its margin); the bot decides how much within it. */
    maxPerTrade: positive('Suma maximă pe tranzacție'),
    /** FD-BOTPCT: the signal's stop loss and take profit, or "Risc / câștig": one's own, in percent from the entry. */
    levels: z.enum(['slingshot', 'percent']),
    slPct: number('Stop loss-ul', 0.1, 50),
    tpPct: number('Take profit-ul', 0.1, 500),
    exitOnTpSignal: z.boolean(),
    exitOnFlip: z.boolean(),
    exitOnOpposite: z.boolean(),
    /** FD-BOTDIR: on the market's score, a long enters from this up, a short from `shortMax` down. */
    longMin: whole('Scorul minim pentru long', 0, 100),
    shortMax: whole('Scorul maxim pentru short', 0, 100),
    areaVeto: z.boolean(),
    newsWindowMin: whole('Minutele dinaintea știrilor economice importante', 0, 720),
    weights: z
      .object({
        day: whole('Ponderea scorului zilei', 0, 100),
        area: whole('Ponderea ariei', 0, 100),
        general: whole('Ponderea sentimentului general', 0, 100),
        symbol: whole('Ponderea știrilor simbolului', 0, 100),
        slingshot: whole('Ponderea Slingshot', 0, 100),
      })
      .strict(),
    ai: z.enum(['off', 'confirm']),
    aiFallback: z.enum(['skip', 'rules']),
    maxOpen: whole('Tranzacțiile deschise odată', 1, MAX_BOT_SYMBOLS),
    cooldownMin: whole('Pauza după o pierdere', 0, 10_080),
  })
  .strict(),
);
export type PremiumConfig = z.infer<typeof premiumSchema>;
/** FIX-BOTSHORTS: the entry, as the form and the summary say it. */
export const ENTRY_RO: Record<PremiumConfig['entry'], string> = { setup: 'La setup', signal: 'La confirmare' };

const common = {
  name: z.string().trim().min(1, 'Numele lipsește').max(60, 'Numele: cel mult 60 de caractere'),
  exec: z.enum(['paper', 'real']),
  accountId: z.number().int().positive().nullable(),
  market: z.enum(['spot', 'futures', 'stock']),
  symbols: z
    .array(z.string().trim().toUpperCase().min(1, 'Simbolul lipsește').max(40))
    .min(1, 'Alege cel puțin un simbol')
    .max(MAX_BOT_SYMBOLS, `Cel mult ${MAX_BOT_SYMBOLS} simboluri`),
  tf: z.enum(TIMEFRAMES),
  maxAmount: positive('Suma maximă'),
  leverage: whole('Levierul', 1, 125),
  /** FIX-BOTMARGIN: futures only; the settings saved before it (and the pages sending none) are Isolated. */
  marginMode: z.enum(BOT_MARGIN_MODES).default('isolated'),
  /** null: now. */
  startsAt: z.number().int().nonnegative().nullable(),
  /** null: no end. */
  endsAt: z.number().int().positive().nullable(),
  endAction: z.enum(['close', 'finish', 'leave']),
  dailyLoss: positive('Pierderea maximă pe zi').nullable(),
  lossStop: positive('Pierderea la care se oprește').nullable(),
  /** Per execution, in percent: the estimate of the platform's (a Paper Trading profile's fills take its own). */
  fee: number('Comisionul', 0, 1),
};

/** The area of a market: a bot trades either coins or shares. */
export const areaOf = (market: BotMarket): BotArea => (market === 'stock' ? 'stocks' : 'crypto');

/** FIX-PAPERLEV: on a real account's spot (a Paper Trading profile shorts and leverages everything). Said by the check. */
export const SPOT_LONG = 'Pe spot nu se poate short: doar Long (short pe futures, pe acțiuni sau pe un profil Paper Trading).';
export const LEVERAGE_FUTURES = 'Levierul se aplică doar pe futures (pe spot și pe acțiuni, doar pe un profil Paper Trading).';
export const MARGIN_FUTURES = 'Marja se alege doar pe futures (pe spot și pe acțiuni, doar pe un profil Paper Trading).';

/** The side a bot's settings may open short on (FD-BOT §3–§6): a grid not only long, a short DCA, a Slingshot not only long. */
export const wantsShort = (b: { strategy: BotStrategy; grid?: GridConfig; dca?: DcaConfig; premium?: PremiumConfig }): boolean =>
  b.strategy === 'grid' ? b.grid?.direction !== 'long' : b.strategy === 'dca' ? b.dca?.direction === 'short' : b.premium?.direction !== 'long';

/**
 * The rules across fields (FD-BOT §3–§6), shared by the form and the server. FIX-PAPERLEV: the leverage, the margin and a
 * short on spot depend on the account (a Paper Trading profile allows them everywhere): the server's check says them.
 */
function checkBot(b: BotInputBase & { grid?: GridConfig; dca?: DcaConfig; premium?: PremiumConfig }, ctx: z.RefinementCtx): void {
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const area = areaOf(b.market);
  const seen = new Set<string>();
  b.symbols.forEach((s, i) => {
    if (area === 'stocks' ? !STOCK_TICKER_RE.test(s) : !CRYPTO_PAIR_RE.test(s)) fail(['symbols', i], area === 'stocks' ? `„${s}” nu e simbolul unei acțiuni (AAPL)` : `„${s}” nu e o pereche crypto (BTC/USDT)`);
    if (seen.has(s)) fail(['symbols', i], `„${s}” apare de două ori`);
    seen.add(s);
  });
  if (b.exec === 'real' && b.accountId === null) fail(['accountId'], 'Alege contul în care tranzacționează botul.');
  if (b.exec === 'paper' && b.accountId !== null) fail(['accountId'], 'Simularea nu folosește un cont.');
  if (b.startsAt !== null && b.endsAt !== null && b.endsAt <= b.startsAt) fail(['endsAt'], 'Sfârșitul trebuie să fie după început.');
  if (b.strategy !== 'premium' && b.symbols.length !== 1) fail(['symbols'], `Un bot ${STRATEGY_RO[b.strategy]} are un singur simbol.`);
  if (b.strategy === 'grid' && b.grid) {
    const g = b.grid;
    if (b.endAction === 'finish') fail(['endAction'], 'O grilă nu are tranzacții de terminat: alege „Închide pozițiile” sau „Lasă pozițiile deschise”.');
    if (g.lower >= g.upper) fail(['grid', 'upper'], 'Limita de sus trebuie să fie peste cea de jos.');
    if (g.stopBelow !== null && g.stopBelow >= g.lower) fail(['grid', 'stopBelow'], '„Oprește sub” trebuie să fie sub limita de jos.');
    if (g.stopAbove !== null && g.stopAbove <= g.upper) fail(['grid', 'stopAbove'], '„Oprește peste” trebuie să fie peste limita de sus.');
    if (g.lower < g.upper) {
      const step = gridProfit(g, b.fee);
      if (step.min <= 0) fail(['grid', 'grids'], 'Pasul unei grile nu acoperă comisioanele: mai puține grile sau un interval mai larg.');
    }
  }
  if (b.strategy === 'dca' && b.dca) {
    const d = b.dca;
    const orders = dcaOrders(d);
    const last = orders.at(-1);
    if (d.stopLoss !== null && last && d.safetyOrders > 0 && d.stopLoss <= last.deviation) fail(['dca', 'stopLoss'], `Stop loss-ul (${fmtPctPlain(d.stopLoss)}) e mai aproape decât ultimul ordin de siguranță (${fmtPctPlain(last.deviation)}): ordinele de după el n-ar avea loc.`);
    if (last && d.direction === 'long' && last.deviation >= 100) fail(['dca', 'deviation'], 'Ultimul ordin de siguranță ar fi la un preț sub zero: abateri mai mici.');
    const capital = last?.total ?? 0;
    if (capital > b.maxAmount * (1 + 1e-9)) fail(['maxAmount'], `Ordinele cer ${fmtAmountPlain(capital)}, peste suma maximă (${fmtAmountPlain(b.maxAmount)}).`);
  }
  if (b.strategy === 'premium' && b.premium) {
    const p = b.premium;
    const r = p.tpPct / p.slPct;
    if (p.levels === 'percent' && !(r >= 0.5 - 1e-9 && r <= 10 + 1e-9)) fail(['premium', 'tpPct'], `Raportul risc : câștig ${rrText(p.slPct, p.tpPct)} iese din limite: take profit-ul e între jumătate și de 10 ori distanța stop loss-ului (de la 2:1 la 1:10).`);
    if (WEIGHT_KEYS.every((k) => p.weights[k] === 0)) fail(['premium', 'weights'], 'Cel puțin o pondere a scorului trebuie să fie peste zero.');
  }
}

type BotInputBase = z.infer<z.ZodObject<typeof common>> & { strategy: BotStrategy };

export const botInputSchema = z
  .discriminatedUnion('strategy', [
    z.object({ strategy: z.literal('grid'), ...common, grid: gridSchema }).strict(),
    z.object({ strategy: z.literal('dca'), ...common, dca: dcaSchema }).strict(),
    z.object({ strategy: z.literal('premium'), ...common, premium: premiumSchema }).strict(),
  ])
  .superRefine(checkBot);
export type BotInput = z.infer<typeof botInputSchema>;

/**
 * Before FD-BOTEDIT, what a started bot could change (FD-BOT §7). Still read: a page opened before the deploy sends it,
 * and it applies over the bot's settings.
 */
export const botPatchSchema = z
  .object({
    name: common.name,
    endsAt: common.endsAt,
    endAction: common.endAction,
    dailyLoss: common.dailyLoss,
    lossStop: common.lossStop,
    fee: common.fee,
    maxAmount: common.maxAmount.optional(),
    leverage: common.leverage.optional(),
    premium: premiumSchema.optional(),
    tf: common.tf.optional(),
  })
  .strict();
export type BotPatch = z.infer<typeof botPatchSchema>;

/** FD-BOTEDIT: every setting of the form, and what becomes of the positions the new ones cannot keep (§3). */
export const botEditSchema = z.object({ input: botInputSchema, positions: z.enum(['finish', 'close']).optional() }).strict();
export type BotEdit = z.infer<typeof botEditSchema>;

/** FD-BOTEDIT §2: the settings that apply at once, during a transition too (the rest waits for the open positions). */
export const LIVE_KEYS = ['name', 'endsAt', 'endAction', 'dailyLoss', 'lossStop', 'fee'] as const;

/** What the engine runs with during a transition: the settings of the open positions, with the live ones of the new. */
export const liveOf = (basis: BotInput, next: BotInput): BotInput => {
  const out: Record<string, unknown> = { ...basis };
  for (const k of LIVE_KEYS) out[k] = next[k];
  return out as BotInput;
};

const MARKET_RO: Record<BotMarket, string> = { spot: 'Spot', futures: 'Futures', stock: 'Acțiuni' };
const GRID_REBUILD = ['lower', 'upper', 'grids', 'spacing', 'direction', 'trigger'] as const;

/**
 * FD-BOTEDIT §3: why the new settings cannot keep the open positions (in Romanian), or nothing when they apply at once:
 * the execution, the account, the market; a DCA's or a grid's symbol; a grid made otherwise.
 */
export function transitionOf(basis: BotInput, next: BotInput): string[] {
  const out: string[] = [];
  if (basis.exec !== next.exec) out.push(`execuția: ${basis.exec === 'paper' ? 'Simulare → Real' : 'Real → Simulare'}`);
  else if (basis.accountId !== next.accountId) out.push('contul');
  if (basis.market !== next.market) out.push(`piața: ${MARKET_RO[basis.market]} → ${MARKET_RO[next.market]}`);
  if (basis.strategy !== 'premium' && basis.symbols[0] !== next.symbols[0]) out.push(`simbolul: ${basis.symbols[0] ?? ''} → ${next.symbols[0] ?? ''}`);
  // FIX-BOTMARGIN: a grid's positions all hold its margin; another one makes the grid again.
  const margin = basis.market === 'futures' && next.market === 'futures' && basis.marginMode !== next.marginMode;
  if (basis.strategy === 'grid' && next.strategy === 'grid' && (GRID_REBUILD.some((k) => basis.grid[k] !== next.grid[k]) || basis.maxAmount !== next.maxAmount || basis.leverage !== next.leverage || margin))
    out.push('grila: limitele, grilele, spațierea, direcția, prețul de pornire, suma, levierul sau marja');
  return out;
}

export const botStopSchema = z.object({ action: z.enum(['close', 'finish', 'leave']) }).strict();

const levelValue = z.number().finite().positive();
/** FIX-BOTDRAG: a bot's stop loss / take profit dragged on the chart, for one of its positions. POST /api/bots/:id/levels. */
export const botLevelMoveSchema = z
  .object({ symbol: z.string().min(1).max(40), side: z.enum(['long', 'short']), openedAt: z.number().int().nonnegative(), sl: levelValue.optional(), tp: levelValue.optional() })
  .strict()
  .refine((m) => m.sl !== undefined || m.tp !== undefined, { message: 'Niciun nivel de mutat.' });
export type BotLevelMove = z.infer<typeof botLevelMoveSchema>;

// ---------------- Plans (the form's summary and the engine) ----------------

/** The risk : reward of a stop and a take profit (their distances), risk first and brought to 1: „1:2”, „1:1,33” (FD-BOTPCT). */
export const rrText = (sl: number, tp: number): string => `1:${fmtAmountPlain(tp / sl)}`;
const fmtPctPlain = (v: number) => `${String(Number(v.toFixed(2))).replace('.', ',')}%`;
const fmtAmountPlain = (v: number) => String(Number(v.toFixed(2))).replace('.', ',');

/** The grid's n + 1 lines, low to high. */
export function gridLines(lower: number, upper: number, n: number, spacing: GridConfig['spacing']): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(spacing === 'geometric' ? lower * (upper / lower) ** (i / n) : lower + ((upper - lower) * i) / n);
  out[n] = upper;
  return out;
}

/** The profit of one grid after both fees, in percent: the smallest (the top grid, arithmetic) and the largest. */
export function gridProfit(g: Pick<GridConfig, 'lower' | 'upper' | 'grids' | 'spacing'>, feePct: number): { min: number; max: number } {
  const lines = gridLines(g.lower, g.upper, g.grids, g.spacing);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < g.grids; i++) {
    const pct = ((lines[i + 1] as number) / (lines[i] as number) - 1) * 100 - 2 * feePct;
    min = Math.min(min, pct);
    max = Math.max(max, pct);
  }
  return { min, max };
}

export interface GridSlotPlan {
  side: BotSide;
  /** Bought (a long) or sold (a short) at the start, at the market. */
  holding: boolean;
}

/**
 * Each grid's side and whether it starts full (FD-BOT §4): a Long grid buys the grids above the price, a Short one sells
 * the grids below it; a Neutral one starts empty, long below the price and short above it.
 */
export function gridSlots(lines: number[], direction: GridConfig['direction'], price: number): GridSlotPlan[] {
  const out: GridSlotPlan[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const low = lines[i] as number;
    const high = lines[i + 1] as number;
    if (direction === 'long') out.push({ side: 'long', holding: high > price });
    else if (direction === 'short') out.push({ side: 'short', holding: low < price });
    else out.push(low >= price ? { side: 'short', holding: false } : { side: 'long', holding: false });
  }
  return out;
}

/** The price a grid enters at: a long buys at its low line, a short sells at its high one. */
export const slotEntryLine = (lines: number[], i: number, side: BotSide): number => (side === 'long' ? (lines[i] as number) : (lines[i + 1] as number));

export interface GridPlan {
  lines: number[];
  /** In the asset, the same on every grid. */
  qty: number;
  slots: GridSlotPlan[];
  /** Grids filled at the start, at the market, and what that costs (margin on futures). */
  atStart: number;
  startCost: number;
  /** One grid's order, in the quote (the smallest: at the lowest entry line). */
  minOrder: number;
  profit: { min: number; max: number };
}

/** The grid at `price`: all its grids full at once never use more than the investment (FD-BOT §4). */
export function gridPlan(g: GridConfig, investment: number, leverage: number, feePct: number, price: number): GridPlan {
  const lines = gridLines(g.lower, g.upper, g.grids, g.spacing);
  const slots = gridSlots(lines, g.direction, price);
  const entries = slots.map((s, i) => slotEntryLine(lines, i, s.side));
  const qty = (investment * leverage) / entries.reduce((a, b) => a + b, 0);
  const atStart = slots.filter((s) => s.holding).length;
  return { lines, qty, slots, atStart, startCost: (atStart * qty * price) / leverage, minOrder: qty * Math.min(...entries), profit: gridProfit(g, feePct) };
}

export interface DcaOrderPlan {
  /** 0: the base order; 1…: the safety orders. */
  k: number;
  /** From the base order's price, in percent. */
  deviation: number;
  /** What it uses (margin on futures). */
  amount: number;
  /** All the orders so far. */
  total: number;
}

/** The base order and the safety orders (FD-BOT §5): the price does not change these. */
export function dcaOrders(d: Pick<DcaConfig, 'baseOrder' | 'safetyOrders' | 'safetyOrder' | 'volumeScale' | 'deviation' | 'stepScale'>): DcaOrderPlan[] {
  const out: DcaOrderPlan[] = [{ k: 0, deviation: 0, amount: d.baseOrder, total: d.baseOrder }];
  let deviation = 0;
  let step = d.deviation;
  let amount = d.safetyOrder;
  let total = d.baseOrder;
  for (let k = 1; k <= d.safetyOrders; k++) {
    deviation += step;
    total += amount;
    out.push({ k, deviation, amount, total });
    step *= d.stepScale;
    amount *= d.volumeScale;
  }
  return out;
}

export interface DcaPricedOrder extends DcaOrderPlan {
  price: number;
  /** The average entry after this order, and the take profit then. */
  avg: number;
  tp: number;
}

/** The orders at a base price: their prices, and the average and the take profit after each. */
export function dcaPlan(d: DcaConfig, basePrice: number, leverage: number): DcaPricedOrder[] {
  const dir = d.direction === 'long' ? 1 : -1;
  let qty = 0;
  let cost = 0;
  return dcaOrders(d).map((o) => {
    const price = basePrice * (1 - (dir * o.deviation) / 100);
    const q = (o.amount * leverage) / price;
    qty += q;
    cost += q * price;
    const avg = cost / qty;
    return { ...o, price, avg, tp: avg * (1 + (dir * d.takeProfit) / 100) };
  });
}

/**
 * The price at or past a level (FD-BOT §4–§6): `up` = at or above it. A level computed as 100 × 1.1 is 110.00000000000001:
 * a price of 110 reaches it.
 */
export const reached = (price: number, level: number, up: boolean): boolean => (up ? price >= level * (1 - 1e-9) : price <= level * (1 + 1e-9));

/** How far the price may move against a position before liquidation, as a share of the entry (FD-BOT §6). */
export const liqDistance = (leverage: number): number => 1 / leverage - MAINT_MARGIN;

/** A chart's coin pair as its USDT-margined perpetual: BTC/USDT → BTC/USDT:USDT. */
export const perpetualOf = (pair: string): string => {
  const quote = pair.split('/')[1] ?? '';
  return pair.includes(':') ? pair : `${pair}:${quote}`;
};

/** The quote a bot counts in: a pair's (USDT), or USD for shares. */
export const botCurrency = (market: BotMarket, symbols: string[]): string => (market === 'stock' ? 'USD' : (symbols[0]?.split('/')[1] ?? 'USDT'));

export const defaultBotName = (strategy: BotStrategy, symbols: string[]): string =>
  `${symbols.length > 1 ? `${symbols[0]} +${symbols.length - 1}` : (symbols[0] ?? '')} · ${STRATEGY_RO[strategy]}`.slice(0, 60);

// ---------------- API ----------------

export interface BotAccountView {
  id: number;
  label: string;
  exchange: string;
  env: string;
}

export interface BotView {
  id: number;
  name: string;
  strategy: BotStrategy;
  exec: BotExec;
  market: BotMarket;
  area: BotArea;
  symbols: string[];
  tf: Timeframe;
  /** The account (FD-PAPER: a Paper Trading profile too); null for a simulation from before it, or when the account is gone. */
  account: BotAccountView | null;
  status: BotStatus;
  statusReason: string | null;
  startsAt: number;
  endsAt: number | null;
  currency: string;
  maxAmount: number;
  /** What the bot has in play now (margin on futures). */
  committed: number;
  realized: number;
  /** At the prices the engine last read; null when a price is missing. */
  unrealized: number | null;
  trades: number;
  wins: number;
  openPositions: number;
  createdAt: number;
  ranAt: number | null;
}

export interface BotPositionView {
  symbol: string;
  side: BotSide;
  qty: number;
  entry: number;
  price: number | null;
  sl: number | null;
  tp: number | null;
  unrealized: number | null;
  leverage: number;
  margin: number;
  openedAt: number;
}

/**
 * FIX-BOTLEVELS: the stop loss / take profit a real bot keeps for a position it holds on an account (the bot closes the
 * position itself there: they are no orders at the platform). GET /api/bots/levels.
 */
export interface BotLevel {
  bot: { id: number; name: string };
  accountId: number;
  /** False while the bot has a problem: it sends nothing until "Reia", so the levels do not fire. */
  active: boolean;
  market: BotMarket;
  /** The bot's symbol: "JUP/USDT" (spot and futures), "AAPL". */
  symbol: string;
  side: BotSide;
  qty: number;
  entry: number;
  sl: number | null;
  tp: number | null;
  /** FIX-BOTDRAG: when the position opened (a grid: its first open interval); with the symbol and side, which one it is. */
  openedAt: number;
}

export interface BotTradeRow {
  id: number;
  symbol: string;
  side: BotSide;
  qty: number;
  entry: number;
  exit: number;
  pnl: number;
  fees: number;
  openedAt: number;
  closedAt: number;
  reason: BotTradeReason;
}

export interface ScorePart {
  key: WeightKey;
  /**
   * What was read: an index (0–100), or for Slingshot the last break of the market structure (+1 up, −1 down, 0 none;
   * before FD-BOTDIR +1 with the trade, −1 against); null when there was no data.
   */
  value: number | null;
  /** FD-BOTDIR: where it leans the market, −1 (down: a short's side) … +1 (up: a long's); before it, the agreement with the trade. */
  a: number;
  weight: number;
  /** What the value means, in Romanian („pozitiv”, „ultima rupere în sus”). */
  note: string;
}

export interface BotScore {
  /** FD-BOTDIR: the market's score, 0–100, 50 neutral (high favours longs, low shorts); before it, the trade's. */
  score: number;
  /** FD-BOTDIR: the side's threshold (a long from it up, a short from it down); absent on the events before it. */
  limit?: { side: BotSide; value: number };
  /** Before FD-BOTDIR: the one minimum of the trade's score, for either side. */
  min?: number;
  parts: ScorePart[];
}

export interface BotAiVerdict {
  decision: 'enter' | 'skip';
  confidence: number;
  reason: string;
  risks: string[];
  /** FIX-BOTBUDGET: the amount the AI chose for the trade (its margin), within the bounds it was given. */
  amount?: number;
}

export interface BotEventDetail {
  side?: BotSide;
  price?: number;
  sl?: number;
  tp?: number;
  score?: BotScore;
  ai?: BotAiVerdict;
  qty?: number;
  leverage?: number;
  /** FIX-BOTBUDGET: the amount an entry took from the budget (its margin). */
  margin?: number;
  pnl?: number;
}

export interface BotEventRow {
  id: number;
  at: number;
  kind: BotEventKind;
  symbol: string | null;
  message: string;
  detail: BotEventDetail | null;
}

export interface BotGridView {
  lines: number[];
  qty: number;
  /** Waiting for its start price. */
  armed: boolean;
  trigger: number | null;
  slots: { side: BotSide; entry: number | null }[];
}

export interface BotDcaView {
  cycle: number;
  cooldownUntil: number | null;
  deal: {
    side: BotSide;
    basePrice: number;
    avg: number;
    qty: number;
    filled: number;
    tp: number;
    sl: number | null;
    next: { k: number; price: number; amount: number }[];
  } | null;
}

export interface BotDetail extends BotView {
  input: BotInput;
  positions: BotPositionView[];
  grid: BotGridView | null;
  dca: BotDcaView | null;
  /** The closed trades, newest first. */
  history: BotTradeRow[];
  events: BotEventRow[];
  /** FD-BOTEDIT §3: new settings waiting for the positions made with the old ones. */
  switching: { changes: string[]; mode: PositionsMode } | null;
}

/** FD-BOTEDIT §3: the edit's transition, as the check tells it to the form. */
export interface BotTransition {
  /** What asks for it (`transitionOf`). */
  changes: string[];
  /** The open positions (a grid's full intervals). */
  open: number;
  /** What the form offers: none without positions (nor an order on its way); a grid only closes. */
  modes: PositionsMode[];
  /** The one the summary tells. */
  mode: PositionsMode;
}

/** The form's summary (POST /api/bots/check, and POST /api/bots/:id/check at an edit). */
export interface BotCheck {
  price: number | null;
  capital: number;
  errors: string[];
  warnings: string[];
  summary: string[];
  grid: GridPlan | null;
  dca: DcaPricedOrder[] | null;
  /** At an edit: null when the open positions keep going with the new settings. */
  transition?: BotTransition | null;
}
