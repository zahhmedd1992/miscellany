/* Grain - text layout: blocks in, pages out.
 *
 * This is the part the project spec called "deceptively enormous" and
 * deferred for a year. It is enormous in the sense that a word processor is
 * never finished; it is tractable in the sense that the enormity is all
 * ADDITIVE - tab stops, tables, widow control and justification are separate
 * decisions that compose, not one giant knot.
 *
 * The design constraint that makes the rest fall out:
 *
 *   NOTHING HERE MEASURES ANYTHING ON A CANVAS.
 *
 * Every width comes from core/text/metrics.js, the same table that is written
 * into the PDF as the font's /Widths array. So the line breaks on screen and
 * the line breaks on the page are not "kept in sync" - they are one
 * computation with two renderers, and cannot disagree. Every "export to PDF"
 * button that reflows your document does it the other way round.
 *
 * Units are POINTS (1/72 inch) everywhere, because that is what a page is
 * measured in and what a PDF speaks. The screen converts at the end; the
 * document never knows what a pixel is.
 *
 * The output is a list of pages of DRAWING PRIMITIVES plus a parallel line
 * index for hit-testing. Both are plain data: the renderer that paints a
 * canvas and the renderer that writes a PDF read the same array, and a test
 * can assert on it without a browser.
 */

import { faceOf, textWidth, familyOf, VMETRICS, unprintable } from './metrics.js';

/* ---- page geometry ------------------------------------------------------ */

export const PAGE_SIZES = {
  letter: { w: 612, h: 792, label: 'US Letter' },
  legal:  { w: 612, h: 1008, label: 'US Legal' },
  a4:     { w: 595.28, h: 841.89, label: 'A4' },
  a5:     { w: 419.53, h: 595.28, label: 'A5' },
};

export const DEFAULT_PAGE = {
  size: 'letter',
  landscape: false,
  margin: { top: 72, right: 72, bottom: 72, left: 72 },
  header: null,          // { text, align } - {PAGE} and {PAGES} substituted
  footer: null,
  firstPageNumber: 1,
};

/** Page box in points, honouring landscape. */
export function pageBox(page) {
  const s = PAGE_SIZES[page.size] || PAGE_SIZES.letter;
  return page.landscape ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
}

/* ---- paragraph styles ---------------------------------------------------
 * A style is a bundle of defaults, not a class in a hierarchy. Word's style
 * inheritance is a model - it decides that a document IS a tree of derived
 * formats - and inheriting it would put every later decision downstream of
 * that. A flat table of defaults, overridable per paragraph, covers what a
 * document actually needs and can be read in one screen.
 */

export const STYLES = {
  title:   { size: 26, bold: true,  before: 0,  after: 10, family: 'serif', line: 1.1 },
  h1:      { size: 18, bold: true,  before: 16, after: 6,  family: 'serif', line: 1.15 },
  h2:      { size: 14, bold: true,  before: 13, after: 4,  family: 'serif', line: 1.15 },
  h3:      { size: 12, bold: true,  before: 11, after: 3,  family: 'serif', line: 1.15, italic: true },
  body:    { size: 11, before: 0,  after: 8,  family: 'serif', line: 1.15 },
  quote:   { size: 11, before: 6,  after: 8,  family: 'serif', line: 1.15,
             italic: true, indentLeft: 36, indentRight: 36, color: '#4A4338' },
  code:    { size: 9.5, before: 6, after: 8,  family: 'mono',  line: 1.25,
             indentLeft: 18, shade: '#F5F0E6' },
  caption: { size: 9,  before: 2,  after: 10, family: 'sans',  line: 1.15, color: '#6C6356' },
};

export const STYLE_LABELS = {
  title: 'Title', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3',
  body: 'Body text', quote: 'Quote', code: 'Code', caption: 'Caption',
};

