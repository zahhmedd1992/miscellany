/* Grain — reference translation.
 *
 * Shifting the relative references in a formula is needed in three places:
 * expanding OOXML shared formulas on read, fill-down, and copy/paste. It is
 * one function so those three cannot drift apart.
 *
 * The trap that makes the naive regex wrong: a formula is not a bag of cell
 * references. `LOG10(A1)` contains the substring "G10". `"A1"` inside quotes
 * is text, not a reference. `SUM(A1:A9)` has two refs but `Sheet1!A1` has a
 * sheet qualifier that must survive. A pattern that ignores any of this
 * silently corrupts formulas — and a corrupted formula still computes, which
 * is the worst possible failure.
 */

import { indexToCol, colToIndex } from '../formula.js';

const A1 = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/g;

/**
 * Shift every relative reference in `src` by (dCol, dRow).
 * Absolute parts marked with `$` are held. Quoted strings are skipped.
 */
export function translateFormula(src, dCol, dRow) {
  if (!src || (dCol === 0 && dRow === 0)) return src;

  // Split into quoted and unquoted runs so string literals are never touched.
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const q = src.indexOf('"', i);
    if (q < 0) { out.push(shiftRun(src.slice(i), dCol, dRow)); break; }
    out.push(shiftRun(src.slice(i, q), dCol, dRow));
    // consume the literal, honouring "" as an escaped quote
    let j = q + 1;
    while (j < n) {
      if (src[j] === '"') {
        if (src[j + 1] === '"') { j += 2; continue; }
        j++; break;
      }
      j++;
    }
    out.push(src.slice(q, j));
    i = j;
  }
  return out.join('');
}

function shiftRun(run, dCol, dRow) {
  return run.replace(A1, (m, ac, col, ar, row, offset, whole) => {
    // Reject matches that are part of a longer identifier.
    const before = offset > 0 ? whole[offset - 1] : '';
    const after = whole[offset + m.length] || '';
    // `LOG10(` — 'G10' preceded by a letter is not a reference.
    if (/[A-Za-z0-9_.]/.test(before) && ac === '') return m;
    // `A1B` or `A1(` — a function call or a longer name, not a reference.
    if (/[A-Za-z0-9_(]/.test(after)) return m;

    let c = colToIndex(col);
    let r = parseInt(row, 10) - 1;
    if (ac !== '$') c += dCol;
    if (ar !== '$') r += dRow;
    // Off-sheet after shifting: Excel writes #REF!. Producing a wrong-but-
    // plausible reference instead would be far worse.
    if (c < 0 || r < 0 || c > 16383 || r > 1048575) return '#REF!';
    return `${ac}${indexToCol(c)}${ar}${r + 1}`;
  });
}

/** Parse "B4" -> {col,row}; null if not an A1 reference. */
export function parseA1(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref || '');
  return m ? { col: colToIndex(m[1]), row: parseInt(m[2], 10) - 1 } : null;
}

/** Parse "B4:D9" -> {c0,r0,c1,r1}; a single ref yields a 1x1 range. */
export function parseRange(ref) {
  if (!ref) return null;
  const [a, b] = ref.split(':');
  const p = parseA1(a);
  if (!p) return null;
  const q = b ? parseA1(b) : p;
  if (!q) return null;
  return {
    c0: Math.min(p.col, q.col), r0: Math.min(p.row, q.row),
    c1: Math.max(p.col, q.col), r1: Math.max(p.row, q.row),
  };
}

/* ---------------------------------------------------------------------------
 * Structural edits: inserting and deleting rows and columns.
 *
 * Every formula in the WORKBOOK may point at the sheet being changed, so the
 * adjustment has to run over all of them, not just the edited sheet.
 *
 * The rule is applied per REFERENCE, which turns out to handle ranges for
 * free. Inserting a row at 5 into `A1:A10`: A1 is above the cut so it stays,
 * A10 is at or below so it becomes A11 — and the range has grown, which is
 * exactly right. Deleting row 5 from the same range: A1 stays, A10 becomes
 * A9, and the range has shrunk. No special case for the pair.
 * ------------------------------------------------------------------------ */

/**
 * @param {string} src   formula text, WITHOUT the leading '='
 * @param {object} op
 * @param {string} op.sheet       the sheet being structurally changed
 * @param {string} op.homeSheet   the sheet this formula lives on (for bare refs)
 * @param {'row'|'col'} op.axis
 * @param {number} op.at          0-based index of the first affected row/col
 * @param {number} op.count       how many are inserted, or deleted
 * @param {boolean} op.remove     true to delete, false to insert
 */
export function adjustReferences(src, op) {
  if (!src) return src;
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const q = src.indexOf('"', i);
    if (q < 0) { out.push(adjustRun(src.slice(i), op)); break; }
    out.push(adjustRun(src.slice(i, q), op));
    let j = q + 1;
    while (j < n) {
      if (src[j] === '"') { if (src[j + 1] === '"') { j += 2; continue; } j++; break; }
      j++;
    }
    out.push(src.slice(q, j));
    i = j;
  }
  // A range whose every endpoint died collapses to a single #REF!, which is
  // what Excel shows; "#REF!:#REF!" is not a thing.
  return out.join('').replace(/#REF!:#REF!/g, '#REF!');
}

/* A reference, optionally sheet-qualified. Captured so the sheet can be
 * compared before anything is shifted — a formula on Sheet1 pointing at
 * Sheet2 must not move when Sheet1 gains a row. */
const QUAL_RE = /(?:('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/g;

function adjustRun(run, op) {
  return run.replace(QUAL_RE, (m, sheetTok, ac, colTxt, ar, rowTxt, offset, whole) => {
    const before = offset > 0 ? whole[offset - 1] : '';
    const after = whole[offset + m.length] || '';
    if (!sheetTok && /[A-Za-z0-9_.]/.test(before) && ac === '') return m;   // LOG10(
    if (/[A-Za-z0-9_(]/.test(after)) return m;

    let sheet = op.homeSheet;
    if (sheetTok) {
      sheet = sheetTok.startsWith("'") ? sheetTok.slice(1, -1).replace(/''/g, "'") : sheetTok;
    }
    if (sheet !== op.sheet) return m;                 // a different sheet: untouched

    const col = colToIndex(colTxt);
    const row = parseInt(rowTxt, 10) - 1;
    const idx = op.axis === 'row' ? row : col;

    let next = idx;
    if (op.remove) {
      if (idx >= op.at && idx < op.at + op.count) return '#REF!';
      if (idx >= op.at + op.count) next = idx - op.count;
    } else if (idx >= op.at) {
      next = idx + op.count;
    }
    if (next === idx) return m;
    if (next < 0 || next > (op.axis === 'row' ? 1048575 : 16383)) return '#REF!';

    const q = sheetTok ? sheetTok + '!' : '';
    return op.axis === 'row'
      ? `${q}${ac}${colTxt}${ar}${next + 1}`
      : `${q}${ac}${indexToCol(next)}${ar}${row + 1}`;
  });
}

/** Where a cell moves to under a structural edit, or null if it is deleted. */
export function moveCell(col, row, op) {
  const idx = op.axis === 'row' ? row : col;
  let next = idx;
  if (op.remove) {
    if (idx >= op.at && idx < op.at + op.count) return null;
    if (idx >= op.at + op.count) next = idx - op.count;
  } else if (idx >= op.at) {
    next = idx + op.count;
  }
  return op.axis === 'row' ? { col, row: next } : { col: next, row };
}
