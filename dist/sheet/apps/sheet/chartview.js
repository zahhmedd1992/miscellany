/* Grain — chart rendering.
 *
 * Draws a parsed chart spec into a box on the canvas. Values come from a
 * `resolve(ref)` callback rather than from the file's cache, so a chart shows
 * what the spreadsheet says NOW. The cache is the fallback for references we
 * cannot resolve — a sheet that is not loaded, or a `#REF!` left behind by an
 * edit made years ago (four charts in the corpus are exactly that).
 */

const PAD = 10;
const TITLE_H = 22;
const AXIS_L = 54;
const AXIS_B = 34;
const LEGEND_H = 20;

/* Office's default accent palette, used when a series says schemeClr accent1.
 * A workbook's own theme overrides this; this is the fallback so a chart is
 * never drawn in undifferentiated grey. */
const ACCENTS = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
const INK = '#211C16';
const MUTED = '#6C6356';
const GRID = '#E3E0DA';

function seriesColor(s, i, theme) {
  if (s.color && s.color.rgb) return s.color.rgb;
  if (s.color && s.color.scheme) {
    const m = /^accent(\d)$/.exec(s.color.scheme);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (theme && theme[idx + 4]) return '#' + theme[idx + 4];
      return ACCENTS[idx % ACCENTS.length];
    }
    if (/^(tx|dk)\d?$/.test(s.color.scheme)) return '#44546A';
    if (/^(bg|lt)\d?$/.test(s.color.scheme)) return '#D9D9D9';
  }
  return ACCENTS[i % ACCENTS.length];
}

/** Pick round axis ticks covering [lo, hi]. */
function ticks(lo, hi, target = 5) {
  if (!isFinite(lo) || !isFinite(hi)) return { lo: 0, hi: 1, step: 1 };
  if (lo === hi) { lo = Math.min(0, lo); hi = hi === 0 ? 1 : hi * 1.2; }
  const span = hi - lo;
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

function fmtTick(v, step) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  const dec = step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 0;
  return v.toFixed(dec);
}

/**
 * @param ctx      canvas 2d context
 * @param spec     from parseChart()
 * @param box      {x, y, w, h}
 * @param resolve  (ref) => (number|string|null)[]  — live values, or null
 * @param theme    optional array of theme colours (hex, no '#')
 */
