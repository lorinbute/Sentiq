// "Cum s-a calculat?" (FD-INDEXWHY): today's index step by step, with the numbers of now: the news counted, how each
// weighs, the weighted mean, the pull towards neutral, the 0–100 scale; by category, by source, and item by item.
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import type { MarketPart, TodayExplain } from '../../shared/api-types.ts';
import { api } from '../api.ts';
import { confidenceLabel, fmtNum, fmtTime, indexLabel, indexTone } from '../format.ts';
import { useTz } from '../hooks.ts';
import { Modal } from './Modal.tsx';
import { ScoreWhy } from './ScoreWhy.tsx';
import { PremiumBadge } from './IndicatorPicker.tsx';
import { fmtPoints } from '../why-text.ts';
import { marketMoves, marketRarity, marketShown, marketWhen, sharePct, signedPct } from '../market-text.ts';
import { ErrorNote, fmtScore, Loading } from './ui.tsx';

const CAT: Record<string, string> = { crypto: 'Crypto', stocks: 'Acțiuni', macro: 'Macro', geopolitics: 'Geopolitică' };
const FLAG: Record<string, string> = { sponsored: 'sponsorizat', speculative: 'speculativ', recap: 'rezumat' };
/** FIX-SENTWEIGHT: the themes that weigh more. */
const THEME: Record<string, string> = { energy: 'energie', ai: 'AI' };
const PAGE = 20;
const SCORE_TEXT = (s: number) => (s > 0.2 ? 'text-bull' : s < -0.2 ? 'text-bear' : 'text-muted');
/** The index's colours as on the card (neutral in the text colour). */
const TONE = { bull: 'text-bull', bear: 'text-bear', neutral: 'text-text' } as const;

/** A signed number in the page's style ("+0,231", "−0,05", "0"). */
const signed = (v: number, digits = 3) => {
  const s = fmtNum(Math.abs(v), digits, digits);
  return Number(Math.abs(v).toFixed(digits)) === 0 ? fmtNum(0, digits, digits) : `${v > 0 ? '+' : '−'}${s}`;
};
const pct = (v: number) => `${fmtNum(v * 100, 1)}%`;
// The index itself as on the card ("52.0"); every other number in the page's (Romanian) style.
const n2 = (v: number) => fmtNum(v, 2);

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[26px_minmax(0,1fr)] gap-x-2.5">
      <span className="num mt-px grid size-[22px] place-items-center rounded-full bg-panel-3 text-[12px] text-muted">{n}</span>
      <div className="flex min-w-0 flex-col gap-1">
        <h4 className="text-[13.5px] font-semibold">{title}</h4>
        <div className="text-[13px] text-muted">{children}</div>
      </div>
    </li>
  );
}

function Formula({ children }: { children: ReactNode }) {
  // Not `.num` (it never wraps): a formula longer than a phone is wide goes on to the next line.
  return <div className="w-fit max-w-full rounded-lg bg-panel-2 px-3 py-1.5 font-mono text-[12.5px] break-words text-text tabular-nums">{children}</div>;
}

