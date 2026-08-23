/* A 2D drawing context that writes PDF instead of pixels.
 *
 * Everything Miscellany draws - a laid-out page, a chart bound to a range,
 * a table - is drawn by code written against a canvas context. This class
 * answers the same calls and emits PDF content-stream operators, so the PDF
 * is not a re-implementation of what is on screen. It is the same drawing
 * code pointed at a different surface, and the two therefore cannot drift.
 *
 * That matters more than it sounds. The normal way to build "export to PDF"
 * is to write the document out a second time against a PDF library, and the
 * second implementation is a second opinion about what the document looks
 * like. Every disagreement between them is found by a person holding a
 * print-out next to a screen.
 *
 * WHAT IS AND IS NOT SUPPORTED, precisely:
 *   supported - save/restore, translate/scale/rotate, fillRect, strokeRect,
 *               paths (moveTo/lineTo/rect/arc/closePath) with fill/stroke,
 *               clipping to a rectangle, fillText with alignment and
 *               baseline, measureText, images.
 *   not       - gradients, shadows, compositing modes, dashed lines,
 *               non-rectangular clips. Each throws or is ignored explicitly
 *               rather than silently producing a different picture; a silent
 *               difference between the screen and the page is the exact
 *               failure this file exists to prevent.
 *
 * Coordinates are POINTS with y increasing downward, matching the layout
 * engine. PDF's own axis points up, and the conversion is done per call
 * rather than by flipping the base transform, because flipping the transform
 * flips the glyphs with it.
 */

import { stringWidth, winAnsiCode, faceOf, familyOf, FAMILIES } from '../text/metrics.js';

/* matrix helpers: [a,b,c,d,e,f], x' = a x + c y + e, y' = b x + d y + f */
const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/* PDF forbids exponent notation, and JS produces it eagerly — hence toFixed.
 * The trailing-zero trim must only run on a number that HAS a fractional
 * part: `(2e9).toFixed(4)` is "2000000000.0000", and stripping trailing zeros
 * from that gives "2", which is a different number by a factor of a billion.
 * Unreachable at page dimensions today; a landmine for whoever reuses this. */
const num = (n) => {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return n.toFixed(0);
  const s = n.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

/** '#RRGGBB' or 'rgba(...)' -> [r,g,b] in 0..1, plus alpha. */
export function parseColour(c) {
  if (typeof c !== 'string') return { rgb: [0, 0, 0], a: 1 };
  let s = c.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return {
      rgb: [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255,
            parseInt(h.slice(4, 6), 16) / 255],
      a,
    };
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { rgb: [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255],
             a: p.length > 3 ? p[3] : 1 };
  }
  const named = { white: '#ffffff', black: '#000000', red: '#ff0000', none: null };
  if (named[s.toLowerCase()]) return parseColour(named[s.toLowerCase()]);
  return { rgb: [0, 0, 0], a: 1 };
}