export function drawChart(ctx, spec, box, resolve, theme) {
  const { x, y, w, h } = box;
  if (w < 40 || h < 30) return;

  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  // resolve every series against live data, falling back to the saved cache
  const series = [];
  for (let i = 0; i < spec.series.length; i++) {
    const s = spec.series[i];
    let vals = null;
    if (s.val && s.val.ref && !/#REF!/.test(s.val.ref)) vals = resolve(s.val.ref);
    if (!vals || !vals.length) vals = s.val ? s.val.cache : [];
    const nums = vals.map((v) => {
      const n = typeof v === 'number' ? v : parseFloat(v);
      return Number.isFinite(n) ? n : null;
    });
    if (!nums.some((n) => n !== null)) continue;
    series.push({ ...s, nums, color: seriesColor(s, i, theme) });
  }

  let cats = [];
  const first = spec.series.find((s) => s.cat && (s.cat.ref || s.cat.cache.length));
  if (first) {
    let c = null;
    if (first.cat.ref && !/#REF!/.test(first.cat.ref)) c = resolve(first.cat.ref);
    cats = (c && c.length ? c : first.cat.cache).map((v) => (v === null || v === undefined ? '' : String(v)));
  }

  let top = y + PAD;
  ctx.textBaseline = 'middle';
  if (spec.title) {
    ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    const t = fit(ctx, spec.title, w - PAD * 2);
    ctx.fillText(t, x + w / 2, top + 8);
    top += TITLE_H;
  }

  if (!series.length) {
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    ctx.fillText('no data in range', x + w / 2, y + h / 2);
    ctx.restore();
    return;
  }

  const legendH = spec.hasLegend && series.length > 1 ? LEGEND_H : 0;
  const kind = spec.kinds[0] || 'bar';

  if (kind === 'pie' || kind === 'doughnut') {
    drawPie(ctx, series, cats, { x: x + PAD, y: top, w: w - PAD * 2, h: y + h - top - PAD - legendH }, kind);
  } else {
    const plot = {
      x: x + AXIS_L,
      y: top,
      w: w - AXIS_L - PAD,
      h: y + h - top - AXIS_B - legendH,
    };
    if (plot.w > 20 && plot.h > 20) {
      drawAxes(ctx, spec, series, cats, plot);
      if (kind === 'line') drawLines(ctx, series, plot, cats.length);
      else if (kind === 'area') drawAreas(ctx, spec, series, plot, cats.length);
      else drawBars(ctx, spec, series, plot, cats.length);
    }
  }

  if (legendH) drawLegend(ctx, series, x, y + h - legendH, w);
  ctx.restore();
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

/* ---- scales ---- */

function extent(spec, series) {
  const stacked = /stacked/i.test(spec.grouping || '');
  let lo = 0, hi = 0;
  const n = Math.max(...series.map((s) => s.nums.length), 0);
  if (stacked) {
    for (let i = 0; i < n; i++) {
      let pos = 0, neg = 0;
      for (const s of series) {
        const v = s.nums[i];
        if (v === null || v === undefined) continue;
        if (v >= 0) pos += v; else neg += v;
      }
      hi = Math.max(hi, pos); lo = Math.min(lo, neg);
    }
  } else {
    for (const s of series) for (const v of s.nums) {
      if (v === null || v === undefined) continue;
      hi = Math.max(hi, v); lo = Math.min(lo, v);
    }
  }
  return ticks(lo, hi);
}

function drawAxes(ctx, spec, series, cats, p) {
  const t = extent(spec, series);
  p.scale = t;
  const yOf = (v) => p.y + p.h - ((v - t.lo) / (t.hi - t.lo)) * p.h;

  ctx.font = '10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.fillStyle = MUTED;

  for (let v = t.lo; v <= t.hi + t.step / 2; v += t.step) {
    const gy = Math.round(yOf(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(p.x, gy); ctx.lineTo(p.x + p.w, gy); ctx.stroke();
    ctx.fillText(fmtTick(v, t.step), p.x - 6, yOf(v));
  }

  // category labels, thinned so they never collide
  if (cats.length) {
    const bw = p.w / cats.length;
    const every = Math.max(1, Math.ceil((cats.length * 46) / p.w));
    ctx.textAlign = 'center';
    for (let i = 0; i < cats.length; i += every) {
      const label = fit(ctx, String(cats[i]), bw * every - 4);
      ctx.fillText(label, p.x + bw * (i + 0.5), p.y + p.h + 12);
    }
  }

  if (spec.axisTitles && spec.axisTitles.y) {
    ctx.save();
    ctx.translate(p.x - AXIS_L + 12, p.y + p.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.font = '10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = MUTED;
    ctx.fillText(fit(ctx, spec.axisTitles.y, p.h), 0, 0);
    ctx.restore();
  }
}

/* ---- marks ---- */

function drawBars(ctx, spec, series, p, catCount) {
  const t = p.scale;
  const n = Math.max(catCount, ...series.map((s) => s.nums.length));
  if (!n) return;
  const stacked = /stacked/i.test(spec.grouping || '');
  const yOf = (v) => p.y + p.h - ((v - t.lo) / (t.hi - t.lo)) * p.h;
  const slot = p.w / n;
  const gap = Math.min(6, slot * 0.2);
  const bw = stacked ? slot - gap : (slot - gap) / series.length;

  for (let i = 0; i < n; i++) {
    let accPos = 0, accNeg = 0;
    for (let k = 0; k < series.length; k++) {
      const v = series[k].nums[i];
      if (v === null || v === undefined) continue;
      ctx.fillStyle = series[k].color;
      let x0, y0, y1;
      if (stacked) {
        x0 = p.x + slot * i + gap / 2;
        const base = v >= 0 ? accPos : accNeg;
        y0 = yOf(base + v); y1 = yOf(base);
        if (v >= 0) accPos += v; else accNeg += v;
      } else {
        x0 = p.x + slot * i + gap / 2 + bw * k;
        y0 = yOf(Math.max(v, t.lo < 0 ? 0 : t.lo));
        y1 = yOf(v < 0 ? 0 : t.lo < 0 ? 0 : t.lo);
        if (v < 0) { y0 = yOf(0); y1 = yOf(v); }
      }
      const hgt = Math.max(1, Math.abs(y1 - y0));
      ctx.fillRect(x0, Math.min(y0, y1), Math.max(1, bw - 1), hgt);
    }
  }
}

function drawLines(ctx, series, p, catCount) {
  const t = p.scale;
  const n = Math.max(catCount, ...series.map((s) => s.nums.length));
  if (n < 1) return;
  const yOf = (v) => p.y + p.h - ((v - t.lo) / (t.hi - t.lo)) * p.h;
  const xOf = (i) => p.x + (n === 1 ? p.w / 2 : (p.w * i) / (n - 1));

  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = s.nums[i];
      // A gap in the data is a GAP, not a zero. Joining across it invents a
      // trend line through values that do not exist.
      if (v === null || v === undefined) { started = false; continue; }
      const px = xOf(i), py = yOf(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

function drawAreas(ctx, spec, series, p, catCount) {
  const t = p.scale;
  const n = Math.max(catCount, ...series.map((s) => s.nums.length));
  if (n < 2) return;
  const yOf = (v) => p.y + p.h - ((v - t.lo) / (t.hi - t.lo)) * p.h;
  const xOf = (i) => p.x + (p.w * i) / (n - 1);
  for (const s of series) {
    ctx.fillStyle = s.color + 'aa';
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(0));
    for (let i = 0; i < n; i++) {
      const v = s.nums[i];
      ctx.lineTo(xOf(i), yOf(v === null || v === undefined ? 0 : v));
    }
    ctx.lineTo(xOf(n - 1), yOf(0));
    ctx.closePath();
    ctx.fill();
  }
}

function drawPie(ctx, series, cats, p, kind) {
  const s = series[0];
  if (!s) return;
  const total = s.nums.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (!total) return;
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  const r = Math.max(8, Math.min(p.w, p.h) / 2 - 8);
  let a0 = -Math.PI / 2;
  for (let i = 0; i < s.nums.length; i++) {
    const v = s.nums[i];
    if (!(v > 0)) continue;
    const a1 = a0 + (v / total) * Math.PI * 2;
    ctx.fillStyle = ACCENTS[i % ACCENTS.length];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fill();
    a0 = a1;
  }
  if (kind === 'doughnut') {
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2); ctx.fill();
  }
  void cats;
}

function drawLegend(ctx, series, x, y, w) {
  ctx.font = '10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const items = series.map((s, i) => ({ label: s.name || `Series ${i + 1}`, color: s.color }));
  let total = 0;
  for (const it of items) total += ctx.measureText(it.label).width + 26;
  let cx = x + Math.max(6, (w - total) / 2);
  for (const it of items) {
    if (cx > x + w - 30) break;
    ctx.fillStyle = it.color;
    ctx.fillRect(cx, y + 5, 9, 9);
    ctx.fillStyle = MUTED;
    ctx.fillText(it.label, cx + 13, y + 10);
    cx += ctx.measureText(it.label).width + 26;
  }
}
