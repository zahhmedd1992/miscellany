/* Doc - the editing surface.
 *
 * A page of paper on a canvas, with a caret and a selection this file owns
 * outright. It does NOT use contenteditable, and that is a deliberate refusal
 * rather than a preference: contenteditable is the browser's model of what a
 * document is, complete with its own opinions about what Enter does, what
 * paste means, and which of your elements it may rewrite. Adopting it would
 * put every later decision downstream of somebody else's analysis, which is
 * the one rule this project does not bend. Sheet draws its own grid and Deck
 * draws its own slides for the same reason.
 *
 * What that costs, honestly: a caret, a selection, hit-testing, and keyboard
 * handling all have to be written. What it buys is that the document on
 * screen is the document in the graph, laid out by our own engine with the
 * metrics the PDF will use - so the page you are looking at is the page that
 * prints, and no browser is in a position to disagree.
 *
 * Text still ARRIVES through a hidden textarea, because that is the only way
 * to receive an IME composition, an autocorrect, or a phone keyboard. It is
 * an input pipe, never a document.
 */

import { layout, DEFAULT_PAGE, pageBox, STYLES, paraProps, SOFT_BREAK, countWords }
  from '../../core/text/layout.js';
import { drawPage, drawPaper, offsetAtX, xAtOffset, lineRange } from '../../core/text/render.js';
import { drawChart } from '../sheet/chartview.js';
/* Doc does not have its own chart renderer, and does not have its own idea of
 * what a chart bound to a range IS. It builds the spec Deck builds and hands
 * it to the renderer Sheet uses. Three apps, one chart. */
import { chartSpecFor, liveResolver } from '../deck/deck.js';
import {
  readBlocks, blockIds, paraOf, setPara, fieldResolver, pageSetup,
  insertRuns, deleteRuns, packRuns, ownerOf, removeBlock, pruneFields,
  keyBetween, bodyId, keyOf, isBodyId,
} from './model.js';

const PAGE_GAP = 22;

export class DocView {
  /**
   * @param scroller the scrolling element
   * @param canvas   the canvas painted into
   * @param host     the shell's pane host
   */
  constructor(scroller, canvas, spacer, input, host) {
    this.scroller = scroller;
    this.cv = canvas;
    this.spacer = spacer;
    this.input = input;
    this.host = host;
    this.doc = host.doc;

    this.zoom = 1;                       // css px per point
    this.caret = null;                   // { id, off }
    this.anchor = null;                  // selection anchor, same shape
    this.wantX = null;                   // remembered column for up/down
    this.blocks = [];
    this.order = [];
    this.pages = [];
    this.images = {};
    this.focusRing = false;

    this._onScroll = () => this.draw();
    this.scroller.addEventListener('scroll', this._onScroll, { passive: true });

    /* The document changed - by our own edit, by Undo, or by somebody
     * editing a cell in the Sheet pane that a field on page 3 reads. All
     * three are the same event, which is the whole point of the node graph.
     * This handler only READS: writing from a change listener re-enters
     * recalculation and the graph refuses it. */
    /* Broken lines, kept between layouts and thrown away per node. The graph
     * tells us exactly which nodes changed, so a keystroke invalidates one
     * paragraph — including when what changed is a FIELD, whose owner is the
     * paragraph that displays it. */
    this._lineCache = new Map();
    /* Note what changed and repaint. It does NOT lay out here: after() runs
     * immediately afterwards for our own edits, and laying out in both places
     * did the whole document twice per keystroke. draw() lays out if it still
     * needs to, which covers a change that came from another pane. */
    this._off = this.doc.onChange((ids) => {
      for (const id of ids || []) this.invalidate(id);
      this.dirty = true;
      if (!this._editing) this.draw();
    });

    this._blink = setInterval(() => {
      if (document.activeElement !== this.input) return;
      this.caretOn = !this.caretOn;
      this.drawCaretOnly();
    }, 530);
    this.caretOn = true;

    this._bindMouse();
    this._bindInput();
    this.relayout();
  }

  /** Drop the cached line breaking for a node and whatever contains it. */
  invalidate(id) {
    this._lineCache.delete(id);
    const owner = ownerOf(id);
    if (owner && owner !== id) this._lineCache.delete(owner);
  }

  dispose() {
    clearInterval(this._blink);
    this.scroller.removeEventListener('scroll', this._onScroll);
    if (this._off) this._off();
    for (const [, fn] of this._docListeners || []) fn();
  }

  /* ---- layout ---------------------------------------------------------- */

