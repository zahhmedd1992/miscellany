/* Deck — a view over the same Grain document Sheet uses.
 *
 * Deck gives the substrate the SAME two answers Sheet gives it:
 *   1. how its objects are named        (deck:<name>/s<n>/<object>)
 *   2. how to draw them                 (a slide surface, not a grid)
 *
 * Everything else — the node graph, the recalculation scheduler, the formula
 * engine, the value model, the number formats, the chart renderer — is core,
 * used unchanged. Nothing in this file knows what a spreadsheet is, and
 * nothing in core knows what a slide is.
 *
 * A slide object is a node exactly like a cell is a node. That is what makes
 * `=SUM(Budget!B4:B16)` on a slide a live figure rather than a copied one,
 * and a chart on a slide an ordinary dependent of a range. There is no
 * integration code anywhere in this file, because there is nothing to
 * integrate: it was always one document.
 */

import { toText, isRange } from '../../core/value.js';
import { formatValue } from '../../core/numfmt.js';
import { formatGeneral } from '../../core/format.js';
import { drawChart } from '../sheet/chartview.js';
import { parseChart } from '../../core/ooxml/chart.js';

export const DECK = 'deck';

/** Slide n of a deck, 0-based. */
export const slideId = (n, deck = DECK) => `${deck}:s${n + 1}`;
/** An object on a slide. Ids are opaque to the graph; this is Deck's shape. */
export const objId = (slide, name, deck = DECK) => `${deck}:s${slide + 1}/${name}`;

/** Which slide an object id belongs to, or -1. */
export function slideOfId(id) {
  const m = /:s(\d+)\//.exec(String(id));
  return m ? parseInt(m[1], 10) - 1 : -1;
}

/** A chart's category labels are a SECOND range, so they are a second node.
 *  Anything a view reads must be a node — see defineObject(). */
export const catsId = (objectId) => `${objectId}/cats`;

/**
 * How many slides the document has. DERIVED, never stored.
 *
 * It used to be a counter on the view, and that is a fact about the document
 * kept somewhere the document is not: saving wrote every object faithfully
 * and the count went nowhere, so reopening a three-slide deck showed one
 * slide and silently buried the other two. The objects were all still there.
 * You just could not get to them.
 *
 * The rule this breaks is the same one everywhere else in this codebase: if a
 * view needs it, it comes from the document.
 */
export function slideCount(doc, deck = DECK) {
  let max = 0;
  for (const [id, node] of doc.nodes) {
    if (!node.meta || !node.meta.object) continue;
    if (!id.startsWith(deck + ':')) continue;
    const n = slideOfId(id);
    if (n >= 0) max = Math.max(max, n + 1);
  }
  return Math.max(1, max);
}

/**
 * Move every object on slide `from` and after by `delta` slides.
 *
 * Inserting and deleting a slide in the middle both need this. Without it,
 * deleting slide 1 of 3 left slides 2 and 3 where they were and just lowered
 * a counter — so the last slide fell off the end of the deck while its
 * objects sat in the document, unreachable.
 *
 * Ids are opaque to the graph, so "moving" is re-creating the node under a new
 * id with the same input and meta.
 */
export function shiftSlides(doc, from, delta, deck = DECK) {
  const items = [];
  for (const [id, node] of doc.nodes) {
    if (!id.startsWith(deck + ':')) continue;
    const n = slideOfId(id);
    if (n < from) continue;
    items.push({ id, n, raw: doc.raw(id), meta: node.meta });
  }
  // Ascending when moving down, descending when moving up, so a move never
  // lands on an id that has not been vacated yet.
  items.sort((a, b) => (delta < 0 ? a.n - b.n : b.n - a.n));
  for (const it of items) {
    const name = it.id.slice(it.id.indexOf('/') + 1);
    const next = objId(it.n + delta, name, deck);
    doc.set(next, it.raw);
    doc.setMeta(next, it.meta || null);
    doc.set(it.id, '');
    doc.setMeta(it.id, null);
  }
}

