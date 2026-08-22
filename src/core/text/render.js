/* Grain - paint a laid-out page onto a 2D context.
 *
 * ONE renderer, two surfaces. The screen passes a real canvas context; the
 * PDF writer passes core/pdf/canvas.js, which answers the same calls by
 * emitting PDF content-stream operators.
 *
 * This is not a tidiness argument. "Export to PDF" is normally a second
 * implementation of the drawing code, and a second implementation is a second
 * opinion: the two drift, and the drift is only ever discovered by a person
 * comparing a print-out to a screen. Here there is nothing to drift, because
 * there is one set of drawing instructions and two things that obey them.
 *
 * The contract with a context is deliberately small - the subset below is all
 * that is used, which is what makes the PDF shim a page of code rather than a
 * project:
 *     save restore  translate scale
 *     fillStyle strokeStyle globalAlpha lineWidth font textBaseline
 *     fillRect  beginPath moveTo lineTo closePath rect arc fill stroke
 *     fillText  drawImage
 */

import { textWidth, faceOf, FAMILIES, familyOf } from './metrics.js';

/**
 * The CSS font shorthand for a base font name at a size.
 *
 * The size is written in `px` and it is NOT a pixel measurement: the context
 * has already been scaled so that one user unit is one point, so `11px` under
 * that transform paints eleven POINTS. Writing `11pt` instead asks the
 * browser to convert points to CSS pixels first (x 96/72) and then scales
 * that again - every word comes out a third too large and overlaps the next,
 * while every line-break, every width and every page count stays correct,
 * because layout never asked the canvas anything.
 *
 * That is the failure mode this whole file exists to make impossible, and it
 * still got in once. It is here in a comment because it is invisible to any
 * check that does not look at the picture.
 */
export function cssFont(face, size) {
  const fam = FAMILIES[familyOf(face)];
  const bold = /Bold/.test(face) ? 'bold ' : '';
  const ital = /(Oblique|Italic)/.test(face) ? 'italic ' : '';
  return `${ital}${bold}${size}px ${fam.css}`;
}

/**
 * Draw one page.
 *
 * @param ctx    a 2D context (canvas, or the PDF shim)
 * @param page   one entry from layout().pages
 * @param opts.images   key -> something ctx.drawImage accepts
 * @param opts.chart    (ctx, item) => void, for chart blocks
 * @param opts.fieldTint  paint the pale background behind live fields
 */
export function drawPage(ctx, page, opts = {}) {
  for (const it of page.items) {
    switch (it.t) {
      case 'rect':
        ctx.fillStyle = it.fill;
        ctx.fillRect(it.x, it.y, it.w, it.h);
        break;
      case 'rule':
        ctx.fillStyle = it.color || '#211C16';
        ctx.fillRect(it.x, it.y, it.w, it.h);
        break;
      case 'field':
        if (opts.fieldTint !== false) {
          ctx.fillStyle = opts.fieldColor || '#EEF2F6';
          ctx.fillRect(it.x, it.y, it.w, it.h);
        }
        break;
      case 'text':
        drawText(ctx, it);
        break;
      case 'image':
        if (opts.images && opts.images[it.key]) {
          ctx.drawImage(opts.images[it.key], it.x, it.y, it.w, it.h);
        } else {
          ctx.fillStyle = '#F5F0E6';
          ctx.fillRect(it.x, it.y, it.w, it.h);
          ctx.fillStyle = '#9A9384';
          ctx.font = cssFont('Helvetica', 9);
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(it.alt || 'image', it.x + 6, it.y + 14);
        }
        break;
      case 'chart':
        if (opts.chart) opts.chart(ctx, it);
        break;
      default:
        break;
    }
  }
}

/**
 * Draw a text item.
 *
 * When a line is justified the extra space is distributed between words, so
 * the string cannot be handed to the context in one call: `wordSpacing` on a
 * canvas context is not universally supported and does not exist at all in a
 * PDF content stream. Placing each word at a computed x costs nothing and is
 * identical on both surfaces - which is the whole point of this file.
 */
function drawText(ctx, it) {
  ctx.fillStyle = it.color || '#211C16';
  ctx.font = cssFont(it.face, it.size);
  ctx.textBaseline = 'alphabetic';
  if (ctx.setFace) ctx.setFace(it.face, it.size);
  if (!it.spacing) {
    ctx.fillText(it.s, it.x, it.y);
    return;
  }
  let x = it.x;
  const parts = it.s.split(' ');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) {
      ctx.fillText(parts[i], x, it.y);
      x += textWidth(it.face, parts[i], it.size);
    }
    if (i < parts.length - 1) {
      x += textWidth(it.face, ' ', it.size) + it.spacing;
    }
  }
}

/** The paper itself: white page, hairline edge. Screen only. */
export function drawPaper(ctx, box, opts = {}) {
  ctx.fillStyle = opts.paper || '#FFFFFF';
  ctx.fillRect(0, 0, box.w, box.h);
  if (opts.edge !== false) {
    ctx.fillStyle = opts.edgeColor || '#E3E0DA';
    ctx.fillRect(0, 0, box.w, 0.5);
    ctx.fillRect(0, box.h - 0.5, box.w, 0.5);
    ctx.fillRect(0, 0, 0.5, box.h);
    ctx.fillRect(box.w - 0.5, 0, 0.5, box.h);
  }
}

/** Where in a line's source text does an x coordinate fall? */
export function offsetAtX(line, x) {
  let best = null;
  for (const c of line.chunks) {
    if (c.px === undefined) continue;
    if (c.atomic) {
      // A field is one character wide in the document however wide it looks.
      const mid = c.px + (c.pw || 0) / 2;
      const cand = { off: c.src + (x > mid ? c.len : 0), d: Math.abs(x - (x > mid ? c.px + c.pw : c.px)) };
      if (!best || cand.d < best.d) best = cand;
      continue;
    }
    if (c.tab) {
      for (const [px, off] of [[c.px, c.src], [c.px + c.pw, c.src + c.len]]) {
        const d = Math.abs(x - px);
        if (!best || d < best.d) best = { off, d };
      }
      continue;
    }
    const face = faceOf(c.style.family, c.style.bold, c.style.italic);
    let acc = c.px;
    for (let i = 0; i <= c.text.length; i++) {
      const d = Math.abs(x - acc);
      if (!best || d < best.d) best = { off: c.src + i, d };
      if (i < c.text.length) acc += textWidth(face, c.text[i], c.style.size);
    }
  }
  return best ? best.off : 0;
}

/** The x coordinate of a source offset within a line, or null if not on it. */
export function xAtOffset(line, off) {
  let last = null;
  for (const c of line.chunks) {
    if (c.px === undefined) continue;
    const end = c.src + c.len;
    if (off < c.src) continue;
    if (off > end) { last = c.px + (c.pw || 0); continue; }
    if (c.atomic || c.tab) return off >= end ? c.px + (c.pw || 0) : c.px;
    const face = faceOf(c.style.family, c.style.bold, c.style.italic);
    return c.px + textWidth(face, c.text.slice(0, off - c.src), c.style.size);
  }
  return last;
}

/** The span of a line, in source offsets. */
export function lineRange(line) {
  let lo = Infinity, hi = -Infinity;
  for (const c of line.chunks) {
    if (c.src === undefined) continue;
    lo = Math.min(lo, c.src);
    hi = Math.max(hi, c.src + c.len);
  }
  return lo === Infinity ? { start: 0, end: 0 } : { start: lo, end: hi };
}