  relayout() {
    this.blocks = readBlocks(this.doc);
    this.order = blockIds(this.doc);
    const page = { ...DEFAULT_PAGE, ...pageSetup(this.doc) };
    this.pageSpec = page;
    this.box = pageBox(page);
    const out = layout(this.blocks, page,
      { resolve: fieldResolver(this.doc), cache: this._lineCache });
    /* Counted here, once. Both the pane header and the status bar want it,
     * and walking every paragraph twice more per keystroke is most of what a
     * long document costs. */
    this.counts = countWords(this.blocks);
    this.pages = out.pages;
    this.content = out.content;
    this.dirty = false;

    // Where each page sits in the scroll space, in points.
    this.pageTops = [];
    let y = PAGE_GAP;
    for (let i = 0; i < this.pages.length; i++) {
      this.pageTops.push(y);
      y += this.box.h + PAGE_GAP;
    }
    this.totalHeight = y;
    this.spacer.style.height = Math.round(this.totalHeight * this.zoom) + 'px';

    if (!this.caret || !this.findLine(this.caret)) {
      const first = this.blocks.find((b) => b.kind === 'para');
      this.caret = first ? { id: first.id, off: 0 } : null;
      this.anchor = null;
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.scroller.clientWidth;
    const h = this.scroller.clientHeight;
    if (!w || !h) return;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.cv.style.width = w + 'px';
    this.cv.style.height = h + 'px';
    this.dpr = dpr;
    this.fitZoom();
    this.draw();
  }

  /** Fit the page to the pane, but never blow it up past 100 %. */
  fitZoom() {
    if (this.zoomLocked) return;
    const avail = this.scroller.clientWidth - 40;
    this.zoom = Math.max(0.35, Math.min(1.25, avail / this.box.w));
    this.spacer.style.height = Math.round(this.totalHeight * this.zoom) + 'px';
  }

  setZoom(z) {
    this.zoomLocked = true;
    this.zoom = Math.max(0.25, Math.min(3, z));
    this.spacer.style.height = Math.round(this.totalHeight * this.zoom) + 'px';
    this.draw();
  }

  /* ---- painting -------------------------------------------------------- */

  draw() {
    if (this.dirty) this.relayout();
    const ctx = this.cv.getContext('2d');
    if (!ctx || !this.cv.width) return;
    const dpr = this.dpr || 1;
    const z = this.zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    ctx.fillStyle = '#EDE9E1';
    ctx.fillRect(0, 0, this.cv.width, this.cv.height);

    const scroll = this.scroller.scrollTop / z;
    const viewH = this.cv.height / dpr / z;
    const sel = this.selectionRange();
    // Paper sits in the middle of the desk when there is room for it to.
    this.padX = Math.max(0, (this.cv.width / dpr / z - this.box.w) / 2);

    for (let i = 0; i < this.pages.length; i++) {
      const top = this.pageTops[i];
      if (top + this.box.h < scroll - 8 || top > scroll + viewH + 8) continue;
      ctx.setTransform(dpr * z, 0, 0, dpr * z, this.padX * z * dpr, -(scroll * z) * dpr);
      ctx.translate(0, top);

      // paper and its shadow
      ctx.fillStyle = 'rgba(33,28,22,0.10)';
      ctx.fillRect(2, 3, this.box.w, this.box.h);
      drawPaper(ctx, this.box, { edgeColor: '#DDD7CC' });

      if (sel) this.paintSelection(ctx, this.pages[i], sel);
      drawPage(ctx, this.pages[i], {
        images: this.images,
        chart: (c, item) => this.paintChart(c, item),
        fieldColor: '#EDF2F7',
      });
      this.paintPageNumberChip(ctx, i);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawCaretOnly();
  }

  paintChart(ctx, item) {
    const o = item.spec || {};
    const node = this.doc.node(item.blockId, true);
    drawChart(ctx, chartSpecFor(node, o), { x: item.x, y: item.y, w: item.w, h: item.h },
      liveResolver(this.doc, item.blockId, o), null);
  }

  paintSelection(ctx, page, sel) {
    ctx.fillStyle = 'rgba(37,80,110,0.20)';
    for (const line of page.lines) {
      const bi = this.orderIndex(line.blockId);
      if (bi < sel.fromIdx || bi > sel.toIdx) continue;
      const r = lineRange(line);
      let a = bi === sel.fromIdx ? Math.max(sel.fromOff, r.start) : r.start;
      let b = bi === sel.toIdx ? Math.min(sel.toOff, r.end) : r.end;
      if (b < a) continue;
      if (a === b && !(bi > sel.fromIdx && bi < sel.toIdx)) {
        if (!(sel.fromIdx !== sel.toIdx && (bi === sel.fromIdx || bi === sel.toIdx))) continue;
      }
      const x0 = xAtOffset(line, a);
      const x1 = xAtOffset(line, b);
      const left = x0 === null ? line.x : x0;
      const right = x1 === null ? line.x + (line.width || 0) : x1;
      const w = Math.max(right - left, bi > sel.fromIdx || b > a ? 2 : 0);
      if (w <= 0) continue;
      ctx.fillRect(left, line.y, w, line.height);
    }
  }

  paintPageNumberChip(ctx, i) {
    ctx.fillStyle = '#9A9384';
    ctx.font = '7pt Arial, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${i + 1} / ${this.pages.length}`, this.box.w - 46, this.box.h + 13);
  }

  /** The caret is painted on every blink, so it is separate from the page. */
  drawCaretOnly() {
    if (!this._caretLayer) return;
    const c = this._caretLayer;
    const g = c.getContext('2d');
    const dpr = this.dpr || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    if (!this.caret || !this.caretOn) return;
    if (document.activeElement !== this.input) return;
    if (this.anchor && this.selectionRange() && !this.collapsed()) return;
    const pos = this.caretRect();
    if (!pos) return;
    const z = this.zoom;
    const scroll = this.scroller.scrollTop / z;
    g.setTransform(dpr * z, 0, 0, dpr * z, (this.padX || 0) * z * dpr, -(scroll * z) * dpr);
    g.fillStyle = '#25506E';
    g.fillRect(pos.x, pos.y, Math.max(1 / z, 1.1), pos.h);
  }

  /* ---- positions ------------------------------------------------------- */

  orderIndex(id) {
    const own = ownerOf(id) || id;
    const i = this.order.indexOf(own);
    // A cell or a synthetic row sorts with its table, then by its own id.
    return i < 0 ? this.order.length : i + (id === own ? 0 : 0.5);
  }

  /** Every line belonging to a block, in order. */
  linesOf(id) {
    const out = [];
    for (const p of this.pages) for (const l of p.lines) if (l.blockId === id) out.push(l);
    return out;
  }

  findLine(caret) {
    const lines = this.linesOf(caret.id);
    if (!lines.length) return null;
    for (const l of lines) {
      const r = lineRange(l);
      if (caret.off >= r.start && caret.off <= r.end) return l;
    }
    return lines[lines.length - 1];
  }

  /** The page a line is on, and its y offset in scroll space. */
  pageTopOf(line) {
    const i = (line.page || 1) - 1;
    return this.pageTops[i] ?? 0;
  }

  caretRect() {
    if (!this.caret) return null;
    const lines = this.linesOf(this.caret.id);
    if (!lines.length) return null;
    let line = lines[0];
    for (const l of lines) {
      const r = lineRange(l);
      if (this.caret.off >= r.start && this.caret.off <= r.end) { line = l; break; }
      if (this.caret.off > r.end) line = l;
    }
    const x = xAtOffset(line, this.caret.off);
    const top = this.pageTopOf(line);
    return { x: (x === null ? line.x : x), y: top + line.y + 1, h: line.height - 2 };
  }

  /** Client coordinates -> a caret position. */
  hit(clientX, clientY) {
    const rect = this.cv.getBoundingClientRect();
    const z = this.zoom;
    const x = (clientX - rect.left) / z - (this.padX || 0);
    const y = (clientY - rect.top) / z + this.scroller.scrollTop / z;

    let best = null;
    for (let i = 0; i < this.pages.length; i++) {
      const top = this.pageTops[i];
      const localY = y - top;
      for (const line of this.pages[i].lines) {
        if (line.box) continue;
        if (String(line.blockId).includes('/v')) continue;   // a live table is read-only
        const dy = localY < line.y ? line.y - localY
          : localY > line.y + line.height ? localY - (line.y + line.height) : 0;
        const dx = x < line.x ? line.x - x
          : x > line.x + (line.width || 0) ? x - (line.x + (line.width || 0)) : 0;
        const d = dy * 1000 + dx;
        if (!best || d < best.d) best = { d, line, x, localY };
      }
    }
    if (!best) return null;
    return { id: best.line.blockId, off: offsetAtX(best.line, best.x) };
  }

  /** Which block, if any, is a point inside (for selecting a chart/table)? */
  hitBlock(clientX, clientY) {
    const rect = this.cv.getBoundingClientRect();
    const z = this.zoom;
    const x = (clientX - rect.left) / z - (this.padX || 0);
    const y = (clientY - rect.top) / z + this.scroller.scrollTop / z;
    for (let i = 0; i < this.pages.length; i++) {
      const top = this.pageTops[i];
      for (const line of this.pages[i].lines) {
        if (!line.box) continue;
        if (y >= top + line.y && y <= top + line.y + line.height &&
            x >= line.x && x <= line.x + 600) return line.blockId;
      }
    }
    return null;
  }

  scrollCaretIntoView() {
    const r = this.caretRect();
    if (!r) return;
    const z = this.zoom;
    const top = r.y * z;
    const bottom = (r.y + r.h) * z;
    const vt = this.scroller.scrollTop;
    const vb = vt + this.scroller.clientHeight;
    if (top < vt + 8) this.scroller.scrollTop = Math.max(0, top - 40);
    else if (bottom > vb - 8) this.scroller.scrollTop = bottom - this.scroller.clientHeight + 40;
  }

  /* ---- selection ------------------------------------------------------- */

  collapsed() {
    return !this.anchor ||
      (this.anchor.id === this.caret.id && this.anchor.off === this.caret.off);
  }

  /** Ordered selection bounds, or null when there is no selection. */
  selectionRange() {
    if (!this.caret || !this.anchor) return null;
    const a = this.anchor, b = this.caret;
    const ai = this.orderIndex(a.id), bi = this.orderIndex(b.id);
    const forward = ai < bi || (ai === bi && a.off <= b.off);
    const from = forward ? a : b, to = forward ? b : a;
    return {
      from, to,
      fromIdx: this.orderIndex(from.id), toIdx: this.orderIndex(to.id),
      fromOff: from.off, toOff: to.off,
      empty: from.id === to.id && from.off === to.off,
    };
  }

  selectedText() {
    const sel = this.selectionRange();
    if (!sel || sel.empty) return '';
    const out = [];
    let inside = false;
    for (const b of this.blocks) {
      if (b.kind !== 'para') { if (inside) out.push(''); continue; }
      if (b.id === sel.from.id) inside = true;
      if (!inside) continue;
      const start = b.id === sel.from.id ? sel.fromOff : 0;
      const end = b.id === sel.to.id ? sel.toOff : b.text.length;
      out.push(b.text.slice(start, end));
      if (b.id === sel.to.id) break;
    }
    return out.join('\n');
  }

  selectAll() {
    const paras = this.blocks.filter((b) => b.kind === 'para');
    if (!paras.length) return;
    this.anchor = { id: paras[0].id, off: 0 };
    const last = paras[paras.length - 1];
    this.caret = { id: last.id, off: last.text.length };
    this.draw();
  }

  /* ---- input ----------------------------------------------------------- */

  _bindMouse() {
    let dragging = false;
    this.cv.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const blk = this.hitBlock(e.clientX, e.clientY);
      if (blk) {
        this.selBlock = blk;
        this.anchor = null;
        this.input.focus();
        this.draw();
        return;
      }
      this.selBlock = null;
      const p = this.hit(e.clientX, e.clientY);
      if (!p) return;
      if (e.detail === 2) { this.selectWordAt(p); }
      else if (e.detail >= 3) { this.selectParaAt(p); }
      else {
        this.caret = p;
        this.anchor = e.shiftKey ? (this.anchor || p) : null;
        dragging = true;
      }
      this.wantX = null;
      this.caretOn = true;
      this.input.focus();
      this.draw();
      e.preventDefault();
    });
    this._move = (e) => {
      if (!dragging) return;
      const p = this.hit(e.clientX, e.clientY);
      if (!p) return;
      if (!this.anchor) this.anchor = { ...this.caret };
      this.caret = p;
      this.draw();
    };
    this._up = () => { dragging = false; };
    window.addEventListener('mousemove', this._move);
    window.addEventListener('mouseup', this._up);
    this._docListeners = [
      ['mousemove', () => window.removeEventListener('mousemove', this._move)],
      ['mouseup', () => window.removeEventListener('mouseup', this._up)],
    ];
  }