/**
 * Put an object on a slide.
 *
 * Every range an object displays gets BOUND TO A NODE here, at definition
 * time, rather than resolved later while painting. That is not tidiness:
 *
 *   - painting must be a pure read. The first version resolved a chart's
 *     range by writing a scratch node into the document mid-paint, so drawing
 *     mutated the document, which re-entered drawing. One keystroke produced
 *     496 nested draws and a stack overflow — invisible to every error
 *     listener, because an exhausted stack has no room left to report itself.
 *
 *   - a range the graph does not know about is a dependency that does not
 *     exist. The category labels were resolved by string at paint time, so
 *     the graph could not tell you that this chart depends on A4:A6 — it only
 *     looked right because the view repainted on every change to anything.
 *
 * @param doc      the document
 * @param id       object id, from objId()
 * @param object   geometry + role (see OBJECT)
 * @param formula  raw content: a literal, or `=…`. Charts default to their ref.
 */
export function defineObject(doc, id, object, formula) {
  const raw = formula !== undefined ? formula
            : object.ref ? '=' + object.ref
            : '';
  doc.set(id, raw);
  doc.setMeta(id, { object });
  // the second range, bound the same way as the first
  if (object.cats) doc.set(catsId(id), '=' + object.cats);
  return id;
}

/* A slide is 16:9 in its own coordinate space; the view scales to fit, so a
 * deck looks the same on any screen and objects are positioned once. */
export const SLIDE_W = 1280;
export const SLIDE_H = 720;

const C = {
  page: '#FFFFFF',
  stage: '#EFECE6',
  ink: '#211C16',
  muted: '#6C6356',
  rule: '#E3E0DA',
  sel: '#9A3B1B',
};

/* ---- objects -----------------------------------------------------------
 * An object's CONTENT is its node's value; its geometry and role live in the
 * node's meta, exactly as a cell's formatting does. One model, two views. */

export const OBJECT = {
  /** A text box. Its value may be typed, or a formula — a live figure. */
  text: (x, y, w, h, opts = {}) => ({ kind: 'text', x, y, w, h, ...opts }),
  /** A chart. Its node's value is a RANGE, so the graph makes it a dependent
   *  of every cell in that range and repaints it when any of them changes. */
  chart: (x, y, w, h, opts = {}) => ({ kind: 'chart', x, y, w, h, ...opts }),
};

export class DeckView {
  constructor(canvas, doc, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.doc = doc;
    this.deck = opts.deck || DECK;
    this.slide = 0;
    this.sel = null;                       // selected object id
    this.onSelect = opts.onSelect || (() => {});
    this.onEdit = opts.onEdit || (() => {});
    this.dpr = window.devicePixelRatio || 1;

    this._bind();
    this.resize();
    doc.onChange(() => this.draw());
  }

  /** Read from the document, so it survives a save. See slideCount(). */
  get slides() { return slideCount(this.doc, this.deck); }