/** FD-WHYPLAIN §2: the day in words, before the formulas. */
function Summary({ e }: { e: TodayExplain }) {
  const c = e.counts;
  const n = c.positive + c.neutral + c.negative;
  if (n === 0) {
    return (
      <section aria-labelledby="ix-short" className="flex flex-col gap-1.5">
        <h3 id="ix-short" className="panel-title">Pe scurt</h3>
        <p className="text-[13.5px] text-muted">Încă nu sunt știri analizate azi: indicele stă la 50.</p>
      </section>
    );
  }
  const heaviest = e.items[0];
  const mover = [...e.items].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))[0];
  const most = [...e.sources].sort((a, b) => b.count - a.count)[0];
  const mostCut = most ? most.weight < most.base * (1 - 1e-9) : false;
  const t = e.total;
  return (
    <section aria-labelledby="ix-short" className="flex flex-col gap-1.5">
      <h3 id="ix-short" className="panel-title">Pe scurt</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-[13.5px] text-muted">
        <li>
          Azi intră în calcul <span className="text-text">{n}</span> {n === 1 ? 'știre' : 'știri'}: <span className="text-bull">{c.positive} pozitive</span>, {c.neutral} neutre ({pct(c.neutral / n)}),{' '}
          <span className="text-bear">{c.negative} negative</span>.
          {c.neutral / n >= 0.5 && ` Neutrele (scor între ${signed(-e.rules.labelT, 1)} și ${signed(e.rules.labelT, 1)}) trag media spre 0, deci indicele spre 50.`}
        </li>
        {heaviest && (
          <li>
            O știre obișnuită are {pct(1 / n)} din pondere; cea mai grea, {pct(heaviest.share)} („{heaviest.title}”).
          </li>
        )}
        {mover && (
          <li>
            Cea mai mare mișcare dată de o singură știre{e.rest.count > 0 ? ` (dintre cele ${e.items.length} mai grele)` : ''}: <span className="text-text">{fmtPoints(mover.effect)}</span> („{mover.title}”). Restul mută indicele cu și mai puțin.
          </li>
        )}
        {most && (
          <li>
            Cele mai multe știri vin de la {most.name}: {most.count}, cu {pct(t.weight > 0 ? most.weight / t.weight : 0)} din pondere{mostCut ? `, tăiată de plafonul de ${pct(e.params.sourceCap)}` : ''}.
          </li>
        )}
        {[e.crypto, e.market].filter(marketShown).map((m) => (
          <li key={m.area}>
            {marketWhen(m, e.tz, e.asOf)}: {marketMoves(m)}, {marketRarity(m)}. Reacția pieței intră la {m.area === 'crypto' ? 'Crypto' : 'Acțiuni'} cu {sharePct(m.share)} din scorul lor și{' '}
            {sharePct(m.dayShare)} din ziua întreagă.
          </li>
        ))}
        <li>
          Media ponderată a scorurilor{e.market || e.crypto ? ', cu reacția piețelor,' : ''} iese {signed(t.raw)}, deci indicele {t.index.toFixed(1)}: {indexLabel(t.index).toLowerCase()}.
        </li>
      </ul>
    </section>
  );
}

/** FD-MARKETMOVE: the reaction of a part, if it has one. */
const marketOf = (e: TodayExplain, c: string): MarketPart | null => (c === 'stocks' ? e.market : c === 'crypto' ? e.crypto : null) ?? null;

/** FD-MARKETMOVE: one market's reaction, step by step (step 4). */
function MarketBlock({ m, e }: { m: MarketPart; e: TodayExplain }) {
  const p = e.params;
  const r = e.rules;
  const part = m.area === 'crypto' ? 'Crypto' : 'Acțiuni';
  const partNews = e.breakdown[m.area].weight - m.weight;
  return (
    <div className="mt-3 flex flex-col gap-1">
      <h5 className="text-[13px] font-semibold text-text">{part}</h5>
      <p>
        {marketWhen(m, e.tz, e.asOf)}: {m.indices.map((i) => `${i.name} ${signedPct(i.changePct)} (o zi obișnuită: ±${fmtNum(i.typicalPct, 2, 2)}%)`).join('; ')}.
      </p>
      <Formula>
        m = media({m.indices.map((i) => signed(i.z, 2)).join('; ')}) = {signed(m.move, 2)} zile obișnuite
      </Formula>
      <Formula>
        scor = tanh({signed(m.move, 2)} ÷ {fmtNum(r.market.scale, 0)}) = {signed(m.sentiment)} <span className="text-faint">(singură, reacția ar da {m.value.toFixed(1)})</span>
      </Formula>
      <Formula>
        cota = |m| ÷ (|m| + {fmtNum(r.market.strength, 1)}) × prospețime {n2(m.decay)} = {n2(m.strength)} × {n2(m.decay)} = {n2(m.share)}
      </Formula>
      <p>
        {m.area === 'crypto' ? 'Piața crypto nu se închide: prospețimea e 1.' : m.live ? 'Ședința e în curs: prospețimea e 1.' : 'Ședința s-a închis: prospețimea scade cu orele.'} Reacția intră ca o știre în plus la {part},
        cu ponderea care îi dă cota ei din scorul lor:
      </p>
      <Formula>
        pondere = {n2(m.share)} ÷ (1 − {n2(m.share)}) × {partNews < p.shrinkK ? `max(${n2(partNews)}, ${fmtNum(p.shrinkK, 2)})` : n2(partNews)} = {n2(m.weight)}
      </Formula>
      <p>
        {part}: din știri singure {m.news.toFixed(1)}, cu reacția pieței {e.breakdown[m.area].index.toFixed(1)}; în ziua întreagă, piața are {sharePct(m.dayShare)}.
      </p>
    </div>
  );
}