  selectWordAt(p) {
    const b = this.blocks.find((x) => x.id === p.id);
    if (!b) return;
    const t = b.text;
    let a = p.off, z = p.off;
    while (a > 0 && /\S/.test(t[a - 1])) a--;
    while (z < t.length && /\S/.test(t[z])) z++;
    this.anchor = { id: p.id, off: a };
    this.caret = { id: p.id, off: z };
  }

  selectParaAt(p) {
    const b = this.blocks.find((x) => x.id === p.id);
    if (!b) return;
    this.anchor = { id: p.id, off: 0 };
    this.caret = { id: p.id, off: b.text.length };
  }

  _bindInput() {
    /* Text arrives here and nowhere else. The textarea is emptied on every
     * input so its own value never becomes a second copy of the document. */
    this.input.addEventListener('input', () => {
      const t = this.input.value;
      this.input.value = '';
      if (t) this.insertText(t);
    });
    this.input.addEventListener('blur', () => this.drawCaretOnly());
    this.input.addEventListener('focus', () => { this.caretOn = true; this.drawCaretOnly(); });
  }

  /* ---- editing ---------------------------------------------------------
   * Every one of these runs inside host.batch(), so a burst of changes is a
   * single undo step and a single repaint. */

  /** Run an edit with the repaint suppressed until it is finished. */
  edit(fn) {
    this._editing = true;
    try { return fn(); } finally { this._editing = false; }
  }

