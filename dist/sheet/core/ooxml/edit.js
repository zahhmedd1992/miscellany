/* Grain — surgical edits to worksheet XML.
 *
 * The alternative is to model a sheet, then re-serialise it. That is what
 * every wrapper library does, and it is why every wrapper library rewrites
 * your whole file: attribute order, self-closing style, whitespace, entity
 * choice, and every element it didn't model are all lost on the way out.
 *
 * So we splice. The original text is authoritative; we replace exactly the
 * span of the cell being changed and touch nothing else. A sheet with 400
 * cells where one changed comes back with 399 cells byte-identical.
 */

import { scan, elements, local } from './xml.js';
import { colToIndex, indexToCol } from '../formula.js';

/** Detect the namespace prefix in use ("" for none, "x" for <x:worksheet>). */
export function detectPrefix(xml) {
  const m = /<([A-Za-z_][\w.-]*):worksheet[\s>]/.exec(xml);
  return m ? m[1] : '';
}

const parseRef = (ref) => {
  const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(ref);
  return m ? { col: colToIndex(m[1]), row: parseInt(m[2], 10) } : null;   // row is 1-based here
};

function splice(src, start, end, text) {
  return src.slice(0, start) + text + src.slice(end);
}

/**
 * Set one cell's content in worksheet XML, preserving every other byte.
 *
 * @param {string} xml      the worksheet part, verbatim
 * @param {string} ref      "B4"
 * @param {string} inner    inner XML, e.g. "<v>42</v>" or "<f>SUM(A1:A3)</f><v>6</v>"
 *                          — pass null to delete the cell
 * @param {string} [type]   the t= attribute ("n","s","str","b","e","inlineStr")
 * @param {string} [style]  the s= attribute; preserved from the existing cell if omitted
 */
export function setCellRaw(xml, ref, inner, type = 'n', style) {
  const pos = parseRef(ref);
  if (!pos) throw new Error(`bad cell reference: ${ref}`);
  const p = detectPrefix(xml);
  const q = p ? p + ':' : '';

  // --- locate <sheetData> ---
  let sdOpenEnd = -1, sdCloseStart = -1;
  {
    let depth = 0;
    for (const ev of scan(xml)) {
      if (ev.type === 'open' && ev.name === 'sheetData') {
        if (ev.selfClosing) {
          // An empty sheet is written <sheetData/>. Expand it before inserting.
          xml = splice(xml, ev.start, ev.end, `<${q}sheetData></${q}sheetData>`);
          return setCellRaw(xml, ref, inner, type, style);
        }
        if (depth === 0) sdOpenEnd = ev.end;
        depth++;
      } else if (ev.type === 'close' && ev.name === 'sheetData') {
        depth--;
        if (depth === 0) { sdCloseStart = ev.start; break; }
      }
    }
  }
  if (sdOpenEnd < 0) throw new Error('no sheetData element');

  const body = xml.slice(sdOpenEnd, sdCloseStart);

  // --- locate the row ---
  let rowStart = -1, rowEnd = -1, rowInnerStart = -1, rowInnerEnd = -1, insertRowAt = -1;
  for (const r of elements(body, 'row')) {
    const n = parseInt(r.attr('r') || '0', 10);
    if (n === pos.row) { rowStart = r.start; rowEnd = r.end; rowInnerStart = r.innerStart; rowInnerEnd = r.innerEnd; break; }
    if (n > pos.row && insertRowAt < 0) { insertRowAt = r.start; break; }
  }

  const cellXml = inner === null ? '' :
    `<${q}c r="${ref}"${type && type !== 'n' ? ` t="${type}"` : ''}${style !== undefined ? ` s="${style}"` : ''}>${inner}</${q}c>`;

  if (rowStart < 0) {
    if (inner === null) return xml;                     // deleting from a row that isn't there
    const rowXml = `<${q}row r="${pos.row}">${cellXml}</${q}row>`;
    const at = insertRowAt >= 0 ? sdOpenEnd + insertRowAt : sdCloseStart;
    return splice(xml, at, at, rowXml);
  }

  // --- locate the cell within the row ---
  const rowInner = body.slice(rowInnerStart, rowInnerEnd);
  let cStart = -1, cEnd = -1, insertCellAt = -1, existingStyle;
  for (const c of elements(rowInner, 'c')) {
    const cr = c.attr('r');
    const cp = cr ? parseRef(cr) : null;
    if (cr === ref) { cStart = c.start; cEnd = c.end; existingStyle = c.attr('s'); break; }
    if (cp && cp.col > pos.col && insertCellAt < 0) { insertCellAt = c.start; break; }
  }

  const base = sdOpenEnd + rowInnerStart;
  const finalCell = inner === null ? '' :
    (style === undefined && existingStyle !== undefined
      ? `<${q}c r="${ref}"${type && type !== 'n' ? ` t="${type}"` : ''} s="${existingStyle}">${inner}</${q}c>`
      : cellXml);

  if (cStart >= 0) return splice(xml, base + cStart, base + cEnd, finalCell);
  if (inner === null) return xml;
  const at = insertCellAt >= 0 ? base + insertCellAt : sdOpenEnd + rowInnerEnd;
  return splice(xml, at, at, finalCell);
}

