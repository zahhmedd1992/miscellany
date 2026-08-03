/* Sheet — a view over the Grain node graph.
 *
 * Note what is NOT here: any notion of recalculation, dependency, or value
 * semantics. Those live in core/ and are shared with every other app. Sheet
 * only knows how to (a) turn A1 notation into node ids and (b) draw a grid.
 *
 * That split is the whole architectural claim. When Deck is built, it reuses
 * core/ untouched and supplies its own two answers.
 */

import { Graph } from '../../core/graph.js';
import { parse, evaluate, indexToCol, colToIndex } from '../../core/formula.js';
import { V, ERR, isErr, isBlank, toText } from '../../core/value.js';
import { Decimal } from '../../core/decimal.js';
import { formatGeneral } from '../../core/format.js';
import { formatValue, BUILTIN } from '../../core/numfmt.js';
import { drawChart } from './chartview.js';

export const SHEET = 'main';
export const COLS = 40;
export const ROWS = 500;

export const cellId = (col, row, sheet = SHEET) => `${sheet}!${indexToCol(col)}${row + 1}`;

/* ---- the reference expander ------------------------------------------
 * This is Sheet's answer to "what node ids does this reference name?".
 * The graph asks; it never assumes. */
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

/** The sheet a node id belongs to: "Land-Based Wind!S28" -> "Land-Based Wind".
 *  Ids without a '!' (a chart node, say) have no sheet. */
export function sheetOfId(id) {
  const i = String(id).indexOf('!');
  return i < 0 ? SHEET : id.slice(0, i);
}

export function makeGraph() {
  return new Graph({
    parse: (src, ctx) => parse(src, ctx),
    // The context comes from the CELL BEING EVALUATED, not a constant. Pinning
    // it to one sheet makes every bare reference on every other sheet resolve
    // to that sheet — 18,953 root disagreements in one corpus workbook, and
    // the single largest cause of a 19% agreement rate with Excel.
    evaluate: (ast, api) => evaluate(ast, api, api.ctx || { sheet: SHEET }),
    expand,
    contextOf: (id) => ({ sheet: sheetOfId(id) }),
  });
}

/* =======================================================================
 * GRID VIEW
 * ==================================================================== */

// Excel's default column width is 8.43 characters ~= 64px at Calibri 11.
// Ours was 108px, which stretched every sheet without explicit widths and
// made anchored charts far too wide, since their extent is measured in cells.
const CW = 64;           // default column width, matching Excel
const RH = 26;           // row height
const HW = 52;           // row-header width
const HH = 26;           // column-header height

const C = {
  bg:        '#FFFFFF',
  grid:      '#E3E0DA',
  gridStrong:'#CFCAC1',
  headBg:    '#F7F5F1',
  headText:  '#6C6356',
  headActive:'#EDE7DC',
  text:      '#211C16',
  err:       '#9A3B1B',
  sel:       '#9A3B1B',
  selFill:   'rgba(154,59,27,0.06)',
  formula:   '#2F5D3A',
};

/** Render a value through its number format, falling back to General.
 *
 * Built-in format ids (0-49) are NOT written into styles.xml, so a cell with
 * numFmtId 14 has no formatCode anywhere in the file. Looking only at
 * <numFmt> elements renders every date in the workbook as a raw serial. */
/** Greedy word wrap against a measured width. Falls back to breaking inside
 *  a word when a single word is wider than the cell. */
/** Does a number genuinely not fit its column?
 *
 * Judged on the TRIMMED width and with a tolerance. Accounting formats emit
 * padding spaces that are alignment, not content; and column widths were
 * authored against Calibri's digit metrics while we render Inter, so a few
 * percent of disagreement is our problem, not the file's. Without both, a
 * comfortable "1,478.0" renders as "######". */
export function numberOverflows(trimmedWidth, availWidth, tolerance = 1.06) {
  return trimmedWidth > availWidth * tolerance;
}

const MAX_WRAP_LINES = 500;