/** Resolve a paragraph's effective properties: style defaults + overrides. */
export function paraProps(p = {}) {
  const base = STYLES[p.style] || STYLES.body;
  return {
    style: p.style || 'body',
    size: p.size ?? base.size,
    family: p.family ?? base.family ?? 'serif',
    bold: p.bold ?? base.bold ?? false,
    italic: p.italic ?? base.italic ?? false,
    color: p.color ?? base.color ?? '#211C16',
    align: p.align ?? base.align ?? 'left',
    line: p.line ?? base.line ?? 1.15,
    before: p.before ?? base.before ?? 0,
    after: p.after ?? base.after ?? 0,
    indentLeft: p.indentLeft ?? base.indentLeft ?? 0,
    indentRight: p.indentRight ?? base.indentRight ?? 0,
    indentFirst: p.indentFirst ?? base.indentFirst ?? 0,
    shade: p.shade ?? base.shade ?? null,
    list: p.list ?? null,
    level: p.level ?? 0,
    keepNext: p.keepNext ?? (base.keepNext || false),
    breakBefore: p.breakBefore ?? false,
    tabs: p.tabs ?? null,
    rule: p.rule ?? null,        // a horizontal rule under the paragraph
  };
}

/* Default tab stops, half an inch apart, exactly as every word processor
 * since the typewriter. Explicit stops in `tabs` take precedence. */
const DEFAULT_TAB = 36;

const BULLETS = ['•', '◦', '▪', '–', '·'];
const LIST_INDENT = 24;

/* ---- segmentation --------------------------------------------------------
 * A paragraph's text is one string; its formatting is a list of runs, each
 * covering a character count. Layout works on SEGMENTS: a run sliced at every
 * break opportunity, carrying its source offsets so a click on a glyph can be
 * turned back into a caret position in the text.
 */

/** Split a paragraph into styled segments, expanding field runs. */
function segments(block, resolve) {
  const props = paraProps(block.p);
  const text = block.text || '';
  const runs = normaliseRuns(block.runs, text.length);
  const out = [];
  let at = 0;
  for (const r of runs) {
    const slice = text.slice(at, at + r.n);
    const style = runStyle(props, r);
    if (r.field) {
      /* A field is one source character (an object-replacement placeholder)
       * that displays as however many the formula produced. It stays ATOMIC
       * for the caret - you put the cursor before or after it, never inside -
       * because the characters on screen are not the characters in the
       * document, and a caret at "offset 4 of a computed value" is a position
       * that ceases to exist the moment the number changes. */
      const shown = (resolve ? resolve(r.field, block.id) : null) ?? '';
      out.push({ text: String(shown), style, src: at, len: r.n, field: r.field, atomic: true });
    } else {
      for (const piece of breakPieces(slice)) {
        out.push({ text: piece.text, style, src: at + piece.at, len: piece.text.length });
      }
    }
    at += r.n;
  }
  if (!out.length) out.push({ text: '', style: runStyle(props, {}), src: 0, len: 0 });
  return { props, segs: out, runs };
}

/** Runs always cover the text exactly; a short or absent list is repaired. */
export function normaliseRuns(runs, len) {
  const out = [];
  let total = 0;
  for (const r of runs || []) {
    const n = Math.max(0, Math.min(r.n | 0, len - total));
    if (n === 0 && !r.field) continue;
    out.push({ ...r, n });
    total += n;
    if (total >= len) break;
  }
  if (total < len) out.push({ n: len - total });
  if (!out.length) out.push({ n: 0 });
  return out;
}

/** Character-level formatting for a run, over the paragraph's defaults. */
function runStyle(props, r) {
  const size = (r.sz ?? props.size) * (r.sup || r.sub ? 0.66 : 1);
  return {
    family: r.f ?? props.family,
    bold: r.b ?? props.bold,
    italic: r.i ?? props.italic,
    under: !!r.u,
    strike: !!r.s,
    size,
    baseSize: r.sz ?? props.size,
    color: r.c ?? props.color,
    hl: r.hl ?? null,
    sup: !!r.sup,
    sub: !!r.sub,
    link: r.link ?? null,
  };
}

/**
 * Break a string into pieces at every legal line-break opportunity.
 *
 * A piece keeps its own trailing spaces, so trailing whitespace never pushes
 * a line over: the space at the end of a wrapped line is invisible and must
 * not be measured against the margin. Word processors that get this wrong
 * wrap one word early on justified text and nobody can say why.
 */
