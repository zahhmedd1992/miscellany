/* Write a .docx back, changing as little as possible.
 *
 * The promise is the one Sheet makes for a workbook: open a document full of
 * things we cannot display — tracked changes, content controls, an embedded
 * spreadsheet, a chart, a hundred styles — edit one sentence, save, and every
 * part we did not touch comes back byte for byte.
 *
 * That is only achievable by SPLICING the original XML, never by
 * regenerating it. Regeneration loses attribute order, self-closing style,
 * whitespace, entity choice, rsid stamps and every element we do not model —
 * and it loses them silently, so the file still opens and the damage is only
 * visible to whoever had put the work in.
 *
 * So the unit of change is a RUN'S TEXT REGION — the span from a run's first
 * <w:t>/<w:tab>/<w:br> to its last:
 *
 *   untouched paragraph   -> not re-serialised at all
 *   text changed          -> that run's text region replaced; its <w:rPr>,
 *                            and anything else in the paragraph, untouched
 *   formatting changed    -> its <w:rPr> PATCHED: the elements we manage are
 *                            replaced in schema order, the rest kept in place
 *   properties changed    -> its <w:pPr> patched the same way
 *   paragraph inserted    -> generated, spliced in at a zero-length span
 *   paragraph deleted     -> its span omitted
 *
 * The first version of this rebuilt the whole <w:p> from our model, and
 * deleted an anchored full-page background image from a corpus document —
 * while every gate stayed green, because exactly one part had changed and the
 * edit really was in it. A paragraph contains more than its text: a drawing,
 * a bookmark, a comment anchor, a hyperlink, a content control, a maths
 * block. Rewriting at the run level means we never have to enumerate them.
 */

import { writeZip } from './zipwrite.js';
import { encode, encodeAttr, firstElement, elements } from './xml.js';
import { wscan } from './docx.js';

/* ECMA-376 fixes the ORDER of a <w:pPr>'s children, and Word rejects a
 * document that gets it wrong. Only the elements we manage are listed by
 * name; anything else keeps its position relative to its neighbours. */
const PPR_ORDER = [
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl',
  'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens',
  'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE',
  'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind',
  'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection',
  'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr',
  'sectPr', 'pPrChange',
];

const RPR_ORDER = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike',
  'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid',
  'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz',
  'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign',
  'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath',
];

const TWIP = 20;

/** The prefix the document actually uses for WordprocessingML, e.g. 'w:'. */
export function wordPrefix(xml) {
  for (const ev of wscan(xml)) {
    if (ev.type !== 'open' || !ev.w) continue;
    const i = ev.qname.indexOf(':');
    return i < 0 ? '' : ev.qname.slice(0, i + 1);
  }
  return 'w:';
}

/* ---- splitting an element's children into (name, source) pairs ----------- */

function childSpans(inner) {
  const out = [];
  let depth = 0, start = 0, name = null;
  for (const ev of wscan(inner)) {
    if (ev.type === 'open') {
      if (depth === 0) { name = ev.name; start = ev.start; }
      if (!ev.selfClosing) depth++;
      else if (depth === 0) { out.push({ name, xml: inner.slice(start, ev.end) }); name = null; }
      continue;
    }
    if (ev.type !== 'close') continue;
    depth--;
    if (depth === 0 && name !== null) {
      out.push({ name, xml: inner.slice(start, ev.end) });
      name = null;
    }
  }
  return out;
}

/**
 * Replace the elements we manage inside a property element, keeping every
 * other child exactly as it was and putting ours back in schema order.
 *
 * @param inner    the original inner XML
 * @param order    PPR_ORDER or RPR_ORDER
 * @param replace  Map<localName, xml|null>   null removes it
 */
export function patchProps(inner, order, replace) {
  const kept = childSpans(inner).filter((c) => !replace.has(c.name));
  const out = [];
  for (const [n, xml] of replace) if (xml) out.push({ name: n, xml });
  const all = [...kept, ...out];
  const rank = (n) => {
    const i = order.indexOf(n);
    return i < 0 ? order.length + 1 : i;
  };
  // A stable sort keeps unmanaged siblings in their original relative order,
  // which matters because we do not know what they are.
  return all
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i)
    .map((c) => c.xml)
    .join('');
}

/* ---- generating the bits we do manage ------------------------------------ */

const STYLE_ID = {
  title: 'Title', h1: 'Heading1', h2: 'Heading2', h3: 'Heading3',
  quote: 'Quote', caption: 'Caption', code: 'HTMLPreformatted', body: null,
};

const ALIGN = { left: 'left', center: 'center', right: 'right', justify: 'both' };

