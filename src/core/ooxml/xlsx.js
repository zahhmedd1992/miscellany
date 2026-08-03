/* Grain — .xlsx reader (OOXML / ECMA-376), written against the spec.
 *
 * Read-only. The writer comes next, and comes second deliberately: the
 * format's weirdness is far cheaper to learn on the read side.
 *
 * The whole design serves one property. We do NOT translate a workbook into
 * our model and discard the rest — we model what we understand and KEEP
 * everything else, with its original bytes and its original order, so the
 * writer can put it back untouched. A library that hands you a clean object
 * graph has already thrown away the thing that matters.
 */

import { readZip } from './zip.js';
import { scan, elements, firstElement, local, decode } from './xml.js';
import { Decimal } from '../decimal.js';
import { V, ERR, BLANK } from '../value.js';
import { indexToCol, colToIndex } from '../formula.js';
import { translateFormula } from './refs.js';
import { parseChart, parseDrawing } from './chart.js';
import { serialToISO } from '../dates.js';

/* Built-in number format ids that denote a date and/or time (ECMA-376
 * §18.8.30). There is no date CELL TYPE in xlsx — a date is a number wearing
 * a date format, which is why "it opened my file and turned dates into
 * numbers" is such a common complaint about naive readers. */
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Does a format code render a date or time? Quoted literals don't count. */
export function isDateFormat(code) {
  if (!code) return false;
  let out = '', q = false, br = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') { q = !q; continue; }
    if (q) continue;
    if (c === '[') { br = true; continue; }
    if (c === ']') { br = false; continue; }
    if (br) continue;
    if (c === '\\') { i++; continue; }
    out += c;
  }
  return /[dmyhs]/i.test(out) && !/^[#0.,%eE+\-() ]*$/.test(out);
}

function parseRef(ref) {
  const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(ref);
  if (!m) return null;
  return { col: colToIndex(m[1]), row: parseInt(m[2], 10) - 1 };
}

/* ---- shared strings ---------------------------------------------------- */

function readSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of elements(xml, 'si')) {
    // <si> may hold a single <t>, or rich text as several <r><t> runs.
    // Concatenating the runs is correct; taking only the first is the classic
    // bug that silently truncates every styled string in the workbook.
    let s = '';
    for (const ev of scan(si.inner())) {
      if (ev.type === 'text') s += ev.value();
    }
    out.push(s);
  }
  return out;
}

/* ---- styles ------------------------------------------------------------ */

/* Excel's legacy indexed palette (ECMA-376 §18.8.27). Still emitted by older
 * tools and by LibreOffice; a reader that ignores it renders coloured cells
 * as uncoloured, which looks like the file lost its formatting. */
const INDEXED = ['000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
  '000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
  '800000','008000','000080','808000','800080','008080','C0C0C0','808080',
  '9999FF','993366','FFFFCC','CCFFFF','660066','FF8080','0066CC','CCCCFF',
  '000080','FF00FF','FFFF00','00FFFF','800080','800000','008080','0000FF',
  '00CCFF','CCFFFF','CCFFCC','FFFF99','99CCFF','FF99CC','CC99FF','FFCC99',
  '3366FF','33CCCC','99CC00','FFCC00','FF9900','FF6600','666699','969696',
  '003366','339966','003300','333300','993300','993366','333399','333333'];