function breakPieces(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const start = i;
    // a run of tabs is its own piece - a tab is a positioning instruction
    if (s[i] === '\t') {
      while (i < s.length && s[i] === '\t') i++;
      out.push({ at: start, text: s.slice(start, i) });
      continue;
    }
    while (i < s.length && s[i] !== ' ' && s[i] !== '\t' && !isBreakAfter(s[i])) i++;
    if (i < s.length && isBreakAfter(s[i])) i++;         // keep the hyphen/dash
    while (i < s.length && s[i] === ' ') i++;            // and the spaces after
    out.push({ at: start, text: s.slice(start, i) });
  }
  return out;
}

const isBreakAfter = (ch) => ch === '-' || ch === '–' || ch === '—' || ch === '/';

/** Width in points of a segment's text, in its own style. */
function segWidth(seg, s = seg.text) {
  return textWidth(faceOf(seg.style.family, seg.style.bold, seg.style.italic), s, seg.style.size);
}

const trimEnd = (s) => s.replace(/[ \t]+$/, '');

/* ---- the engine ---------------------------------------------------------- */

/**
 * Lay a document out.
 *
 * @param blocks   [{ kind:'para'|'table'|'image'|'chart'|'pagebreak', ... }]
 * @param page     see DEFAULT_PAGE
 * @param opts.resolve   (fieldId, blockId) -> display string
 * @param opts.numbering a mutable object; list counters live here so a
 *                       re-layout of the same document numbers identically
 * @returns { pages, box, content, blocks }  pages[i] = { items, lines, num }
 */
export function layout(blocks, page = DEFAULT_PAGE, opts = {}) {
  const pg = { ...DEFAULT_PAGE, ...page, margin: { ...DEFAULT_PAGE.margin, ...(page.margin || {}) } };
  const box = pageBox(pg);
  const content = {
    x: pg.margin.left,
    y: pg.margin.top,
    w: box.w - pg.margin.left - pg.margin.right,
    h: box.h - pg.margin.top - pg.margin.bottom,
  };

  const ctx = {
    pg, box, content, opts,
    pages: [],
    counters: [0, 0, 0, 0, 0],
    warnings: [],
  };
  newPage(ctx);

  // A line remembers which block it came from BY INDEX, because that is what
  // the editor needs to turn a click into a caret and an id alone cannot
  // survive two blocks sharing one (a table cell's paragraphs do).
  blocks.forEach((b, i) => { b._index = i; });

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.kind === 'pagebreak') { forcePage(ctx); continue; }
    if (b.kind === 'table') { placeTable(ctx, b, bi); continue; }
    if (b.kind === 'image' || b.kind === 'chart') { placeBox(ctx, b, bi); continue; }
    placePara(ctx, b, bi, blocks[bi + 1]);
  }

  // A trailing empty page happens when the last block ends exactly at the
  // bottom margin. It is real in Word too, but only if something is on it.
  const last = ctx.pages[ctx.pages.length - 1];
  if (ctx.pages.length > 1 && !last.lines.length && !last.items.length) ctx.pages.pop();

  decorate(ctx);
  return { pages: ctx.pages, box, content, page: pg, warnings: ctx.warnings };
}

function newPage(ctx) {
  const p = { items: [], lines: [], num: ctx.pages.length + 1, y: ctx.content.y };
  ctx.pages.push(p);
  return p;
}

const cur = (ctx) => ctx.pages[ctx.pages.length - 1];
const roomLeft = (ctx) => ctx.content.y + ctx.content.h - cur(ctx).y;

function forcePage(ctx) {
  const p = cur(ctx);
  if (!p.lines.length && !p.items.length) return;  // already at the top
  newPage(ctx);
}

/* ---- paragraphs ---------------------------------------------------------- */

