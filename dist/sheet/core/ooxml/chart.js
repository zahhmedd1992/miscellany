/* Grain — chart definitions (DrawingML charts, ECMA-376 part 1 §21.2).
 *
 * A chart part does NOT contain a picture. It contains a set of REFERENCES —
 * `Sheet1!$B$2:$B$7` — plus a cache of the values that were in those cells
 * when the file was last saved. Every other tool treats the cache as the
 * data, which is why an imported chart is a fossil: it shows what the
 * spreadsheet used to say.
 *
 * We keep the references. The chart becomes an ordinary node in the graph
 * that depends on those ranges, so editing a cell moves the chart — by the
 * same dirty-propagation walk that updates =SUM(). The cache is only a
 * fallback for when the referenced sheet is not loaded.
 */

import { scan, elements, firstElement } from './xml.js';

const CHART_KINDS = [
  ['barChart', 'bar'], ['bar3DChart', 'bar'],
  ['lineChart', 'line'], ['line3DChart', 'line'],
  ['pieChart', 'pie'], ['pie3DChart', 'pie'], ['doughnutChart', 'doughnut'],
  ['scatterChart', 'scatter'], ['areaChart', 'area'], ['area3DChart', 'area'],
  ['radarChart', 'line'], ['bubbleChart', 'scatter'],
];

/** All text inside an element, in document order. Chart titles are built from
 *  several <a:t> runs, so taking the first one truncates them. */
function textOf(xml) {
  let s = '';
  for (const ev of scan(xml)) if (ev.type === 'text') s += ev.value();
  return s;
}

/** Cached points: <c:pt idx="3"><c:v>12</c:v></c:pt>, sparse and unordered. */
function cachePoints(xml) {
  if (!xml) return [];
  const out = [];
  for (const pt of elements(xml, 'pt')) {
    const i = parseInt(pt.attr('idx') || '0', 10);
    const v = firstElement(pt.inner(), 'v');
    out[i] = v ? textOf(v.inner()) : '';
  }
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = '';
  return out;
}

/** A <c:cat>/<c:val>/<c:xVal>/<c:yVal> wrapper: a formula plus a cache. */
function refOf(wrapperXml) {
  if (!wrapperXml) return null;
  const f = firstElement(wrapperXml, 'f');
  const cacheEl = firstElement(wrapperXml, 'numCache') || firstElement(wrapperXml, 'strCache');
  return {
    ref: f ? textOf(f.inner()).trim() : null,
    cache: cacheEl ? cachePoints(cacheEl.inner()) : [],
  };
}

/** Series colour: an explicit RGB, or a theme slot we resolve at render time. */
function colorOf(spPrXml) {
  if (!spPrXml) return null;
  const fill = firstElement(spPrXml, 'solidFill');
  const src = fill ? fill.inner() : spPrXml;
  const srgb = firstElement(src, 'srgbClr');
  if (srgb) return { rgb: '#' + srgb.attr('val') };
  const scheme = firstElement(src, 'schemeClr');
  if (scheme) return { scheme: scheme.attr('val') };
  return null;
}

/**
 * Parse a chart part.
 * @returns {{title:string|null, kinds:string[], series:Array, barDir:string,
 *            grouping:string, hasLegend:boolean}}
 */
