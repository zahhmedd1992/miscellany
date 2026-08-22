/* The text layout engine and the PDF it produces.
 * Run: node test/doc.layout.test.mjs
 *
 * THE CLAIM UNDER TEST, stated so a failure means something:
 *
 *   Doc lays a page out with core/text/metrics.js, and writes those same
 *   numbers into the PDF as the font's /Widths array. So the PDF must break
 *   its lines in exactly the places the layout engine chose - not
 *   approximately, and not "when we checked".
 *
 * The last section proves it the only way that is worth anything: it builds a
 * PDF, then READS IT BACK with the project's own PDF reader (core/pdf), pulls
 * the text-positioning operators out of the content stream, and compares
 * them against what layout() said. Two implementations agreeing is evidence;
 * one asserting is a press release.
 */

import {
  layout, DEFAULT_PAGE, PAGE_SIZES, pageBox, paraProps, countWords, unprintableIn,
} from '../src/core/text/layout.js';
import { drawPage } from '../src/core/text/render.js';
import { textWidth, faceOf, stringWidth, winAnsiCode, unprintable, WIDTHS }
  from '../src/core/text/metrics.js';
import { PdfCanvas, FontRegistry, pdfString, parseColour } from '../src/core/pdf/canvas.js';
import { buildDocument } from '../src/core/pdf/make.js';
import { PdfDoc } from '../src/core/pdf/doc.js';
import { decodeStream } from '../src/core/pdf/xref.js';

let pass = 0, fail = 0;
const fails = [];
const t = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else { fail++; fails.push(`${name}\n      want: ${want}\n      got : ${got}`); }
};
const ok = (name, cond, extra = '') => t(name + (extra ? ` (${extra})` : ''), !!cond, true);
const near = (name, got, want, tol) => {
  if (Math.abs(got - want) <= tol) pass++;
  else { fail++; fails.push(`${name}\n      want: ${want} ±${tol}\n      got : ${got}`); }
};

const para = (text, p = {}) => ({ kind: 'para', text, runs: [{ n: text.length }], p });
const LOREM =
  'The quick brown fox jumps over the lazy dog and keeps on running past the ' +
  'edge of the column, which is the only way to find out where a line breaks.';

/* ---- metrics ------------------------------------------------------------- */

t('Helvetica space is 278/1000', WIDTHS['Helvetica'][0], 278);
t('Courier is monospaced', new Set(WIDTHS['Courier']).size, 1);
t('an oblique face shares its upright advances',
  WIDTHS['Helvetica'] === WIDTHS['Helvetica-Oblique'], true);
t('Times italic is NOT its upright', WIDTHS['Times-Roman'] === WIDTHS['Times-Italic'], false);
t('faceOf picks the bold italic', faceOf('serif', true, true), 'Times-BoldItalic');
/* H=722 e=556 l=222 l=222 o=556 -> 2278/1000 em, x 12pt. Worked out from the
 * table rather than remembered, because a remembered number is how a wrong
 * width table gets a passing test written around it. */
near('a 12pt "Hello" in Helvetica', textWidth('Helvetica', 'Hello', 12), 2278 * 12 / 1000, 0.001);
t('a curly quote is encodable', winAnsiCode('’'), 0x92);
t('an em dash is encodable', winAnsiCode('—'), 0x97);
t('a Cyrillic letter is not', winAnsiCode('Ж'), -1);
t('unprintable() names what it cannot set', unprintable('a Ж b 中').join(''), 'Ж中');
t('an unencodable character still takes width',
  stringWidth('Helvetica', 'Ж') > 0, true);

/* ---- line breaking ------------------------------------------------------- */

