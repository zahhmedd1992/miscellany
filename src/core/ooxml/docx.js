/* Read a .docx.
 *
 * Same doctrine as the .xlsx reader: parse what we model, keep everything
 * else as bytes, hand it back untouched on save. What is different is that
 * WordprocessingML sets a different set of traps, and every one of the rules
 * below is a MEASURED fact about the 40-file corpus in corpus/docx.json
 * rather than a reading of the spec.
 *
 *  1. THE PREFIX TRAP IS INVERTED FROM THE SPREADSHEET SIDE. In xlsx the
 *     default namespace is normal and `x:` is the surprise. In Word 37 of 40
 *     files use `w:` — AND ALL TWENTY REAL-WORLD ONES DO. So a reader that
 *     hardcodes "w:" passes a corpus of genuine documents and is silently
 *     broken on the ones that do not. Nothing in ordinary use would catch it.
 *
 *  2. THERE ARE TWO OOXML NAMESPACES. Transitional (schemas.openxmlformats.org)
 *     and Strict (purl.oclc.org). Word writes Strict when asked to. Hardcode
 *     the transitional URI and a Strict document opens with zero paragraphs
 *     and no error.
 *
 *  3. MATCH ON LOCAL NAME **AND** NAMESPACE, NEVER EITHER ALONE. <m:r> is a
 *     maths run and <w:r> is a text run. On one corpus file a local-name-only
 *     scan over-counts runs by 0.9% — small enough to look like rounding.
 *
 *  4. word/document.xml IS A CONVENTION. One corpus file keeps its body at
 *     word/document2.xml. The package relationships are authoritative.
 *
 *  5. NO RECURSION. One file nests tables 4,999 deep — element depth 15,004,
 *     and it is a VALID document. Every walk here uses an explicit stack.
 *
 *  6. <w:t> IS NOT "THE TEXT". Headers, footers, footnotes and comments are
 *     separate parts; <w:delText> is deleted text; <w:instrText> is a field
 *     instruction that looks like text and is not.
 *
 *  7. mc:AlternateContent DESCRIBES THE SAME CONTENT TWICE — once modern,
 *     once legacy. Read the Choice, skip the Fallback, or every shape's
 *     caption appears twice.
 *
 *  8. xml:space="preserve" IS NOT DECORATION. 13,261 <w:t> elements in the
 *     corpus carry it. Trimming destroys real content and the damage is
 *     invisible, because the sentence still reads correctly.
 *
 *  9. AN ENCRYPTED .docx IS NOT A ZIP. It is an OLE compound file, magic
 *     D0 CF 11 E0, and unzipping it fails in a way that reads exactly like a
 *     corrupt download.
 */

import { readZip } from './zip.js';
import { scan, local, decode, parseAttrs, elements, firstElement } from './xml.js';

/* Both spellings of every namespace we care about. */
const W = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const REL_NS = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);

const TWIP = 20;                 // twentieths of a point
/** A soft line break inside a paragraph: <w:br/>, Shift+Enter. */
export const SOFT_BREAK = '\u2028';
const HALFPT = 2;                // w:sz is in half-points

/** Is this a compound file (an encrypted or otherwise OLE-wrapped package)? */
export function isEncryptedPackage(bytes) {
  return bytes.length > 8 && bytes[0] === 0xD0 && bytes[1] === 0xCF &&
         bytes[2] === 0x11 && bytes[3] === 0xE0;
}

/* ---- namespace-aware scanning -------------------------------------------
 * xml.js is prefix-agnostic, which solves half the problem: it will find
 * <w:p> and <p> alike. The other half is telling <w:r> from <m:r>, and that
 * needs the prefix RESOLVED against the declarations in scope. A stack, not
 * recursion, because of trap 5.
 */

function nsTracker() {
  const stack = [new Map()];
  return {
    push(attrsFn) {
      const top = stack[stack.length - 1];
      let map = top;
      const raw = attrsFn ? attrsFn._raw : null;
      if (raw) {
        let copied = false;
        for (const [k, v] of raw) {
          if (k !== 'xmlns' && !k.startsWith('xmlns:')) continue;
          if (!copied) { map = new Map(top); copied = true; }
          map.set(k === 'xmlns' ? '' : k.slice(6), v);
        }
      }
      stack.push(map);
    },
    pop() { if (stack.length > 1) stack.pop(); },
    uri(qname) {
      const i = qname.indexOf(':');
      const prefix = i < 0 ? '' : qname.slice(0, i);
      return stack[stack.length - 1].get(prefix) || '';
    },
  };
}

/** Raw attribute pairs of a start tag, prefixes intact. */
function rawAttrs(src, from, to) {
  const out = [];
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(src)) && m.index < to) {
    out.push([m[1], decode(m[3] !== undefined ? m[3] : m[4])]);
  }
  return out;
}

