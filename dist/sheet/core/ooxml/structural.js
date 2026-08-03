/* Grain — structural edits to a worksheet part.
 *
 * Expressing "insert a row" as thousands of individual cell writes is both
 * unbearably slow — each write rescans the part, so it is quadratic, and a
 * 3,000-cell sheet never finishes — and the wrong shape. The change is to the
 * SKELETON, not to the contents.
 *
 * So we renumber rows and cell references in one pass and leave everything
 * else exactly where it was: styles, spans, custom heights, and every element
 * we do not model.
 */

import { scan, elements, firstElement } from './xml.js';
import { detectPrefix } from './edit.js';
import { adjustReferences } from './refs.js';

const colToIdx = (t) => {
  let n = 0;
  for (const c of t.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};
const idxToCol = (n) => {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

/** Where an index lands, or null when the edit removes it. */
export function shiftIndex(i, op) {
  if (op.remove) {
    if (i >= op.at && i < op.at + op.count) return null;
    return i >= op.at + op.count ? i - op.count : i;
  }
  return i >= op.at ? i + op.count : i;
}

const MARK = 'DROP';   // a sentinel no XML can contain

/**
 * Apply an insert or delete of rows/columns to a worksheet part.
 * @param op { axis:'row'|'col', at (0-based), count, remove, sheet }
 */
export function applyStructural(xml, op) {
  const prefix = detectPrefix(xml);
  void prefix;

  let sdOpen = -1, sdClose = -1, depth = 0;
  for (const ev of scan(xml)) {
    if (ev.type === 'open' && ev.name === 'sheetData') {
      if (ev.selfClosing) return xml;
      if (depth === 0) sdOpen = ev.end;
      depth++;
    } else if (ev.type === 'close' && ev.name === 'sheetData') {
      depth--;
      if (depth === 0) { sdClose = ev.start; break; }
    }
  }
  if (sdOpen < 0) return xml;

  const body = xml.slice(sdOpen, sdClose);
  const kept = [];

  for (const row of elements(body, 'row')) {
    const rn = parseInt(row.attr('r') || '0', 10) - 1;
    const nextRow = shiftIndex(rn, op);
    if (op.axis === 'row' && nextRow === null) continue;           // row deleted

    let piece = body.slice(row.start, row.end);

    if (op.axis === 'row' && nextRow !== rn) {
      piece = piece.replace(/^(<[^>]*?\sr=")\d+(")/, '$1' + (nextRow + 1) + '$2');
    }

    // cell references
    piece = piece.replace(/(<(?:[\w.-]+:)?c\b[^>]*?\sr=")([A-Za-z]{1,3})(\d+)(")/g,
      (m, a, ct, rt, z) => {
        if (op.axis === 'col') {
          const nc = shiftIndex(colToIdx(ct), op);
          if (nc === null) return a + MARK + rt + z;
          return a + idxToCol(nc) + rt + z;
        }
        return a + ct + (nextRow + 1) + z;
      });

    // whole cells whose column was deleted
    if (piece.indexOf(MARK) >= 0) {
      piece = piece.replace(
        /<(?:[\w.-]+:)?c\b[^>]*?DROP[^>]*?(?:\/>|>[\s\S]*?<\/(?:[\w.-]+:)?c>)/g, '');
      piece = piece.split(MARK).join('');
    }

    // formulas follow the same rules as every other formula in the workbook
    piece = piece.replace(/(<(?:[\w.-]+:)?f\b[^>]*>)([\s\S]*?)(<\/(?:[\w.-]+:)?f>)/g,
      (m, a, f, z) => a + adjustReferences(f, { ...op, homeSheet: op.sheet }) + z);
    // a shared formula's range lives in an attribute, not in the text
    piece = piece.replace(/(<(?:[\w.-]+:)?f\b[^>]*?\sref=")([^"]+)(")/g,
      (m, a, refTxt, z) => a + adjustReferences(refTxt, { ...op, homeSheet: op.sheet }) + z);

    kept.push(piece);
  }

  let out = xml.slice(0, sdOpen) + kept.join('') + xml.slice(sdClose);

  // ---- merged ranges ----
  out = out.replace(/(<(?:[\w.-]+:)?mergeCell\b[^>]*\sref=")([^"]+)(")/g, (m, a, refTxt, z) => {
    const adj = adjustReferences(refTxt, { ...op, homeSheet: op.sheet });
    return adj.indexOf('#REF!') >= 0 ? MARK : a + adj + z;
  });
  if (out.indexOf(MARK) >= 0) {
    out = out.replace(/<(?:[\w.-]+:)?mergeCell\b[^>]*?DROP[^>]*?\/?>/g, '');
    out = out.split(MARK).join('');
  }

  // ---- column width spans ----
  if (op.axis === 'col') {
    out = out.replace(/(<(?:[\w.-]+:)?col\b[^>]*?\smin=")(\d+)("[^>]*?\smax=")(\d+)(")/g,
      (m, a, mn, mid, mx, z) => {
        const lo = shiftIndex(parseInt(mn, 10) - 1, op);
        const hi = shiftIndex(parseInt(mx, 10) - 1, op);
        if (lo === null && hi === null) return m;
        return a + ((lo === null ? op.at : lo) + 1) + mid + ((hi === null ? op.at : hi) + 1) + z;
      });
  }

  return out;
}

/* ---------------------------------------------------------------------------
 * Column widths and row heights.
 *
 * Widths are stored in CHARACTERS of the default font, not pixels, and as
 * SPANS (min..max) rather than one entry per column. Both facts have to be
 * undone on the way in and redone on the way out, or a resize is silently
 * lost the moment the user saves.
 * ------------------------------------------------------------------------ */

const MDW = 7;    // max digit width of Calibri 11 at 96dpi

/* The exact inverse of charsToPx below. A naive (px - 5) / MDW looks right
 * and is not: 59px round-trips to 54, so every save would shrink the columns
 * the user had just widened. */
export const pxToChars = (px) =>
  Math.round((((px * 256) / MDW - Math.trunc(128 / MDW)) / 256) * 100) / 100;
export const charsToPx = (w) => Math.trunc(((256 * w + Math.trunc(128 / MDW)) / 256) * MDW);

/**
 * Override the width of specific columns, leaving every other span exactly as
 * the file had it.
 *
 * Regenerating the whole <cols> element looks simpler and is wrong: each
 * width round-trips through the character-unit conversion, so a column the
 * user never touched comes back a pixel narrower. Do that on every save and
 * a workbook slowly shrinks.
 *
 * @param overrides Map<colIndex0, px>  ONLY the columns the user resized
 */
export function setColumnWidths(xml, overrides) {
  const prefix = detectPrefix(xml);
  const q = prefix ? prefix + ':' : '';
  const want = new Map([...overrides.entries()].filter(([i]) => i >= 0));
  if (!want.size) return xml;

  const colEl = (min, max, px) =>
    `<${q}col min="${min + 1}" max="${max + 1}" width="${pxToChars(px)}" customWidth="1"/>`;

  const existing = firstElement(xml, 'cols');
  const out = [];
  const handled = new Set();

  if (existing) {
    for (const c of elements(existing.inner(), 'col')) {
      const lo = parseInt(c.attr('min') || '1', 10) - 1;
      const hi = parseInt(c.attr('max') || '1', 10) - 1;
      const raw = existing.inner().slice(c.start, c.end);

      // Split the span around any column being overridden, so the untouched
      // parts keep their ORIGINAL text byte-for-byte.
      let cursor = lo;
      for (let i = lo; i <= hi; i++) {
        if (!want.has(i)) continue;
        if (i > cursor) out.push(raw.replace(/\smin="\d+"/, ` min="${cursor + 1}"`).replace(/\smax="\d+"/, ` max="${i}"`));
        out.push(colEl(i, i, want.get(i)));
        handled.add(i);
        cursor = i + 1;
      }
      if (cursor === lo) out.push(raw);                       // nothing overridden
      else if (cursor <= hi) out.push(raw.replace(/\smin="\d+"/, ` min="${cursor + 1}"`));
    }
  }

  // columns with no span in the file at all
  const extra = [...want.keys()].filter((i) => !handled.has(i)).sort((a, b) => a - b);
  for (const i of extra) out.push(colEl(i, i, want.get(i)));

  const block = `<${q}cols>${out.join('')}</${q}cols>`;
  if (existing) return xml.slice(0, existing.start) + block + xml.slice(existing.end);
  const sd = xml.indexOf(`<${q}sheetData`);
  if (sd < 0) return xml;
  return xml.slice(0, sd) + block + xml.slice(sd);
}

/** Set custom row heights on the <row> elements that already exist. */
export function setRowHeights(xml, heights) {
  if (!heights.size) return xml;
  return xml.replace(/<(?:[\w.-]+:)?row\b[^>]*>/g, (tag) => {
    const m = /\sr="(\d+)"/.exec(tag);
    if (!m) return tag;
    const px = heights.get(parseInt(m[1], 10) - 1);
    if (px === undefined) return tag;
    const pts = Math.round((px * 72 / 96) * 100) / 100;
    let out = tag;
    out = /\sht="[^"]*"/.test(out) ? out.replace(/\sht="[^"]*"/, ` ht="${pts}"`)
                                   : out.replace(/^(<[^\s/>]+)/, `$1 ht="${pts}"`);
    if (!/\scustomHeight="1"/.test(out)) out = out.replace(/^(<[^\s/>]+)/, '$1 customHeight="1"');
    return out;
  });
}