function Body({ e, tz }: { e: TodayExplain; tz: string }) {
  const [shown, setShown] = useState(PAGE);
  const p = e.params;
  const r = e.rules;
  const t = e.total;
  const scored = e.counts.positive + e.counts.neutral + e.counts.negative;
  const all = scored + e.counts.pending + e.counts.excluded;
  const capped = e.sources.filter((s) => s.weight < s.base * (1 - 1e-9));
  const list = e.items.slice(0, shown);
  // What the list does not show: past the page, and past the hundred the server sends.
  const hidden = e.items.slice(shown);
  const restCount = hidden.length + e.rest.count;
  const restShare = hidden.reduce((a, it) => a + it.share, 0) + e.rest.share;
  const restContribution = hidden.reduce((a, it) => a + it.contribution, 0) + e.rest.contribution;
  const conf = { low: 'mică', medium: 'medie', high: 'mare' }[t.confidence];
  // FD-MARKETMOVE: the news' own mean (step 3), then the markets' reactions (step 4) when there is one.
  const news = e.news ?? { raw: t.raw, weight: t.weight };
  const markets = [e.crypto, e.market].filter((x): x is MarketPart => Boolean(x));
  const n = markets.length ? 1 : 0;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-1">
        <span className={clsx('num-display text-[44px] leading-none font-semibold', TONE[indexTone(t.index)])}>{t.index.toFixed(1)}</span>
        <div className="flex flex-col pb-0.5">
          <span className="text-[17px] font-semibold">{indexLabel(t.index)}</span>
          <span className="text-[12.5px] text-faint">
            {confidenceLabel[t.confidence]}; azi, până la <span className="num">{fmtTime(e.asOf, tz)}</span>
          </span>
        </div>
      </div>

      <Summary e={e} />

      <section aria-labelledby="ix-steps" className="flex flex-col gap-3">
        <h3 id="ix-steps" className="panel-title">Pașii</h3>
        <ol className="flex flex-col gap-4">
          <Step n={1} title="Știrile zilei">
            {all === 0 ? (
              <p>Încă nu sunt știri azi (de la 00:00, în fusul tău).</p>
            ) : (
              <>
                <p>
                  {all} {all === 1 ? 'știre publicată' : 'știri publicate'} azi, de la 00:00 până acum (în fusul tău):
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  <li>
                    <span className="text-text">{scored}</span> intră în calcul: <span className="text-bull">{e.counts.positive} pozitive</span> (peste {signed(r.labelT, 1)}),{' '}
                    {e.counts.neutral} neutre, <span className="text-bear">{e.counts.negative} negative</span> (sub {signed(-r.labelT, 1)});
                  </li>
                  <li>{e.counts.excluded} nu țin de piețe (relevanță 0) și nu intră;</li>
                  <li>{e.counts.pending} nu au încă scor: intră când îl primesc.</li>
                </ul>
              </>
            )}
          </Step>
          <Step n={2} title="Ponderea fiecărei știri">
            <Formula>pondere = relevanță × importanță × greutatea sursei × factor × temă × prospețime × poveste × plafon</Formula>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
              <li>
                <span className="text-text">relevanța:</span> 1 la crypto; la acțiuni și macro 1 cu termeni de piață, altfel 0,8; la geopolitică 0,8 când e legată de piețe, de energie sau de AI,
                altfel 0;
              </li>
              <li>
                <span className="text-text">importanța</span> 1–3: a AI-ului, unde a dat una; altfel din cuvinte-cheie (3: Fed, dobânzi, inflație, război, tarife, hack, faliment…; 2: ETF, randamente, dolar,
                BTC / ETH…; 1,5: alte monede din top 10; 1: restul). Energia și AI-ul au cel puțin 2, iar 3 la o mișcare mare (sell-off, criză, CEO înlocuit, restricții la cipuri…);
              </li>
              <li>
                <span className="text-text">greutatea sursei:</span> din Setări → Admin → Surse;
              </li>
              <li>
                <span className="text-text">factorul:</span> sponsorizat {fmtNum(r.spec.sponsored, 1)}; speculativ sau rezumat {fmtNum(r.spec.speculative, 1)}; altfel 1;
              </li>
              <li>
                <span className="text-text">tema:</span> o știre despre energie (petrol, combustibili, gaz, electricitate, prețurile și producția energiei) sau despre AI cântărește × {fmtNum(r.theme, 1)}; altfel 1;
              </li>
              <li>
                <span className="text-text">prospețimea:</span> se înjumătățește la fiecare {fmtNum(p.halfLifeH, 1)} ore;
              </li>
              <li>
                <span className="text-text">povestea:</span> o știre preluată de n surse cântărește, toate la un loc, 1 + {fmtNum(p.clusterBoost, 2)} · log₂ n, împărțit între ele;
              </li>
              <li>
                <span className="text-text">plafonul sursei:</span> cu cel puțin 4 surse, niciuna nu trece de {pct(p.sourceCap)} din total.{' '}
                {!e.capActive
                  ? 'Azi nu se aplică (sub 4 surse).'
                  : capped.length === 0
                    ? `Azi nicio sursă nu a trecut de ${pct(p.sourceCap)}.`
                    : `Azi a tăiat: ${capped.map((s) => `${s.name} (pondere ${n2(s.base)} → ${n2(s.weight)})`).join(', ')}. Când una e tăiată, totalul scade, iar partea celorlalte crește.`}
              </li>
            </ul>
          </Step>
          <Step n={3} title="Media ponderată a scorurilor">
            <Formula>
              Σ(pondere × scor) ÷ Σ pondere = {signed(news.raw)} <span className="text-faint">(Σ pondere = {n2(news.weight)})</span>
            </Formula>
          </Step>
          {markets.length > 0 && (
            <Step n={4} title="Reacția piețelor">
              <p>
                <span className="text-text">De ce:</span> știrile despre acțiuni și crypto sunt mai ales despre companii și proiecte (rezultate, ratinguri, lansări), iar media lor stă aproape de
                neutru chiar și într-o zi de panică. Așa că în scor intră și ce face piața: cât s-a mișcat, față de o zi obișnuită a ei. Cu cât mișcarea e mai rară, cu atât cântărește mai mult: o zi
                liniștită aproape nu contează, o zi de panică trage scorul spre capăt.
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                <li>
                  <span className="text-text">Acțiuni:</span> S&amp;P 500 și Nasdaq 100, de la închiderea anterioară. După închidere reacția rămâne, dar cântărește tot mai puțin (la jumătate la fiecare{' '}
                  {fmtNum(p.halfLifeH, 1)} ore, ca știrile), până la ședința următoare.
                </li>
                <li>
                  <span className="text-text">Crypto:</span> BTC și ETH în ultimele 24 de ore (piața nu se închide): o mișcare contează cât timp e în aceste 24 de ore.
                </li>
                <li>
                  <span className="text-text">O zi obișnuită</span> a fiecăruia: mișcarea mediană din ultimele {r.market.sessions} de zile de tranzacționare.
                </li>
              </ul>
              {markets.map((m) => (
                <MarketBlock key={m.area} m={m} e={e} />
              ))}
              <p className="mt-2">Ziua întreagă le ia cu aceleași ponderi, alături de toate știrile:</p>
              <Formula>
                ({signed(news.raw)} × {n2(news.weight)}
                {markets.map((m) => ` + ${m.sentiment < 0 ? `(${signed(m.sentiment)})` : signed(m.sentiment)} × ${n2(m.weight)}`).join('')}) ÷ ({n2(news.weight)}
                {markets.map((m) => ` + ${n2(m.weight)}`).join('')}) = {signed(t.raw)} <span className="text-faint">(Σ pondere = {n2(t.weight)})</span>
              </Formula>
            </Step>
          )}
          <Step n={4 + n} title="Spre neutru când sunt puține știri">
            <Formula>
              {signed(t.raw)} × {n2(t.weight)} ÷ ({n2(t.weight)} + {fmtNum(p.shrinkK, 2)}) = {signed(t.shrunk)}
            </Formula>
          </Step>
          <Step n={5 + n} title="Pe scala 0–100">
            <Formula>
              50 + 50 · tanh({fmtNum(p.gamma, 2)} × {signed(t.shrunk)}) = {t.index.toFixed(1)}
            </Formula>
          </Step>
          <Step n={6 + n} title="Încrederea">
            <p>
              Σ pondere {n2(t.weight)}: <span className="text-text">{conf}</span> (sub {fmtNum(r.confidence.medium, 0)} mică, sub {fmtNum(r.confidence.high, 0)} medie, altfel mare).
            </p>
          </Step>
        </ol>
      </section>

      <section aria-labelledby="ix-cats" className="flex flex-col gap-2">
        <h3 id="ix-cats" className="panel-title">Pe categorii</h3>
        <p className="text-[12.5px] text-faint">Fiecare categorie, la fel, doar din știrile ei (cu plafonul ei){markets.length ? '; la Crypto și la Acțiuni, și reacția pieței' : ''}.</p>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(['crypto', 'stocks', 'macro', 'geopolitics'] as const).map((c) => {
            const b = e.breakdown[c];
            return (
              <li key={c} className="flex items-baseline justify-between gap-3 rounded-xl border border-line-soft bg-panel-2 px-3.5 py-2.5 text-[13px]">
                <span className="min-w-0">
                  <span className="font-semibold">{CAT[c]}</span>
                  <span className="text-faint">
                    {' '}
                    · {b.count} știri{b.count ? ` · Σ pondere ${n2(b.weight)} · media ${signed(b.raw)}` : ''}
                    {marketOf(e, c) ? ` · cu reacția pieței (${sharePct((marketOf(e, c) as MarketPart).share)}); din știri singure ${(marketOf(e, c) as MarketPart).news.toFixed(1)}` : ''}
                  </span>
                </span>
                <span className={clsx('num shrink-0 font-semibold', b.count ? TONE[indexTone(b.index)] : 'text-faint')}>{b.count ? b.index.toFixed(1) : '—'}</span>
              </li>
            );
          })}
        </ul>
      </section>

      {e.sources.length > 0 && (
        <section aria-labelledby="ix-sources" className="flex flex-col gap-2">
          <h3 id="ix-sources" className="panel-title">Pe surse</h3>
          <p className="text-[12.5px] text-faint">Ponderea fiecărei surse (tăiată de plafon, unde e cazul) și partea ei din total.</p>
          <ul className="flex flex-col divide-y divide-line-soft text-[13px]">
            {e.sources.map((s) => {
              const after = t.weight > 0 ? s.weight / t.weight : 0;
              const cut = s.weight < s.base * (1 - 1e-9);
              return (
                <li key={s.id} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span className="min-w-0 truncate">
                    {s.name}{' '}
                    <span className="text-faint">
                      · {s.count} știri · greutate {n2(s.sourceWeight)}
                    </span>
                  </span>
                  <span className="num shrink-0 text-muted">
                    {cut && <span className="text-faint line-through">{n2(s.base)}</span>} <span className={cut ? 'text-warn' : undefined}>{n2(s.weight)}</span> · {pct(after)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="ix-items" className="flex flex-col gap-2">
        <h3 id="ix-items" className="panel-title">Știrile, de la cea care a cântărit cel mai mult</h3>
        {e.items.length === 0 ? (
          <p className="text-[13px] text-faint">Încă nu sunt știri analizate azi.</p>
        ) : (
          <>
            <p className="text-[12.5px] text-faint">Contribuția = pondere × scor ÷ Σ pondere; adunate, dau media de la pasul 3.</p>
            <ol className="flex flex-col divide-y divide-line-soft">
              {list.map((it) => {
                const terms = [
                  `relevanță ${n2(it.relevance)}`,
                  `importanță ${n2(it.impact)}${it.why ? (it.why.impactSource === 'ai' ? ' (AI)' : ' (cuvinte-cheie)') : ''}`,
                  `sursă ${n2(it.sourceWeight)}`,
                  ...(it.spec !== 1 ? [`factor ${n2(it.spec)} (${it.flags.map((f) => FLAG[f]).filter(Boolean).join(', ')})`] : []),
                  ...(it.theme !== 1 ? [`temă ${n2(it.theme)} (${it.flags.map((f) => THEME[f]).filter(Boolean).join(', ')})`] : []),
                  `prospețime ${n2(it.decay)}`,
                  ...(it.clusterN > 1 ? [`poveste ${n2(it.cluster)} (${it.clusterN} surse)`] : []),
                  ...(it.cap < 1 ? [`plafon ${n2(it.cap)}`] : []),
                ];
                return (
                  <li key={it.id} className="grid grid-cols-[46px_minmax(0,1fr)] gap-x-2.5 py-2.5 text-[13px] leading-snug">
                    <span className={clsx('num', SCORE_TEXT(it.sentiment))}>{fmtScore(it.sentiment)}</span>
                    <div className="flex min-w-0 flex-col gap-1">
                      {it.url ? (
                        <a href={it.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 text-text">
                          {it.title}
                        </a>
                      ) : (
                        <span className="line-clamp-2">{it.title}</span>
                      )}
                      <span className="text-[12px] text-faint">
                        {it.source} · {CAT[it.category] ?? it.category} · <span className="num">{fmtTime(it.publishedAt, tz)}</span>
                      </span>
                      <span className="font-mono text-[12px] break-words text-muted tabular-nums">
                        {terms.join(' × ')} = pondere <span className="text-text">{n2(it.weight)}</span>
                      </span>
                      <span className="text-[12px] text-muted">
                        {pct(it.share)} din total · contribuție <span className={clsx('num', SCORE_TEXT(it.sentiment))}>{signed(it.contribution)}</span> · fără ea:{' '}
                        <span className="num">{(Math.round(it.without * 10) / 10).toFixed(1)}</span> (<span className={clsx('num', it.effect > 0.005 ? 'text-bull' : it.effect < -0.005 ? 'text-bear' : undefined)}>{fmtPoints(it.effect)}</span>)
                      </span>
                      {it.why && <ScoreWhy why={it.why} />}
                    </div>
                  </li>
                );
              })}
            </ol>
            {shown < e.items.length && (
              <button type="button" className="btn self-start" onClick={() => setShown((s) => s + PAGE)}>
                Arată încă {Math.min(PAGE, e.items.length - shown)}
              </button>
            )}
            {restCount > 0 && (
              <p className="text-[13px] text-muted">
                {restCount === 1 ? 'Cealaltă știre' : `Celelalte ${restCount} știri`}: {pct(restShare)} din pondere, contribuție {signed(restContribution)} la medie.
              </p>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="ix-params" className="flex flex-col gap-2">
        <h3 id="ix-params" className="panel-title">Parametrii</h3>
        <ul className="grid grid-cols-1 gap-x-6 gap-y-0.5 text-[12.5px] text-muted sm:grid-cols-2">
          <li>prospețimea: jumătate la {fmtNum(p.halfLifeH, 1)} ore</li>
          <li>spre neutru: + {fmtNum(p.shrinkK, 2)} la Σ pondere</li>
          <li>panta scalei: {fmtNum(p.gamma, 2)}</li>
          <li>plafonul sursei: {pct(p.sourceCap)}, de la 4 surse</li>
          <li>povestea: + {fmtNum(p.clusterBoost, 2)} · log₂ n</li>
          <li>
            pozitiv / negativ: peste {signed(r.labelT, 1)} / sub {signed(-r.labelT, 1)}
          </li>
          <li>
            încrederea: {fmtNum(r.confidence.medium, 0)} / {fmtNum(r.confidence.high, 0)}
          </li>
          <li>
            factori: sponsorizat {fmtNum(r.spec.sponsored, 1)}, speculativ / rezumat {fmtNum(r.spec.speculative, 1)}; tema energie / AI × {fmtNum(r.theme, 1)}
          </li>
          {r.market && (
            <li>
              reacția piețelor (S&amp;P 500 și Nasdaq 100; BTC și ETH): ziua obișnuită din {r.market.sessions} de zile; scor tanh(m ÷ {fmtNum(r.market.scale, 0)}); cota |m| ÷ (|m| +{' '}
              {fmtNum(r.market.strength, 1)})
            </li>
          )}
        </ul>
        <p className="text-[12.5px] text-faint">Din aplicație se schimbă greutatea surselor (Setări → Admin → Surse); restul, din cod.</p>
      </section>
    </div>
  );
}

export function IndexExplain({ onClose }: { onClose: () => void }) {
  const tz = useTz();
  // Fetched when opened (never in the background): the numbers of that moment; "Recalculează" takes new ones.
  const q = useQuery({ queryKey: ['sentiment', 'explain'], queryFn: () => api.get<TodayExplain>('/api/sentiment/today/explain'), staleTime: 0, gcTime: 0, refetchOnWindowFocus: false });
  return (
    <Modal
      // A premium feature (FD-WHYPLAIN §2): the same tag as Slingshot and LMA.
      title={
        <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
          Cum s-a calculat sentimentul zilei <PremiumBadge />
        </span>
      }
      onClose={onClose}
      width={980}
      headerExtra={
        q.data ? (
          <button type="button" className="btn" onClick={() => q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? 'Se calculează…' : 'Recalculează'}
          </button>
        ) : null
      }
    >
      {q.data ? (
        <>
          {/* A failed "Recalculează": the numbers shown stay those of before, and it says so. */}
          {q.isError && <p className="mb-4 text-[12.5px] text-bear">Recalcularea a eșuat; se arată calculul de dinainte.</p>}
          <Body e={q.data} tz={tz} />
        </>
      ) : q.isError ? (
        <ErrorNote error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <Loading />
      )}
    </Modal>
  );
}
