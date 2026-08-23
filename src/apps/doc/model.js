/* Doc - how a written document is spelled in the node graph.
 *
 * Doc gives the substrate the same two answers Sheet and Deck give it:
 *   1. how its things are named          (doc:body/p<key>, and /f<n> inside)
 *   2. what a view has to know to draw   (text in the node, formatting in meta)
 *
 * THE ONE DESIGN DECISION THAT MATTERS - paragraph ORDER.
 *
 * The obvious spelling is doc:body/p1, p2, p3. It is also unusable: pressing
 * Enter in the middle of a fifty-page report would renumber every paragraph
 * below the cursor, which means rewriting hundreds of nodes, journalling
 * hundreds of undo entries, and doing it again on the next keystroke. Deck
 * gets away with the equivalent (shiftSlides) because a deck has thirty
 * slides and you insert one a minute.
 *
 * So a paragraph's key is a FRACTIONAL INDEX: a base-62 string that sorts
 * lexicographically, with the property that there is always a valid key
 * strictly between any two. Inserting between "a1" and "a2" produces "a1V",
 * and touches exactly one node. The document's order is the sorted order of
 * its ids, so order is derived from the document rather than stored beside it
 * - the same rule that made Deck's slide count derived after a stored one
 * lost every slide but the first.
 *
 * Fractional indexing is a MECHANISM, not a model: "give me a string between
 * these two strings" has a provably correct answer and no opinion about what
 * a document is.
 */

import { toText, isRange } from '../../core/value.js';
import { formatValue } from '../../core/numfmt.js';
import { formatGeneral } from '../../core/format.js';

export const DOC = 'doc';
export const BODY = `${DOC}:body/p`;

/** The character a field occupies in a paragraph's text: U+FFFC. */
export const FIELD_CHAR = '￼';

/* ---- fractional index keys ----------------------------------------------
 * Digits are ordered exactly as ASCII orders them, so comparing two keys as
 * strings is comparing two fractions.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];
const LAST = DIGITS[DIGITS.length - 1];

/* A key is an INTEGER part followed by a FRACTION part.
 *
 * The integer part is what keeps typing cheap. Without it, appending a
 * thousand paragraphs makes the thousandth key a thousand characters long,
 * because "after everything" can only be expressed by extending the last
 * key. With it, the first character encodes how many digits follow -
 * a0, a1 ... az, b00, b01 ... bzz, c000 - so 5,000 appended paragraphs all
 * have keys of four characters or fewer, and the file stays small and
 * readable.
 *
 * The fraction part is only reached when something is inserted BETWEEN two
 * existing keys, which is the case the integer part cannot express.
 *
 * Heads a..z count upward (2..27 digits) and A..Z downward, so a document can
 * grow in both directions from its first paragraph without ever renumbering.
 */

const integerLength = (head) => {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new Error('invalid order-key head: ' + head);
};

function integerPart(key) {
  const n = integerLength(key[0]);
  if (n > key.length) throw new Error('invalid order key: ' + key);
  return key.slice(0, n);
}

function validate(key) {
  if (typeof key !== 'string' || !key.length) throw new Error('invalid order key: ' + key);
  const i = integerPart(key);
  if (key.slice(i.length).slice(-1) === ZERO) {
    // "a0V0" and "a0V" would name the same fraction while comparing
    // differently, so one of the two spellings has to be illegal.
    throw new Error('order key fraction ends in a zero: ' + key);
  }
}

function incrementInteger(x) {
  const [head, ...digs] = x.split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) + 1;
    if (d === DIGITS.length) digs[i] = ZERO;
    else { digs[i] = DIGITS[d]; carry = false; }
  }
  if (!carry) return head + digs.join('');
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > 'a') digs.push(ZERO); else digs.pop();
  return h + digs.join('');
}

function decrementInteger(x) {
  const [head, ...digs] = x.split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = LAST;
    else { digs[i] = DIGITS[d]; borrow = false; }
  }
  if (!borrow) return head + digs.join('');
  if (head === 'a') return 'Z' + LAST;
  if (head === 'A') return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < 'Z') digs.push(LAST); else digs.pop();
  return h + digs.join('');
}