{
  const out = layout([para(LOREM)], DEFAULT_PAGE);
  t('one page', out.pages.length, 1);
  const lines = out.pages[0].lines;
  ok('the paragraph wrapped', lines.length > 1, `${lines.length} lines`);

  /* The property that matters, checked against the metrics rather than
   * against a remembered result: no line's trimmed text may be wider than
   * the column, and adding the first word of the next line must overflow it.
   * That is what "greedy and correct" means, and it holds whatever the font. */
  let over = 0, slack = 0;
  const availW = out.content.w;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const text = l.chunks.map((c) => c.text).join('');
    const w = textWidth('Times-Roman', text.replace(/\s+$/, ''), 11);
    if (w > availW + 0.01) over++;
    if (i + 1 < lines.length) {
      const nextWord = lines[i + 1].chunks.map((c) => c.text).join('').split(' ')[0];
      const w2 = textWidth('Times-Roman', text.replace(/\s+$/, '') + ' ' + nextWord, 11);
      if (w2 <= availW + 0.01) slack++;
    }
  }
  t('no line overflows the column', over, 0);
  t('no line could have taken another word', slack, 0);
}

t('an empty paragraph is still a line',
  layout([para('')], DEFAULT_PAGE).pages[0].lines.length, 1);

{
  /* Trailing spaces must not push a line over. A word processor that measures
   * them wraps one word early on justified text and nobody can say why. */
  const width = DEFAULT_PAGE.margin ? 0 : 0;
  void width;
  const text = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn ooo ppp';
  const a = layout([para(text)], DEFAULT_PAGE).pages[0].lines.length;
  const b = layout([para(text.split(' ').join('  '))], DEFAULT_PAGE).pages[0].lines.length;
  ok('double spaces do not change the line count wildly', Math.abs(a - b) <= 1, `${a} vs ${b}`);
}

{
  const long = 'https://example.com/' + 'x'.repeat(400);
  const out = layout([para(long)], DEFAULT_PAGE);
  ok('an over-long word is broken rather than overflowing',
    out.pages[0].lines.length > 1, `${out.pages[0].lines.length} lines`);
  const widest = Math.max(...out.pages[0].lines.map((l) => l.width || 0));
  ok('and every piece of it fits the column', widest <= out.content.w + 0.5,
     `widest ${widest.toFixed(1)} of ${out.content.w}`);
}

/* ---- alignment and justification ----------------------------------------- */

{
  const out = layout([para(LOREM, { align: 'justify' })], DEFAULT_PAGE);
  const lines = out.pages[0].lines;
  const items = out.pages[0].items.filter((i) => i.t === 'text');
  const spaced = items.filter((i) => i.spacing > 0);
  ok('justification stretched the spaces', spaced.length > 0);
  /* The last line of a justified paragraph is NEVER justified. Every naive
   * implementation gets this wrong and the result is instantly recognisable. */
  const lastLine = lines[lines.length - 1];
  const lastItems = lastLine.items.filter((i) => i.t === 'text');
  t('the last line is not justified', lastItems.every((i) => !i.spacing), true);

  /* A justified line reaches the right margin. Measured on the last INK, not
   * on the string: a chunk keeps its trailing space, and a trailing space
   * sits past the margin by design - which is exactly why trailing whitespace
   * must not be measured when deciding where to break, either. */
  const first = lines[0];
  const inkEnd = (i) => {
    const trimmed = i.s.replace(/\s+$/, '');
    return i.x + textWidth(i.face, trimmed, i.size) +
      (trimmed.split(' ').length - 1) * (i.spacing || 0);
  };
  const end = Math.max(...first.items.filter((i) => i.t === 'text').map(inkEnd));
  near('a justified line ends at the right margin', end, out.content.x + out.content.w, 0.6);
}

{
  const c = layout([para('centre me', { align: 'center' })], DEFAULT_PAGE);
  const item = c.pages[0].items.find((i) => i.t === 'text');
  const w = textWidth('Times-Roman', 'centre me', 11);
  near('centred text is centred', item.x + w / 2, c.content.x + c.content.w / 2, 0.5);
  const r = layout([para('right me', { align: 'right' })], DEFAULT_PAGE);
  const ri = r.pages[0].items.find((i) => i.t === 'text');
  near('right-aligned text ends at the margin',
    ri.x + textWidth('Times-Roman', 'right me', 11), r.content.x + r.content.w, 0.5);
}