/**
 * Point a cell at a different style index, creating the cell if it is not
 * there. Everything else about the cell — its value, its formula, its
 * attribute order — is untouched.
 */
export function setCellStyle(xml, ref, styleIndex) {
  const pos = parseRef(ref);
  if (!pos) throw new Error(`bad cell reference: ${ref}`);
  const p = detectPrefix(xml);
  const q = p ? p + ':' : '';

  let sdOpenEnd = -1, sdCloseStart = -1, depth = 0;
  for (const ev of scan(xml)) {
    if (ev.type === 'open' && ev.name === 'sheetData') {
      if (ev.selfClosing) {
        xml = splice(xml, ev.start, ev.end, `<${q}sheetData></${q}sheetData>`);
        return setCellStyle(xml, ref, styleIndex);
      }
      if (depth === 0) sdOpenEnd = ev.end;
      depth++;
    } else if (ev.type === 'close' && ev.name === 'sheetData') {
      depth--;
      if (depth === 0) { sdCloseStart = ev.start; break; }
    }
  }
  if (sdOpenEnd < 0) throw new Error('no sheetData element');
  const body = xml.slice(sdOpenEnd, sdCloseStart);

  let rowInnerStart = -1, rowInnerEnd = -1, insertRowAt = -1;
  for (const r of elements(body, 'row')) {
    const n = parseInt(r.attr('r') || '0', 10);
    if (n === pos.row) { rowInnerStart = r.innerStart; rowInnerEnd = r.innerEnd; break; }
    if (n > pos.row && insertRowAt < 0) { insertRowAt = r.start; break; }
  }
  if (rowInnerStart < 0) {
    const at = insertRowAt >= 0 ? sdOpenEnd + insertRowAt : sdCloseStart;
    return splice(xml, at, at, `<${q}row r="${pos.row}"><${q}c r="${ref}" s="${styleIndex}"/></${q}row>`);
  }

  const rowInner = body.slice(rowInnerStart, rowInnerEnd);
  const base = sdOpenEnd + rowInnerStart;
  let insertCellAt = -1;
  for (const c of elements(rowInner, 'c')) {
    const cr = c.attr('r');
    if (cr === ref) {
      // rewrite ONLY the s= attribute inside the existing start tag
      const openEnd = c.innerStart >= 0 ? c.innerStart : c.end;
      const head = xml.slice(base + c.start, base + openEnd);
      const withS = /\ss="\d+"/.test(head)
        ? head.replace(/\ss="\d+"/, ` s="${styleIndex}"`)
        : head.replace(/^(<[^\s/>]+)/, `$1 s="${styleIndex}"`);
      return splice(xml, base + c.start, base + openEnd, withS);
    }
    const cp = cr ? parseRef(cr) : null;
    if (cp && cp.col > pos.col && insertCellAt < 0) { insertCellAt = c.start; break; }
  }
  const at = insertCellAt >= 0 ? base + insertCellAt : sdOpenEnd + rowInnerEnd;
  return splice(xml, at, at, `<${q}c r="${ref}" s="${styleIndex}"/>`);
}

/** Escape a string for use as an inline <v>/<t> text node. */
export function xmlText(s) {
  return String(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/**
 * Build the inner XML for a cell from a plain value.
 * Strings are written INLINE rather than pushed into the shared string table:
 * appending to sharedStrings.xml would rewrite a part that every other sheet
 * points into, turning a one-cell edit into a whole-workbook diff.
 */
export function cellInner(value) {
  if (value === null || value === undefined || value === '') return { inner: null, type: 'n' };
  if (typeof value === 'boolean') return { inner: `<v>${value ? 1 : 0}</v>`, type: 'b' };
  if (typeof value === 'number') return { inner: `<v>${value}</v>`, type: 'n' };
  const s = String(value);
  if (s.startsWith('=')) return { inner: `<f>${xmlText(s.slice(1))}</f>`, type: 'n' };
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return { inner: `<v>${s}</v>`, type: 'n' };
  if (/^#(DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)$/.test(s)) return { inner: `<v>${s}</v>`, type: 'e' };
  return { inner: `<is><t>${xmlText(s)}</t></is>`, type: 'inlineStr' };
}