function placePara(ctx, block, bi, next) {
  const { props, segs } = segments(block, ctx.opts.resolve);
  const listMark = listMarker(ctx, props);

  if (props.breakBefore) forcePage(ctx);

  const indentL = props.indentLeft + (props.list ? LIST_INDENT * (props.level + 1) : 0);
  const availW = ctx.content.w - indentL - props.indentRight;
  const lines = breakLines(segs, availW, props, listMark);

  /* Space before collapses at the top of a page - a heading that lands first
   * on page 3 should sit on the margin, not 16pt below it, and every reader
   * notices the difference between pages without knowing why. */
  const p0 = cur(ctx);
  const atTop = !p0.lines.length && !p0.items.length;
  if (!atTop) p0.y += props.before;

  /* Widow and orphan control: never leave one line of a paragraph alone on
   * either side of a page break. Two lines is the convention; a two-line
   * paragraph moves wholesale. */
  const heights = lines.map((l) => l.height);
  const need = heights.reduce((a, b) => a + b, 0);
  if (lines.length >= 2 && need > roomLeft(ctx)) {
    let fits = 0, acc = 0;
    for (const h of heights) { if (acc + h > roomLeft(ctx)) break; acc += h; fits++; }
    if (fits > 0 && (fits < 2 || lines.length - fits < 2)) forcePage(ctx);
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.height > roomLeft(ctx)) {
      // keepNext: a heading does not get to sit alone at the bottom of a page
      forcePage(ctx);
    }
    emitLine(ctx, block, props, line, li, lines.length, indentL, availW);
  }

  const p = cur(ctx);
  if (props.rule) {
    p.items.push({ t: 'rule', x: ctx.content.x, y: p.y + 3, w: ctx.content.w, h: 0.75,
                   color: props.rule === true ? '#DAD0BC' : props.rule });
    p.y += 7;
  }
  p.y += props.after;

  /* keepNext, applied after the fact: if the next block would start on a new
   * page, this one should have gone with it. Cheaper and more predictable
   * than lookahead, and it is what a heading needs. */
  if (props.keepNext && next && next.kind !== 'pagebreak') {
    const nextNeed = estimateFirstLine(next, ctx);
    if (nextNeed > roomLeft(ctx)) movePara(ctx, lines.length);
  }
}

/** Roughly how tall the first line of the following block will be. */
function estimateFirstLine(block, ctx) {
  if (block.kind === 'image' || block.kind === 'chart') return Math.min(block.h || 200, ctx.content.h);
  if (block.kind === 'table') return 24;
  const props = paraProps(block.p);
  return props.before + props.size * props.line;
}

/**
 * Move the last `n` lines of the current page onto a fresh one.
 *
 * This is how keepNext is honoured without laying anything out twice. The
 * lines already carry absolute coordinates, so they are translated by the
 * difference between where they were and where the new page starts.
 */
function movePara(ctx, n) {
  const from = cur(ctx);
  if (from.lines.length <= n) return;                 // it is the whole page
  const moved = from.lines.splice(from.lines.length - n, n);
  const firstY = moved[0].y;
  const items = [];
  for (const l of moved) items.push(...l.items);
  from.items = from.items.filter((it) => !items.includes(it));
  const to = newPage(ctx);
  const dy = ctx.content.y - firstY;
  for (const l of moved) {
    l.y += dy;
    l.page = to.num;
    for (const it of l.items) it.y += dy;
    to.items.push(...l.items);
    to.lines.push(l);
    to.y = l.y + l.height;
  }
  from.y = from.lines.length ? from.lines[from.lines.length - 1].y +
    from.lines[from.lines.length - 1].height : ctx.content.y;
}

/** The marker for a list paragraph, and the counter bookkeeping behind it. */
function listMarker(ctx, props) {
  if (!props.list) { ctx.counters = ctx.counters.map(() => 0); return null; }
  if (props.list === 'bullet') {
    return { text: BULLETS[props.level % BULLETS.length] };
  }
  const lv = props.level;
  ctx.counters[lv] = (ctx.counters[lv] || 0) + 1;
  for (let i = lv + 1; i < ctx.counters.length; i++) ctx.counters[i] = 0;
  const n = ctx.counters[lv];
  const label = lv === 0 ? `${n}.` : lv === 1 ? `${letter(n)}.` : `${roman(n)}.`;
  return { text: label };
}