  /** Every object on the current slide, in document order. */
  objects() {
    const prefix = `${this.deck}:s${this.slide + 1}/`;
    const out = [];
    for (const [id, node] of this.doc.nodes) {
      if (!id.startsWith(prefix)) continue;
      if (!node.meta || !node.meta.object) continue;
      out.push({ id, node, o: node.meta.object });
    }
    return out;
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

  /** The slide rectangle on screen, letterboxed to keep 16:9. */
  stage() {
    const pad = 24;
    const availW = this.vw - pad * 2, availH = this.vh - pad * 2;
    const scale = Math.min(availW / SLIDE_W, availH / SLIDE_H);
    const w = SLIDE_W * scale, h = SLIDE_H * scale;
    return { x: (this.vw - w) / 2, y: (this.vh - h) / 2, w, h, scale };
  }

  boxOf(o, st) {
    return { x: st.x + o.x * st.scale, y: st.y + o.y * st.scale,
             w: o.w * st.scale, h: o.h * st.scale };
  }

  draw() {
    const x = this.ctx;
    if (!this.vw) return;
    x.fillStyle = C.stage;
    x.fillRect(0, 0, this.vw, this.vh);

    const st = this.stage();
    x.fillStyle = C.page;
    x.fillRect(st.x, st.y, st.w, st.h);
    x.strokeStyle = C.rule;
    x.lineWidth = 1;
    x.strokeRect(st.x + 0.5, st.y + 0.5, st.w - 1, st.h - 1);

    for (const { id, node, o } of this.objects()) {
      const b = this.boxOf(o, st);
      const v = node.value;

      if (o.kind === 'chart') {
        // The chart's node value IS the range it depends on. Building the
        // spec from live values rather than a cached copy is the whole point.
        const spec = o.spec || chartSpecFor(node, o);
        drawChart(x, spec, b, liveResolver(this.doc, id, o), null);
      } else {
        drawText(x, v, o, b, st.scale);
      }

      if (this.sel === id) {
        x.strokeStyle = C.sel;
        x.lineWidth = 2;
        x.strokeRect(b.x - 1, b.y - 1, b.w + 2, b.h + 2);
      }
    }

    // slide number, the one piece of chrome a deck earns
    x.font = `${Math.round(12 * st.scale * 1.1)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    x.fillStyle = C.muted;
    x.textAlign = 'right';
    x.textBaseline = 'alphabetic';
    x.fillText(String(this.slide + 1), st.x + st.w - 24 * st.scale, st.y + st.h - 20 * st.scale);
  }

  hit(px, py) {
    const st = this.stage();
    const list = this.objects();
    for (let i = list.length - 1; i >= 0; i--) {
      const b = this.boxOf(list[i].o, st);
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return list[i].id;
    }
    return null;
  }

  select(id) { this.sel = id; this.draw(); this.onSelect(id); }

  go(n) {
    this.slide = Math.max(0, Math.min(this.slides - 1, n));
    this.sel = null;
    this.draw();
    this.onSelect(null);
  }

  _bind() {
    const cv = this.cv;
    cv.addEventListener('mousedown', (e) => {
      const r = cv.getBoundingClientRect();
      this.select(this.hit(e.clientX - r.left, e.clientY - r.top));
    });
    cv.addEventListener('dblclick', () => { if (this.sel) this.onEdit(this.sel); });
    // No window resize listener: the shell observes the pane and calls
    // resize(). A listener here would also leak one per re-mount.
  }
}

/* ---- drawing ----------------------------------------------------------- */

function drawText(ctx, v, o, b, scale) {
  const size = Math.round((o.size || 24) * scale);
  const weight = o.bold ? '600 ' : '';
  ctx.font = `${o.italic ? 'italic ' : ''}${weight}${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = o.color || C.ink;
  ctx.textBaseline = 'top';

  const text = v.k === 'number'
    ? (o.numFmt ? formatValue(v, o.numFmt).text : formatGeneral(v.d))
    : toText(v);

  const align = o.align || 'left';
  ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
  const tx = align === 'center' ? b.x + b.w / 2 : align === 'right' ? b.x + b.w : b.x;

  ctx.save();
  ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
  let ty = b.y;
  for (const line of wrap(ctx, text, b.w)) {
    ctx.fillText(line, tx, ty);
    ty += size * 1.28;
  }
  ctx.restore();
}

function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const probe = line + word;
      if (ctx.measureText(probe).width <= maxW || line === '') line = probe;
      else { out.push(line.trimEnd()); line = word.trimStart(); }
      if (out.length > 200) return out;
    }
    out.push(line);
  }
  return out;
}

/* ---- charts on slides ---------------------------------------------------
 * Deck does not have its own chart renderer. It builds the same spec shape
 * that the .xlsx reader produces and hands it to the same drawChart() Sheet
 * uses. Two apps, one renderer — which is the only reason a second app is
 * cheap at all. */

function chartSpecFor(node, o) {
  const v = node.value;
  const ids = isRange(v) ? v.ids : [];
  return {
    title: o.title || null,
    kinds: [o.chart || 'bar'],
    barDir: 'col',
    grouping: 'clustered',
    hasLegend: !!o.legend,
    axisTitles: { x: null, y: o.yTitle || null },
    series: [{
      kind: o.chart || 'bar',
      name: o.seriesName || null,
      val: { ref: o.ref || null, cache: [] },
      cat: o.cats ? { ref: o.cats, cache: [] } : null,
      color: o.color ? { rgb: o.color } : null,
    }],
    _ids: ids,
  };
}

/** One cell, as the chart renderer wants it. */
const plain = (v) =>
  v.k === 'number' ? v.d.toNumber() : v.k === 'text' ? v.s : null;

const asArray = (v) => (isRange(v) ? v.values.map(plain) : null);

/**
 * Values for a chart's references — read, never written.
 *
 * Both ranges were bound to nodes by defineObject(), so by the time we paint
 * the scheduler has already computed them. Painting is a lookup. It does not
 * touch the document, which is what makes it safe to call from a change
 * listener at all.
 */
function liveResolver(doc, id, o) {
  const byRef = new Map();
  if (o.ref)  byRef.set(o.ref,  asArray(doc.value(id)));
  if (o.cats) byRef.set(o.cats, asArray(doc.value(catsId(id))));
  return (ref) => byRef.get(ref) || null;
}

export { chartSpecFor, liveResolver };
export { parseChart };
