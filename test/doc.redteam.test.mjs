/* Regression gate for what an adversarial review found.
 * Run: node test/doc.redteam.test.mjs
 *
 * Every assertion here corresponds to a defect that the author's own 110
 * assertions were green on. They are kept together, and named after the
 * failure rather than the function, so that a regression reads as the thing
 * coming back rather than as a test going red.
 *
 * The common shape of all of them: the suite measured the thing it had
 * thought of, on the case it had thought of. The review measured the picture.
 */

import { layout, DEFAULT_PAGE, pageBox, countWords, unprintableIn, SHY, SOFT_BREAK }
  from '../src/core/text/layout.js';
import { drawPage } from '../src/core/text/render.js';
import { textWidth, winAnsiCode, unprintable, stringWidth } from '../src/core/text/metrics.js';
import { PdfCanvas, FontRegistry } from '../src/core/pdf/canvas.js';

let pass = 0, fail = 0;
const fails = [];
const t = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else { fail++; fails.push(`${name}\n      want: ${want}\n      got : ${got}`); }
};
const ok = (name, cond, extra = '') => t(name + (extra ? ` (${extra})` : ''), !!cond, true);

const para = (text, p = {}) => ({ kind: 'para', text, runs: [{ n: text.length }], p });
const inkEnd = (i) => {
  const trimmed = i.s.replace(/\s+$/, '');
  return i.x + textWidth(i.face, trimmed, i.size) +
    (i.stretch ? Math.min(i.stretch, (trimmed.match(/ /g) || []).length) * i.spacing : 0);
};

/* ---- 1. a table row taller than the page must not fall off it ------------ */

{
  /* One long answer typed into one cell of a two-cell table — a risk register,
   * a requirements table, a form. 1,213 of 1,923 drawing instructions used to
   * be emitted below the bottom edge of the paper, and the PDF just stopped. */
  const long = [];
  for (let i = 0; i < 160; i++) long.push(`Point ${i}: a sentence of ordinary body text typed into the cell.`);
  const cell = { blocks: long.map((x) => para(x)) };
  const out = layout([{ kind: 'table', rows: [[{ blocks: [para('Question')] }, cell]],
                        cols: [140, 330] }], DEFAULT_PAGE);
  const box = pageBox(DEFAULT_PAGE);
  ok('a tall row spills onto more pages', out.pages.length > 1, `${out.pages.length} pages`);

  let offPaper = 0, belowMargin = 0;
  for (const p of out.pages) {
    for (const it of p.items) {
      if (it.t !== 'text') continue;
      if (it.y > box.h) offPaper++;
      if (it.y > box.h - DEFAULT_PAGE.margin.bottom + 2) belowMargin++;
    }
  }
  t('not one word is drawn off the paper', offPaper, 0);
  t('and not one is drawn below the bottom margin', belowMargin, 0);

  // and the LAST sentence of the cell is really on a page
  const all = out.pages.flatMap((p) => p.items).filter((i) => i.t === 'text')
    .map((i) => i.s).join('');
  ok('the last line of the cell survived', all.includes('Point 159'));
  ok('and so did the first', all.includes('Point 0'));
}

{
  // a chart taller than the page is scaled, not clipped
  const out = layout([{ kind: 'chart', id: 'c', w: 400, h: 2000, spec: {} }], DEFAULT_PAGE);
  const box = pageBox(DEFAULT_PAGE);
  const item = out.pages[0].items.find((i) => i.t === 'chart');
  ok('an over-tall chart is scaled to the page', item.y + item.h <= box.h + 0.5,
     `bottom ${(item.y + item.h).toFixed(0)} of ${box.h}`);
  ok('and says so', out.warnings.some((w) => /taller than the page/.test(w)));
}

/* ---- 2. the soft hyphen: screen and page must spell the same word -------- */

t('a soft hyphen has no width', stringWidth('Times-Roman', SHY), 0);
t('and is not reported as a character we cannot print', unprintable('co' + SHY + 'op').length, 0);
t('while a real one still is', unprintable('Ж').length, 1);

{
  const text = 'The co' + SHY + 'operative agreed to re' + SHY + 'examine the pre' +
               SHY + 'existing sub' + SHY + 'contract.';
  const out = layout([para(text)], DEFAULT_PAGE);
  const items = out.pages[0].items.filter((i) => i.t === 'text');
  const shown = items.map((i) => i.s).join('');
  t('the screen shows the word unhyphenated', shown.includes('cooperative'), true);
  t('and no hyphen was inserted', /co-operative/.test(shown), false);

  /* The PDF is the same drawing instructions, so it cannot differ. Compared
   * on the CONCATENATION of the strings the content stream actually shows —
   * the pieces are separate Tj operators (a soft hyphen ends a piece), so
   * searching the raw stream for the whole word would fail on a correct file
   * and prove nothing about an incorrect one. */
  const reg = new FontRegistry();
  const ctx = new PdfCanvas(612, 792, reg);
  drawPage(ctx, out.pages[0], { fieldTint: false });
  const printed = [...ctx.content().matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]).join('');
  t('the PDF prints exactly what the screen shows', printed, shown);
  t('and no hyphen reached the page', /co-operative|re-examine/.test(printed), false);
}