const letter = (n) => String.fromCharCode(96 + ((n - 1) % 26) + 1);
function roman(n) {
  const t = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}

/**
 * Greedy line breaking.
 *
 * Greedy, not Knuth-Plass: optimal paragraph breaking produces prettier
 * rivers but makes an edit at the top of a paragraph reflow the bottom of it,
 * which in an interactive editor reads as the text jumping under your hands.
 * Word is greedy for the same reason.
 */
function breakLines(segs, availW, props, listMark) {
  const lines = [];
  let line = startLine(props, 0, listMark);
  let x = props.indentFirst;
  if (listMark) x = 0;

  const push = () => {
    finishLine(line, props);
    lines.push(line);
    line = startLine(props, lines.length, null);
    x = 0;
  };

  for (const seg of segs) {
    if (seg.text === '') {
      // An empty run still contributes its height - an empty paragraph is a
      // line, and a paragraph whose only run is a 24pt space is 24pt tall.
      line.chunks.push({ ...seg, x, w: 0 });
      continue;
    }
    if (seg.text[0] === '\t' && !seg.field) {
      for (const _ of seg.text) {
        const target = nextTab(x, props);
        line.chunks.push({ ...seg, text: '\t', x, w: target - x, tab: true });
        x = target;
      }
      continue;
    }
    let w = segWidth(seg);
    const wTrim = segWidth(seg, trimEnd(seg.text));
    if (x + wTrim > availW && line.chunks.some((c) => c.text.trim() !== '')) {
      push();
      w = segWidth(seg);
    }
    // A single piece wider than the column: hard-break it character by
    // character. A URL in a narrow cell has to go somewhere.
    if (w > availW && !seg.atomic) {
      let rest = seg.text, at = seg.src;
      while (rest.length) {
        let take = rest.length;
        while (take > 1 && x + segWidth(seg, rest.slice(0, take)) > availW) take--;
        const part = rest.slice(0, take);
        const pw = segWidth(seg, part);
        line.chunks.push({ ...seg, text: part, src: at, len: part.length, x, w: pw });
        x += pw;
        rest = rest.slice(take);
        at += take;
        if (rest.length) push();
      }
      continue;
    }
    line.chunks.push({ ...seg, x, w });
    x += w;
  }
  finishLine(line, props);
  lines.push(line);
  return lines;
}

function startLine(props, index, listMark) {
  return { chunks: [], height: 0, ascent: 0, index, listMark: index === 0 ? listMark : null };
}

function finishLine(line, props) {
  let asc = 0, desc = 0;
  for (const c of line.chunks) {
    const vm = VMETRICS[familyOf(faceOf(c.style.family, c.style.bold, c.style.italic))];
    const rise = c.style.sup ? c.style.baseSize * 0.33 : 0;
    const drop = c.style.sub ? c.style.baseSize * 0.16 : 0;
    asc = Math.max(asc, (vm.ascent / 1000) * c.style.size + rise);
    desc = Math.max(desc, (vm.descent / 1000) * c.style.size + drop);
  }
  if (!line.chunks.length) {
    const vm = VMETRICS[props.family] || VMETRICS.serif;
    asc = (vm.ascent / 1000) * props.size;
    desc = (vm.descent / 1000) * props.size;
  }
  line.ascent = asc;
  line.height = (asc + desc) * props.line;
  line.width = line.chunks.length
    ? line.chunks[line.chunks.length - 1].x + line.chunks[line.chunks.length - 1].w
    : 0;
}

function nextTab(x, props) {
  if (props.tabs && props.tabs.length) {
    for (const t of props.tabs) if (t.pos > x + 0.01) return t.pos;
  }
  return (Math.floor(x / DEFAULT_TAB) + 1) * DEFAULT_TAB;
}