export function wrapText(ctx, text, maxW) {
  if (!(maxW > 0)) return [text];
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const probe = line + word;
      if (ctx.measureText(probe).width <= maxW || line === '') {
        line = probe;
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
      // Break inside an over-long word. `cut` is floored at 1 so `line`
      // strictly shrinks every pass; the length cap is a hard backstop
      // because this runs inside the repaint loop, where a spin freezes the
      // tab with no error at all — the worst failure shape available.
      while (ctx.measureText(line).width > maxW && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxW) cut--;
        if (cut < 1) cut = 1;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
        if (out.length > MAX_WRAP_LINES) { line = ''; break; }
      }
      if (out.length > MAX_WRAP_LINES) break;
    }
    out.push(line);
    if (out.length > MAX_WRAP_LINES) break;
  }
  return out;
}

function formatCell(v, code, meta) {
  if (v.k === 'number') {
    const c = code || (meta && meta.numFmtId ? BUILTIN[meta.numFmtId] : null);
    if (c && c !== 'General') return formatValue(v, c, { date1904: meta && meta.date1904 });
    return { text: formatGeneral(v.d), color: null, align: 'right' };
  }
  return formatValue(v, code, {});
}

export class Grid {
  constructor(canvas, graph, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.g = graph;
    this.onSelect = opts.onSelect || (() => {});
    this.onEdit = opts.onEdit || (() => {});

    this.colW = new Map();
    this.rowH = new Map();
    this.merges = [];
    this.charts = [];
    this.resolveRef = null;
    this.theme = null;
    this._mergeIndex = new Map();
    this._offX = null;
    this._resize = null;
    this.onResize = opts.onResize || null;
    this.sheet = SHEET;          // which sheet this view is showing
    this.sel = { col: 0, row: 0 };
    this.anchor = null;        // multi-cell selection anchor
    this.scrollX = 0;
    this.scrollY = 0;
    this.dpr = window.devicePixelRatio || 1;

    this._bind();
    this.resize();
    graph.onChange(() => this.draw());
  }

  width(col) { return this.colW.get(col) || this.colW.get(-1) || CW; }
  height(row) { return this.rowH.get(row) || RH; }

  /* Cumulative offsets, cached. Recomputing a prefix sum per cell turns a
   * 40-column repaint into 800 additions; with variable row heights it would
   * be far worse. Invalidated whenever a width or height changes. */
  _offsets() {
    if (this._offX) return;
    this._offX = new Float64Array(COLS + 1);
    for (let c = 0; c < COLS; c++) this._offX[c + 1] = this._offX[c] + this.width(c);
    this._offY = new Float64Array(ROWS + 1);
    for (let r = 0; r < ROWS; r++) this._offY[r + 1] = this._offY[r] + this.height(r);
  }
  invalidate() { this._offX = null; this._offY = null; }

  colX(col) { this._offsets(); return HW + this._offX[Math.min(col, COLS)] - this.scrollX; }
  rowY(row) { this._offsets(); return HH + this._offY[Math.min(row, ROWS)] - this.scrollY; }