/** The <w:pPr> children our model owns, as XML. */
export function pPrParts(p, P, numId) {
  const m = new Map();
  const styleId = STYLE_ID[p.style || 'body'];
  m.set('pStyle', styleId ? `<${P}pStyle ${P}val="${encodeAttr(styleId)}"/>` : null);
  m.set('jc', p.align && p.align !== 'left'
    ? `<${P}jc ${P}val="${ALIGN[p.align] || 'left'}"/>` : null);

  const l = Math.round((p.indentLeft || 0) * TWIP);
  const r = Math.round((p.indentRight || 0) * TWIP);
  const f = Math.round((p.indentFirst || 0) * TWIP);
  m.set('ind', (l || r || f)
    ? `<${P}ind${l ? ` ${P}left="${l}"` : ''}${r ? ` ${P}right="${r}"` : ''}` +
      `${f > 0 ? ` ${P}firstLine="${f}"` : f < 0 ? ` ${P}hanging="${-f}"` : ''}/>`
    : null);

  const before = Math.round((p.before ?? 0) * TWIP);
  const after = Math.round((p.after ?? 0) * TWIP);
  const line = p.line ? Math.round(p.line * 240) : 0;
  m.set('spacing', (before || after || line)
    ? `<${P}spacing${before ? ` ${P}before="${before}"` : ''}` +
      `${after ? ` ${P}after="${after}"` : ''}` +
      `${line ? ` ${P}line="${line}" ${P}lineRule="auto"` : ''}/>`
    : null);

  m.set('numPr', p.list && numId
    ? `<${P}numPr><${P}ilvl ${P}val="${p.level || 0}"/>` +
      `<${P}numId ${P}val="${numId}"/></${P}numPr>`
    : null);

  m.set('pageBreakBefore', p.breakBefore ? `<${P}pageBreakBefore/>` : null);
  m.set('keepNext', p.keepNext ? `<${P}keepNext/>` : null);
  return m;
}

/** The <w:rPr> children our model owns, as XML. */
export function rPrParts(r, P) {
  const m = new Map();
  m.set('b', r.b ? `<${P}b/>` : null);
  m.set('i', r.i ? `<${P}i/>` : null);
  m.set('u', r.u ? `<${P}u ${P}val="single"/>` : null);
  m.set('strike', r.s ? `<${P}strike/>` : null);
  m.set('sz', r.sz ? `<${P}sz ${P}val="${Math.round(r.sz * 2)}"/>` : null);
  m.set('color', r.c ? `<${P}color ${P}val="${String(r.c).replace('#', '').toUpperCase()}"/>` : null);
  m.set('highlight', null);
  m.set('shd', r.hl
    ? `<${P}shd ${P}val="clear" ${P}color="auto" ${P}fill="${String(r.hl).replace('#', '').toUpperCase()}"/>`
    : null);
  m.set('vertAlign', r.sup ? `<${P}vertAlign ${P}val="superscript"/>`
    : r.sub ? `<${P}vertAlign ${P}val="subscript"/>` : null);
  const fam = { serif: 'Times New Roman', sans: 'Arial', mono: 'Courier New' }[r.f];
  m.set('rFonts', fam
    ? `<${P}rFonts ${P}ascii="${fam}" ${P}hAnsi="${fam}" ${P}cs="${fam}"/>` : null);
  return m;
}

/** One <w:r> for a run of our model. */
function runXml(run, text, P, originalRPr) {
  const parts = rPrParts(run, P);
  const inner = originalRPr !== null && originalRPr !== undefined
    ? patchProps(originalRPr, RPR_ORDER, parts)
    : [...parts.values()].filter(Boolean).join('');
  const rpr = inner ? `<${P}rPr>${inner}</${P}rPr>` : '';
  return `<${P}r>${rpr}${textXml(text, P)}</${P}r>`;
}

/**
 * One <w:p>.
 *
 * THE RULE THAT MAKES THIS SAFE: a paragraph is rewritten CHILD BY CHILD, not
 * regenerated. Every direct child of the original <w:p> that is not a
 * text-bearing run is copied back byte for byte, in its original position —
 * a drawing, a bookmarkStart, a comment range, a content control, a
 * hyperlink, a maths block. Only the runs that carry text are replaced, all
 * together, at the position of the first of them.
 *
 * Without this, editing one word in a document whose title paragraph anchors
 * a full-page background image deletes the image. That is a real paragraph in
 * this project's corpus (`in-dhs-minutes`), and the first version of this
 * function did exactly that while every gate stayed green: only one part had
 * changed, and the edit really was in it.
 *
 * @param block   { text, runs, p, openTag?, children?, source? }
 * @param origin  { pprInner, propsChanged, rprOf(run, i), xml } or null
 */