/** Place one laid-out line onto the current page, applying alignment. */
function emitLine(ctx, block, props, line, li, total, indentL, availW) {
  const p = cur(ctx);
  const x0 = ctx.content.x + indentL;
  const y = p.y;
  const base = y + line.ascent;
  const items = [];

  // trailing whitespace is not part of the line for alignment purposes
  let used = 0;
  for (let i = line.chunks.length - 1; i >= 0; i--) {
    const c = line.chunks[i];
    if (c.text.trim() === '' && !c.tab) continue;
    used = c.x + segWidth(c, trimEnd(c.text));
    break;
  }
  const slack = Math.max(0, availW - used);
  let shift = 0;
  if (props.align === 'center') shift = slack / 2;
  else if (props.align === 'right') shift = slack;

  /* Justification stretches the SPACES, never the letters. Letter-spacing to
   * fill a line is what a layout engine does when it has given up; it is
   * legible at a glance and it is always wrong. The last line of a paragraph
   * is never justified, which is the rule every typesetter uses and every
   * naive implementation forgets. */
  let extraPerGap = 0, gaps = 0;
  if (props.align === 'justify' && li < total - 1 && slack > 0) {
    for (const c of line.chunks) {
      if (c.tab || c.atomic) continue;
      gaps += (c.text.match(/ /g) || []).length;
    }
    if (gaps > 0 && slack < availW * 0.35) extraPerGap = slack / gaps;
  }

  if (props.shade) {
    items.push({ t: 'rect', x: ctx.content.x + props.indentLeft - 4,
                 y: y - (li === 0 ? 3 : 0), w: availW + 8,
                 h: line.height + (li === 0 ? 3 : 0) + (li === total - 1 ? 3 : 0),
                 fill: props.shade });
  }

  if (line.listMark) {
    const st = { family: props.family, bold: props.bold, italic: false, size: props.size,
                 baseSize: props.size, color: props.color, under: false, strike: false };
    const mw = textWidth(faceOf(st.family, st.bold, false), line.listMark.text, st.size);
    items.push({ t: 'text', x: x0 - 12 - mw, y: base, s: line.listMark.text,
                 face: faceOf(st.family, st.bold, false), size: st.size, color: st.color,
                 marker: true });
  }

  let drift = 0;
  for (const c of line.chunks) {
    if (c.tab) continue;
    if (c.text === '') continue;
    const face = faceOf(c.style.family, c.style.bold, c.style.italic);
    const x = x0 + shift + c.x + drift;
    const dy = c.style.sup ? -c.style.baseSize * 0.33 : c.style.sub ? c.style.baseSize * 0.16 : 0;
    const shown = extraPerGap ? c.text : c.text;
    const w = extraPerGap
      ? segWidth(c, c.text) + (c.text.match(/ /g) || []).length * extraPerGap
      : c.w;

    if (c.style.hl) {
      items.push({ t: 'rect', x, y: y + line.height - line.ascent - c.style.size * 0.78,
                   w: segWidth(c, trimEnd(c.text)) + (extraPerGap ? w - c.w : 0),
                   h: c.style.size * 1.02, fill: c.style.hl });
    }
    if (c.field) {
      items.push({ t: 'field', x: x - 1, y: base - c.style.size * 0.82,
                   w: w + 2, h: c.style.size * 1.08, id: c.field });
    }
    items.push({
      t: 'text', x, y: base + dy, s: shown, face, size: c.style.size,
      color: c.style.color, spacing: extraPerGap || 0,
      link: c.style.link || null,
    });
    if (c.style.under) {
      items.push({ t: 'rule', x, y: base + c.style.size * 0.12,
                   w: segWidth(c, trimEnd(c.text)) + (extraPerGap ? w - c.w : 0),
                   h: Math.max(0.5, c.style.size / 16), color: c.style.color });
    }
    if (c.style.strike) {
      items.push({ t: 'rule', x, y: base - c.style.size * 0.27,
                   w: segWidth(c, trimEnd(c.text)) + (extraPerGap ? w - c.w : 0),
                   h: Math.max(0.5, c.style.size / 18), color: c.style.color });
    }
    c.px = x;
    c.pw = w;
    drift += extraPerGap ? w - c.w : 0;
  }
  // tabs after the loop so their advance is already in c.x
  for (const c of line.chunks) if (c.tab) { c.px = x0 + shift + c.x; c.pw = c.w; }

  line.x = x0 + shift;
  line.y = y;
  line.base = base;
  line.page = p.num;
  line.blockId = block.id;
  line.blockIndex = block._index;
  line.items = items;
  p.items.push(...items);
  p.lines.push(line);
  p.y = y + line.height;
}