export function parseChart(xml) {
  if (!xml) return null;
  const spec = {
    title: null, kinds: [], series: [], barDir: 'col',
    grouping: 'clustered', hasLegend: false,
  };

  // <c:title> appears in three places: the chart's own title, and one per
  // axis. Position is NOT a reliable discriminator — Excel writes plotArea
  // FIRST and the chart title after it (offset 747 vs 19810 in one corpus
  // file), so "the title before the plot area" finds nothing at all.
  //
  // The structural rule is what holds: axes live inside <c:plotArea>, so the
  // chart title is the <c:title> that survives removing the plot area.
  const chartEl = firstElement(xml, 'chart');
  if (chartEl) {
    let outer = chartEl.inner();
    const pa = firstElement(outer, 'plotArea');
    if (pa) outer = outer.slice(0, pa.start) + outer.slice(pa.end);
    const t = firstElement(outer, 'title');
    if (t) {
      // Titles are built from several <a:t> runs; taking the first truncates
      // "Land-Based Wind Levelized Cost of Energy" to "Land-Based Wind Levelized".
      const s = textOf(t.inner()).replace(/\s+/g, ' ').trim();
      if (s) spec.title = s;
    }
  }

  spec.hasLegend = /<c:legend[\s>]/.test(xml);

  const plot = firstElement(xml, 'plotArea');
  const body = plot ? plot.inner() : xml;

  // Axis titles are separate from the chart title and carry the units —
  // "Levelized Cost of Energy ($/MWh)". In several corpus charts the axis
  // title is the ONLY title present, so dropping it loses the whole label.
  spec.axisTitles = { x: null, y: null };
  for (const [tag, slot] of [['catAx', 'x'], ['dateAx', 'x'], ['valAx', 'y'], ['serAx', 'x']]) {
    for (const ax of elements(body, tag)) {
      const t = firstElement(ax.inner(), 'title');
      if (!t) continue;
      const s = textOf(t.inner()).replace(/\s+/g, ' ').trim();
      if (!s) continue;
      // A vertical axis title is rotated; use that when a chart has two
      // value axes and no category axis to tell them apart.
      const rot = /rot="(-?\d+)"/.exec(t.inner());
      const vertical = rot && Math.abs(parseInt(rot[1], 10)) === 5400000;
      const key = vertical ? 'y' : slot;
      if (!spec.axisTitles[key]) spec.axisTitles[key] = s;
    }
  }

  for (const [tag, kind] of CHART_KINDS) {
    for (const grp of elements(body, tag)) {
      const g = grp.inner();
      spec.kinds.push(kind);
      const dir = firstElement(g, 'barDir');
      if (dir) spec.barDir = dir.attr('val') || 'col';
      const gr = firstElement(g, 'grouping');
      if (gr) spec.grouping = gr.attr('val') || 'clustered';

      for (const ser of elements(g, 'ser')) {
        const si = ser.inner();
        const tx = firstElement(si, 'tx');
        const cat = firstElement(si, 'cat') || firstElement(si, 'xVal');
        const val = firstElement(si, 'val') || firstElement(si, 'yVal');
        const spPr = firstElement(si, 'spPr');
        const nameRef = tx ? refOf(tx.inner()) : null;
        spec.series.push({
          kind,
          idx: parseInt((firstElement(si, 'idx') || { attr: () => '0' }).attr('val') || '0', 10),
          name: nameRef && nameRef.cache.length ? nameRef.cache[0] : null,
          nameRef: nameRef ? nameRef.ref : null,
          cat: cat ? refOf(cat.inner()) : null,
          val: val ? refOf(val.inner()) : null,
          color: colorOf(spPr ? spPr.inner() : null),
        });
      }
    }
  }
  return spec;
}

/* ---- drawings: where a chart sits on the sheet ------------------------- */

const EMU_PER_PX = 9525;   // 914400 EMU/inch at 96 dpi

function anchorPoint(xml) {
  if (!xml) return null;
  const g = (n) => {
    const e = firstElement(xml, n);
    return e ? parseInt(textOf(e.inner()).trim() || '0', 10) : 0;
  };
  return { col: g('col'), colOff: g('colOff'), row: g('row'), rowOff: g('rowOff') };
}

/**
 * Parse a drawing part into placed graphic frames.
 * @param rels Map of rId -> resolved part path
 * @returns Array<{kind, from, to, x, y, w, h, chartPath}>
 */
export function parseDrawing(xml, rels) {
  if (!xml) return [];
  const out = [];

  const collect = (tag, kind) => {
    for (const a of elements(xml, tag)) {
      const inner = a.inner();
      const frame = firstElement(inner, 'graphicFrame');
      const chartEl = firstElement(inner, 'chart');
      if (!chartEl) continue;
      const rId = chartEl.attr('id');
      const target = rels.get(rId);
      if (!target) continue;

      const fromEl = firstElement(inner, 'from');
      const toEl = firstElement(inner, 'to');
      const posEl = firstElement(inner, 'pos');
      const extEl = firstElement(inner, 'ext');

      out.push({
        kind,
        chartPath: target,
        from: fromEl ? anchorPoint(fromEl.inner()) : null,
        to: toEl ? anchorPoint(toEl.inner()) : null,
        // absoluteAnchor / oneCellAnchor carry pixel-ish extents in EMU
        x: posEl ? Math.round(parseInt(posEl.attr('x') || '0', 10) / EMU_PER_PX) : null,
        y: posEl ? Math.round(parseInt(posEl.attr('y') || '0', 10) / EMU_PER_PX) : null,
        w: extEl ? Math.round(parseInt(extEl.attr('cx') || '0', 10) / EMU_PER_PX) : null,
        h: extEl ? Math.round(parseInt(extEl.attr('cy') || '0', 10) / EMU_PER_PX) : null,
        name: frame ? null : null,
      });
    }
  };

  collect('twoCellAnchor', 'two');
  collect('oneCellAnchor', 'one');
  collect('absoluteAnchor', 'absolute');
  return out;
}

/** "Sheet1!$B$2:$B$7" -> { sheet, ref } with the $ removed. */
export function splitRef(f) {
  if (!f) return null;
  const i = f.lastIndexOf('!');
  if (i < 0) return { sheet: null, ref: f.replace(/\$/g, '') };
  let sheet = f.slice(0, i);
  if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  return { sheet, ref: f.slice(i + 1).replace(/\$/g, '') };
}