/* ---- pagination ---------------------------------------------------------- */

{
  const many = [];
  for (let i = 0; i < 220; i++) many.push(para(`Paragraph number ${i + 1}. ${LOREM}`));
  const out = layout(many, DEFAULT_PAGE);
  ok('220 paragraphs make several pages', out.pages.length > 8, `${out.pages.length} pages`);
  const box = pageBox(DEFAULT_PAGE);
  let spill = 0;
  for (const p of out.pages) {
    for (const l of p.lines) {
      if (l.y + l.height > box.h - DEFAULT_PAGE.margin.bottom + 0.5) spill++;
      if (l.y < DEFAULT_PAGE.margin.top - 0.5) spill++;
    }
  }
  t('nothing is laid out past a margin', spill, 0);
  // every paragraph survived
  const ids = new Set();
  for (const p of out.pages) for (const l of p.lines) ids.add(l.blockIndex);
  t('every paragraph reached a page', ids.size, 220);
}

{
  const out = layout(
    [para('before'), { kind: 'pagebreak' }, para('after')], DEFAULT_PAGE);
  t('a page break makes a page', out.pages.length, 2);
  t('and moves the text to it', out.pages[1].lines[0].chunks[0].text.trim(), 'after');
}

{
  /* Widows and orphans: never one line of a paragraph alone across a break. */
  const filler = [];
  for (let i = 0; i < 44; i++) filler.push(para(`line ${i}`));
  filler.push(para(LOREM + ' ' + LOREM));
  const out = layout(filler, DEFAULT_PAGE);
  let widows = 0;
  for (const p of out.pages) {
    const byBlock = new Map();
    for (const l of p.lines) byBlock.set(l.blockIndex, (byBlock.get(l.blockIndex) || 0) + 1);
    for (const [bi, n] of byBlock) {
      const total = out.pages.reduce((acc, pg) =>
        acc + pg.lines.filter((l) => l.blockIndex === bi).length, 0);
      if (total > 1 && n === 1) widows++;
    }
  }
  t('no paragraph is split leaving a single line', widows, 0);
}

/* ---- fields, lists, tables ------------------------------------------------ */

{
  const blocks = [{
    kind: 'para', id: 'p1', text: 'Revenue was ￼ last quarter.',
    runs: [{ n: 12 }, { n: 1, field: 'f1' }, { n: 14 }], p: {},
  }];
  const out = layout(blocks, DEFAULT_PAGE, { resolve: () => '$425,550' });
  const texts = out.pages[0].items.filter((i) => i.t === 'text').map((i) => i.s).join('');
  ok('a field renders its computed value', texts.includes('$425,550'), texts);
  ok('and is marked so it can be tinted on screen',
    out.pages[0].items.some((i) => i.t === 'field'));

  // the source offsets must still describe the DOCUMENT, not the display
  const chunk = out.pages[0].lines[0].chunks.find((c) => c.field);
  t('a field is one character in the document', chunk.len, 1);

  const wider = layout(blocks, DEFAULT_PAGE, { resolve: () => 'a much longer value indeed' });
  ok('a longer value re-flows the line',
    wider.pages[0].lines[0].chunks.length >= out.pages[0].lines[0].chunks.length);
}

{
  const items = [];
  for (let i = 0; i < 3; i++) items.push(para(`item ${i}`, { list: 'number' }));
  const out = layout(items, DEFAULT_PAGE);
  const marks = out.pages[0].items.filter((i) => i.marker).map((i) => i.s);
  t('a numbered list numbers itself', marks.join(' '), '1. 2. 3.');
  const nested = layout([
    para('a', { list: 'number' }),
    para('b', { list: 'number', level: 1 }),
    para('c', { list: 'number', level: 1 }),
    para('d', { list: 'number' }),
  ], DEFAULT_PAGE);
  t('a sub-list restarts and the parent continues',
    nested.pages[0].items.filter((i) => i.marker).map((i) => i.s).join(' '),
    '1. a. b. 2.');
  const bullets = layout([para('x', { list: 'bullet' })], DEFAULT_PAGE);
  t('a bulleted list gets a bullet',
    bullets.pages[0].items.find((i) => i.marker).s, '•');
}