/* ---- blocks that are not paragraphs -------------------------------------- */

function placeBox(ctx, block, bi) {
  const w = Math.min(block.w || ctx.content.w, ctx.content.w);
  const h = block.h || 200;
  if (h > roomLeft(ctx) && h <= ctx.content.h) forcePage(ctx);
  const p = cur(ctx);
  const align = block.align || 'center';
  const x = ctx.content.x + (align === 'center' ? (ctx.content.w - w) / 2
    : align === 'right' ? ctx.content.w - w : 0);
  const item = block.kind === 'image'
    ? { t: 'image', x, y: p.y, w, h, key: block.key, alt: block.alt || '' }
    : { t: 'chart', x, y: p.y, w, h, spec: block.spec, blockId: block.id };
  p.items.push(item);
  p.lines.push({ chunks: [], x, y: p.y, height: h, base: p.y + h, page: p.num,
                 blockId: block.id, blockIndex: block._index, items: [item], box: true });
  p.y += h + (block.after ?? 10);
}

/**
 * Tables.
 *
 * A cell is laid out by running the whole engine on its own blocks at the
 * cell's width - which is why layout() takes blocks and returns pages rather
 * than being a method on a document. A row's height is its tallest cell.
 *
 * A row that does not fit moves whole to the next page. Splitting a row
 * across pages is the correct behaviour for a long table and it is v2: done
 * badly it silently loses the bottom of a cell, and "silently loses" is the
 * one failure this project does not ship.
 */
function placeTable(ctx, table, bi) {
  const cols = table.cols && table.cols.length
    ? table.cols
    : new Array(Math.max(1, (table.rows[0] || []).length)).fill(
        ctx.content.w / Math.max(1, (table.rows[0] || []).length));
  const total = cols.reduce((a, b) => a + b, 0);
  const scale = total > ctx.content.w ? ctx.content.w / total : 1;
  const w = cols.map((c) => c * scale);
  const pad = table.pad ?? 4;
  const border = table.border ?? '#CFCAC1';

  for (let ri = 0; ri < table.rows.length; ri++) {
    const row = table.rows[ri];
    const cellLayouts = [];
    let rowH = table.rowHeight ?? 0;
    for (let ci = 0; ci < row.length; ci++) {
      const cell = row[ci] || { blocks: [] };
      const inner = w[ci] - pad * 2;
      // A cell is the whole engine run again at the cell's width. That is why
      // layout() takes blocks and a box rather than being a method on a
      // document: a table cell is a small page.
      const cl = layoutInBox(cell.blocks || [], inner, ctx.opts);
      cellLayouts.push(cl);
      rowH = Math.max(rowH, cl.height + pad * 2);
    }
    if (rowH > roomLeft(ctx) && rowH <= ctx.content.h) forcePage(ctx);
    const p = cur(ctx);
    const y0 = p.y;
    let x = ctx.content.x;
    for (let ci = 0; ci < row.length; ci++) {
      const cell = row[ci] || {};
      if (cell.fill) p.items.push({ t: 'rect', x, y: y0, w: w[ci], h: rowH, fill: cell.fill });
      const cl = cellLayouts[ci];
      const dy = cell.valign === 'middle' ? (rowH - pad * 2 - cl.height) / 2
        : cell.valign === 'bottom' ? rowH - pad * 2 - cl.height : 0;
      for (const it of cl.items) {
        const moved = { ...it, x: it.x + x + pad, y: it.y + y0 + pad + dy };
        p.items.push(moved);
      }
      for (const ln of cl.lines) {
        p.lines.push({ ...ln, x: ln.x + x + pad, y: ln.y + y0 + pad + dy,
                       base: ln.base + y0 + pad + dy, page: p.num,
                       chunks: ln.chunks.map((c) => ({ ...c, px: (c.px || 0) + x + pad })),
                       items: [] });
      }
      x += w[ci];
    }
    if (border) {
      let bx = ctx.content.x;
      p.items.push({ t: 'rule', x: bx, y: y0, w: x - ctx.content.x, h: 0.6, color: border });
      p.items.push({ t: 'rule', x: bx, y: y0 + rowH, w: x - ctx.content.x, h: 0.6, color: border });
      for (let ci = 0; ci <= row.length; ci++) {
        p.items.push({ t: 'rule', x: bx, y: y0, w: 0.6, h: rowH, color: border, vertical: true });
        bx += w[ci] || 0;
      }
    }
    p.y = y0 + rowH;
  }
  cur(ctx).y += table.after ?? 10;
}