/** A fraction strictly between two fractions, `b` null meaning 1. */
function midpoint(a, b) {
  if (b !== null && a >= b) throw new Error(`order key out of order: ${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b && b.slice(-1) === ZERO)) {
    throw new Error('order key fraction ends in a zero');
  }
  if (b !== null) {
    let n = 0;
    while ((a[n] || ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round(0.5 * (da + db))];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

/** The very first key a document uses. */
export const FIRST_KEY = 'a' + ZERO;

/**
 * A key strictly between `a` and `b`. Either may be null, meaning "before
 * everything" / "after everything". This is the only way a paragraph gets an
 * id, so an insert anywhere costs exactly one node write.
 */
export function keyBetween(a, b) {
  if (a !== null) validate(a);
  if (b !== null) validate(b);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);

  if (a === null) {
    if (b === null) return FIRST_KEY;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === 'A' + ZERO.repeat(26)) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const dec = decrementInteger(ib);
    if (dec === null) throw new Error('order keys exhausted downwards');
    return dec;
  }
  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const inc = incrementInteger(ia);
    return inc === null ? ia + midpoint(fa, null) : inc;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const inc = incrementInteger(ia);
  if (inc === null) throw new Error('order keys exhausted upwards');
  return inc < b ? inc : ia + midpoint(fa, null);
}

/* ---- ids ----------------------------------------------------------------- */

export const bodyId = (key) => BODY + key;
export const fieldId = (paraId, n) => `${paraId}/f${n}`;
export const catsId = (blockId) => `${blockId}/cats`;

/** Is this the id of a body block (not a field or a cell inside one)? */
export function isBodyId(id) {
  return typeof id === 'string' && id.startsWith(BODY) && id.indexOf('/', BODY.length) < 0;
}

/** The fractional key of a body id. */
export const keyOf = (id) => String(id).slice(BODY.length);

/** The block a sub-node (field, cell, cats) belongs to. */
export function ownerOf(id) {
  if (!String(id).startsWith(BODY)) return null;
  const cut = String(id).indexOf('/', BODY.length);
  return cut < 0 ? String(id) : String(id).slice(0, cut);
}

/** A table cell's id. Cells are nodes so a cell can hold a formula. */
export const cellId = (tableId, r, c) => `${tableId}/r${r}c${c}`;

/* ---- page setup ---------------------------------------------------------- */

export const PAGE_NODE = `${DOC}:page`;

export function pageSetup(doc) {
  const n = doc.nodes.get(PAGE_NODE);
  return (n && n.meta && n.meta.page) || {};
}

export function setPageSetup(doc, patch) {
  doc.setMeta(PAGE_NODE, { page: { ...pageSetup(doc), ...patch } });
}

/* ---- reading the document ------------------------------------------------ */

/** Is this node actually present, or has it been cleared? */
export function isLive(node) {
  return !!node && (node.raw !== '' || (node.meta !== null && node.meta !== undefined));
}

/**
 * Every body block id, in document order.
 *
 * A node that has been cleared is NOT a block. Graph.set(id, '') never removes
 * a node from the map - it only changes its input - so a deleted paragraph
 * used to stay in the document as an EMPTY one. Every delete path went
 * through it: backspacing into the previous paragraph, selecting three
 * paragraphs and typing, deleting a table. The document grew a blank line
 * where the deleted thing had been, in the editor and in the exported PDF,
 * and then changed shape again on reload because docfile.serialise drops
 * exactly these nodes when it writes the file.
 *
 * This is the same rule the file format uses, so what is on screen and what
 * is on disk now agree, and undo still works because clearing a node is an
 * ordinary journalled write.
 */
export function blockIds(doc) {
  const out = [];
  for (const [id, node] of doc.nodes) if (isBodyId(id) && isLive(node)) out.push(id);
  // Ordering IS the sorted order of the keys. Sorting the whole id would work
  // too (the prefix is constant), but sorting the key alone says what is
  // meant and cannot be broken by a future change to the prefix.
  out.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  return out;
}

/** The paragraph record for a node: text, runs, paragraph properties. */
export function paraOf(doc, id) {
  const n = doc.node(id, true);
  const m = (n.meta && n.meta.para) || {};
  const text = n.raw || '';
  /* When a paragraph has no stored run list, the default one is memoised on
   * the node rather than built fresh. Layout caches its line breaking and
   * checks the cache by OBJECT IDENTITY, so handing back a new array every
   * call would mean such a paragraph could never hit the cache — and the
   * document would be re-broken from scratch on every keystroke, which is
   * precisely the cost the cache exists to remove. */
  let runs = m.runs;
  if (!runs) {
    if (!n._runs || n._runsFor !== text) {
      n._runs = [{ n: text.length }];
      n._runsFor = text;
    }
    runs = n._runs;
  }
  return { id, text, runs, p: m.p || EMPTY_PROPS };
}

/* One shared object, so a paragraph with no properties compares equal to
 * itself between layouts. */
const EMPTY_PROPS = Object.freeze({});

/**
 * Turn the document into the block list the layout engine eats.
 *
 * Nothing here computes anything: a field's value comes from the graph at
 * layout time through `resolve`, so this function is a pure read and can be
 * called from a change listener without tripping the graph's write guard.
 */
export function readBlocks(doc) {
  const out = [];
  for (const id of blockIds(doc)) {
    const n = doc.node(id, true);
    const meta = n.meta || {};
    if (meta.block) {
      const b = meta.block;
      if (b.kind === 'pagebreak') { out.push({ kind: 'pagebreak', id }); continue; }
      if (b.kind === 'image') {
        out.push({ kind: 'image', id, key: b.key, w: b.w, h: b.h, align: b.align, alt: b.alt });
        continue;
      }
      if (b.kind === 'chart') {
        out.push({
          kind: 'chart', id, w: b.w || 460, h: b.h || 260, align: b.align || 'center',
          spec: { ...b, ref: n.raw.replace(/^=/, ''), catsRef: doc.raw(catsId(id)).replace(/^=/, '') },
        });
        continue;
      }
      if (b.kind === 'table') { out.push(tableBlock(doc, id, n, b)); continue; }
    }
    const p = paraOf(doc, id);
    out.push({ kind: 'para', id, text: p.text, runs: p.runs, p: p.p });
  }
  if (!out.length) out.push({ kind: 'para', id: bodyId(FIRST_KEY), text: '', runs: [{ n: 0 }], p: {} });
  return out;
}

/**
 * A table, either authored cell by cell or BOUND TO A RANGE.
 *
 * The bound form is the Word analog of Deck's live chart: the table node's
 * input is `=Budget!A3:D9`, so the graph knows this table depends on those
 * cells, and editing one repaints the report. There is no synchronisation
 * code because there is nothing to synchronise - the table is a dependent.
 */
function tableBlock(doc, id, node, b) {
  const rows = [];
  if (b.ref || (node.raw || '').startsWith('=')) {
    const v = node.value;
    if (isRange(v)) {
      const shape = v.shape || { rows: v.values.length, cols: 1 };
      for (let r = 0; r < shape.rows; r++) {
        const row = [];
        for (let c = 0; c < shape.cols; c++) {
          const cell = v.values[r * shape.cols + c];
          const head = b.header !== false && r === 0;
          row.push({
            blocks: [{
              kind: 'para', id: `${id}/v${r}c${c}`, text: displayOf(cell, null),
              runs: [{ n: displayOf(cell, null).length, b: head || undefined }],
              p: { style: 'body', after: 0, before: 0, size: b.size || 9.5,
                   family: b.family || 'sans',
                   align: head ? 'left' : (numericish(cell) ? 'right' : 'left') },
            }],
            fill: head ? (b.headFill || '#F5F0E6') : null,
            valign: 'top',
          });
        }
        rows.push(row);
      }
    }
    return { kind: 'table', id, rows, cols: b.cols || null, live: true,
             border: b.border ?? '#DAD0BC', pad: b.pad ?? 4, after: b.after ?? 10 };
  }
  for (let r = 0; r < (b.rows || 0); r++) {
    const row = [];
    for (let c = 0; c < (b.colsN || 0); c++) {
      const cid = cellId(id, r, c);
      const p = paraOf(doc, cid);
      row.push({
        blocks: [{ kind: 'para', id: cid, text: p.text, runs: p.runs,
                   p: { after: 0, before: 0, size: 10, ...p.p } }],
        fill: b.header && r === 0 ? (b.headFill || '#F5F0E6') : null,
        valign: 'top',
      });
    }
    rows.push(row);
  }
  return { kind: 'table', id, rows, cols: b.cols || null,
           border: b.border ?? '#DAD0BC', pad: b.pad ?? 4, after: b.after ?? 10 };
}

const numericish = (v) => v && (v.k === 'number' || v.k === 'bool');

/** How a value shows in prose: a number format if one is set, else General. */
export function displayOf(v, fmt) {
  if (!v) return '';
  if (v.k === 'number') {
    return fmt ? formatValue(v, fmt).text : formatGeneral(v.d);
  }
  return toText(v);
}

/**
 * The resolver layout uses for field runs.
 *
 * A field is a node whose input is a formula, so its value is maintained by
 * the same scheduler that maintains a cell. This function only READS it.
 */
export function fieldResolver(doc) {
  return (id) => {
    const n = doc.nodes.get(id);
    if (!n) return '#REF!';
    const fmt = n.meta && n.meta.field && n.meta.field.fmt;
    return displayOf(n.value, fmt || null);
  };
}

/* ---- writing ------------------------------------------------------------- */

/**
 * Clear any field node this paragraph no longer refers to.
 *
 * A field is a node with a formula in it, so it sits in the dependency graph
 * and is recalculated forever. Deleting the character that displayed it used
 * to leave the node behind: invisible, still reading the sheet, still costing
 * a recalculation, and still written into the saved file.
 */
export function pruneFields(doc, paraId, oldRuns, newRuns) {
  const kept = new Set();
  for (const r of newRuns || []) if (r.field) kept.add(r.field);
  for (const r of oldRuns || []) {
    if (r.field && !kept.has(r.field) && doc.nodes.has(r.field)) {
      doc.set(r.field, '');
      doc.setMeta(r.field, null);
    }
  }
}

/** Create or replace a paragraph. Meta is ALWAYS written, for two reasons. */
export function setPara(doc, id, text, runs, p) {
  doc.set(id, text ?? '');
  /* 1. an empty paragraph is a real paragraph, and docfile.serialise drops a
   *    node whose input is empty AND whose meta is null - so a document with
   *    three blank lines between sections would come back with none of them.
   * 2. a run list is formatting, and formatting must travel through setMeta
   *    or it never reaches the undo journal. */
  doc.setMeta(id, { para: { runs: runs ?? [{ n: (text || '').length }], p: p ?? {} } });
}

/** Insert a paragraph after `afterId` (or at the very start when null). */
export function insertPara(doc, afterId, ids, text = '', p = {}) {
  const order = ids || blockIds(doc);
  const i = afterId === null ? -1 : order.indexOf(afterId);
  const a = i >= 0 ? keyOf(order[i]) : null;
  const b = i + 1 < order.length ? keyOf(order[i + 1]) : null;
  const id = bodyId(keyBetween(a, b));
  setPara(doc, id, text, [{ n: text.length }], p);
  return id;
}

/** Insert a block (table, image, chart, page break) after `afterId`. */
export function insertBlock(doc, afterId, block, raw = '') {
  const order = blockIds(doc);
  const i = afterId === null ? -1 : order.indexOf(afterId);
  const a = i >= 0 ? keyOf(order[i]) : null;
  const b = i + 1 < order.length ? keyOf(order[i + 1]) : null;
  const id = bodyId(keyBetween(a, b));
  doc.set(id, raw);
  doc.setMeta(id, { block });
  return id;
}

/** Delete a block and everything that hangs off it (fields, cells, cats). */
export function removeBlock(doc, id) {
  const kill = [id];
  for (const other of doc.nodes.keys()) {
    if (other !== id && String(other).startsWith(id + '/')) kill.push(other);
  }
  for (const k of kill) { doc.set(k, ''); doc.setMeta(k, null); }
}

/** The next free field number in a paragraph. */
export function nextFieldNumber(doc, paraId) {
  let max = 0;
  for (const id of doc.nodes.keys()) {
    const m = new RegExp(`^${escapeId(paraId)}/f(\\d+)$`).exec(String(id));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

const escapeId = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---- run arithmetic ------------------------------------------------------
 * Runs are (length, formatting) pairs covering the text exactly. Every edit
 * has to keep that true, and getting it wrong is the classic word-processor
 * bug: the text is right, the bold starts three characters late, and it is
 * unrecoverable because nothing ever told you.
 */

/** Normalise: drop empties, merge neighbours that are formatted the same. */
export function packRuns(runs, len) {
  const out = [];
  let total = 0;
  for (const r of runs) {
    const n = Math.max(0, Math.min(r.n | 0, len - total));
    if (n <= 0) continue;
    const prev = out[out.length - 1];
    if (prev && sameFormat(prev, r)) prev.n += n;
    else out.push({ ...r, n });
    total += n;
  }
  if (total < len) out.push({ n: len - total });
  return out.length ? out : [{ n: len }];
}

const FMT_KEYS = ['b', 'i', 'u', 's', 'sz', 'f', 'c', 'hl', 'sup', 'sub', 'link', 'field'];

export function sameFormat(a, b) {
  if (a.field || b.field) return false;             // a field is never merged
  for (const k of FMT_KEYS) if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  return true;
}

/** The run covering source offset `at` (the one starting at `at` wins). */
export function runAt(runs, at) {
  let acc = 0;
  for (let i = 0; i < runs.length; i++) {
    if (at < acc + runs[i].n || (at === acc && runs[i].n === 0)) return { i, start: acc };
    acc += runs[i].n;
  }
  return { i: Math.max(0, runs.length - 1), start: Math.max(0, acc - (runs[runs.length - 1]?.n || 0)) };
}

/** Split the run list so that a run boundary falls exactly at `at`. */
export function splitAt(runs, at) {
  const out = [];
  let acc = 0;
  for (const r of runs) {
    if (at > acc && at < acc + r.n) {
      out.push({ ...r, n: at - acc }, { ...r, n: acc + r.n - at });
    } else out.push({ ...r });
    acc += r.n;
  }
  return out;
}

/** Insert `n` characters at `at`, taking the formatting of the run before. */
export function insertRuns(runs, at, n, format) {
  if (n <= 0) return runs.map((r) => ({ ...r }));
  const parts = splitAt(runs, at);
  const out = [];
  let acc = 0;
  let done = false;
  for (const r of parts) {
    if (!done && acc === at) {
      out.push(format ? { ...format, n } : inheritAt(parts, at, n));
      done = true;
    }
    out.push({ ...r });
    acc += r.n;
  }
  if (!done) out.push(format ? { ...format, n } : inheritAt(parts, at, n));
  return packRuns(out, totalOf(out));
}

/* Typing next to a field must not inherit the FIELD - otherwise the character
 * you type becomes part of a computed value and vanishes on the next
 * recalculation. Inherit from the nearest run that is real text. */
function inheritAt(parts, at, n) {
  let acc = 0, last = null;
  for (const r of parts) {
    if (acc >= at) break;
    if (!r.field) last = r;
    acc += r.n;
  }
  if (!last) for (const r of parts) if (!r.field) { last = r; break; }
  const { n: _n, field: _f, ...fmt } = last || {};
  return { n, ...fmt };
}

const totalOf = (runs) => runs.reduce((a, r) => a + r.n, 0);

/** Delete the characters in [from, to). */
export function deleteRuns(runs, from, to) {
  const out = [];
  let acc = 0;
  for (const r of runs) {
    const s = acc, e = acc + r.n;
    acc = e;
    const keepA = Math.max(0, Math.min(r.n, from - s));
    const keepB = Math.max(0, Math.min(r.n, e - to));
    const n = keepA + keepB;
    if (n <= 0) continue;
    if (r.field && (from < e && to > s)) continue;      // a partly-deleted field goes
    out.push({ ...r, n });
  }
  return packRuns(out, totalOf(out));
}

/** Apply a formatting change to [from, to). `fn` maps a run to its new form. */
export function formatRuns(runs, from, to, fn) {
  if (to <= from) return runs.map((r) => ({ ...r }));
  const parts = splitAt(splitAt(runs, from), to);
  const out = [];
  let acc = 0;
  for (const r of parts) {
    const s = acc;
    acc += r.n;
    if (s >= from && acc <= to && r.n > 0) out.push({ ...r, ...fn(r), n: r.n });
    else out.push({ ...r });
  }
  return packRuns(out, totalOf(out));
}

/** The formatting in force across [from, to): a key is only reported when
 *  every run in the span agrees about it. */
export function formatAcross(runs, from, to) {
  let acc = 0;
  let first = null;
  const agree = {};
  for (const r of runs) {
    const s = acc, e = acc + r.n;
    acc = e;
    if (e <= from || s >= to) continue;
    if (!first) { first = r; for (const k of FMT_KEYS) agree[k] = r[k] ?? null; continue; }
    for (const k of FMT_KEYS) if ((r[k] ?? null) !== agree[k]) agree[k] = undefined;
  }
  return first ? agree : {};
}