{
  const cell = (s) => ({ blocks: [para(s)] });
  const table = {
    kind: 'table',
    rows: [[cell('Month'), cell('Revenue')], [cell('July'), cell('128,400')]],
    cols: [200, 200],
  };
  const out = layout([table], DEFAULT_PAGE);
  const texts = out.pages[0].items.filter((i) => i.t === 'text').map((i) => i.s.trim());
  ok('every cell was laid out', ['Month', 'Revenue', 'July', '128,400']
    .every((w) => texts.includes(w)), texts.join('|'));
  ok('the table has rules', out.pages[0].items.some((i) => i.t === 'rule'));
  const xs = out.pages[0].items.filter((i) => i.t === 'text').map((i) => i.x);
  ok('the second column starts to the right of the first',
    Math.max(...xs) > Math.min(...xs) + 100);
}

{
  const out = layout([para('body')], { ...DEFAULT_PAGE, footer: { text: 'Page {PAGE} of {PAGES}' } });
  const chrome = out.pages[0].items.find((i) => i.chrome);
  t('a footer substitutes the page numbers', chrome.s, 'Page 1 of 1');
}

t('A4 is not Letter', Math.round(pageBox({ ...DEFAULT_PAGE, size: 'a4' }).w), 595);
t('landscape swaps the axes',
  Math.round(pageBox({ ...DEFAULT_PAGE, size: 'letter', landscape: true }).w), 792);

t('word count counts words',
  countWords([para('one two three'), para('four')]).words, 4);
t('word count ignores a field placeholder',
  countWords([{ kind: 'para', text: 'a ￼ b', runs: [], p: {} }]).words, 2);
t('unprintableIn finds what the fonts cannot print',
  unprintableIn([para('fine'), para('中文')]).length, 2);

/* ---- the PDF ------------------------------------------------------------- */

function makePdf(blocks, page = DEFAULT_PAGE, opts = {}) {
  const out = layout(blocks, page, opts);
  const reg = new FontRegistry();
  const box = pageBox(page);
  const pages = [];
  for (const p of out.pages) {
    const ctx = new PdfCanvas(box.w, box.h, reg);
    drawPage(ctx, p, { fieldTint: false });
    pages.push({ w: box.w, h: box.h, content: ctx.content(),
                 images: ctx.images, gstates: ctx.gstates(), fonts: reg.names() });
  }
  return { bytes: buildDocument(pages, { title: 'test', date: new Date(0) }), out, pages };
}

t('pdfString escapes a parenthesis', pdfString('a(b)c'), 'a\\(b\\)c');
t('pdfString octal-escapes a curly quote', pdfString('’'), '\\222');
t('pdfString substitutes what it cannot encode', pdfString('中'), '?');
t('parseColour reads #RGB', JSON.stringify(parseColour('#f00').rgb), '[1,0,0]');
t('parseColour reads rgba alpha', parseColour('rgba(0,0,0,0.5)').a, 0.5);

{
  const { bytes } = makePdf([para(LOREM)]);
  const head = String.fromCharCode(...bytes.subarray(0, 8));
  t('the file starts with a PDF header', head.startsWith('%PDF-1.'), true);
  const tail = String.fromCharCode(...bytes.subarray(bytes.length - 8));
  t('and ends with %%EOF', tail.trim().endsWith('%%EOF'), true);
}

