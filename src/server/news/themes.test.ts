// FIX-SENTWEIGHT: energy and AI stories: their themes (by the title), a higher importance, in the index when they were
// left out, and the category of an AI story about nothing else.
import { describe, expect, it } from 'vitest';
import { categorize, subjectOf } from './categorize.ts';
import { classify, newsThemes } from './classify.ts';
import { macroVerdict } from './macro.ts';

const isCrypto = () => false;

describe('the energy and AI themes (FIX-SENTWEIGHT)', () => {
  it('energy: its goods, and the prices / output of fuel, power and energy; not a company named "Energy"', () => {
    for (const t of [
      'Oil prices fall on expectations of coming supply surplus',
      'U.S. diesel prices fall below $6 a gallon to two-month low',
      'Heating oil prices are up 59% from last winter',
      'Electricity prices soar in Europe as wind output drops',
      'Power grid strained as demand hits a record',
      "Japan's economy contracts as elevated energy costs bite",
      'OPEC+ agrees to extend output cuts',
      'Natural gas futures jump on cold snap',
      'Gas prices hit $4 a gallon',
    ])
      expect(newsThemes(t), t).toContain('energy');
    for (const t of ['UBS upgrades Peabody Energy stock rating on valuation after selloff', 'Diamondback Energy nears $5 bln Double Eagle deal', 'Ethereum gas prices fall to record lows', 'Bitcoin network gas prices spike', 'Palm oil prices rise on weak output'])
      expect(newsThemes(t), t).not.toContain('energy');
  });

  it('AI: "AI" in capitals, its words, its leading companies and hardware; not "ai" inside a name', () => {
    for (const t of [
      "AI sell-off resumes as Jensen Huang 'discusses comeback as Nvidia CEO'",
      'Take Five: Huang’s exit, Anthropic’s entrance',
      'OpenAI raises $40 billion',
      'Hyperscalers lift data center spending again',
      'Artificial intelligence boom lifts chipmakers',
      'Generative models drive cloud demand',
    ])
      expect(newsThemes(t), t).toEqual(['ai']);
    for (const t of ['Pony.ai, Toyota roll out driverless robotaxis', 'Sai Life Sciences shares rise', 'The ai of the matter']) expect(newsThemes(t), t).toEqual([]);
  });

  it('AI is the whole industry, not one company: the labs, the chips and memory, the clouds, the software, their tickers', () => {
    for (const t of [
      'Microsoft lifts capex guidance as cloud demand surges',
      'Alphabet shares fall after Google search ruling',
      'Meta to cut 5% of staff',
      'Amazon AWS outage hits websites',
      'Oracle bond sale draws record demand',
      'AMD unveils new MI400 AI accelerators',
      'Broadcom beats on custom chip demand',
      'TSMC October sales jump 40%',
      'Arm Holdings shares slide',
      'Micron sold out of HBM for 2027',
      'SK Hynix posts record profit',
      'ASML orders miss estimates',
      'Intel shares jump on foundry deal',
      'Chipmakers lead Nasdaq lower',
      'CoreWeave stock plunges on delayed data center',
      'Nebius Stock Falls Nearly 17% as neoclouds rattle',
      'Palantir raises guidance',
      'C3.ai stock tumbles',
      'Mistral AI raises €2bn',
      'DeepSeek releases a new reasoning model',
      'Perplexity in talks at $20bn valuation',
      'xAI merges with SpaceX',
      'Anthropic IPO demand surges',
      'NVDA, MSFT lead premarket gains',
    ])
      expect(newsThemes(t), t).toEqual(['ai']);
    for (const t of ['The ARM of the law', 'Investment arm of the bank sells stake', 'Meta-analysis shows coffee benefits', 'Oracle of Omaha Warren Buffett letter', 'US intel says talks stalled', 'Mu Sigma names new CEO'])
      expect(newsThemes(t), t).toEqual([]);
    expect(newsThemes('AI data centers drive power prices higher')).toEqual(['energy', 'ai']);
  });

  it('a higher importance: at least 2, 3 with a big move; the themes in the flags', () => {
    expect(classify('stocks', 'Stifel reiterates Salesforce stock rating on AI momentum', '', [])).toMatchObject({ impact: 2, flags: ['ai'] });
    expect(classify('stocks', 'AI infrastructure sell-off erases $4.2T from industrial, energy stocks', '', [])).toMatchObject({ impact: 3, flags: ['energy', 'ai'] });
    expect(classify('stocks', 'Scott Bessent calls for an external CEO to replace Jensen Huang', '', [])).toMatchObject({ impact: 1, flags: [] });
    expect(classify('stocks', 'Bessent calls for an external CEO to replace Nvidia’s Jensen Huang', '', []).impact).toBe(3);
    expect(classify('macro', 'Oil slips as supplies recover', '', []).impact).toBe(2);
    expect(classify('macro', 'Oil prices surge on Gulf supply shock', '', []).impact).toBe(3);
    // Already major by the keywords: stays 3.
    expect(classify('macro', 'Fed hikes rates as energy prices push inflation', '', []).impact).toBe(3);
    // Without a theme: as before.
    expect(classify('stocks', 'Stifel reiterates Salesforce stock rating', '', [])).toMatchObject({ impact: 1, flags: [] });
  });

  it('geopolitics: an energy or AI story is tied to the markets (0,8); without one, as before (0)', () => {
    expect(classify('geopolitics', "AI sell-off resumes as Jensen Huang 'discusses comeback as Nvidia CEO' – business live", '', [])).toMatchObject({ relevance: 0.8, impact: 3, flags: ['ai'] });
    expect(classify('geopolitics', 'Diesel shortages spread across the region', '', [])).toMatchObject({ relevance: 0.8, flags: ['energy'] });
    expect(classify('geopolitics', 'Leaders meet for a cultural summit', '', [])).toMatchObject({ relevance: 0, flags: ['lowRelevance'] });
  });

  it('energy is macro by the rules (an input shock); an AI story about nothing else is about shares', () => {
    for (const t of ['US diesel below $6 a gallon at 2-month low on easing tensions', 'Electricity bills to rise 20% this winter', 'Power outages hit three states', 'Refinery fire cuts gasoline supply'])
      expect(macroVerdict(t, '', 0).macro, t).toBe(true);
    expect(subjectOf('Take Five: Huang’s exit, Anthropic’s entrance', '', [], isCrypto)).toBe('stocks');
    expect(subjectOf('Denmark shows how to deal with AI job disruption', '', [], isCrypto)).toBe('stocks');
    // A general source (crypto and stocks): an AI story with no other sign goes to shares, not out of the index.
    expect(categorize('OpenAI unveils a new model', '', [], ['crypto', 'stocks'], isCrypto)).toEqual({ category: 'stocks', matched: true });
    // Crypto words still win their tie (the fixed order).
    expect(categorize('AI tokens rally as OpenAI unveils a new model', '', [], ['crypto', 'stocks'], isCrypto).category).toBe('crypto');
  });
});