/** Apply Excel's tint to a hex colour: positive lightens, negative darkens. */
function applyTint(hex, tint) {
  if (!tint) return hex;
  const n = parseInt(hex, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (c) => {
    const v = tint < 0 ? c * (1 + tint) : c * (1 - tint) + 255 * tint;
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  r = f(r); g = f(g); b = f(b);
  return ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase();
}

function readTheme(xml) {
  // The <clrScheme> order is lt1, dk1, lt2, dk2, accent1..6, hlink, folHlink —
  // but theme index 0 and 1 are SWAPPED relative to document order. Getting
  // this wrong tints every themed cell with the wrong colour.
  const out = [];
  if (!xml) return out;
  const scheme = firstElement(xml, 'clrScheme');
  if (!scheme) return out;
  for (const ev of scan(scheme.inner())) {
    if (ev.type !== 'open') continue;
    if (ev.name === 'srgbClr') out.push(ev.attr('val'));
    else if (ev.name === 'sysClr') out.push(ev.attr('lastClr') || '000000');
  }
  if (out.length >= 4) { const t = out[0]; out[0] = out[1]; out[1] = t; }
  return out;
}

function colorOf(el, theme) {
  if (!el) return null;
  const rgb = el.attr('rgb');
  if (rgb) return '#' + (rgb.length === 8 ? rgb.slice(2) : rgb);
  const th = el.attr('theme');
  if (th !== undefined) {
    const base = theme[parseInt(th, 10)] || '000000';
    return '#' + applyTint(base, parseFloat(el.attr('tint') || '0'));
  }
  const ix = el.attr('indexed');
  if (ix !== undefined) {
    const i = parseInt(ix, 10);
    if (i === 64 || i === 65) return null;        // "automatic"
    return '#' + (INDEXED[i] || '000000');
  }
  return null;
}

/** First direct child element with this local name, or null. */
function child(inner, name) {
  for (const e of elements(inner, name)) return e;
  return null;
}

function readStyles(xml, themeXml) {
  const numFmts = new Map();
  const xfNumFmt = [];
  const xfs = [];
  const fonts = [];
  const fills = [];
  const borders = [];
  const theme = readTheme(themeXml);

  if (!xml) return { numFmts, xfNumFmt, xfs, isDateXf: () => false, styleOf: () => null, formatOf: () => null };

  for (const nf of elements(xml, 'numFmt')) {
    numFmts.set(parseInt(nf.attr('numFmtId'), 10), nf.attr('formatCode') || '');
  }

  const fontsEl = firstElement(xml, 'fonts');
  if (fontsEl) {
    for (const fo of elements(fontsEl.inner(), 'font')) {
      const inner = fo.inner();
      fonts.push({
        bold: !!child(inner, 'b'),
        italic: !!child(inner, 'i'),
        underline: !!child(inner, 'u'),
        strike: !!child(inner, 'strike'),
        size: parseFloat((child(inner, 'sz') || { attr: () => '11' }).attr('val') || '11'),
        color: colorOf(child(inner, 'color'), theme),
        name: (child(inner, 'name') || { attr: () => null }).attr('val'),
      });
    }
  }

  const fillsEl = firstElement(xml, 'fills');
  if (fillsEl) {
    for (const fl of elements(fillsEl.inner(), 'fill')) {
      const pf = child(fl.inner(), 'patternFill');
      if (!pf) { fills.push(null); continue; }
      const type = pf.attr('patternType');
      if (!type || type === 'none') { fills.push(null); continue; }
      const fg = colorOf(child(pf.inner(), 'fgColor'), theme);
      const bg = colorOf(child(pf.inner(), 'bgColor'), theme);
      fills.push({ type, color: type === 'solid' ? fg : (fg || bg) });
    }
  }

  const bordersEl = firstElement(xml, 'borders');
  if (bordersEl) {
    for (const bo of elements(bordersEl.inner(), 'border')) {
      const inner = bo.inner();
      const edge = (n) => {
        const e = child(inner, n);
        if (!e) return null;
        const style = e.attr('style');
        if (!style || style === 'none') return null;
        return { style, color: colorOf(child(e.inner(), 'color'), theme) || '#000000' };
      };
      borders.push({ left: edge('left'), right: edge('right'), top: edge('top'), bottom: edge('bottom') });
    }
  }

  const cellXfs = firstElement(xml, 'cellXfs');
  if (cellXfs) {
    for (const xf of elements(cellXfs.inner(), 'xf')) {
      const numFmtId = parseInt(xf.attr('numFmtId') || '0', 10);
      xfNumFmt.push(numFmtId);
      const al = child(xf.inner(), 'alignment');
      xfs.push({
        numFmtId,
        fontId: parseInt(xf.attr('fontId') || '0', 10),
        fillId: parseInt(xf.attr('fillId') || '0', 10),
        borderId: parseInt(xf.attr('borderId') || '0', 10),
        align: al ? {
          h: al.attr('horizontal') || null,
          v: al.attr('vertical') || null,
          wrap: al.attr('wrapText') === '1',
          indent: parseInt(al.attr('indent') || '0', 10),
        } : null,
      });
    }
  }

  const dateCache = new Map();
  const isDateXf = (s) => {
    const i = s === undefined || s === '' ? 0 : parseInt(s, 10);
    if (!Number.isFinite(i) || i < 0 || i >= xfNumFmt.length) return false;
    const id = xfNumFmt[i];
    if (dateCache.has(id)) return dateCache.get(id);
    const r = BUILTIN_DATE_FMT.has(id) || isDateFormat(numFmts.get(id));
    dateCache.set(id, r);
    return r;
  };

  /** Resolve a cell's style index to everything the renderer needs. */
  const styleOf = (s) => {
    const i = s === undefined || s === '' ? 0 : parseInt(s, 10);
    const xf = xfs[i];
    if (!xf) return null;
    return {
      font: fonts[xf.fontId] || null,
      fill: fills[xf.fillId] || null,
      border: borders[xf.borderId] || null,
      align: xf.align,
      numFmtId: xf.numFmtId,
    };
  };

  /** The format CODE for a cell's style index. Built-ins are not in the file. */
  const formatOf = (s) => {
    const i = s === undefined || s === '' ? 0 : parseInt(s, 10);
    const xf = xfs[i];
    const id = xf ? xf.numFmtId : 0;
    return numFmts.has(id) ? numFmts.get(id) : null;   // null => caller uses BUILTIN[id]
  };

  return { numFmts, xfNumFmt, xfs, fonts, fills, borders, theme, isDateXf, styleOf, formatOf,
           numFmtIdOf: (s) => { const i = s === undefined || s === '' ? 0 : parseInt(s, 10);
                                return xfs[i] ? xfs[i].numFmtId : 0; } };
}

/* Date-serial conversion lives in core/dates.js — it is arithmetic, not
 * OOXML, and the number-format engine needs it without dragging the whole
 * file reader in as a dependency of DISPLAY. */


/* ---- the workbook ------------------------------------------------------ */

export class Workbook {
  constructor(zip) {
    this.zip = zip;              // retained IN FULL — this is preserve-unknown
    this.sheets = [];            // [{ name, path, sheetId, rId, state }]
    this.sharedStrings = [];
    this.styles = null;
    this.date1904 = false;
    this.definedNames = [];
    this.warnings = [];
  }

  /** Parts we understand. Everything else is retained and never touched. */
  modelledParts() {
    const s = new Set(['xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/styles.xml']);
    for (const sh of this.sheets) s.add(sh.path);
    return s;
  }

  unmodelledParts() {
    const m = this.modelledParts();
    return this.zip.names().filter((n) => !m.has(n));
  }
}

async function relsFor(zip, partPath) {
  const i = partPath.lastIndexOf('/');
  const dir = i < 0 ? '' : partPath.slice(0, i);
  const base = partPath.slice(i + 1);
  const relPath = `${dir}/_rels/${base}.rels`;
  const xml = await zip.text(relPath);
  const map = new Map();
  if (!xml) return map;
  for (const r of elements(xml, 'Relationship')) {
    map.set(r.attr('Id'), { target: r.attr('Target'), type: r.attr('Type') });
  }
  return map;
}

function resolveTarget(base, target) {
  if (!target) return null;
  if (target.startsWith('/')) return target.slice(1);
  const i = base.lastIndexOf('/');
  const dir = i < 0 ? '' : base.slice(0, i);
  const parts = (dir ? dir.split('/') : []).concat(target.split('/'));
  const out = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/** Open a .xlsx from bytes. Does not read cell data — call readSheet(). */
export async function openXlsx(bytes) {
  const zip = await readZip(bytes);
  const wb = new Workbook(zip);

  // The workbook part is normally xl/workbook.xml, but the package
  // relationships are authoritative. Trusting the conventional path is how a
  // reader fails on files that are perfectly valid.
  let wbPath = 'xl/workbook.xml';
  const rootXml = await zip.text('_rels/.rels');
  if (rootXml) {
    for (const r of elements(rootXml, 'Relationship')) {
      const t = r.attr('Type') || '';
      if (t.endsWith('/officeDocument')) wbPath = resolveTarget('', r.attr('Target'));
    }
  }
  wb.workbookPath = wbPath;

  const wbXml = await zip.text(wbPath);
  if (!wbXml) throw new Error('no workbook part');

  const pr = firstElement(wbXml, 'workbookPr');
  if (pr) {
    const d = pr.attr('date1904');
    wb.date1904 = d === '1' || d === 'true';
  }

  const rels = await relsFor(zip, wbPath);
  const sheetsEl = firstElement(wbXml, 'sheets');
  if (sheetsEl) {
    for (const sh of elements(sheetsEl.inner(), 'sheet')) {
      const rId = sh.attr('id');                 // r:id -> local name 'id'
      const rel = rels.get(rId);
      const path = rel ? resolveTarget(wbPath, rel.target) : null;
      // <sheets> lists more than worksheets. A CHART SHEET is a full-page
      // chart with no grid and no <sheetData> at all; a dialog sheet is a
      // form. Treating everything in <sheets> as a worksheet makes any code
      // that assumes a grid throw on a perfectly valid file.
      const relType = rel ? (rel.type || '') : '';
      const kind = relType.endsWith('/chartsheet') ? 'chart'
        : relType.endsWith('/dialogsheet') ? 'dialog'
        : 'worksheet';
      wb.sheets.push({
        name: sh.attr('name') || '',
        sheetId: sh.attr('sheetId'),
        state: sh.attr('state') || 'visible',
        kind,
        rId, path,
      });
      if (!path) wb.warnings.push(`sheet "${sh.attr('name')}" has no resolvable target`);
    }
  }

  const dn = firstElement(wbXml, 'definedNames');
  if (dn) {
    for (const d of elements(dn.inner(), 'definedName')) {
      wb.definedNames.push({ name: d.attr('name'), value: d.inner().trim() });
    }
  }

  // sharedStrings / styles paths also come from relationships where present
  let ssPath = null, stPath = null;
  for (const [, r] of rels) {
    if ((r.type || '').endsWith('/sharedStrings')) ssPath = resolveTarget(wbPath, r.target);
    if ((r.type || '').endsWith('/styles')) stPath = resolveTarget(wbPath, r.target);
  }
  wb.sharedStrings = readSharedStrings(await zip.text(ssPath || 'xl/sharedStrings.xml'));
  // Theme colours are in a separate part; styles reference them by index.
  // Without it, every themed fill and font resolves to black.
  const themeName = zip.names().find((n) => /^xl\/theme\/theme\d*\.xml$/.test(n));
  wb.styles = readStyles(await zip.text(stPath || 'xl/styles.xml'),
                         themeName ? await zip.text(themeName) : null);
  wb.sharedStringsPath = ssPath || 'xl/sharedStrings.xml';
  wb.stylesPath = stPath || 'xl/styles.xml';

  return wb;
}

/**
 * Read one sheet's cells.
 * @returns {{cells: Array, maxCol:number, maxRow:number, merges:string[]}}
 *   cell = { ref, col, row, kind, value, formula, styleIndex, isDate }
 */
export async function readSheet(wb, sheet) {
  // A chart sheet has no grid. Returning an empty result is right; throwing
  // "no sheetData" at the caller is not.
  if (sheet.kind && sheet.kind !== 'worksheet') return { cells: [], maxCol: -1, maxRow: -1, merges: [], kind: sheet.kind };
  const xml = await wb.zip.text(sheet.path);
  if (xml === null) return { cells: [], maxCol: -1, maxRow: -1, merges: [] };

  const cells = [];
  let maxCol = -1, maxRow = -1;

  const sheetDataEl = firstElement(xml, 'sheetData');
  const data = sheetDataEl ? sheetDataEl.inner() : '';

  // Walk cells with the scanner rather than a regex: attribute values can
  // contain '>' and inline strings can contain anything.
  let cur = null, inV = false, inF = false, inIs = false;
  let vBuf = '', fBuf = '', isBuf = '';
  const sharedMasters = new Map();          // si -> { text, col, row }
  const deferred = [];                       // refs seen before their anchor
  const sharedExpanded = { count: 0, pending: 0 };

  for (const ev of scan(data)) {
    if (ev.type === 'open') {
      switch (ev.name) {
        case 'c': {
          const ref = ev.attr('r');
          const pos = ref ? parseRef(ref) : null;
          cur = {
            ref: ref || null,
            col: pos ? pos.col : (cur ? cur.col + 1 : 0),
            row: pos ? pos.row : (cur ? cur.row : 0),
            t: ev.attr('t') || 'n',
            s: ev.attr('s'),
          };
          vBuf = fBuf = isBuf = '';
          if (ev.selfClosing) { flush(); }
          break;
        }
        case 'v':  if (!ev.selfClosing) inV = true; break;
        case 'f': {
          // A shared formula is written ONCE, on the anchor cell, as
          //   <f t="shared" ref="J24:J28" si="0">…</f>
          // and every other cell in the range carries only
          //   <f t="shared" si="0"/>
          // with no text at all. Treating a text-less <f> as "no formula"
          // drops them silently — 116,491 of 233,410 formulas in one corpus
          // workbook, which still opens, still looks right, and is wrong.
          if (cur) {
            cur.fType = ev.attr('t') || null;
            cur.fSi = ev.attr('si');
            cur.fRef = ev.attr('ref');
          }
          if (!ev.selfClosing) inF = true;
          break;
        }
        case 'is': if (!ev.selfClosing) inIs = true; break;
      }
    } else if (ev.type === 'text') {
      if (inV) vBuf += ev.value();
      else if (inF) fBuf += ev.value();
      else if (inIs) isBuf += ev.value();
    } else if (ev.type === 'close') {
      switch (ev.name) {
        case 'v':  inV = false; break;
        case 'f':  inF = false; break;
        case 'is': inIs = false; break;
        case 'c':  flush(); break;
      }
    }
  }

  function flush() {
    if (!cur) return;
    const c = cur; cur = null;

    let formula = fBuf ? fBuf : null;
    let deferSi = null;
    if (c.fType === 'shared' && c.fSi !== undefined) {
      if (formula) {
        // This is the anchor: remember it for the rest of its range.
        sharedMasters.set(c.fSi, { text: formula, col: c.col, row: c.row });
      } else {
        const m = sharedMasters.get(c.fSi);
        if (m) formula = translateFormula(m.text, c.col - m.col, c.row - m.row);
        else deferSi = c.fSi;
      }
      if (formula) sharedExpanded.count++;
    }

    const out = {
      ref: c.ref || `${indexToCol(c.col)}${c.row + 1}`,
      col: c.col, row: c.row,
      styleIndex: c.s,
      formula,
      shared: c.fType === 'shared' ? c.fSi : undefined,
      kind: 'blank', value: null, isDate: false,
    };
    const raw = vBuf;

    switch (c.t) {
      case 's': {
        const i = parseInt(raw, 10);
        out.kind = 'text';
        out.value = wb.sharedStrings[i] !== undefined ? wb.sharedStrings[i] : '';
        if (wb.sharedStrings[i] === undefined && raw !== '') {
          wb.warnings.push(`shared string index ${i} out of range on ${sheet.name}!${out.ref}`);
        }
        break;
      }
      case 'inlineStr':
        out.kind = 'text'; out.value = isBuf;
        break;
      case 'str':                       // cached string result of a formula
        out.kind = 'text'; out.value = decode(raw);
        break;
      case 'b':
        out.kind = 'bool'; out.value = raw === '1' || raw === 'true';
        break;
      case 'e':
        out.kind = 'error'; out.value = raw;
        break;
      case 'd':                          // ISO 8601 date (rare, strict OOXML)
        out.kind = 'date'; out.value = raw; out.isDate = true;
        break;
      default: {                         // 'n' or absent
        if (raw === '') { out.kind = 'blank'; break; }
        const d = Decimal.fromString(raw);
        if (d === null) { out.kind = 'text'; out.value = raw; break; }
        out.kind = 'number'; out.value = d;
        if (wb.styles.isDateXf(c.s)) {
          out.isDate = true;
          out.dateISO = serialToISO(Number(raw), wb.date1904);
        }
      }
    }

    // Resolve presentation once, here, rather than per repaint.
    if (c.s !== undefined && wb.styles.styleOf) {
      out.style = wb.styles.styleOf(c.s);
      out.numFmt = wb.styles.formatOf(c.s);
      out.numFmtId = wb.styles.numFmtIdOf ? wb.styles.numFmtIdOf(c.s) : 0;
    }

    if (out.kind !== 'blank' || out.formula || deferSi !== null) {
      // Register the deferral AFTER the push, so the index is the real one.
      // Deriving it from cells.length beforehand is wrong for any cell the
      // push condition then skips — an off-by-one that would attach a
      // formula to the wrong cell, which is worse than dropping it.
      cells.push(out);
      if (deferSi !== null) { deferred.push({ si: deferSi, idx: cells.length - 1 }); sharedExpanded.pending++; }
      if (out.col > maxCol) maxCol = out.col;
      if (out.row > maxRow) maxRow = out.row;
    }
  }

  // The spec puts the anchor first, but a file is not obliged to be sane.
  // Resolve any reference that arrived before its master rather than
  // dropping it.
  for (const d of deferred) {
    const cell = cells[d.idx];
    const m = sharedMasters.get(d.si);
    if (cell && m && !cell.formula) {
      cell.formula = translateFormula(m.text, cell.col - m.col, cell.row - m.row);
      sharedExpanded.count++;
      sharedExpanded.pending--;
    }
  }
  if (sharedExpanded.pending > 0) {
    wb.warnings.push(`${sheet.name}: ${sharedExpanded.pending} shared-formula refs had no anchor`);
  }

  const merges = [];
  const mc = firstElement(xml, 'mergeCells');
  if (mc) for (const m of elements(mc.inner(), 'mergeCell')) merges.push(m.attr('ref'));

  // Column widths are declared as SPANS (min..max), not per column, and the
  // unit is "characters of the default font" — not pixels. Ignoring them is
  // why an imported sheet shows "New Privately-O" where the file says the
  // column is 40 characters wide.
  const colWidths = new Map();
  // A sheet may declare its own default width; honour it before falling back.
  const fmtPr = firstElement(xml, 'sheetFormatPr');
  if (fmtPr) {
    const dw = parseFloat(fmtPr.attr('defaultColWidth') || '0');
    if (dw > 0) colWidths.set(-1, Math.trunc(((256 * dw + Math.trunc(128 / 7)) / 256) * 7));
  }
  const colsEl = firstElement(xml, 'cols');
  if (colsEl) {
    for (const c of elements(colsEl.inner(), 'col')) {
      const w = parseFloat(c.attr('width') || '0');
      if (!w) continue;
      const lo = parseInt(c.attr('min') || '1', 10), hi = parseInt(c.attr('max') || lo, 10);
      // ECMA-376 §18.3.1.13: px = trunc(((256*w + trunc(128/MDW))/256) * MDW),
      // MDW = max digit width of the default font = 7px at Calibri 11.
      const MDW = 7;
      const px = Math.trunc(((256 * w + Math.trunc(128 / MDW)) / 256) * MDW);
      for (let i = lo; i <= Math.min(hi, 16384); i++) colWidths.set(i - 1, px);
    }
  }

  const rowHeights = new Map();
  const sdEl = firstElement(xml, 'sheetData');
  if (sdEl) {
    for (const r of elements(sdEl.inner(), 'row')) {
      // `ht` is authoritative whenever present. `customHeight` only records
      // whether the USER set it rather than it being auto-fitted — Excel
      // honours the height either way, and gating on it renders a 48pt
      // header row at the 15pt default.
      const ht = r.attr('ht');
      if (ht) {
        rowHeights.set(parseInt(r.attr('r') || '0', 10) - 1, Math.round(parseFloat(ht) * 96 / 72));
      }
    }
  }

  return { cells, maxCol, maxRow, merges, colWidths, rowHeights,
           sharedExpanded: sharedExpanded.count };
}

/** Load a workbook into a Grain graph. Sheet names become node id prefixes. */
export async function loadIntoGraph(wb, graph, { sheetPrefix = (n) => n } = {}) {
  let total = 0;
  const data = {};
  for (const sheet of wb.sheets) {
    if (!sheet.path) continue;
    const { cells } = await readSheet(wb, sheet);
    const p = sheetPrefix(sheet.name);
    for (const c of cells) {
      const id = `${p}!${c.ref}`;
      if (c.formula) { data[id] = '=' + c.formula; }
      else if (c.kind === 'text') data[id] = "'" + c.value;
      else if (c.kind === 'number') data[id] = c.isDate && c.dateISO ? "'" + c.dateISO : c.value.toString();
      else if (c.kind === 'bool') data[id] = c.value ? 'TRUE' : 'FALSE';
      else if (c.kind === 'error') data[id] = c.value;
      else if (c.kind === 'date') data[id] = "'" + c.value;
      total++;
    }
  }
  graph.loadJSON(data);
  return total;
}

export { serialToISO };

/* ---- charts placed on a sheet ------------------------------------------ */

/**
 * Every chart anchored on this worksheet, with its position and its spec.
 * Returns [] for sheets with no drawing — which is most of them.
 */
export async function readSheetCharts(wb, sheet) {
  if (!sheet.path || (sheet.kind && sheet.kind !== 'worksheet' && sheet.kind !== 'chart')) return [];
  const xml = await wb.zip.text(sheet.path);
  if (!xml) return [];

  const rels = await relsFor(wb.zip, sheet.path);
  const out = [];
  // A sheet may reference several drawings; each drawing may hold several
  // charts. Both are normal, and assuming one of each loses the rest.
  for (const el of elements(xml, 'drawing')) {
    const rel = rels.get(el.attr('id'));
    if (!rel) continue;
    const drawPath = resolveTarget(sheet.path, rel.target);
    const drawXml = await wb.zip.text(drawPath);
    if (!drawXml) continue;

    const drawRels = await relsFor(wb.zip, drawPath);
    const idToPath = new Map();
    for (const [id, r] of drawRels) idToPath.set(id, resolveTarget(drawPath, r.target));

    for (const frame of parseDrawing(drawXml, idToPath)) {
      const spec = parseChart(await wb.zip.text(frame.chartPath));
      if (spec) out.push({ frame, spec, path: frame.chartPath });
    }
  }
  return out;
}