  insertText(s) {
    const text = String(s).replace(/\r\n?/g, '\n');
    /* One undo step per RUN of typing, not per keystroke. The key is the
     * paragraph, so Enter, a click, or any other command ends the run - which
     * is exactly where a person expects Ctrl+Z to stop. A paste that contains
     * a line break is never merged: it is one deliberate act either way. */
    /* The undo run ends when the caret MOVED for a reason other than the
     * typing itself. Keying on the paragraph alone meant clicking somewhere
     * else in the same paragraph and typing again merged both bursts into one
     * step, so a single Ctrl+Z wiped work the person had put in twice. */
    const contiguous = this._typedAt && this.caret &&
      this._typedAt.id === this.caret.id && this._typedAt.off === this.caret.off;
    /* A fresh run gets a fresh key. Deriving the key from the caret POSITION
     * looked right and was not: type a sentence, click back to the start of
     * the same paragraph, type again, and both runs are keyed on offset 0 —
     * so one Ctrl+Z wiped both. A counter cannot collide with itself. */
    if (!contiguous) this._typeRun = (this._typeRun || 0) + 1;
    const key = text.indexOf('\n') >= 0 || !this.caret ? null : 'type:' + this._typeRun;
    this._typeKey = key;
    this._editing = true;
    this.host.batch(() => {
      if (!this.collapsed()) this.deleteSelection();
      if (!this.caret) return;
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) this.splitParagraph();
        if (parts[i]) this.insertAtCaret(parts[i]);
      }
    }, key);
    this._editing = false;
    this._typedAt = this.caret ? { ...this.caret } : null;
    this._deletedAt = null;        // deleting after typing is a new run
    this.after();
  }

  insertAtCaret(s) {
    const { id, off } = this.caret;
    const p = paraOf(this.doc, id);
    const text = p.text.slice(0, off) + s + p.text.slice(off);
    const runs = insertRuns(p.runs, off, s.length, this.pending || null);
    setPara(this.doc, id, text, runs, p.p);
    this.caret = { id, off: off + s.length };
    this.pending = null;
  }

  /** Is the caret inside a table cell rather than in the body? */
  inCell() { return !!this.caret && !isBodyId(this.caret.id); }

  /**
   * Enter: cut the paragraph in two, with its formatting following the text.
   *
   * INSIDE A TABLE CELL there is no paragraph to cut in two - a cell is one
   * node, and its id is not a fractional key, so asking for a key between it
   * and its neighbour threw and Enter did nothing at all except log an
   * exception. Inside a cell, Enter is a line break, which is what a person
   * filling in a table wants from it anyway.
   */
  splitParagraph() {
    const { id, off } = this.caret;
    const p = paraOf(this.doc, id);
    if (this.inCell()) {
      const text = p.text.slice(0, off) + SOFT_BREAK + p.text.slice(off);
      setPara(this.doc, id, text, packRuns(insertRuns(p.runs, off, 1), text.length), p.p);
      this.caret = { id, off: off + 1 };
      return;
    }
    const order = blockIds(this.doc);
    const i = order.indexOf(id);
    const a = keyOf(id);
    const b = i + 1 < order.length ? keyOf(order[i + 1]) : null;
    const nid = bodyId(keyBetween(a, b));

    const head = p.text.slice(0, off);
    const tail = p.text.slice(off);
    const headRuns = deleteRuns(p.runs, off, p.text.length);
    const tailRuns = deleteRuns(p.runs, 0, off);

    /* A heading does not continue into the paragraph after it - pressing
     * Enter at the end of a title means "now write the body", and every word
     * processor that gets this wrong makes people re-style every paragraph
     * they type. A split in the MIDDLE keeps the style, because that is one
     * heading becoming two. */
    const nextProps = (off >= p.text.length && /^(title|h1|h2|h3|caption)$/.test(p.p.style || ''))
      ? { ...p.p, style: 'body', list: p.p.list, level: p.p.level }
      : { ...p.p };

    setPara(this.doc, id, head, packRuns(headRuns, head.length), p.p);
    setPara(this.doc, nid, tail, packRuns(tailRuns, tail.length), nextProps);
    this.caret = { id: nid, off: 0 };
  }

  deleteSelection() {
    const sel = this.selectionRange();
    if (!sel || sel.empty) return;

    /* A selection inside ONE paragraph is handled by id, without needing that
     * paragraph to be a top-level block. `this.blocks` holds body blocks only,
     * so looking a table cell up in it returned -1 and this function returned
     * silently - the selection was drawn on screen, and typing over it
     * appended instead of replacing. */
    if (sel.from.id === sel.to.id) {
      const p = paraOf(this.doc, sel.from.id);
      const text = p.text.slice(0, sel.fromOff) + p.text.slice(sel.toOff);
      const runs = packRuns(deleteRuns(p.runs, sel.fromOff, sel.toOff), text.length);
      pruneFields(this.doc, sel.from.id, p.runs, runs);
      setPara(this.doc, sel.from.id, text, runs, p.p);
      this.caret = { id: sel.from.id, off: sel.fromOff };
      this.anchor = null;
      return;
    }

    const fromI = this.blocks.findIndex((b) => b.id === sel.from.id);
    const toI = this.blocks.findIndex((b) => b.id === sel.to.id);
    if (fromI < 0 || toI < 0) { this.anchor = null; return; }

    if (fromI === toI) {
      const p = paraOf(this.doc, sel.from.id);
      const text = p.text.slice(0, sel.fromOff) + p.text.slice(sel.toOff);
      const runs = packRuns(deleteRuns(p.runs, sel.fromOff, sel.toOff), text.length);
      pruneFields(this.doc, sel.from.id, p.runs, runs);
      setPara(this.doc, sel.from.id, text, runs, p.p);
      this.caret = { id: sel.from.id, off: sel.fromOff };
      this.anchor = null;
      return;
    }

    const first = paraOf(this.doc, sel.from.id);
    const last = paraOf(this.doc, sel.to.id);
    const merged = first.text.slice(0, sel.fromOff) + last.text.slice(sel.toOff);
    const headRuns = deleteRuns(first.runs, sel.fromOff, first.text.length);
    const tailRuns = deleteRuns(last.runs, 0, sel.toOff);
    setPara(this.doc, sel.from.id, merged,
      packRuns([...headRuns, ...tailRuns], merged.length), first.p);

    for (let i = fromI + 1; i <= toI; i++) removeBlock(this.doc, this.blocks[i].id);
    this.caret = { id: sel.from.id, off: sel.fromOff };
    this.anchor = null;
  }

  backspace() {
    /* Deleting coalesces the same way typing does, and for the same reason:
     * a key derived from the POSITION lets two separate runs collide on one
     * value, so holding Backspace, clicking elsewhere in the paragraph, and
     * holding it again would let one Ctrl+Z take both. The typing path was
     * fixed after a reviewer found it there; this one is the same shape and
     * was not tested, which is exactly why it is worth fixing now. */
    const contiguous = this._deletedAt && this.caret &&
      this._deletedAt.id === this.caret.id && this._deletedAt.off === this.caret.off;
    if (!contiguous) this._delRun = (this._delRun || 0) + 1;
    const key = 'del:' + this._delRun;
    this._editing = true;
    this.host.batch(() => {
      if (!this.collapsed()) { this.deleteSelection(); return; }
      const { id, off } = this.caret;
      const p = paraOf(this.doc, id);
      if (off > 0) {
        const text = p.text.slice(0, off - 1) + p.text.slice(off);
        const runs = packRuns(deleteRuns(p.runs, off - 1, off), text.length);
        pruneFields(this.doc, id, p.runs, runs);
        setPara(this.doc, id, text, runs, p.p);
        this.caret = { id, off: off - 1 };
        return;
      }
      /* At the start of a paragraph, Backspace first removes the LIST or the
       * INDENT if there is one. Word does this and it is the difference
       * between "escape from this list" being one key and being a hunt
       * through a menu. */
      const props = p.p || {};
      if (props.list) { setPara(this.doc, id, p.text, p.runs, { ...props, list: null }); return; }
      if ((props.indentLeft || 0) > 0) {
        setPara(this.doc, id, p.text, p.runs,
          { ...props, indentLeft: Math.max(0, props.indentLeft - 18) });
        return;
      }
      if ((props.style || 'body') !== 'body' && p.text.length) {
        setPara(this.doc, id, p.text, p.runs, { ...props, style: 'body' });
        return;
      }
      // merge into the previous paragraph
      const order = blockIds(this.doc);
      const i = order.indexOf(id);
      if (i <= 0) return;
      const prevId = order[i - 1];
      const prev = this.blocks.find((b) => b.id === prevId);
      if (prev && prev.kind !== 'para') { removeBlock(this.doc, prevId); return; }
      const pp = paraOf(this.doc, prevId);
      const text = pp.text + p.text;
      setPara(this.doc, prevId, text, packRuns([...pp.runs, ...p.runs], text.length), pp.p);
      removeBlock(this.doc, id);
      this.caret = { id: prevId, off: pp.text.length };
    }, key);
    this._editing = false;
    this._deletedAt = this.caret ? { ...this.caret } : null;
    this._typedAt = null;          // typing after deleting is a new run
    this.after();
  }

  forwardDelete() {
    this._editing = true;
    this.host.batch(() => {
      if (!this.collapsed()) { this.deleteSelection(); return; }
      const { id, off } = this.caret;
      const p = paraOf(this.doc, id);
      if (off < p.text.length) {
        const text = p.text.slice(0, off) + p.text.slice(off + 1);
        const runs = packRuns(deleteRuns(p.runs, off, off + 1), text.length);
        pruneFields(this.doc, id, p.runs, runs);
        setPara(this.doc, id, text, runs, p.p);
        return;
      }
      const order = blockIds(this.doc);
      const i = order.indexOf(id);
      if (i < 0 || i + 1 >= order.length) return;
      const nextId = order[i + 1];
      const next = this.blocks.find((b) => b.id === nextId);
      if (next && next.kind !== 'para') { removeBlock(this.doc, nextId); return; }
      const np = paraOf(this.doc, nextId);
      const text = p.text + np.text;
      setPara(this.doc, id, text, packRuns([...p.runs, ...np.runs], text.length), p.p);
      removeBlock(this.doc, nextId);
    });
    this._editing = false;
    this.after();
  }

  /**
   * Finish an edit: one layout, one paint.
   *
   * `_editing` keeps the change listener from painting in the middle of the
   * batch — otherwise every keystroke laid the document out twice, and at 58
   * pages that was the difference between 42ms and 84ms per character.
   */
  after() {
    if (this.caret) this.invalidate(this.caret.id);
    this.dirty = true;
    this.relayout();
    this.scrollCaretIntoView();
    // host.refresh() draws every surface and then the status bar; drawing
    // here as well laid the page out and painted it twice per keystroke.
    this.host.refresh();
  }

  /* ---- caret movement --------------------------------------------------- */

  move(what, extend) {
    if (!this.caret) return false;
    if (extend && !this.anchor) this.anchor = { ...this.caret };
    if (!extend) this.anchor = null;
    const paras = this.blocks;
    const idx = paras.findIndex((b) => b.id === this.caret.id);
    const p = paraOf(this.doc, this.caret.id);

    const prevPara = () => { for (let i = idx - 1; i >= 0; i--) if (paras[i].kind === 'para') return paras[i]; return null; };
    const nextPara = () => { for (let i = idx + 1; i < paras.length; i++) if (paras[i].kind === 'para') return paras[i]; return null; };

    switch (what) {
      case 'left': {
        this.wantX = null;
        if (this.caret.off > 0) { this.caret = { ...this.caret, off: this.caret.off - 1 }; break; }
        const pv = prevPara();
        if (pv) this.caret = { id: pv.id, off: pv.text.length };
        break;
      }
      case 'right': {
        this.wantX = null;
        if (this.caret.off < p.text.length) { this.caret = { ...this.caret, off: this.caret.off + 1 }; break; }
        const nx = nextPara();
        if (nx) this.caret = { id: nx.id, off: 0 };
        break;
      }
      case 'wordLeft': {
        this.wantX = null;
        let o = this.caret.off;
        while (o > 0 && /\s/.test(p.text[o - 1])) o--;
        while (o > 0 && /\S/.test(p.text[o - 1])) o--;
        if (o === this.caret.off) { const pv = prevPara(); if (pv) { this.caret = { id: pv.id, off: pv.text.length }; break; } }
        this.caret = { ...this.caret, off: o };
        break;
      }
      case 'wordRight': {
        this.wantX = null;
        let o = this.caret.off;
        while (o < p.text.length && /\S/.test(p.text[o])) o++;
        while (o < p.text.length && /\s/.test(p.text[o])) o++;
        if (o === this.caret.off) { const nx = nextPara(); if (nx) { this.caret = { id: nx.id, off: 0 }; break; } }
        this.caret = { ...this.caret, off: o };
        break;
      }
      case 'up': case 'down': return this.moveLine(what === 'down' ? 1 : -1, extend);
      case 'home': {
        const line = this.findLine(this.caret);
        this.caret = { ...this.caret, off: line ? lineRange(line).start : 0 };
        this.wantX = null;
        break;
      }
      case 'end': {
        const line = this.findLine(this.caret);
        this.caret = { ...this.caret, off: line ? lineRange(line).end : p.text.length };
        this.wantX = null;
        break;
      }
      case 'docStart': {
        const first = paras.find((b) => b.kind === 'para');
        if (first) this.caret = { id: first.id, off: 0 };
        break;
      }
      case 'docEnd': {
        for (let i = paras.length - 1; i >= 0; i--) {
          if (paras[i].kind === 'para') { this.caret = { id: paras[i].id, off: paras[i].text.length }; break; }
        }
        break;
      }
      case 'pageUp': case 'pageDown': {
        const dy = (what === 'pageDown' ? 1 : -1) * this.scroller.clientHeight / this.zoom * 0.9;
        const r = this.caretRect();
        if (r) {
          const target = this.pointToCaret(r.x, r.y + dy);
          if (target) this.caret = target;
        }
        this.scroller.scrollTop += (what === 'pageDown' ? 1 : -1) * this.scroller.clientHeight * 0.9;
        break;
      }
      default: return false;
    }
    this.caretOn = true;
    this.scrollCaretIntoView();
    this.draw();
    return true;
  }

  /** Up/down keeps the column you started in, which is what a reader expects. */
  moveLine(dir, extend) {
    const flat = [];
    for (const pg of this.pages) for (const l of pg.lines) {
      if (!l.box && !String(l.blockId).includes('/v')) flat.push(l);
    }
    const here = this.findLine(this.caret);
    let i = flat.indexOf(here);
    if (i < 0) return false;
    if (this.wantX === null) {
      const x = xAtOffset(here, this.caret.off);
      this.wantX = x === null ? here.x : x;
    }
    const j = i + dir;
    if (j < 0 || j >= flat.length) {
      // already on the first/last line: go to its start/end
      this.caret = { ...this.caret, off: dir < 0 ? lineRange(here).start : lineRange(here).end };
    } else {
      const target = flat[j];
      this.caret = { id: target.blockId, off: offsetAtX(target, this.wantX) };
    }
    if (!extend) this.anchor = null;
    this.caretOn = true;
    this.scrollCaretIntoView();
    this.draw();
    return true;
  }

  /* ---- find and replace ------------------------------------------------
   * Searching walks the BLOCKS, not the laid-out lines: a phrase broken
   * across two lines is one phrase in the document, and a search that works
   * on lines silently cannot find it. */

  /**
   * Every paragraph in the document, INCLUDING the ones inside table cells.
   *
   * `this.blocks` is the top level only, so search and replace used to walk
   * straight past a table: two occurrences left behind, the status bar
   * reporting a successful replacement, and Find unable to locate them either
   * - so there was no way to discover the miss from inside the app.
   */
  allParagraphs() {
    const out = [];
    for (const b of this.blocks) {
      if (b.kind === 'para') { out.push({ id: b.id, text: b.text }); continue; }
      if (b.kind !== 'table') continue;
      for (const row of b.rows || []) {
        for (const cell of row) {
          for (const inner of cell.blocks || []) {
            // a live table's cells are computed, not editable
            if (inner.id && !String(inner.id).includes('/v')) {
              out.push({ id: inner.id, text: inner.text || '' });
            }
          }
        }
      }
    }
    return out;
  }

  findNext(needle) {
    if (!needle) return false;
    const n = needle.toLowerCase();
    const paras = this.allParagraphs();
    if (!paras.length) return false;
    const startIdx = Math.max(0, paras.findIndex((b) => b.id === (this.caret && this.caret.id)));
    const startOff = this.caret ? this.caret.off : 0;
    for (let k = 0; k <= paras.length; k++) {
      const i = (startIdx + k) % paras.length;
      const from = k === 0 ? startOff : 0;
      const at = paras[i].text.toLowerCase().indexOf(n, from);
      if (at >= 0) {
        this.anchor = { id: paras[i].id, off: at };
        this.caret = { id: paras[i].id, off: at + needle.length };
        this.wantX = null;
        this.scrollCaretIntoView();
        this.draw();
        return true;
      }
    }
    return false;
  }

  replaceAll(needle, replacement) {
    if (!needle) return 0;
    let count = 0;
    const rep = replacement || '';
    this.host.batch(() => {
      for (const b of this.allParagraphs()) {
        const p = paraOf(this.doc, b.id);
        let text = p.text;
        let runs = p.runs;
        let at = text.toLowerCase().indexOf(needle.toLowerCase());
        let guard = 0;
        while (at >= 0 && guard++ < 10000) {
          text = text.slice(0, at) + rep + text.slice(at + needle.length);
          runs = deleteRuns(runs, at, at + needle.length);
          runs = rep ? insertRuns(runs, at, rep.length) : runs;
          count++;
          at = text.toLowerCase().indexOf(needle.toLowerCase(), at + rep.length);
        }
        if (count && text !== p.text) {
          setPara(this.doc, b.id, text, packRuns(runs, text.length), p.p);
        }
      }
    });
    this.anchor = null;
    this.after();
    return count;
  }

  pointToCaret(x, y) {
    let best = null;
    for (let i = 0; i < this.pages.length; i++) {
      const top = this.pageTops[i];
      for (const line of this.pages[i].lines) {
        if (line.box) continue;
        const ly = top + line.y;
        const d = Math.abs(y - (ly + line.height / 2));
        if (!best || d < best.d) best = { d, line };
      }
    }
    return best ? { id: best.line.blockId, off: offsetAtX(best.line, x) } : null;
  }
}