/**
 * Walk XML yielding events that know their namespace.
 *
 * Each event is the xml.js event plus `ns` (the resolved URI) and `w` (is it
 * WordprocessingML?). Attribute lookup is by local name, which is safe once
 * the ELEMENT's namespace has been checked.
 */
export function* wscan(src) {
  const ns = nsTracker();
  for (const ev of scan(src)) {
    if (ev.type === 'open') {
      const raw = rawAttrs(src, ev.start, ev.end);
      const fn = () => Object.fromEntries(raw.map(([k, v]) => [local(k), v]));
      fn._raw = raw;
      ns.push(fn);
      const uri = ns.uri(ev.qname);
      const out = {
        ...ev, ns: uri, w: W.has(uri),
        at: (n) => { for (const [k, v] of raw) if (local(k) === n) return v; return null; },
        raw,
      };
      if (ev.selfClosing) ns.pop();
      yield out;
    } else if (ev.type === 'close') {
      yield { ...ev, ns: ns.uri(ev.qname), w: W.has(ns.uri(ev.qname)) };
      ns.pop();
    } else {
      yield ev;
    }
  }
}

/* ---- the package --------------------------------------------------------- */

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

function resolveTarget(base, target) {
  if (!target) return '';
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dirOf(base) + target).split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

async function relsFor(zip, partPath) {
  const relPath = dirOf(partPath) + '_rels/' + partPath.slice(dirOf(partPath).length) + '.rels';
  const xml = await zip.text(relPath);
  const map = new Map();
  if (!xml) return map;
  for (const r of elements(xml, 'Relationship')) {
    map.set(r.attr('Id'), { type: r.attr('Type') || '', target: r.attr('Target') || '',
                            mode: r.attr('TargetMode') || '' });
  }
  return map;
}

export class WordDoc {
  constructor(zip) {
    this.zip = zip;
    this.warnings = [];
  }
  part(name) { return this.zip.text(name); }
}

/**
 * Open a .docx.
 * @returns {Promise<WordDoc>} with mainPath, xml, styles, numbering, section
 */
export async function openDocx(bytes) {
  if (isEncryptedPackage(bytes)) {
    // Reads as "corrupt download" otherwise, and sends someone hunting a bug
    // that does not exist.
    throw new Error('This document is password-protected. Miscellany cannot open encrypted files.');
  }
  const zip = await readZip(bytes);
  const wd = new WordDoc(zip);

  // trap 4: the relationships are authoritative, not the conventional path
  let mainPath = 'word/document.xml';
  const rootRels = await zip.text('_rels/.rels');
  if (rootRels) {
    for (const r of elements(rootRels, 'Relationship')) {
      const t = r.attr('Type') || '';
      if (t.endsWith('/officeDocument')) mainPath = resolveTarget('', r.attr('Target'));
    }
  }
  wd.mainPath = mainPath;
  wd.xml = await zip.text(mainPath);
  if (!wd.xml) throw new Error('this file has no document part; it may not be a Word document');

  wd.rels = await relsFor(zip, mainPath);
  wd.styles = await readStyles(zip, wd);
  wd.numbering = await readNumbering(zip, wd);
  return wd;
}

/* ---- styles -------------------------------------------------------------- */

const STYLE_BY_NAME = [
  [/^title$/i, 'title'],
  [/^subtitle$/i, 'caption'],
  [/^heading ?1$/i, 'h1'],
  [/^heading ?2$/i, 'h2'],
  [/^heading ?[3-9]$/i, 'h3'],
  [/^(intense )?quote$/i, 'quote'],
  [/^(block ?text|block ?quotation)$/i, 'quote'],
  [/^caption$/i, 'caption'],
  [/^(html |plain )?(pre|code|source ?code)$/i, 'code'],
  [/^(normal|body ?text|default)/i, 'body'],
];