export function paragraphXml(block, P, origin, numId) {
  const parts = pPrParts(block.p || {}, P, numId);
  let pprInner;
  if (origin && origin.pprInner !== null && origin.pprInner !== undefined) {
    pprInner = origin.propsChanged
      ? patchProps(origin.pprInner, PPR_ORDER, parts)
      : origin.pprInner;
  } else {
    pprInner = [...parts.values()].filter(Boolean).join('');
  }
  const ppr = pprInner ? `<${P}pPr>${pprInner}</${P}pPr>` : '';

  let at = 0;
  let runs = '';
  (block.runs || [{ n: (block.text || '').length }]).forEach((r, i) => {
    const text = (block.text || '').slice(at, at + r.n);
    at += r.n;
    if (!text && (block.runs || []).length > 1) return;
    runs += runXml(r, text, P, origin ? origin.rprOf(r, i) : null);
  });

  const open = block.openTag || `<${P}p>`;
  return `${open}${ppr}${runs}</${P}p>`;
}

/**
 * Edits for ONE paragraph that came out of a file, expressed as splices
 * inside the original XML.
 *
 * THIS is how an edited document keeps everything it contains. The unit of
 * change is a RUN'S TEXT REGION — the span from its first <w:t>/<w:tab>/<w:br>
 * to its last — not the paragraph. A <w:drawing>, a bookmark, a comment
 * anchor, a hyperlink, a content control, a maths block and the run's own
 * <w:rPr> are all outside that span, so they are never rewritten and never
 * examined. The first version of this rewrote the whole <w:p> from our model
 * and deleted an anchored full-page background image, while the gate stayed
 * green: exactly one part had changed, and the edit really was in it.
 *
 * @param before  the block as it was read (runs carry `_src`)
 * @param after   the block as it is now  ({ text, runs, p })
 * @returns [{ span, kind, xml }] for spliceDocument
 */
export function paragraphEdits(before, after, P, opts = {}) {
  const edits = [];
  const seen = new Set();
  let at = 0;
  let lastSrcEnd = before.insertAt >= 0 ? before.insertAt : null;
  let appended = '';

  for (const r of after.runs || []) {
    const text = (after.text || '').slice(at, at + r.n);
    at += r.n;
    const src = r._src;
    if (src && !seen.has(src.from)) {
      seen.add(src.from);
      // replace only the run's text region; its properties stay put unless
      // the character formatting actually changed
      edits.push({ span: { start: src.from, end: src.to }, kind: 'replace',
                   xml: textXml(text, P) });
      if (src.rprSpan && r._rprChanged) {
        const whole = opts.xml.slice(src.rprSpan.start, src.rprSpan.end);
        const o = whole.indexOf('>') + 1, c = whole.lastIndexOf('</');
        const inner = c > o ? whole.slice(o, c) : '';
        edits.push({ span: src.rprSpan, kind: 'replace',
                     xml: `<${P}rPr>${patchProps(inner, RPR_ORDER, rPrParts(r, P))}</${P}rPr>` });
      }
      lastSrcEnd = src.end;
      continue;
    }
    // a run with no source, or a second model run sharing one source run:
    // a brand-new <w:r>, emitted right after the run it follows
    const xml = runXml(r, text, P, src ? opts.xml.slice(0, 0) : null);
    if (lastSrcEnd !== null) {
      edits.push({ span: { start: lastSrcEnd, end: lastSrcEnd }, kind: 'replace', xml });
    } else {
      appended += xml;
    }
  }

  // runs that were deleted outright
  for (const r of before.runs || []) {
    if (!r._src || seen.has(r._src.from)) continue;
    edits.push({ span: { start: r._src.start, end: r._src.end }, kind: 'delete' });
  }

  if (appended && before.insertAt >= 0) {
    edits.push({ span: { start: before.insertAt, end: before.insertAt },
                 kind: 'replace', xml: appended });
  }

  /* Paragraph properties, patched in place so the elements we do not manage
   * keep their positions. */
  if (opts.propsChanged && before.pprSpan) {
    const whole = opts.xml.slice(before.pprSpan.start, before.pprSpan.end);
    const o = whole.indexOf('>') + 1, c = whole.lastIndexOf('</');
    const inner = c > o ? whole.slice(o, c) : '';
    edits.push({ span: before.pprSpan, kind: 'replace',
                 xml: `<${P}pPr>${patchProps(inner, PPR_ORDER, pPrParts(after.p || {}, P, opts.numId))}</${P}pPr>` });
  }

  return edits.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
}

/** The text-bearing children of a run, for a given string. */
export function textXml(text, P) {
  let body = '';
  let buf = '';
  const flush = () => {
    if (buf) { body += `<${P}t xml:space="preserve">${encode(buf)}</${P}t>`; buf = ''; }
  };
  for (const ch of text) {
    if (ch === '\t') { flush(); body += `<${P}tab/>`; }
    else if (ch === '\u2028') { flush(); body += `<${P}br/>`; }
    else buf += ch;
  }
  flush();
  return body || `<${P}t xml:space="preserve"></${P}t>`;
}

