// FIX-BOTLABEL: a field with buttons or several controls is a titled group, never a <label> (in a label, a click
// anywhere outside a control presses its first one: the first symbol's "×", a switch's first button).
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Field } from './components/bots/bot-ui.tsx';

/** Each `<Field …>…</Field>` of a source: its opening tag and what it holds (nested fields included). */
function fields(src: string): { open: string; body: string; line: number }[] {
  const out: { open: string; body: string; line: number }[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf('<Field', from);
    if (start < 0) return out;
    from = start + 1;
    if (!/[\s>]/.test(src[start + 6] ?? '')) continue;
    // The opening tag ends at the first `>` outside braces and quotes (`=>` in a hint is inside braces).
    let i = start + 6;
    let depth = 0;
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i] as string;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const open = src.slice(start, i + 1);
    if (open.endsWith('/>')) continue;
    // Its </Field>, past the fields inside it.
    let level = 1;
    let j = i + 1;
    while (level > 0) {
      const o = src.indexOf('<Field', j);
      const c = src.indexOf('</Field>', j);
      if (c < 0) throw new Error('unclosed <Field>');
      if (o >= 0 && o < c && /[\s>]/.test(src[o + 6] ?? '')) {
        level++;
        j = o + 1;
      } else {
        level--;
        j = c + 1;
      }
    }
    out.push({ open, body: src.slice(i + 1, j - 1), line: src.slice(0, start).split('\n').length });
  }
}

const CONTROL = /<(input|select|textarea|Num|TfSelect)\b/g;

describe('FIX-BOTLABEL: fields with buttons are groups, not labels', () => {
  for (const file of ['src/web/components/bots/BotFormView.tsx', 'src/web/components/OrderTicket.tsx']) {
    it(`${file}: every field with a button, a switch or several controls has \`group\``, () => {
      const src = readFileSync(file, 'utf8');
      const found = fields(src);
      expect(found.length).toBeGreaterThan(5);
      const wrong = found
        .filter(({ body }) => /<button\b|<Seg\b|className="seg/.test(body) || (body.match(CONTROL)?.length ?? 0) > 1)
        .filter(({ open }) => !/\sgroup(\s|=|>)/.test(open))
        .map(({ open, line }) => `${line}: ${open.slice(0, 80)}`);
      expect(wrong).toEqual([]);
    });
  }

  it('renders a group as a titled div (no label), a single control as a label', () => {
    const group = renderToStaticMarkup(createElement(Field, { label: 'Direcția', group: true, children: createElement('button', { type: 'button' }, 'Long') }));
    expect(group).not.toContain('<label');
    expect(group).toMatch(/^<div role="group" aria-labelledby="([^"]+)"[^>]*><span id="\1"/);
    const single = renderToStaticMarkup(createElement(Field, { label: 'Suma maximă', children: createElement('input', {}) }));
    expect(single).toMatch(/^<label/);
  });
});