async function readStyles(zip, wd) {
  const rel = [...wd.rels.values()].find((r) => r.type.endsWith('/styles'));
  const path = rel ? resolveTarget(wd.mainPath, rel.target) : 'word/styles.xml';
  const xml = await zip.text(path);
  const out = { byId: new Map(), defaults: {}, path, present: !!xml };
  if (!xml) return out;

  // docDefaults gives the size and face everything inherits
  const dd = firstElement(xml, 'docDefaults');
  if (dd) {
    const rpr = firstElement(dd.inner(), 'rPr');
    if (rpr) Object.assign(out.defaults, runProps(rpr.inner()));
    const ppr = firstElement(dd.inner(), 'pPr');
    if (ppr) Object.assign(out.defaults, paraPropsOf(ppr.inner(), out, null));
  }

  for (const st of elements(xml, 'style')) {
    const id = st.attr('styleId');
    if (!id) continue;
    const inner = st.inner();
    const nameEl = firstElement(inner, 'name');
    const name = nameEl ? nameEl.attr('val') || '' : '';
    let kind = null;
    for (const [re, k] of STYLE_BY_NAME) if (re.test(name) || re.test(id)) { kind = k; break; }
    const rpr = firstElement(inner, 'rPr');
    const ppr = firstElement(inner, 'pPr');
    out.byId.set(id, {
      id, name, kind,
      type: st.attr('type') || 'paragraph',
      basedOn: (firstElement(inner, 'basedOn') || { attr: () => null }).attr('val'),
      run: rpr ? runProps(rpr.inner()) : {},
      para: ppr ? paraPropsOf(ppr.inner(), out, null) : {},
    });
  }
  return out;
}

/** Resolve a style id through basedOn, nearest wins. Iterative (trap 5). */
function styleChain(styles, id) {
  const chain = [];
  let cur = id, guard = 0;
  while (cur && guard++ < 32) {
    const s = styles.byId.get(cur);
    if (!s) break;
    chain.push(s);
    cur = s.basedOn;
  }
  return chain;
}

/* ---- numbering ----------------------------------------------------------- */

async function readNumbering(zip, wd) {
  const rel = [...wd.rels.values()].find((r) => r.type.endsWith('/numbering'));
  const path = rel ? resolveTarget(wd.mainPath, rel.target) : 'word/numbering.xml';
  const xml = await zip.text(path);
  const out = { numIdToAbstract: new Map(), abstract: new Map(), path, present: !!xml };
  if (!xml) return out;
  for (const n of elements(xml, 'num')) {
    const id = n.attr('numId');
    const a = firstElement(n.inner(), 'abstractNumId');
    if (id && a) out.numIdToAbstract.set(id, a.attr('val'));
  }
  for (const a of elements(xml, 'abstractNum')) {
    const id = a.attr('abstractNumId');
    if (!id) continue;
    const levels = new Map();
    for (const lv of elements(a.inner(), 'lvl')) {
      const ilvl = lv.attr('ilvl');
      const f = firstElement(lv.inner(), 'numFmt');
      levels.set(ilvl, (f && f.attr('val')) || 'decimal');
    }
    out.abstract.set(id, levels);
  }
  return out;
}

function listKindOf(numbering, numId, ilvl) {
  const abs = numbering.numIdToAbstract.get(String(numId));
  const levels = abs !== undefined ? numbering.abstract.get(abs) : null;
  const fmt = levels ? levels.get(String(ilvl || '0')) : null;
  if (fmt === 'none') return null;
  return fmt === 'bullet' ? 'bullet' : 'number';
}

/* ---- properties ---------------------------------------------------------- */

const FONT_FAMILY = (name) => {
  const n = String(name || '').toLowerCase();
  if (/courier|consolas|mono|menlo|lucida console/.test(n)) return 'mono';
  if (/times|cambria|georgia|garamond|book|minion|palatino|serif/.test(n)) return 'serif';
  if (/arial|helvetica|calibri|aptos|segoe|verdana|tahoma|open sans|roboto|sans/.test(n)) return 'sans';
  return null;
};

const HIGHLIGHT = {
  yellow: '#FFF3A3', green: '#B7E4B0', cyan: '#AEE7EA', magenta: '#F2B8D8',
  blue: '#B8CDF2', red: '#F5B5B5', darkYellow: '#E0CE7A', darkGreen: '#8FBF88',
  darkCyan: '#8FC4C7', darkMagenta: '#D194B8', darkBlue: '#94A9CE', darkRed: '#D19494',
  lightGray: '#E3E0DA', darkGray: '#C4C0B8', black: '#211C16', white: '#FFFFFF',
};

/** The value of a boolean toggle element: present means on unless val says no. */
function toggle(el) {
  if (!el) return undefined;
  const v = el.attr('val');
  if (v === null || v === undefined) return 1;
  return (v === '0' || v === 'false' || v === 'off') ? undefined : 1;
}