/* ---- the splice ---------------------------------------------------------- */

/**
 * Rebuild word/document.xml from the original plus a list of edits.
 *
 * @param xml    the original main part
 * @param edits  [{ span:{start,end}, kind:'keep'|'replace'|'delete',
 *                  xml?:string }] — spans must not overlap
 */
export function spliceDocument(xml, edits) {
  const ordered = [...edits].sort((a, b) => a.span.start - b.span.start);
  let out = '';
  let at = 0;
  for (const e of ordered) {
    if (e.span.start < at) {
      throw new Error(`overlapping edit at ${e.span.start} (already emitted to ${at})`);
    }
    out += xml.slice(at, e.span.start);
    if (e.kind === 'replace') out += e.xml;
    else if (e.kind === 'insertBefore') { out += e.xml; out += xml.slice(e.span.start, e.span.end); }
    else if (e.kind === 'insertAfter') { out += xml.slice(e.span.start, e.span.end); out += e.xml; }
    else if (e.kind === 'keep') out += xml.slice(e.span.start, e.span.end);
    // 'delete' emits nothing
    at = e.span.end;
  }
  out += xml.slice(at);
  return out;
}

/**
 * Save.
 *
 * @param wd      the WordDoc from openDocx
 * @param edits   as spliceDocument
 * @param extra   Map<partName, string|Uint8Array> for parts we regenerate
 */
export async function saveDocx(wd, edits, extra = new Map()) {
  const changes = new Map(extra);
  if (edits && edits.length) {
    changes.set(wd.mainPath, spliceDocument(wd.xml, edits));
  }
  return writeZip(wd.zip, changes);
}

/* ---- numbering: a list we created needs a definition ---------------------- */

/**
 * Ensure word/numbering.xml defines a bullet list and a decimal list, and
 * return their numIds.
 *
 * A paragraph carrying <w:numPr> whose numId names nothing renders as an
 * ordinary paragraph in Word — the bullets simply vanish, with no error. So
 * the definition is written before it is referenced, never after.
 */
export function ensureNumbering(numberingXml, P) {
  const existing = numberingXml || '';
  const ids = [];
  for (const n of elements(existing, 'num')) {
    const v = n.attr('numId');
    if (v) ids.push(parseInt(v, 10));
  }
  const absIds = [];
  for (const a of elements(existing, 'abstractNum')) {
    const v = a.attr('abstractNumId');
    if (v) absIds.push(parseInt(v, 10));
  }
  const nextNum = (ids.length ? Math.max(...ids) : 0) + 1;
  const nextAbs = (absIds.length ? Math.max(...absIds) : 0) + 1;

  const lvl = (i, fmt, text) =>
    `<${P}lvl ${P}ilvl="${i}"><${P}start ${P}val="1"/>` +
    `<${P}numFmt ${P}val="${fmt}"/><${P}lvlText ${P}val="${encodeAttr(text)}"/>` +
    `<${P}lvlJc ${P}val="left"/><${P}pPr><${P}ind ${P}left="${720 * (i + 1)}" ` +
    `${P}hanging="360"/></${P}pPr></${P}lvl>`;

  const bulletChars = ['•', 'o', '▪', '–', '·'];
  const bullet = `<${P}abstractNum ${P}abstractNumId="${nextAbs}">` +
    bulletChars.map((ch, i) => lvl(i, 'bullet', ch)).join('') + `</${P}abstractNum>`;
  const decimal = `<${P}abstractNum ${P}abstractNumId="${nextAbs + 1}">` +
    ['decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter']
      .map((f, i) => lvl(i, f, `%${i + 1}.`)).join('') + `</${P}abstractNum>`;
  const nums =
    `<${P}num ${P}numId="${nextNum}"><${P}abstractNumId ${P}val="${nextAbs}"/></${P}num>` +
    `<${P}num ${P}numId="${nextNum + 1}"><${P}abstractNumId ${P}val="${nextAbs + 1}"/></${P}num>`;

  let xml;
  if (existing) {
    // abstractNum elements must all precede num elements.
    const firstNum = existing.search(new RegExp(`<${P.replace(':', '\\:')}?num\\b`));
    const insertAt = firstNum > 0 ? firstNum : existing.lastIndexOf('</');
    xml = existing.slice(0, insertAt) + bullet + decimal + nums + existing.slice(insertAt);
  } else {
    xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      bullet + decimal + nums + `</w:numbering>`;
  }
  return { xml, bullet: nextNum, number: nextNum + 1 };
}
