/* Grain — A1 addressing.
 *
 * This is NOT the graph's business: the graph cannot parse "B4:B16" and must
 * never learn how. But A1 is not Sheet's private business either — it is the
 * REFERENCE GRAMMAR the whole platform shares. A chart on a slide, a form
 * field, a paragraph with a live total: every one of them points at cells,
 * and they all have to spell it the same way.
 *
 * It lived inside apps/sheet until Deck needed it, at which point the second
 * app would have had to import from the first. That is the moment a thing
 * stops being an app's business and becomes the substrate's.
 */

import { indexToCol, colToIndex } from './formula.js';

export { indexToCol, colToIndex };

/** The default sheet for a document with only one. */
export const SHEET = 'main';

/** "B4" on sheet S -> "S!B4". Ids are opaque to the graph; this is the shape
 *  every app that addresses cells agrees on. */
export const cellId = (col, row, sheet = SHEET) => `${sheet}!${indexToCol(col)}${row + 1}`;

/** "Land-Based Wind!S28" -> "Land-Based Wind". Ids without a '!' have none. */
export function sheetOfId(id) {
  const i = String(id).indexOf('!');
  return i < 0 ? SHEET : String(id).slice(0, i);
}

/** The reference part of an id: "S!B4" -> "B4". */
export function refOfId(id) {
  const i = String(id).indexOf('!');
  return i < 0 ? String(id) : String(id).slice(i + 1);
}

/**
 * Turn a parsed reference into node ids, in row-major order.
 * The returned array carries `.shape` — VLOOKUP and INDEX address a range in
 * two dimensions, and a flat list cannot tell them how wide it is.
 */
export function expand(ref, ctx = {}) {
  const sheet = ref.sheet || ctx.sheet || SHEET;
  if (ref.t === 'ref') {
    const ids = [cellId(ref.col, ref.row, sheet)];
    ids.shape = { rows: 1, cols: 1 };
    return ids;
  }
  if (ref.t === 'range') {
    const a = ref.a, b = ref.b;
    if (!a || !b || a.t !== 'ref' || b.t !== 'ref') return [];
    const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col);
    const r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
    const sh = a.sheet || b.sheet || sheet;
    const ids = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) ids.push(cellId(c, r, sh));
    ids.shape = { rows: r1 - r0 + 1, cols: c1 - c0 + 1 };
    return ids;
  }
  return [];
}

/** "B4:D9" -> {c0,r0,c1,r1}, 0-based. A single cell is a 1x1 range. */
export function parseRangeRef(ref) {
  let m = /^\$?([A-Za-z]{1,3})\$?(\d+):\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref || '');
  if (!m) {
    const one = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref || '');
    if (one) m = [null, one[1], one[2], one[1], one[2]];
  }
  if (!m) return null;
  const c0 = colToIndex(m[1]), r0 = parseInt(m[2], 10) - 1;
  const c1 = colToIndex(m[3]), r1 = parseInt(m[4], 10) - 1;
  return {
    c0: Math.min(c0, c1), r0: Math.min(r0, r1),
    c1: Math.max(c0, c1), r1: Math.max(r0, r1),
  };
}

/** "Sheet1!$B$2:$B$7" -> { sheet, ref }, with the $ stripped. */
export function splitRef(f) {
  if (!f) return null;
  const i = String(f).lastIndexOf('!');
  if (i < 0) return { sheet: null, ref: String(f).replace(/\$/g, '') };
  let sheet = String(f).slice(0, i);
  if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  return { sheet, ref: String(f).slice(i + 1).replace(/\$/g, '') };
}

/** Every node id covered by "Sheet!A1:B2". */
export function idsInRange(sheet, ref) {
  const r = parseRangeRef(ref);
  if (!r) return [];
  const out = [];
  for (let row = r.r0; row <= r.r1; row++) {
    for (let col = r.c0; col <= r.c1; col++) out.push(cellId(col, row, sheet));
  }
  out.shape = { rows: r.r1 - r.r0 + 1, cols: r.c1 - r.c0 + 1 };
  return out;
}