/** Lay blocks out in a box of a given width, with no pagination. */
function layoutInBox(blocks, width, opts) {
  const fake = {
    size: 'letter', landscape: false,
    margin: { top: 0, left: 0, right: 0, bottom: 0 },
  };
  const box = { w: width, h: 1e6 };
  const content = { x: 0, y: 0, w: width, h: 1e6 };
  const ctx = { pg: fake, box, content, opts, pages: [], counters: [0, 0, 0, 0, 0], warnings: [] };
  newPage(ctx);
  blocks.forEach((b, i) => { b._index = b._index ?? i; });
  blocks.forEach((b, i) => {
    if (b.kind === 'table' || b.kind === 'pagebreak') return;   // no nested tables in v1
    if (b.kind === 'image' || b.kind === 'chart') placeBox(ctx, b, i);
    else placePara(ctx, b, i, blocks[i + 1]);
  });
  const p = ctx.pages[0];
  return { items: p.items, lines: p.lines, height: p.y };
}

/* ---- headers, footers, page numbers -------------------------------------- */

function decorate(ctx) {
  const { pg, box, content } = ctx;
  const n = ctx.pages.length;
  for (const p of ctx.pages) {
    const num = (pg.firstPageNumber ?? 1) + p.num - 1;
    if (pg.header) p.items.unshift(...band(pg.header, content, pg.margin.top / 2 + 4, num, n, box));
    if (pg.footer) {
      p.items.push(...band(pg.footer, content, box.h - pg.margin.bottom / 2, num, n, box));
    }
  }
}

function band(spec, content, y, num, total, box) {
  const text = String(spec.text || '')
    .replace(/\{PAGE\}/g, String(num))
    .replace(/\{PAGES\}/g, String(total));
  if (!text) return [];
  const size = spec.size || 9;
  const face = faceOf(spec.family || 'sans', false, false);
  const w = textWidth(face, text, size);
  const align = spec.align || 'center';
  const x = align === 'center' ? content.x + (content.w - w) / 2
    : align === 'right' ? content.x + content.w - w : content.x;
  return [{ t: 'text', x, y, s: text, face, size, color: spec.color || '#6C6356', chrome: true }];
}

/* ---- introspection used by the app --------------------------------------- */

/** Every character the fonts cannot print, across a document. */
export function unprintableIn(blocks) {
  const bad = new Set();
  const walk = (bs) => {
    for (const b of bs || []) {
      if (b.kind === 'table') { for (const r of b.rows || []) for (const c of r) walk(c.blocks); continue; }
      for (const ch of unprintable(b.text || '')) bad.add(ch);
    }
  };
  walk(blocks);
  return [...bad];
}

/** Words and characters, the way a word processor counts them. */
export function countWords(blocks) {
  let words = 0, chars = 0, paras = 0;
  const walk = (bs) => {
    for (const b of bs || []) {
      if (b.kind === 'table') { for (const r of b.rows || []) for (const c of r) walk(c.blocks); continue; }
      if (b.kind !== 'para' && b.kind !== undefined) continue;
      paras++;
      const t = (b.text || '').replace(/￼/g, ' ');
      chars += t.length;
      const m = t.match(/[^\s]+/g);
      words += m ? m.length : 0;
    }
  };
  walk(blocks);
  return { words, chars, paras };
}