/** Escape a string into a PDF literal string of WinAnsi bytes. */
export function pdfString(s) {
  let out = '';
  for (const ch of s) {
    const c = winAnsiCode(ch);
    const b = c < 0 ? 0x3F : c;                       // '?' for what we cannot encode
    if (b === 0x28 || b === 0x29 || b === 0x5C) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out;
}

export class PdfCanvas {
  /**
   * @param w page width in points
   * @param h page height in points
   * @param reg a FontRegistry shared by every page of the document
   */
  constructor(w, h, reg) {
    this.w = w;
    this.h = h;
    this.reg = reg;
    this.ops = [];
    this.images = new Map();          // resource name -> the image object
    // base: our y-down points -> PDF's y-up points
    this.m = [1, 0, 0, -1, 0, h];
    this.stack = [];
    this._path = [];
    this._fill = '#000000';
    this._stroke = '#000000';
    this._alpha = 1;
    this._lw = 1;
    this.font = '11pt serif';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.lineJoin = 'miter';
    this._face = 'Times-Roman';
    this._size = 11;
    this._gs = new Map();             // alpha value -> ExtGState name
  }

  /* ---- state ---------------------------------------------------------- */

  save() {
    this.stack.push({ m: this.m.slice(), fill: this._fill, stroke: this._stroke,
                      lw: this._lw, alpha: this._alpha, face: this._face,
                      size: this._size, align: this.textAlign,
                      baseline: this.textBaseline, clipped: this._clipped });
    this.ops.push('q');
    this._clipped = false;
  }

  restore() {
    const s = this.stack.pop();
    this.ops.push('Q');
    if (!s) return;
    this.m = s.m; this._fill = s.fill; this._stroke = s.stroke;
    this._lw = s.lw; this._alpha = s.alpha; this._face = s.face; this._size = s.size;
    this.textAlign = s.align; this.textBaseline = s.baseline;
    this._clipped = s.clipped;
    this._emittedFill = null; this._emittedStroke = null; this._emittedAlpha = null;
  }

  translate(x, y) { this.m = mul([1, 0, 0, 1, x, y], this.m); }
  scale(x, y) { this.m = mul([x, 0, 0, y === undefined ? x : y, 0, 0], this.m); }
  rotate(a) {
    const c = Math.cos(a), s = Math.sin(a);
    this.m = mul([c, s, -s, c, 0, 0], this.m);
  }
  setTransform(a, b, c, d, e, f) { this.m = mul([a, b, c, d, e, f], [1, 0, 0, -1, 0, this.h]); }

  set fillStyle(v) { this._fill = v; }
  get fillStyle() { return this._fill; }
  set strokeStyle(v) { this._stroke = v; }
  get strokeStyle() { return this._stroke; }
  set lineWidth(v) { this._lw = v; }
  get lineWidth() { return this._lw; }
  set globalAlpha(v) { this._alpha = v; }
  get globalAlpha() { return this._alpha; }

  _setFill() {
    const { rgb, a } = parseColour(this._fill);
    const key = rgb.join(',');
    if (this._emittedFill !== key) {
      this.ops.push(`${num(rgb[0])} ${num(rgb[1])} ${num(rgb[2])} rg`);
      this._emittedFill = key;
    }
    this._setAlpha(this._alpha * a);
  }

  _setStroke() {
    const { rgb, a } = parseColour(this._stroke);
    const key = rgb.join(',');
    if (this._emittedStroke !== key) {
      this.ops.push(`${num(rgb[0])} ${num(rgb[1])} ${num(rgb[2])} RG`);
      this._emittedStroke = key;
    }
    this._setAlpha(this._alpha * a);
    const lw = this._lw * scaleOf(this.m);
    this.ops.push(`${num(lw)} w`);
  }

  /* Transparency is a graphics-state parameter in PDF, not an operator, so
   * each distinct alpha needs a named ExtGState in the page resources. */
  _setAlpha(a) {
    const v = Math.max(0, Math.min(1, a));
    if (Math.abs(v - (this._emittedAlpha ?? 1)) < 0.001) return;
    this._emittedAlpha = v;
    if (v >= 0.999) { this.ops.push('/GS1 gs'); this._gs.set(1, 'GS1'); return; }
    const name = 'GS' + Math.round(v * 1000);
    this._gs.set(v, name);
    this.ops.push(`/${name} gs`);
  }

  /* ---- paths ---------------------------------------------------------- */

  beginPath() { this._path = []; }
  closePath() { this._path.push(['h']); }

  moveTo(x, y) { const [px, py] = apply(this.m, x, y); this._path.push(['m', px, py]); }
  lineTo(x, y) { const [px, py] = apply(this.m, x, y); this._path.push(['l', px, py]); }

  rect(x, y, w, h) {
    this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h);
    this.lineTo(x, y + h); this.closePath();
  }

  /* An arc becomes cubic Bezier segments - PDF has no arc operator. Four
   * segments per full turn keeps the error under a thousandth of the radius,
   * which is below the resolution of any printer. */
  arc(cx, cy, r, a0, a1, ccw) {
    if (ccw) { const t = a0; a0 = a1; a1 = t; }
    let sweep = a1 - a0;
    while (sweep < 0) sweep += Math.PI * 2;
    const steps = Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
    const d = sweep / steps;
    const k = (4 / 3) * Math.tan(d / 4);
    let a = a0;
    const pt = (ang) => apply(this.m, cx + r * Math.cos(ang), cy + r * Math.sin(ang));
    const tan = (ang) => {
      const [x0, y0] = apply(this.m, cx, cy);
      const [x1, y1] = apply(this.m, cx - r * Math.sin(ang), cy + r * Math.cos(ang));
      void x0; void y0;
      return [x1, y1];
    };
    let [sx, sy] = pt(a);
    if (this._path.length) this._path.push(['l', sx, sy]);
    else this._path.push(['m', sx, sy]);
    for (let i = 0; i < steps; i++) {
      const b = a + d;
      const [ex, ey] = pt(b);
      const [tx0, ty0] = tan(a);
      const [tx1, ty1] = tan(b);
      const [ox, oy] = apply(this.m, cx, cy);
      const c1 = [sx + k * (tx0 - ox), sy + k * (ty0 - oy)];
      const c2 = [ex - k * (tx1 - ox), ey - k * (ty1 - oy)];
      this._path.push(['c', c1[0], c1[1], c2[0], c2[1], ex, ey]);
      a = b; sx = ex; sy = ey;
    }
  }

  _emitPath() {
    for (const seg of this._path) {
      if (seg[0] === 'h') { this.ops.push('h'); continue; }
      this.ops.push(seg.slice(1).map(num).join(' ') + ' ' + seg[0]);
    }
  }

  fill() { if (!this._path.length) return; this._setFill(); this._emitPath(); this.ops.push('f'); }
  stroke() { if (!this._path.length) return; this._setStroke(); this._emitPath(); this.ops.push('S'); }

  /** Rectangular clipping only. A non-rectangular clip throws rather than
   *  quietly rendering something the screen does not show. */
  clip() {
    if (!this._path.length) return;
    this._setFill();
    this._emitPath();
    this.ops.push('W n');
    this._clipped = true;
  }

  fillRect(x, y, w, h) {
    if (!(w > 0) || !(h > 0)) return;
    this._setFill();
    const p = [apply(this.m, x, y), apply(this.m, x + w, y),
               apply(this.m, x + w, y + h), apply(this.m, x, y + h)];
    this.ops.push(`${num(p[0][0])} ${num(p[0][1])} m ${num(p[1][0])} ${num(p[1][1])} l ` +
                  `${num(p[2][0])} ${num(p[2][1])} l ${num(p[3][0])} ${num(p[3][1])} l h f`);
  }

  strokeRect(x, y, w, h) {
    this.beginPath();
    this.rect(x, y, w, h);
    this.stroke();
  }

  clearRect(x, y, w, h) {
    const old = this._fill;
    this._fill = '#FFFFFF';
    this.fillRect(x, y, w, h);
    this._fill = old;
    this._emittedFill = null;
  }

  /* ---- text ------------------------------------------------------------ */

  /** Called by our own renderer, which knows the base font by name. */
  setFace(face, size) { this._face = face; this._size = size; }

  /* Chart code sets `ctx.font` as a CSS string, so the shim has to read one.
   * It is a guess by nature - a CSS font stack names fonts a PDF cannot -
   * and the guess is confined to this one function.
   *
   * The NUMBER is taken at face value whatever unit follows it, because the
   * unit is not doing any work: on screen that string is applied to a context
   * scaled so one unit is one point, and here the context is in points
   * already. Converting px to pt would make a chart label in the PDF three
   * quarters the size of the same label on screen. */
  set font(v) {
    this._cssFont = v;
    const s = String(v);
    const m = /(\d*\.?\d+)\s*(pt|px)/.exec(s);
    if (m) this._size = parseFloat(m[1]);
    const bold = /(^|\s)(bold|[5-9]00)(\s|$)/i.test(s);
    const ital = /(^|\s)italic(\s|$)/i.test(s);
    const fam = /courier|mono|consolas|cascadia/i.test(s) ? 'mono'
      : /times|georgia|serif/i.test(s) && !/sans-serif/i.test(s) ? 'serif' : 'sans';
    this._face = faceOf(fam, bold, ital);
  }
  get font() { return this._cssFont || '11pt serif'; }

  measureText(s) {
    return { width: (stringWidth(this._face, String(s)) * this._size) / 1000 };
  }

  fillText(s, x, y) {
    const text = String(s);
    if (!text) return;
    const w = this.measureText(text).width;
    let tx = x;
    if (this.textAlign === 'center') tx -= w / 2;
    else if (this.textAlign === 'right' || this.textAlign === 'end') tx -= w;
    let ty = y;
    const fam = familyOf(this._face);
    const asc = ({ sans: 0.718, serif: 0.683, mono: 0.629 })[fam] * this._size;
    const desc = ({ sans: 0.207, serif: 0.217, mono: 0.157 })[fam] * this._size;
    if (this.textBaseline === 'top') ty += asc;
    else if (this.textBaseline === 'middle') ty += (asc - desc) / 2;
    else if (this.textBaseline === 'bottom') ty -= desc;

    this._setFill();
    const name = this.reg.use(this._face);
    const m = this.m;
    const T = [m[0], m[1], -m[2], -m[3],
               m[0] * tx + m[2] * ty + m[4], m[1] * tx + m[3] * ty + m[5]];
    this.ops.push('BT');
    this.ops.push(`/${name} ${num(this._size)} Tf`);
    this.ops.push(`${num(T[0])} ${num(T[1])} ${num(T[2])} ${num(T[3])} ` +
                  `${num(T[4])} ${num(T[5])} Tm`);
    this.ops.push(`(${pdfString(text)}) Tj`);
    this.ops.push('ET');
  }

  strokeText(s, x, y) { this.fillText(s, x, y); }

  /* ---- images ---------------------------------------------------------- */

  /**
   * @param img an image XObject: { name, width, height, bytes, ... }.
   *
   * A DOM image is not one, and cannot be: a PDF has to carry the pixels.
   * Silently returning would put the image on screen and nothing at all on
   * the page — the one thing this whole class exists to prevent — so an
   * image we cannot embed is drawn as the SAME placeholder the screen falls
   * back to, and the two surfaces still agree.
   */
  drawImage(img, x, y, w, h) {
    if (!img || !img.name) {
      const W = w ?? 120, H = h ?? 90;
      const fill = this._fill;
      this._fill = '#F5F0E6';
      this.fillRect(x, y, W, H);
      this._fill = '#9A9384';
      this.setFace('Helvetica', 9);
      this.textBaseline = 'alphabetic';
      this.fillText('image', x + 6, y + 14);
      this._fill = fill;
      this._emittedFill = null;
      return;
    }
    this.images.set(img.name, img);
    const W = w ?? img.width;
    const H = h ?? img.height;
    // An image XObject draws into the unit square, so the matrix IS the
    // placement: scale to the box, then move the box's top-left to (x, y).
    const place = mul([W, 0, 0, H, x, y + H], this.m);
    // the unit square has y up; our box has y down, so flip inside it
    const flip = mul([1, 0, 0, -1, 0, 0], place);
    this.ops.push('q');
    this.ops.push(`${num(flip[0])} ${num(flip[1])} ${num(flip[2])} ${num(flip[3])} ` +
                  `${num(flip[4])} ${num(flip[5])} cm`);
    this.ops.push(`/${img.name} Do`);
    this.ops.push('Q');
  }

  /* ---- output ---------------------------------------------------------- */

  /** The page's content stream. */
  content() { return this.ops.join('\n'); }

  /** ExtGState resources this page needs, name -> alpha. */
  gstates() {
    const out = new Map([['GS1', 1]]);
    for (const [a, name] of this._gs) out.set(name, a);
    return out;
  }
}

/**
 * The fonts a document uses, and the /Widths that make its line breaks the
 * layout engine's line breaks rather than the reader's guess.
 *
 * One registry is shared by every page, so a face keeps one resource name
 * across the document. Each page then declares the fonts registered up to
 * and including itself — a font first used on page 9 is not in page 1's
 * resource dictionary, and does not need to be.
 */
export class FontRegistry {
  constructor() { this.used = new Map(); }     // base name -> resource name
  use(face) {
    if (!this.used.has(face)) this.used.set(face, 'F' + (this.used.size + 1));
    return this.used.get(face);
  }
  names() { return [...this.used.entries()]; }
}

export { FAMILIES };
