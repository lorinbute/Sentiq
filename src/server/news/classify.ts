// Relevance, impact and flags of a news item (docs/technical-design.html §5.4). Pure functions.
import type { SourceCategory } from './sources.ts';

export type NewsFlag = 'sponsored' | 'speculative' | 'recap' | 'lowRelevance' | NewsTheme;

/** FIX-SENTWEIGHT: the decade's market drivers: energy (its prices, its production) and AI. */
export type NewsTheme = 'energy' | 'ai';

/**
 * Energy: its goods, and the prices / costs / output of fuel, power and energy. A company named "… Energy" is not the theme
 * (it needs a word of the sector after it).
 */
const ENERGY_THEME =
  /\b((?<!\b(?:palm|olive|vegetable|cooking|edible|soybean|sunflower) )oil|crude|brent|wti|opec\+?|gasoline|petrol|diesel|jet fuel|heating oil|natural gas|lng|electricity|power (?:prices?|bills?|costs?|grids?|plants?|generation|demand|supply|shortages?|outages?|markets?)|energy (?:prices?|costs?|bills?|crisis|shock|production|output|supply|supplies|demand|security|markets?|sector|stocks|exports?|imports?|transition)|refiner(?:y|ies)|coal|nuclear power|blackouts?|fuel (?:prices?|costs?|shortages?|supply|supplies)|utility bills)\b|(?<!\b(?:eth|ethereum|network|transaction|gwei) )\bgas prices?\b/i;
/**
 * AI as a whole: "AI" in capitals (not "ai" in another word or tongue) and its tickers (AI = C3.ai); its words; the
 * whole AI industry: the model labs, the chips and memory it runs on (chipmakers as a group too), the clouds and data
 * centers that host it (the hyperscalers: Microsoft, Alphabet / Google, Meta, Amazon, Oracle), its software.
 */
const AI_THEME_CAPS = /\bA\.I\.|\b(AI|NVDA|AMD|AVGO|TSM|MRVL|MU|ASML|SMCI|INTC|QCOM|MSFT|GOOGL?|META|AMZN|ORCL|PLTR|CRWV|NBIS|SOUN|BBAI|ANET|VRT|DELL|Intel)\b/;
const AI_THEME = new RegExp(
  String.raw`\b(` +
    [
      // the field
      String.raw`artificial intelligence|generative|gen ?ai|llms?|large language models?|language models?|foundation models?|frontier models?|chatbots?|machine learning|deep learning|neural networks?|agi|superintelligence|ai agents?|agentic|reasoning models?|inference (?:chips?|demand|costs?|computing)|model training`,
      // the model labs and their products
      String.raw`openai|chatgpt|gpt-\d\w*|sora|anthropic|claude ai|deepmind|google gemini|gemini (?:ai|models?)|xai|grok|mistral(?: ai)?|cohere|perplexity|deepseek|moonshot ai|kimi|zhipu|z\.ai|minimax|baichuan|qwen|ernie bot|sensetime|inflection ai|character\.ai|stability ai|midjourney|hugging face|scale ai|databricks|safe superintelligence|thinking machines|llama models?|copilot`,
      // chips, memory and the machines
      String.raw`nvidia|advanced micro devices|broadcom|tsmc|taiwan semiconductor|arm holdings|marvell|micron|sk hynix|hynix|hbm|asml|super ?micro|cerebras|groq|sambanova|qualcomm|chipmakers?|chip ?makers?|chip stocks|semiconductors?|ai chips?|ai accelerators?|gpus?`,
      // the clouds and data centers
      String.raw`data cent(?:er|re)s?|hyperscalers?|microsoft|alphabet|google|meta platforms|meta(?!-)|amazon|aws|oracle(?! of omaha)|coreweave|nebius|lambda labs|crusoe|vertiv|arista|dell technologies`,
      // AI software
      String.raw`palantir|c3\.ai|soundhound|bigbear\.ai|uipath|servicenow|salesforce agentforce|agentforce`,
    ].join('|') +
    String.raw`)\b`,
  'i',
);
/** A big move in an energy or AI story: its importance is 3 (major). */
const THEME_MAJOR =
  /\b(sell-?offs?|selloffs?|crash(?:es|ed)?|plung\w*|plummet\w*|tumbl\w*|soar\w*|surg\w*|spik\w*|skyrocket\w*|shocks?|crisis|record|turmoil|ousted|ousts?|fired|resign\w*|steps? down|exits?|replac\w*|export (?:bans?|curbs?|controls?|restrictions?)|chip (?:bans?|curbs?|restrictions?)|embargo\w*|shortages?|outages?|blackouts?|opec\+? (?:cuts?|hikes?|output))\b/i;

/** FIX-SENTWEIGHT: the themes of a news item, by its title (what the story is about). */
export function newsThemes(title: string): NewsTheme[] {
  const out: NewsTheme[] = [];
  if (ENERGY_THEME.test(title)) out.push('energy');
  if (AI_THEME_CAPS.test(title) || AI_THEME.test(title)) out.push('ai');
  return out;
}

