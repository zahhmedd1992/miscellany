/* Sheet — clipboard.
 *
 * Two payloads go on the clipboard at once, and the reason matters:
 *
 *   text/plain          the DISPLAYED values as TSV, so pasting into Excel,
 *                       Google Sheets, an email or a text editor works.
 *   application/x-grain the RAW inputs plus the source anchor, so pasting
 *                       back into Sheet keeps formulas and translates their
 *                       relative references.
 *
 * A spreadsheet that only writes TSV loses every formula on copy/paste; one
 * that only writes its own format is a walled garden. Writing both costs
 * nothing and is what a user actually expects from Ctrl+C.
 *
 * We use the browser's own copy/cut/paste EVENTS rather than
 * navigator.clipboard, because the events carry the data with no permission
 * prompt and fire from the native keystrokes the user already knows.
 */

import { translateFormula } from '../../core/ooxml/refs.js';

export const MIME = 'application/x-grain';

/** Split TSV into a grid, honouring Excel's "quoted cell" convention. */
export function parseTSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else q = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') { q = true; continue; }
    if (c === '\t') { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  // A trailing newline produces one empty row; it is not data.
  if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

export function toTSV(grid) {
  return grid.map((r) => r.map((v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join('\t')).join('\n');
}

/**
 * Build both payloads for a selection.
 * @param rect   {c0,r0,c1,r1}
 * @param rawAt  (col,row) => raw input string
 * @param textAt (col,row) => displayed text
 */
export function buildPayload(rect, rawAt, textAt) {
  const raws = [], shown = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    const rr = [], sr = [];
    for (let c = rect.c0; c <= rect.c1; c++) { rr.push(rawAt(c, r)); sr.push(textAt(c, r)); }
    raws.push(rr); shown.push(sr);
  }
  return {
    tsv: toTSV(shown),
    grain: JSON.stringify({ v: 1, anchor: { col: rect.c0, row: rect.r0 }, cells: raws }),
  };
}

/**
 * Turn a clipboard into a grid of raw inputs positioned at `target`.
 * Formulas from a Grain payload are translated by the paste offset; a plain
 * TSV paste is taken literally, because text from elsewhere has no anchor
 * and guessing one would rewrite the user's data.
 */
export function decodePaste({ grain, tsv }, target) {
  if (grain) {
    try {
      const p = JSON.parse(grain);
      if (p && p.v === 1 && Array.isArray(p.cells)) {
        const dCol = target.col - p.anchor.col;
        const dRow = target.row - p.anchor.row;
        return p.cells.map((row) => row.map((raw) => {
          if (typeof raw !== 'string' || !raw.startsWith('=')) return raw;
          return '=' + translateFormula(raw.slice(1), dCol, dRow);
        }));
      }
    } catch (e) { /* fall through to TSV */ }
  }
  return tsv ? parseTSV(tsv) : null;
}