{
  // ...but when the line DOES break there, the hyphen appears
  const word = 'un' + SHY + 'be' + SHY + 'liev' + SHY + 'ably';
  const filler = new Array(14).fill('wide').join(' ');
  const out = layout([para(`${filler} ${word} ${filler}`, { align: 'left' })],
                     { ...DEFAULT_PAGE, margin: { top: 72, right: 400, bottom: 72, left: 72 } });
  const hyphens = out.pages[0].items.filter((i) => i.t === 'text' && i.s === '-').length;
  ok('a line broken at a soft hyphen prints one', hyphens >= 1, `${hyphens} drawn`);
}

/* ---- 3. justification reaches the margin on EVERY line ------------------- */

{
  /* The original assertion measured line 0 of one wide-gap paragraph, and
   * passed at 0.01pt while line 1 of the same paragraph was 1.2pt out. This
   * measures every line of several shapes, including the two-words-per-line
   * case that was over an inch short. */
  const shapes = {
    'ordinary prose': new Array(60).fill('the quick brown fox jumps over it').join(' '),
    'long words': new Array(24).fill('Unternehmensberatungsgesellschaft').join(' '),
    'two per line': new Array(20).fill('Wirtschaftspruefungsgesellschaft Nachrichtenagenturen').join(' '),
  };
  let worst = 0, worstName = '';
  for (const [name, text] of Object.entries(shapes)) {
    const out = layout([para(text, { align: 'justify' })], DEFAULT_PAGE);
    const right = out.content.x + out.content.w;
    for (const p of out.pages) {
      for (let i = 0; i < p.lines.length; i++) {
        const line = p.lines[i];
        const isLast = i === p.lines.length - 1 && p === out.pages[out.pages.length - 1];
        if (isLast) continue;
        const its = line.items.filter((x) => x.t === 'text');
        if (!its.length) continue;
        const end = Math.max(...its.map(inkEnd));
        const shortBy = right - end;
        if (shortBy > worst) { worst = shortBy; worstName = name; }
      }
    }
  }
  ok(`every justified line reaches the right margin (worst ${worst.toFixed(2)}pt, ${worstName})`,
     worst < 0.75);
}

/* ---- 4. a numbered list survives commentary between its items ------------ */

{
  const out = layout([
    para('one', { list: 'number' }),
    para('two', { list: 'number' }),
    para('A note about the above.'),
    para('three', { list: 'number' }),
    para('four', { list: 'number' }),
  ], DEFAULT_PAGE);
  t('a numbered list continues past an interruption',
    out.pages[0].items.filter((i) => i.marker).map((i) => i.s).join(' '),
    '1. 2. 3. 4.');

  const out2 = layout([
    para('one', { list: 'number' }),
    para('New section', { style: 'h1' }),
    para('one again', { list: 'number' }),
  ], DEFAULT_PAGE);
  t('but a heading starts a new one',
    out2.pages[0].items.filter((i) => i.marker).map((i) => i.s).join(' '), '1. 1.');
}

/* ---- 5. {PAGES} is the last page number, not the count ------------------- */

{
  const many = new Array(120).fill(0).map((_, i) => para(`Paragraph ${i}. ` + 'word '.repeat(40)));
  const out = layout(many, { ...DEFAULT_PAGE, firstPageNumber: 5,
                             footer: { text: 'Page {PAGE} of {PAGES}' } });
  const first = out.pages[0].items.find((i) => i.chrome).s;
  const last = out.pages[out.pages.length - 1].items.find((i) => i.chrome).s;
  const n = out.pages.length;
  t('a document numbered from 5 does not say "of 3"', first, `Page 5 of ${4 + n}`);
  t('and its last page agrees with itself', last, `Page ${4 + n} of ${4 + n}`);
}

/* ---- 6. a soft line break really breaks the line ------------------------- */

{
  const out = layout([para('before' + SOFT_BREAK + 'after')], DEFAULT_PAGE);
  t('a soft break makes two lines', out.pages[0].lines.length, 2);
  const shown = out.pages[0].items.filter((i) => i.t === 'text').map((i) => i.s).join('|');
  t('and neither line contains the break character', shown.indexOf(SOFT_BREAK) >= 0, false);
  t('word count does not count it as a word', countWords([para('a' + SOFT_BREAK + 'b')]).words, 2);
}

/* ---- 7. the "cannot print" warning is about what will be PRINTED --------- */

{
  const blocks = [{ kind: 'para', text: 'Revenue was ￼ this quarter.',
                    runs: [{ n: 12 }, { n: 1, field: 'f1' }, { n: 14 }], p: {} }];
  const clean = layout(blocks, DEFAULT_PAGE, { resolve: () => '$4,250,000' });
  t('a document whose only oddity is a live figure warns about nothing',
    unprintableIn(clean).length, 0);

  const bad = layout(blocks, DEFAULT_PAGE, { resolve: () => 'Приход' });
  ok('but a field whose VALUE cannot be printed is caught',
     unprintableIn(bad).length > 0, JSON.stringify(unprintableIn(bad)));

  const head = layout([para('body')],
    { ...DEFAULT_PAGE, header: { text: 'Отчёт — Q3' } });
  ok('and so is a header', unprintableIn(head).length > 0, JSON.stringify(unprintableIn(head)));

  t('a tab is not a character we cannot print',
    unprintableIn(layout([para('a\tb')], DEFAULT_PAGE)).length, 0);
}

/* ---- report -------------------------------------------------------------- */

console.log(`\n  doc red-team regressions: ${pass} passed, ${fail} failed`);
for (const f of fails) console.log('   x ' + f);
process.exit(fail ? 1 : 0);