const SPONSORED = /\b(sponsored|press release|partner content|paid (post|content)|advertorial)\b|\[PR\]|\(PR\)/i;
const SPECULATIVE =
  /\b(price prediction|price forecast|predictions?:|could (soar|surge|crash|explode|hit|reach|rally|drop)|might (soar|surge|crash|hit|reach)|is it time to buy|will .{1,40} (hit|reach|soar)|to the moon|100x|1000x)\b|\?\s*$/i;
const RECAP = /\b(weekly recap|week in review|this week in|daily digest|morning brief|evening brief|newsletter|roundup|what happened in crypto today)\b/i;

const MARKET_TERMS =
  /\b(stocks?|equit(y|ies)|s&p|nasdaq|dow|wall street|fed|federal reserve|fomc|powell|rates?|rate (cut|hike)|inflation|cpi|pce|ppi|yields?|treasur(y|ies)|bonds?|dollar|dxy|earnings|recession|gdp|jobs|payrolls|unemployment|tariffs?|oil|crude|markets?|crypto|bitcoin|etf|sec|ecb|boj|central bank|stimulus|debt|deficit|shutdown)\b/i;

const GEO_MARKET_TERMS =
  /\b(war|missiles?|strikes?|airstrikes?|sanctions?|tariffs?|trade (war|deal|talks)|oil|opec|ceasefire|invasion|invades?|nuclear|attacks?|blockade|elections?|coup|default|embargo|troops|military|conflict|escalat\w*|truce|hostilities|drone|shipping lanes?|strait of hormuz|red sea|semiconductor|export (ban|controls?)|central bank|inflation|recession|markets?|stocks?|crypto|bitcoin)\b/i;

const IMPACT_3 =
  /\b(fed|federal reserve|fomc|powell|rate (decision|cut|hike)s?|cuts? rates|hikes? rates|interest rates?|cpi|inflation|payrolls|jobs report|nonfarm|recession|war|tariffs?|hack(ed|s)?|exploit(ed)?|liquidat\w*|bankrupt\w*|insolven\w*|crash(es|ed)?|default(s|ed)?|emergency|sanctions?)\b/i;
const IMPACT_3_SEC_ETF = /\b(sec|cftc)\b[\s\S]*\betfs?\b|\betfs?\b[\s\S]*\b(sec|approv\w*|reject\w*|denied|deny)\b/i;
const IMPACT_2 =
  /\b(etfs?|regulat\w*|yields?|treasur(y|ies)|dollar|dxy|stablecoins?|sec|cftc|gdp|ppi|pce|unemployment|jobless|earnings|nvidia|apple|microsoft|tesla|blackrock|microstrategy|strategy inc|coinbase|binance|tether|circle|ecb|boj|pboc|opec|oil)\b/i;

/** Relevance of a geopolitical item linked to markets (FD-IMPACT §2; 0.6 before 13 Oct 2026). */
export const GEO_RELEVANCE = 0.8;

export const TOP10 = new Set(['BTC', 'ETH', 'XRP', 'BNB', 'SOL', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX', 'TON', 'SUI', 'HYPE']);
const STABLES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'PYUSD', 'USDS', 'USD1']);

export interface Classification {
  relevance: number;
  impact: number;
  flags: NewsFlag[];
}

export function classify(category: SourceCategory, title: string, summary: string, coins: string[]): Classification {
  const text = `${title} ${summary}`;
  const flags: NewsFlag[] = [];
  const themes = newsThemes(title);
  if (SPONSORED.test(text)) flags.push('sponsored');
  if (SPECULATIVE.test(title)) flags.push('speculative');
  if (RECAP.test(title)) flags.push('recap');

  let relevance: number;
  if (category === 'crypto') relevance = 1;
  // Stock feeds also carry commodity pieces ("Corn gets a dead cat bounce"): full weight for a tagged share or the market.
  else if (category === 'stocks') relevance = coins.length > 0 || MARKET_TERMS.test(text) ? 1 : 0.8;
  else if (category === 'macro') relevance = MARKET_TERMS.test(text) ? 1 : 0.8;
  // Geopolitics moves markets more than it used to (tariffs, sanctions, wars, statements: FD-IMPACT §2); energy and AI
  // always do (FIX-SENTWEIGHT).
  else relevance = GEO_MARKET_TERMS.test(text) || themes.length > 0 ? GEO_RELEVANCE : 0;
  if (relevance === 0) flags.push('lowRelevance');

  const majorCoins = coins.filter((c) => !STABLES.has(c));
  let impact = 1;
  if (IMPACT_3.test(text) || IMPACT_3_SEC_ETF.test(text)) impact = 3;
  else if (IMPACT_2.test(text) || majorCoins.includes('BTC') || majorCoins.includes('ETH')) impact = 2;
  else if (majorCoins.some((c) => TOP10.has(c))) impact = 1.5;
  // FIX-SENTWEIGHT: energy and AI are never minor: at least notable, major with a big move in the title.
  if (themes.length > 0) impact = Math.max(impact, THEME_MAJOR.test(title) ? 3 : 2);
  flags.push(...themes);

  return { relevance, impact, flags };
}