/* The real check: read our own PDF back with our own reader. */
const pdfCheck = await (async () => {
  const blocks = [
    para('A Report', { style: 'title' }),
    para(LOREM, { align: 'justify' }),
    para(LOREM),
    para('Bold and italic', { style: 'h2' }),
  ];
  const { bytes, out } = makePdf(blocks);
  const doc = await PdfDoc.open(bytes);
  t('our reader opens our writer', doc.pages.length, out.pages.length);
  t('the page is US Letter', doc.pages[0].mediaBox.join(','), '0,0,612,792');

  // fonts: /Widths must be present, and must be OUR table
  const res = doc.resolve(doc.pages[0].dict.get('Resources'));
  const fonts = doc.resolve(res.dict.get('Font'));
  const names = [...fonts.dict.keys()];
  ok('the page declares its fonts', names.length >= 1, names.join(','));
  let widthsChecked = 0;
  for (const n of names) {
    const f = doc.resolve(fonts.dict.get(n));
    const base = f.dict.get('BaseFont').name;
    const w = f.dict.get('Widths');
    t(`${base} is not embedded but declares its widths`, Array.isArray(w) && w.length, 224);
    t(`${base} widths match core/text/metrics.js`,
      w.join(',') === WIDTHS[base].join(','), true);
    t(`${base} uses WinAnsiEncoding`, f.dict.get('Encoding').name, 'WinAnsiEncoding');
    widthsChecked++;
  }
  ok('at least two faces were used (title is bold)', widthsChecked >= 2, String(widthsChecked));

  /* Pull the text matrices out of the content stream and compare them with
   * what the layout engine computed. This is the whole claim: the PDF puts
   * the words where the screen puts them. */
  const cs = doc.resolve(doc.pages[0].dict.get('Contents'));
  const data = await decodeStream(bytes, cs.stream);
  const text = new TextDecoder('latin1').decode(data);
  const placed = [];
  const re = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm\n\((.*?)\) Tj/g;
  let m;
  while ((m = re.exec(text))) {
    placed.push({ x: parseFloat(m[5]), y: parseFloat(m[6]), s: m[7] });
  }
  const expect = out.pages[0].items.filter((i) => i.t === 'text');
  t('every text item reached the content stream', placed.length, expect.length);
  let worstX = 0, worstY = 0;
  for (let i = 0; i < Math.min(placed.length, expect.length); i++) {
    worstX = Math.max(worstX, Math.abs(placed[i].x - expect[i].x));
    worstY = Math.max(worstY, Math.abs(placed[i].y - (792 - expect[i].y)));
  }
  near('every word sits where layout put it, horizontally', worstX, 0, 0.0002);
  near('every word sits where layout put it, vertically', worstY, 0, 0.0002);
  return { placed, expect };
})();
void pdfCheck;

{
  /* A justified line in the PDF must reach the right margin, which is only
   * true if the per-word offsets were written out rather than a wordSpacing
   * the format does not have. */
  const { bytes, out } = makePdf([para(LOREM, { align: 'justify' })]);
  const doc = await PdfDoc.open(bytes);
  const cs = doc.resolve(doc.pages[0].dict.get('Contents'));
  const data = await decodeStream(bytes, cs.stream);
  const text = new TextDecoder('latin1').decode(data);
  const xs = [...text.matchAll(/([-\d.]+) ([-\d.]+) Tm\n\((.*?)\) Tj/g)]
    .map((m) => ({ x: parseFloat(m[1]), s: m[3] }));
  const firstLineY = out.pages[0].lines[0].base;
  void firstLineY;
  const rightmost = Math.max(...xs.map((p) => p.x + textWidth('Times-Roman', p.s, 11)));
  ok('the justified text reaches the right margin in the PDF',
    rightmost >= out.content.x + out.content.w - 1.2,
    `${rightmost.toFixed(1)} vs ${(out.content.x + out.content.w).toFixed(1)}`);
}

{
  const many = [];
  for (let i = 0; i < 120; i++) many.push(para(`Paragraph ${i}. ${LOREM}`));
  const { bytes, out } = makePdf(many);
  const doc = await PdfDoc.open(bytes);
  t('a multi-page document writes every page', doc.pages.length, out.pages.length);
  ok('and stays a sane size', bytes.length < 900000, `${(bytes.length / 1024).toFixed(0)} KB`);
}

/* ---- report -------------------------------------------------------------- */

console.log(`\n  doc layout + pdf: ${pass} passed, ${fail} failed`);
for (const f of fails) console.log('   x ' + f);
process.exit(fail ? 1 : 0);