  /** Row index at a pixel offset, honouring variable heights. */
  rowAt(py) {
    this._offsets();
    const y = py - HH + this.scrollY;
    let lo = 0, hi = ROWS;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this._offY[m + 1] <= y) lo = m + 1; else hi = m; }
    return lo >= ROWS ? -1 : lo;
  }

  /** The merge covering a cell, or null. Anchor is {c0,r0}. */
  mergeAt(col, row) {
    const key = this._mergeIndex && this._mergeIndex.get(row * 16384 + col);
    return key === undefined ? null : key;
  }

  /** Charts anchored on this sheet: [{frame, spec}]. */
  setCharts(list) { this.charts = list || []; }

  /** An anchor's pixel box, from its cell coordinates. */
  chartBox(f) {
    const EMU = 9525;
    if (f.from && f.to) {
      const x0 = this.colX(f.from.col) + Math.round((f.from.colOff || 0) / EMU);
      const y0 = this.rowY(f.from.row) + Math.round((f.from.rowOff || 0) / EMU);
      const x1 = this.colX(f.to.col) + Math.round((f.to.colOff || 0) / EMU);
      const y1 = this.rowY(f.to.row) + Math.round((f.to.rowOff || 0) / EMU);
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    if (f.from) {
      const x0 = this.colX(f.from.col) + Math.round((f.from.colOff || 0) / EMU);
      const y0 = this.rowY(f.from.row) + Math.round((f.from.rowOff || 0) / EMU);
      return { x: x0, y: y0, w: f.w || 480, h: f.h || 300 };
    }
    // absoluteAnchor: pinned to the sheet origin, not to any cell
    return { x: HW + (f.x || 0) - this.scrollX, y: HH + (f.y || 0) - this.scrollY,
             w: f.w || 480, h: f.h || 300 };
  }

  setMerges(list) {
    this.merges = list || [];
    this._mergeIndex = new Map();
    for (const m of this.merges) {
      for (let r = m.r0; r <= m.r1; r++)
        for (let c = m.c0; c <= m.c1; c++) this._mergeIndex.set(r * 16384 + c, m);
    }
  }

  /** A column or row border under the pointer, within a few pixels.
   *  Returns {axis:'col'|'row', index} or null. */
  resizeAt(px, py) {
    const G = 4;
    if (py < HH && px >= HW) {                     // column header strip
      this._offsets();
      const x = px - HW + this.scrollX;
      let lo = 0, hi = COLS;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this._offX[m + 1] <= x) lo = m + 1; else hi = m; }
      const col = Math.min(lo, COLS - 1);
      // near the RIGHT edge of `col`, or the right edge of the one before
      if (Math.abs(this._offX[col + 1] - x) <= G) return { axis: 'col', index: col };
      if (col > 0 && Math.abs(this._offX[col] - x) <= G) return { axis: 'col', index: col - 1 };
      return null;
    }
    if (px < HW && py >= HH) {                     // row header strip
      const row = this.rowAt(py);
      if (row < 0) return null;
      this._offsets();
      const y = py - HH + this.scrollY;
      if (Math.abs(this._offY[row + 1] - y) <= G) return { axis: 'row', index: row };
      if (row > 0 && Math.abs(this._offY[row] - y) <= G) return { axis: 'row', index: row - 1 };
      return null;
    }
    return null;
  }

  setWidth(col, px) {
    this.colW.set(col, Math.max(16, Math.round(px)));
    this.invalidate();
  }
  setHeight(row, px) {
    this.rowH.set(row, Math.max(10, Math.round(px)));
    this.invalidate();
  }

  /** Widest rendered text in a column, for double-click auto-fit. */
  autoFit(col) {
    const x = this.ctx;
    let w = 24;
    const firstRow = Math.max(0, this.rowAt(HH + 1));
    const last = Math.min(ROWS - 1, firstRow + 400);
    for (let r = firstRow; r <= last; r++) {
      const n = this.g.nodes.get(cellId(col, r, this.sheet));
      if (!n || (isBlank(n.value) && !n.raw)) continue;
      const meta = n.meta || null;
      const st = meta && meta.style;
      const font = st && st.font;
      const size = font && font.size ? Math.round(font.size * 1.18) : 13;
      x.font = (font && font.bold ? '600 ' : '') + size + 'px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      const res = formatCell(n.value, meta ? meta.numFmt : null, meta);
      w = Math.max(w, x.measureText(res.text).width + 16);
    }
    return Math.min(600, Math.ceil(w));
  }

  hit(px, py) {
    if (px < HW || py < HH) return null;
    this._offsets();
    const x = px - HW + this.scrollX;
    let lo = 0, hi = COLS;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this._offX[m + 1] <= x) lo = m + 1; else hi = m; }
    const col = lo >= COLS ? -1 : lo;
    const row = this.rowAt(py);
    if (col < 0 || row < 0) return null;
    return { col, row };
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    this.cv.width = Math.floor(r.width * this.dpr);
    this.cv.height = Math.floor(r.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.vw = r.width;
    this.vh = r.height;
    this.draw();
  }

  /* ---- selection ---- */

  select(col, row, extend = false) {
    col = Math.max(0, Math.min(COLS - 1, col));
    row = Math.max(0, Math.min(ROWS - 1, row));
    if (extend) { if (!this.anchor) this.anchor = { ...this.sel }; }
    else this.anchor = null;
    this.sel = { col, row };
    this.scrollIntoView();
    this.draw();
    this.onSelect(this.sel);
  }

  selRect() {
    if (!this.anchor) return { c0: this.sel.col, c1: this.sel.col, r0: this.sel.row, r1: this.sel.row };
    return {
      c0: Math.min(this.anchor.col, this.sel.col), c1: Math.max(this.anchor.col, this.sel.col),
      r0: Math.min(this.anchor.row, this.sel.row), r1: Math.max(this.anchor.row, this.sel.row),
    };
  }

  scrollIntoView() {
    const x = this.colX(this.sel.col), w = this.width(this.sel.col);
    if (x < HW) this.scrollX -= HW - x;
    else if (x + w > this.vw) this.scrollX += x + w - this.vw;
    const y = this.rowY(this.sel.row), h = this.height(this.sel.row);
    if (y < HH) this.scrollY -= HH - y;
    else if (y + h > this.vh) this.scrollY += y + h - this.vh;
    this.scrollX = Math.max(0, this.scrollX);
    this.scrollY = Math.max(0, this.scrollY);
  }

  /* ---- drawing ---- */

  draw() {
    const x = this.ctx;
    if (!this.vw) return;
    this._offsets();
    x.fillStyle = C.bg;
    x.fillRect(0, 0, this.vw, this.vh);

    // visible span
    let firstCol = 0;
    { const xs = this.scrollX; let lo = 0, hi = COLS;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this._offX[m + 1] <= xs) lo = m + 1; else hi = m; }
      firstCol = Math.min(lo, COLS - 1); }
    const fr = this.rowAt(HH + 1);
    const firstRow = fr < 0 ? 0 : fr;
    let lastRow = firstRow;
    while (lastRow < ROWS - 1 && this.rowY(lastRow) < this.vh) lastRow++;

    const sr = this.selRect();
    const G = this.g, sheet = this.sheet;
    const nodeAt = (c, r) => G.nodes.get(cellId(c, r, sheet));

    // Cells covered by a merge are painted by their anchor, so skip them.
    const skip = (c, r) => {
      const m = this.mergeAt(c, r);
      return !!m && !(m.c0 === c && m.r0 === r);
    };
    const spanOf = (c, r) => {
      const m = this.mergeAt(c, r);
      if (!m || m.c0 !== c || m.r0 !== r) return null;
      let w = 0, h = 0;
      for (let i = m.c0; i <= m.c1; i++) w += this.width(i);
      for (let i = m.r0; i <= m.r1; i++) h += this.height(i);
      return { w, h };
    };

    /* ---- pass 1: fills ---- */
    for (let r = firstRow; r <= lastRow; r++) {
      const cy = this.rowY(r);
      for (let c = firstCol; c < COLS; c++) {
        const cx = this.colX(c);
        if (cx > this.vw) break;
        if (skip(c, r)) continue;
        const n = nodeAt(c, r);
        const st = n && n.meta && n.meta.style;
        if (!st || !st.fill || !st.fill.color) continue;
        const sp = spanOf(c, r);
        x.fillStyle = st.fill.color;
        x.fillRect(cx, cy, sp ? sp.w : this.width(c), sp ? sp.h : this.height(r));
      }
    }

    /* ---- pass 2: selection wash, over fills and under text ---- */
    x.fillStyle = C.selFill;
    for (let r = sr.r0; r <= sr.r1; r++) {
      for (let c = sr.c0; c <= sr.c1; c++) {
        const cx = this.colX(c), cy = this.rowY(r);
        if (cx > this.vw || cy > this.vh) continue;
        x.fillRect(cx, cy, this.width(c), this.height(r));
      }
    }

    /* ---- pass 3: default gridlines ---- */
    x.strokeStyle = C.grid;
    x.lineWidth = 1;
    x.beginPath();
    for (let c = firstCol; c <= COLS; c++) {
      const cx = this.colX(c);
      if (cx > this.vw) break;
      x.moveTo(Math.floor(cx) + 0.5, HH);
      x.lineTo(Math.floor(cx) + 0.5, this.vh);
    }
    for (let r = firstRow; r <= lastRow + 1; r++) {
      const cy = this.rowY(r);
      x.moveTo(HW, Math.floor(cy) + 0.5);
      x.lineTo(this.vw, Math.floor(cy) + 0.5);
    }
    x.stroke();

    /* ---- pass 4: explicit cell borders, over the default grid ---- */
    for (let r = firstRow; r <= lastRow; r++) {
      const cy = this.rowY(r), h = this.height(r);
      for (let c = firstCol; c < COLS; c++) {
        const cx = this.colX(c);
        if (cx > this.vw) break;
        const n = nodeAt(c, r);
        const b = n && n.meta && n.meta.style && n.meta.style.border;
        if (!b) continue;
        const w = this.width(c);
        const edge = (e, x1, y1, x2, y2) => {
          if (!e) return;
          x.strokeStyle = e.color || '#000';
          x.lineWidth = /thick|double/.test(e.style) ? 2 : /medium/.test(e.style) ? 1.5 : 1;
          x.beginPath();
          x.moveTo(Math.floor(x1) + 0.5, Math.floor(y1) + 0.5);
          x.lineTo(Math.floor(x2) + 0.5, Math.floor(y2) + 0.5);
          x.stroke();
        };
        edge(b.top, cx, cy, cx + w, cy);
        edge(b.bottom, cx, cy + h, cx + w, cy + h);
        edge(b.left, cx, cy, cx, cy + h);
        edge(b.right, cx + w, cy, cx + w, cy + h);
      }
    }

    /* ---- pass 5: text ---- */
    x.textBaseline = 'middle';
    for (let r = firstRow; r <= lastRow; r++) {
      const cy = this.rowY(r), rh = this.height(r);
      for (let c = firstCol; c < COLS; c++) {
        const cx = this.colX(c);
        if (cx > this.vw) break;
        if (skip(c, r)) continue;
        const n = nodeAt(c, r);
        if (!n || (isBlank(n.value) && !n.raw)) continue;

        const meta = n.meta || null;
        const st = meta && meta.style;
        const res = formatCell(n.value, meta ? meta.numFmt : null, meta);
        if (!res.text) continue;

        const sp = spanOf(c, r);
        const cw = sp ? sp.w : this.width(c);
        const h = sp ? sp.h : rh;
        const font = st && st.font;
        const size = font && font.size ? Math.round(font.size * 1.18) : 13;
        x.font = (font && font.italic ? 'italic ' : '') + (font && font.bold ? '600 ' : '') +
                 size + 'px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
        x.fillStyle = res.color || (font && font.color) || C.text;

        let align = (st && st.align && st.align.h) || res.align || 'left';
        if (align === 'general') align = res.align || 'left';
        const pad = 7 + (st && st.align && st.align.indent ? st.align.indent * 8 : 0);
        const wrap = !!(st && st.align && st.align.wrap);

        /* ---- wrapped text: stack lines inside the cell ---- */
        if (wrap && !sp) {
          const lines = wrapText(x, res.text, cw - pad * 2);
          const lh = size * 1.25;
          const total = lines.length * lh;
          const vAlign = (st && st.align && st.align.v) || 'bottom';
          let ty = vAlign === 'center' ? cy + h / 2 - total / 2 + lh / 2
                 : vAlign === 'top' ? cy + 4 + lh / 2
                 : cy + h - total + lh / 2 - 3;
          x.save();
          x.beginPath(); x.rect(cx + 1, cy + 1, cw - 2, h - 2); x.clip();
          for (const line of lines) {
            if (align === 'right') { x.textAlign = 'right'; x.fillText(line, cx + cw - pad, ty); }
            else if (align === 'center') { x.textAlign = 'center'; x.fillText(line, cx + cw / 2, ty); }
            else { x.textAlign = 'left'; x.fillText(line, cx + pad, ty); }
            ty += lh;
          }
          x.restore();
          continue;
        }

        /* ---- overflow into adjacent EMPTY cells ----
         * Excel lets long text spill sideways as long as the neighbour is
         * empty, and clips the moment it is not. Without this a title in a
         * narrow column reads "New Privately-Owned Hous" — the file is fine,
         * the render is lying about it. Numbers never overflow: they become
         * ##### instead, because a truncated number is a wrong number. */
        let clipX = cx, clipW = cw;
        const isNumeric = n.value.k === 'number';
        const tw = x.measureText(res.text).width;
        // Fit is judged on the TRIMMED text and with a tolerance.
        //   - Accounting formats (_(* #,##0.0_) ) emit leading and trailing
        //     padding spaces. That padding is alignment, not content, and
        //     counting it turned a comfortable "1,478.0" into "######".
        //   - Column widths were authored against Calibri's digit metrics;
        //     we render Inter. A few percent of disagreement is our problem,
        //     not the file's, so a marginal overrun clips rather than blanks.
        const fitW = x.measureText(res.text.trim()).width;
        const avail = cw - pad * 2;
        const tooWide = numberOverflows(fitW, avail);
        if (!sp && tw > avail && !isNumeric) {
          if (align !== 'right') {
            for (let k = c + 1; k < COLS && clipW < tw + pad * 2; k++) {
              const nb = nodeAt(k, r);
              if ((nb && (!isBlank(nb.value) || nb.raw)) || skip(k, r)) break;
              clipW += this.width(k);
            }
          }
          if (align !== 'left') {
            for (let k = c - 1; k >= 0 && clipW < tw + pad * 2; k--) {
              const nb = nodeAt(k, r);
              if ((nb && (!isBlank(nb.value) || nb.raw)) || skip(k, r)) break;
              const w2 = this.width(k);
              clipX -= w2; clipW += w2;
            }
          }
        }

        x.save();
        x.beginPath();
        x.rect(clipX + 1, cy + 1, clipW - 2, h - 2);
        x.clip();
        // A number too wide for its column is shown as #### — Excel's rule,
        // and the right one: silently dropping digits changes the value.
        const text = (isNumeric && tooWide && cw > 16)
          ? '#'.repeat(Math.max(1, Math.floor(avail / (size * 0.55))))
          : res.text;
        if (align === 'right') { x.textAlign = 'right'; x.fillText(text, cx + cw - pad, cy + h / 2); }
        else if (align === 'center') { x.textAlign = 'center'; x.fillText(text, cx + cw / 2, cy + h / 2); }
        else { x.textAlign = 'left'; x.fillText(text, cx + pad, cy + h / 2); }
        x.restore();
      }
    }

    /* ---- pass 6: headers ---- */
    x.fillStyle = C.headBg;
    x.fillRect(0, 0, this.vw, HH);
    x.fillRect(0, 0, HW, this.vh);
    x.strokeStyle = C.gridStrong;
    x.beginPath();
    x.moveTo(0, HH + 0.5); x.lineTo(this.vw, HH + 0.5);
    x.moveTo(HW + 0.5, 0);  x.lineTo(HW + 0.5, this.vh);
    x.stroke();

    x.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    x.textAlign = 'center';
    for (let c = firstCol; c < COLS; c++) {
      const cx = this.colX(c);
      if (cx > this.vw) break;
      const w = this.width(c);
      const active = c >= sr.c0 && c <= sr.c1;
      if (active) { x.fillStyle = C.headActive; x.fillRect(cx, 0, w, HH); }
      x.fillStyle = active ? C.text : C.headText;
      x.fillText(indexToCol(c), cx + w / 2, HH / 2);
      x.strokeStyle = C.grid;
      x.beginPath(); x.moveTo(Math.floor(cx) + 0.5, 0); x.lineTo(Math.floor(cx) + 0.5, HH); x.stroke();
    }
    for (let r = firstRow; r <= lastRow; r++) {
      const cy = this.rowY(r), h = this.height(r);
      const active = r >= sr.r0 && r <= sr.r1;
      if (active) { x.fillStyle = C.headActive; x.fillRect(0, cy, HW, h); }
      x.fillStyle = active ? C.text : C.headText;
      // A 6pt spacer row cannot hold an 11px label; drop it rather than
      // overprint the neighbours.
      if (h >= 14) x.fillText(String(r + 1), HW / 2, cy + h / 2);
      x.strokeStyle = C.grid;
      x.beginPath(); x.moveTo(0, Math.floor(cy) + 0.5); x.lineTo(HW, Math.floor(cy) + 0.5); x.stroke();
    }

    /* ---- pass 7: charts, over the grid and under the selection ----
     * Series are resolved through the graph, so a chart shows what the
     * spreadsheet says NOW rather than what was cached when the file was
     * last saved. That is the same dependency walk that updates =SUM(). */
    if (this.charts && this.charts.length && this.resolveRef) {
      for (const c of this.charts) {
        const b = this.chartBox(c.frame);
        if (b.x > this.vw || b.y > this.vh || b.x + b.w < HW || b.y + b.h < HH) continue;
        x.save();
        x.beginPath(); x.rect(HW, HH, this.vw - HW, this.vh - HH); x.clip();
        try { drawChart(x, c.spec, b, this.resolveRef, this.theme); }
        catch (e) { console.error('[grain] chart draw failed', e); }
        x.restore();
      }
    }

    /* ---- pass 8: selection outline ---- */
    const sx = this.colX(sr.c0), sy = this.rowY(sr.r0);
    let sw = 0; for (let c = sr.c0; c <= sr.c1; c++) sw += this.width(c);
    let sh = 0; for (let r = sr.r0; r <= sr.r1; r++) sh += this.height(r);
    x.save();
    x.beginPath(); x.rect(HW, HH, this.vw - HW, this.vh - HH); x.clip();
    x.strokeStyle = C.sel;
    x.lineWidth = 2;
    x.strokeRect(Math.floor(sx) + 1, Math.floor(sy) + 1, sw - 1, sh - 1);
    x.restore();
  }

  /* ---- input ---- */

  _bind() {
    const cv = this.cv;

    cv.addEventListener('mousedown', (e) => {
      const r = cv.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;

      const edge = this.resizeAt(px, py);
      if (edge) {
        this._resize = {
          ...edge,
          start: edge.axis === 'col' ? px : py,
          was: edge.axis === 'col' ? this.width(edge.index) : this.height(edge.index),
        };
        return;
      }

      // Clicking a header selects the whole column or row.
      if (py < HH && px >= HW) {
        const h2 = this.hit(px, HH + 1);
        if (h2) { this.anchor = { col: h2.col, row: 0 }; this.sel = { col: h2.col, row: ROWS - 1 };
                  this.draw(); this.onSelect(this.sel); }
        return;
      }
      if (px < HW && py >= HH) {
        const row = this.rowAt(py);
        if (row >= 0) { this.anchor = { col: 0, row }; this.sel = { col: COLS - 1, row };
                        this.draw(); this.onSelect(this.sel); }
        return;
      }

      const h = this.hit(px, py);
      if (!h) return;
      this.select(h.col, h.row, e.shiftKey);
      this._dragging = true;
    });

    cv.addEventListener('dblclick', (e) => {
      const r = cv.getBoundingClientRect();
      const edge = this.resizeAt(e.clientX - r.left, e.clientY - r.top);
      if (edge && edge.axis === 'col') {
        this.setWidth(edge.index, this.autoFit(edge.index));
        this.draw();
        if (this.onResize) this.onResize('col', edge.index, this.width(edge.index));
      }
    });

    cv.addEventListener('mousemove', (e) => {
      if (this._dragging || this._resize) return;
      const r = cv.getBoundingClientRect();
      cv.style.cursor = this.resizeAt(e.clientX - r.left, e.clientY - r.top)
        ? (this.resizeAt(e.clientX - r.left, e.clientY - r.top).axis === 'col' ? 'col-resize' : 'row-resize')
        : 'cell';
    });

    window.addEventListener('mousemove', (e) => {
      if (this._resize) {
        const r = cv.getBoundingClientRect();
        const now = this._resize.axis === 'col' ? e.clientX - r.left : e.clientY - r.top;
        const next = this._resize.was + (now - this._resize.start);
        if (this._resize.axis === 'col') this.setWidth(this._resize.index, next);
        else this.setHeight(this._resize.index, next);
        this.draw();
        return;
      }
      if (!this._dragging) return;
      const r = cv.getBoundingClientRect();
      const h = this.hit(e.clientX - r.left, e.clientY - r.top);
      if (h && (h.col !== this.sel.col || h.row !== this.sel.row)) {
        if (!this.anchor) this.anchor = { ...this.sel };
        this.sel = h;
        this.draw();
        this.onSelect(this.sel);
      }
    });
    window.addEventListener('mouseup', () => {
      this._dragging = false;
      if (this._resize) {
        const r = this._resize; this._resize = null;
        if (this.onResize) {
          this.onResize(r.axis, r.index,
            r.axis === 'col' ? this.width(r.index) : this.height(r.index));
        }
      }
    });

    cv.addEventListener('dblclick', () => this.onEdit(this.sel, true));

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.scrollY = Math.max(0, Math.min(ROWS * RH - this.vh + HH, this.scrollY + e.deltaY));
      this.scrollX = Math.max(0, this.scrollX + e.deltaX);
      this.draw();
    }, { passive: false });

    window.addEventListener('resize', () => this.resize());
  }

  handleKey(e) {
    const k = e.key;
    const shift = e.shiftKey;
    const s = this.sel;

    switch (k) {
      case 'ArrowUp':    this.select(s.col, s.row - 1, shift); return true;
      case 'ArrowDown':  this.select(s.col, s.row + 1, shift); return true;
      case 'ArrowLeft':  this.select(s.col - 1, s.row, shift); return true;
      case 'ArrowRight': this.select(s.col + 1, s.row, shift); return true;
      case 'Tab':        e.preventDefault(); this.select(s.col + (shift ? -1 : 1), s.row); return true;
      case 'Enter':      this.onEdit(this.sel, true); return true;
      case 'F2':         this.onEdit(this.sel, true); return true;
      case 'Home':       this.select(0, s.row); return true;
      case 'PageDown':   this.select(s.col, s.row + 20); return true;
      case 'PageUp':     this.select(s.col, s.row - 20); return true;
      case 'Delete':
      case 'Backspace': {
        const r = this.selRect();
        for (let row = r.r0; row <= r.r1; row++)
          for (let col = r.c0; col <= r.c1; col++)
            this.g.set(cellId(col, row, this.sheet), '');
        this.draw();
        return true;
      }
    }

    // A printable character starts editing, replacing content — the
    // behaviour every spreadsheet user already has in their fingers.
    //
    // preventDefault is load-bearing: beginEdit() focuses the overlay input,
    // and without this the browser ALSO delivers this same keystroke to it,
    // so typing "200000" lands as "2200000". Silent, and only visible if you
    // actually read the resulting number.
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.onEdit(this.sel, false, k);
      return true;
    }
    return false;
  }
}