/** Character formatting from the inner XML of a <w:rPr>. */
export function runProps(inner) {
  const out = {};
  const b = toggle(firstElement(inner, 'b'));
  if (b) out.b = 1;
  const i = toggle(firstElement(inner, 'i'));
  if (i) out.i = 1;
  const st = toggle(firstElement(inner, 'strike'));
  if (st) out.s = 1;
  const u = firstElement(inner, 'u');
  if (u && (u.attr('val') || 'single') !== 'none') out.u = 1;
  const sz = firstElement(inner, 'sz');
  if (sz && sz.attr('val')) {
    const n = parseFloat(sz.attr('val')) / HALFPT;
    if (Number.isFinite(n) && n > 0) out.sz = n;
  }
  const c = firstElement(inner, 'color');
  const cv = c ? c.attr('val') : null;
  if (cv && /^[0-9A-Fa-f]{6}$/.test(cv)) out.c = '#' + cv.toUpperCase();
  const hl = firstElement(inner, 'highlight');
  if (hl && hl.attr('val') && hl.attr('val') !== 'none') {
    out.hl = HIGHLIGHT[hl.attr('val')] || '#FFF3A3';
  }
  const shd = firstElement(inner, 'shd');
  if (!out.hl && shd) {
    const fill = shd.attr('fill');
    if (fill && /^[0-9A-Fa-f]{6}$/.test(fill) && fill.toUpperCase() !== 'FFFFFF') {
      out.hl = '#' + fill.toUpperCase();
    }
  }
  const rf = firstElement(inner, 'rFonts');
  if (rf) {
    const fam = FONT_FAMILY(rf.attr('ascii') || rf.attr('hAnsi') || rf.attr('cs'));
    if (fam) out.f = fam;
  }
  const va = firstElement(inner, 'vertAlign');
  if (va) {
    if (va.attr('val') === 'superscript') out.sup = 1;
    if (va.attr('val') === 'subscript') out.sub = 1;
  }
  return out;
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/** Paragraph formatting from the inner XML of a <w:pPr>. */
export function paraPropsOf(inner, styles, numbering) {
  const out = {};
  const ps = firstElement(inner, 'pStyle');
  if (ps) out._styleId = ps.attr('val');

  const jc = firstElement(inner, 'jc');
  if (jc) {
    const v = jc.attr('val');
    out.align = v === 'both' || v === 'distribute' ? 'justify'
      : v === 'center' ? 'center' : v === 'right' || v === 'end' ? 'right' : 'left';
  }

  const ind = firstElement(inner, 'ind');
  if (ind) {
    const l = num(ind.attr('left') ?? ind.attr('start'));
    const r = num(ind.attr('right') ?? ind.attr('end'));
    const fl = num(ind.attr('firstLine'));
    const hg = num(ind.attr('hanging'));
    if (l !== null) out.indentLeft = l / TWIP;
    if (r !== null) out.indentRight = r / TWIP;
    if (fl !== null) out.indentFirst = fl / TWIP;
    if (hg !== null) out.indentFirst = -hg / TWIP;
  }

  const sp = firstElement(inner, 'spacing');
  if (sp) {
    const before = num(sp.attr('before'));
    const after = num(sp.attr('after'));
    if (before !== null) out.before = before / TWIP;
    if (after !== null) out.after = after / TWIP;
    const line = num(sp.attr('line'));
    const rule = sp.attr('lineRule') || 'auto';
    if (line !== null) {
      // "auto" is 240ths of a line; "exact"/"atLeast" are twips
      out.line = rule === 'auto' ? line / 240 : Math.max(0.8, (line / TWIP) / 12);
    }
  }

  const numPr = firstElement(inner, 'numPr');
  if (numPr) {
    const ilvl = firstElement(numPr.inner(), 'ilvl');
    const numId = firstElement(numPr.inner(), 'numId');
    out._numId = numId ? numId.attr('val') : null;
    out.level = ilvl ? Math.max(0, Math.min(4, parseInt(ilvl.attr('val') || '0', 10))) : 0;
    if (numbering && out._numId) out.list = listKindOf(numbering, out._numId, out.level);
    else if (out._numId && out._numId !== '0') out.list = 'number';
  }

  if (firstElement(inner, 'pageBreakBefore')) out.breakBefore = true;
  if (firstElement(inner, 'keepNext')) out.keepNext = true;

  const shd = firstElement(inner, 'shd');
  if (shd) {
    const fill = shd.attr('fill');
    if (fill && /^[0-9A-Fa-f]{6}$/.test(fill) && fill.toUpperCase() !== 'FFFFFF') {
      out.shade = '#' + fill.toUpperCase();
    }
  }

  const tabs = firstElement(inner, 'tabs');
  if (tabs) {
    const list = [];
    for (const tb of elements(tabs.inner(), 'tab')) {
      const pos = num(tb.attr('pos'));
      if (pos !== null) list.push({ pos: pos / TWIP, align: tb.attr('val') || 'left' });
    }
    if (list.length) out.tabs = list.sort((a, b) => a.pos - b.pos);
  }
  return out;
}

/** Page setup from a <w:sectPr>. */
export function sectionOf(inner) {
  const out = {};
  const sz = firstElement(inner, 'pgSz');
  if (sz) {
    const w = num(sz.attr('w')), h = num(sz.attr('h'));
    if (w && h) {
      out._w = w / TWIP;
      out._h = h / TWIP;
      out.landscape = (sz.attr('orient') || '') === 'landscape' || w > h;
      out.size = nearestSize(Math.min(w, h) / TWIP, Math.max(w, h) / TWIP);
    }
  }
  const mar = firstElement(inner, 'pgMar');
  if (mar) {
    const m = {};
    for (const [k, a] of [['top', 'top'], ['right', 'right'], ['bottom', 'bottom'], ['left', 'left']]) {
      const v = num(mar.attr(a));
      if (v !== null) m[k] = Math.max(0, v / TWIP);
    }
    if (Object.keys(m).length) out.margin = m;
  }
  return out;
}

function nearestSize(wPt, hPt) {
  const sizes = { letter: [612, 792], legal: [612, 1008], a4: [595.28, 841.89], a5: [419.53, 595.28] };
  let best = 'letter', d = Infinity;
  for (const [k, [w, h]] of Object.entries(sizes)) {
    const dd = Math.abs(w - wPt) + Math.abs(h - hPt);
    if (dd < d) { d = dd; best = k; }
  }
  return d < 12 ? best : 'letter';
}

/* ---- the body ------------------------------------------------------------
 * One pass, one explicit stack. Yields our block shape, and records the
 * source span of every paragraph so the writer can splice rather than
 * regenerate.
 */

export function readBody(wd, opts = {}) {
  const src = wd.xml;
  const styles = wd.styles;
  const numbering = wd.numbering;
  const blocks = [];
  const sections = [];
  let counters = { tables: 0, cellsFlattened: 0, drawings: 0, fields: 0, deleted: 0 };

  /* skip regions: text that exists in the file but is not the document's text
   * — a markup-compatibility Fallback (trap 7), a field instruction, deleted
   * text under tracked changes (trap 6). */
  let skipDepth = 0;
  let skipAt = -1;

  let para = null;                 // the paragraph being built
  let run = null;                  // the run being built
  let inBody = false;
  /* Element depth, so a paragraph's CHILDREN can be told from its
   * descendants. A <w:r> inside a <w:hyperlink> is a child of the hyperlink,
   * and recording both as children of the paragraph makes their spans overlap
   * — which on rewrite emits the run twice, once on its own and once inside
   * the copied hyperlink. */
  let depth = 0;

  const tables = [];               // stack of { rows, row, cell, depth }
  let pending = null;              // <w:t> capture

  const flush = () => {
    if (!para) return;
    const owner = tables.length ? tables[tables.length - 1] : null;
    finishPara(para, styles, numbering);
    if (owner && owner.cell) owner.cell.blocks.push(para.block);
    else blocks.push(para.block);
    para = null;
  };

  for (const ev of wscan(src)) {
    if (ev.type === 'text') {
      if (skipDepth > 0 || !pending) continue;
      pending.text += ev.value();
      continue;
    }
    if (ev.type === 'raw') continue;

    const name = ev.name;
    const isW = ev.w;

    if (ev.type === 'open') {
      depth++;
      if (ev.selfClosing) depth--;
      /* --- skip regions --- */
      if (skipDepth > 0) { if (!ev.selfClosing) skipDepth++; continue; }
      if (ev.ns === MC && name === 'Fallback') {
        if (!ev.selfClosing) { skipDepth = 1; skipAt = ev.start; } void skipAt;
        continue;
      }
      if (isW && (name === 'instrText' || name === 'delText' || name === 'del')) {
        if (name === 'delText' || name === 'del') counters.deleted++;
        if (name === 'instrText') counters.fields++;
        if (!ev.selfClosing) skipDepth = 1;
        continue;
      }

      if (isW && name === 'body') { inBody = true; continue; }
      if (!inBody) continue;

      if (isW && name === 'tbl') {
        flush();
        tables.push({ rows: [], row: null, cell: null, depth: tables.length,
                      start: ev.start, cols: null });
        counters.tables++;
        continue;
      }
      if (isW && name === 'gridCol' && tables.length) {
        const t = tables[tables.length - 1];
        const w = num(ev.at('w'));
        if (w !== null) (t.cols || (t.cols = [])).push(w / TWIP);
        continue;
      }
      if (isW && name === 'tr' && tables.length) {
        flush();
        tables[tables.length - 1].row = [];
        continue;
      }
      if (isW && name === 'tc' && tables.length) {
        flush();
        const t = tables[tables.length - 1];
        t.cell = { blocks: [], valign: 'top' };
        if (t.row) t.row.push(t.cell);
        continue;
      }
      if (isW && name === 'shd' && tables.length && tables[tables.length - 1].cell) {
        const fill = ev.at('fill');
        if (fill && /^[0-9A-Fa-f]{6}$/.test(fill) && fill.toUpperCase() !== 'FFFFFF') {
          tables[tables.length - 1].cell.fill = '#' + fill.toUpperCase();
        }
        continue;
      }

      if (isW && name === 'p') {
        flush();
        para = { start: ev.start, end: -1, text: '', runs: [], props: {}, styleId: null,
                 pprInner: null, openTag: src.slice(ev.start, ev.end), depth };
        continue;
      }
      if (!para) {
        // a sectPr outside any paragraph is the document's final section
        if (isW && name === 'sectPr') sections.push({ start: ev.start, end: ev.end });
        continue;
      }

      if (isW && name === 'pPr') { para._pprStart = ev.end; para._pprOpen = ev.start; continue; }
      if (isW && name === 'r') {
        /* A run records the source spans of its TEXT-BEARING children only.
         * That is the unit an edit is written back through: replacing a run's
         * text region leaves its <w:rPr>, and anything else the run happens to
         * contain, exactly where it was. Rewriting the whole <w:p> instead
         * deletes every child we do not model — in this corpus, an anchored
         * full-page background image. */
        run = { props: {}, start: ev.start, end: -1, rprInner: null, text: 0,
                tspans: [], rprSpan: null };
        if (ev.selfClosing) run = null;
        continue;
      }
      if (isW && name === 'rPr' && run) {
        run._rprStart = ev.end; run._rprOpen = ev.start;
        continue;
      }
      if (isW && name === 't') {
        pending = { text: '', preserve: ev.at('space') === 'preserve', start: ev.start };
        if (ev.selfClosing) {
          // <w:t/> is a real, empty text element and it has a position
          if (run) run.tspans.push({ start: ev.start, end: ev.end });
          pending = null;
        }
        continue;
      }
      if (isW && name === 'tab' && !pending) {
        if (run) run.tspans.push({ start: ev.start, end: ev.end });
        addText(para, run, '\t');
        continue;
      }
      if (isW && name === 'br' && !pending) {
        if (run) run.tspans.push({ start: ev.start, end: ev.end });
        /* A soft line break — Shift+Enter in Word. It has to survive as
         * ITSELF: reading it as a space and writing a space back changes the
         * document by one character per break, which is a silent edit to a
         * file the user only opened. U+2028 LINE SEPARATOR is what Unicode
         * has for exactly this, and nothing else in a document uses it. */
        addText(para, run, SOFT_BREAK);
        continue;
      }
      if (isW && name === 'drawing') counters.drawings++;
      continue;
    }

    /* --- close --- */
    if (ev.type !== 'close') continue;          // `raw`: PI, comment, DOCTYPE
    /* Depth comes down HERE, once, for every close — not inside the branches
     * below. Decrementing in some branches and not others is how a depth
     * counter drifts, and a drifting depth silently reclassifies which
     * elements are a paragraph's children. */
    const closeDepth = depth;
    depth--;
    if (skipDepth > 0) { skipDepth--; continue; }
    if (!inBody) continue;

    if (isW && name === 't' && pending) {
      // xml:space is not consulted: the character data is taken exactly as
      // stored, because trimming destroys content invisibly.
      addText(para, run, pending.text);
      if (run) run.tspans.push({ start: pending.start, end: ev.end });
      pending = null;
      continue;
    }
    if (isW && name === 'rPr' && run && run._rprStart !== undefined) {
      run.rprInner = src.slice(run._rprStart, ev.start);
      run.rprSpan = { start: run._rprOpen, end: ev.end };
      Object.assign(run.props, runProps(run.rprInner));
      continue;
    }
    if (isW && name === 'pPr' && para && para._pprStart !== undefined) {
      para.pprInner = src.slice(para._pprStart, ev.start);
      para.pprSpan = { start: para._pprOpen, end: ev.end };

      Object.assign(para.props, paraPropsOf(para.pprInner, styles, numbering));
      const sect = firstElement(para.pprInner, 'sectPr');
      if (sect) sections.push({ inner: sect.inner() });
      continue;
    }
    if (isW && name === 'r' && run) {
      run.end = ev.end;
      run = null;
      continue;
    }
    if (isW && name === 'p' && para) {
      para.end = ev.end;
      para.closeAt = ev.start;      // where a new run would be appended
      flush();
      continue;
    }
    if (isW && name === 'tc' && tables.length) {
      flush();
      tables[tables.length - 1].cell = null;
      continue;
    }
    if (isW && name === 'tr' && tables.length) {
      flush();
      const t = tables[tables.length - 1];
      if (t.row) t.rows.push(t.row);
      t.row = null;
      continue;
    }
    if (isW && name === 'tbl' && tables.length) {
      flush();
      const t = tables.pop();
      const block = { kind: 'table', rows: t.rows, cols: t.cols || null,
                      span: { start: t.start, end: ev.end } };
      const owner = tables.length ? tables[tables.length - 1] : null;
      if (owner && owner.cell) {
        /* A nested table. The layout engine lays a cell out with the whole
         * engine, but not another table inside one — so the inner table's
         * paragraphs are flattened into the cell and the fact is COUNTED and
         * reported rather than being a silent loss. */
        counters.cellsFlattened++;
        for (const row of t.rows) for (const cell of row) owner.cell.blocks.push(...cell.blocks);
      } else {
        blocks.push(block);
      }
      continue;
    }
    if (isW && name === 'body') inBody = false;
  }
  flush();

  // The section that governs the document is the last one.
  let section = {};
  for (const s of sections) {
    const inner = s.inner !== undefined ? s.inner
      : (firstElement(src.slice(s.start, s.end + 200), 'sectPr') || { inner: () => '' }).inner();
    Object.assign(section, sectionOf(inner));
  }

  return { blocks, section, counters, sectionCount: sections.length };
}

function addText(para, run, s) {
  if (!para || !s) return;
  if (run) run.text += s.length;
  para.text += s;
  const last = para.runs[para.runs.length - 1];
  const props = run ? run.props : {};
  if (last && last._run === run) last.n += s.length;
  else para.runs.push({ n: s.length, ...props, _run: run, _rpr: run ? run.rprInner : null });
}

/** Resolve a paragraph's style chain into the props our layout engine wants. */
function finishPara(para, styles, numbering) {
  const p = { ...para.props };
  const chain = p._styleId ? styleChain(styles, p._styleId) : [];
  let kind = null;
  const inherited = {};
  const inheritedRun = {};
  for (let i = chain.length - 1; i >= 0; i--) {
    const s = chain[i];
    if (s.kind) kind = s.kind;
    Object.assign(inherited, s.para);
    Object.assign(inheritedRun, s.run);
  }
  const props = { ...inherited, ...p };
  delete props._styleId;
  delete props._numId;
  props.style = kind || 'body';

  /* A style's own character formatting is the paragraph's default, so a
   * heading defined as 16pt bold in styles.xml renders that way even though
   * no run says so. Our own style table then supplies whatever is left. */
  const base = { ...styles.defaults, ...inheritedRun };
  if (base.sz && !props.size) props.size = base.sz;
  if (base.f && !props.family) props.family = base.f;
  if (base.b && props.bold === undefined) props.bold = true;
  if (base.i && props.italic === undefined) props.italic = true;
  if (base.c && !props.color) props.color = base.c;

  const runs = para.runs.map((r) => {
    const { _run, _rpr, ...rest } = r;
    const src = _run && _run.tspans.length
      ? { start: _run.start, end: _run.end,
          from: _run.tspans[0].start, to: _run.tspans[_run.tspans.length - 1].end,
          rprSpan: _run.rprSpan }
      : null;
    return { ...rest, _rpr, _src: src };
  });
  para.block = {
    kind: 'para',
    text: para.text,
    runs: runs.length ? runs : [{ n: para.text.length }],
    p: props,
    span: { start: para.start, end: para.end },
    pprSpan: para.pprSpan || null,
    openTag: para.openTag || null,
    // every direct child of the <w:p>, in order, so a rewrite can put the
    // ones it does not understand back exactly where they were
    // where a brand-new run is appended: immediately before </w:p>
    insertAt: para.closeAt ?? -1,
  };
}

/* ---- what else is in the file -------------------------------------------- */

/**
 * The parts we read nothing from, so the app can say so honestly rather than
 * implying the document is fully understood.
 */
export async function surveyParts(wd) {
  const out = { headers: 0, footers: 0, footnotes: 0, endnotes: 0, comments: 0,
                images: 0, charts: 0, embedded: 0, parts: wd.zip.entries.length };
  for (const e of wd.zip.entries) {
    const n = e.name.toLowerCase();
    if (/word\/header\d*\.xml$/.test(n)) out.headers++;
    else if (/word\/footer\d*\.xml$/.test(n)) out.footers++;
    else if (/word\/footnotes\.xml$/.test(n)) out.footnotes++;
    else if (/word\/endnotes\.xml$/.test(n)) out.endnotes++;
    else if (/word\/comments\.xml$/.test(n)) out.comments++;
    else if (/word\/media\//.test(n)) out.images++;
    else if (/charts?\/chart\d*\.xml$/.test(n)) out.charts++;
    else if (/word\/embeddings\//.test(n)) out.embedded++;
  }
  /* trap: word/footnotes.xml always holds two built-in entries (the separator
   * and its continuation), so "2 footnotes" almost always means none. Count
   * the REFERENCES in the body for the number a person means. */
  out.footnoteRefs = 0;
  for (const ev of wscan(wd.xml)) {
    if (ev.type === 'open' && ev.w && ev.name === 'footnoteReference') out.footnoteRefs++;
  }
  return out;
}

/* ---- characterisation, for grading against the corpus ---------------------
 *
 * This deliberately does NOT reuse readBody(). It is a flat count of every
 * WordprocessingML element in the main part, in document order, with no
 * markup-compatibility resolution and nothing skipped — because that is the
 * definition corpus/docx.json was measured with, by a separate implementation
 * in another language. Two implementations agreeing is evidence. One
 * asserting is a press release, and the .xlsx side already learned that: a
 * loose gate reported 158/158 green on a reader that had silently dropped
 * 116,491 formulas.
 *
 * The text BLOB is returned rather than a hash so the caller supplies the
 * hash function — this module has no dependencies and is not going to grow
 * one for SHA-256.
 */
export function characterise(wd) {
  const c = {
    allParagraphs: 0, bodyParagraphs: 0, runs: 0, tables: 0, tableCells: 0,
    tableRows: 0, hyperlinks: 0, sections: 0, numberedParas: 0, drawings: 0,
    emptyTextEls: 0, preserveSpaceEls: 0, deletedTextChars: 0, altContent: 0,
    instrText: 0, footnoteRefs: 0, maxDepth: 0,
  };
  let blob = '';

  /* The root element is depth 0, matching the lock's convention. Getting this
   * wrong is invisible: every OTHER count is relative, so a drifting depth
   * still produces correct paragraph and run totals. Only the depth number
   * itself is wrong, which is exactly the kind of defect a loose gate keeps. */
  let depth = -1;
  let bodyDepth = -1;
  // The paragraph currently open, so numPr can be attributed to the paragraph
  // that OWNS it rather than to an ancestor whose nested table holds one.
  const paraStack = [];
  let inT = null, inDel = null, inInstr = null;

  for (const ev of wscan(wd.xml)) {
    if (ev.type === 'text') {
      if (inT !== null) blob += ev.value();
      else if (inDel !== null) c.deletedTextChars += ev.value().length;
      continue;
    }
    if (ev.type === 'open') {
      depth++;
      if (depth > c.maxDepth) c.maxDepth = depth;
      const w = ev.w, n = ev.name;
      if (w) {
        if (n === 'body') bodyDepth = depth;
        else if (n === 'p') {
          c.allParagraphs++;
          if (bodyDepth >= 0 && depth === bodyDepth + 1) c.bodyParagraphs++;
          paraStack.push({ depth, pprDepth: -1, counted: false });
        } else if (n === 'pPr') {
          const p = paraStack[paraStack.length - 1];
          if (p && depth === p.depth + 1) p.pprDepth = depth;
        } else if (n === 'numPr') {
          const p = paraStack[paraStack.length - 1];
          if (p && p.pprDepth > 0 && depth === p.pprDepth + 1 && !p.counted) {
            c.numberedParas++;
            p.counted = true;
          }
        } else if (n === 'r') c.runs++;
        else if (n === 'tbl') c.tables++;
        else if (n === 'tc') c.tableCells++;
        else if (n === 'tr') c.tableRows++;
        else if (n === 'hyperlink') c.hyperlinks++;
        else if (n === 'sectPr') c.sections++;
        else if (n === 'drawing') c.drawings++;
        else if (n === 'footnoteReference') c.footnoteRefs++;
        else if (n === 't') {
          if (ev.selfClosing) c.emptyTextEls++;
          else inT = depth;
          if (ev.at('space') === 'preserve') c.preserveSpaceEls++;
        } else if (n === 'delText') { if (!ev.selfClosing) inDel = depth; }
        else if (n === 'instrText') { c.instrText++; if (!ev.selfClosing) inInstr = depth; }
      } else if (ev.ns === MC && n === 'AlternateContent') c.altContent++;
      if (ev.selfClosing) depth--;
      continue;
    }
    /* An XML declaration, a comment, a DOCTYPE and a CDATA marker all arrive
     * as `raw`, and treating one as a closing tag unbalances the depth for the
     * whole rest of the file. Every document starts with a declaration, so
     * this was wrong on all forty. */
    if (ev.type !== 'close') continue;
    if (ev.w && ev.name === 't' && inT === depth) {
      // an element with no character data at all contributes the empty string
      inT = null;
    }
    if (ev.w && ev.name === 'delText' && inDel === depth) inDel = null;
    if (ev.w && ev.name === 'instrText' && inInstr === depth) inInstr = null;
    if (ev.w && ev.name === 'p') paraStack.pop();
    depth--;
  }
  return { counts: c, text: blob };
}
