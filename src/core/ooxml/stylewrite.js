/* Grain — creating styles.
 *
 * A cell does not carry its formatting. It carries an INDEX into `cellXfs`,
 * and each xf points at a font, a fill, a border and a number format. So
 * "make this bold" is really "find or create an xf identical to this one but
 * with a bold font, and point the cell at it."
 *
 * We APPEND by splicing, exactly as we do for sheets: new elements go in
 * before the closing tag and the `count=` attributes are bumped. Everything
 * already in styles.xml — the 1,300 styles a real workbook carries, the
 * dxfs, the table styles, the extLst — comes back byte-for-byte. Rebuilding
 * the part from a model would discard every one of them.
 */

import { elements, firstElement, encodeAttr } from './xml.js';
import { detectPrefix } from './edit.js';

/** Built-in number format ids we can reference without declaring them. */
export const BUILTIN_IDS = {
  general: 0, integer: 1, twoDecimals: 2, comma: 3, commaTwo: 4,
  percent: 9, percentTwo: 10, scientific: 11,
  dateShort: 14, dateMedium: 15, time: 21, dateTime: 22,
  currency: 44, currencyRed: 8,
};

const FIRST_CUSTOM_FMT = 164;   // ECMA-376: ids below this are reserved

function countOf(xml, tag) {
  const el = firstElement(xml, tag);
  if (!el) return 0;
  const c = el.attr('count');
  if (c !== undefined) return parseInt(c, 10);
  let n = 0;
  const childTag = tag === 'cellXfs' ? 'xf' : tag.replace(/s$/, '');
  for (const _ of elements(el.inner(), childTag)) n++;   // eslint-disable-line
  return n;
}

/**
 * A splice-based editor for styles.xml.
 *
 * Usage:
 *   const st = new StyleTable(xml);
 *   const idx = st.derive(existingXfIndex, { bold: true });
 *   const newXml = st.serialize();     // null when nothing was added
 */
export class StyleTable {
  constructor(xml) {
    this.xml = xml || DEFAULT_STYLES;
    this.p = detectPrefix(this.xml) ? detectPrefix(this.xml) + ':' : '';
    // styles.xml has no <worksheet>, so detectPrefix cannot see it there.
    const m = /<([A-Za-z_][\w.-]*):styleSheet[\s>]/.exec(this.xml);
    this.p = m ? m[1] + ':' : '';

    this.newFonts = [];
    this.newFills = [];
    this.newBorders = [];
    this.newXfs = [];
    this.newFmts = [];
    this.dirty = false;

    this.fontCount = countOf(this.xml, 'fonts');
    this.fillCount = countOf(this.xml, 'fills');
    this.borderCount = countOf(this.xml, 'borders');
    this.xfCount = countOf(this.xml, 'cellXfs');

    // index existing xfs so an identical request reuses one instead of
    // growing the table on every keystroke
    this.xfs = [];
    const cx = firstElement(this.xml, 'cellXfs');
    if (cx) {
      for (const xf of elements(cx.inner(), 'xf')) {
        const al = firstElement(xf.inner(), 'alignment');
        this.xfs.push({
          numFmtId: +(xf.attr('numFmtId') || 0),
          fontId: +(xf.attr('fontId') || 0),
          fillId: +(xf.attr('fillId') || 0),
          borderId: +(xf.attr('borderId') || 0),
          horizontal: al ? (al.attr('horizontal') || null) : null,
          wrap: al ? al.attr('wrapText') === '1' : false,
        });
      }
    }

    this.fonts = [];
    const fo = firstElement(this.xml, 'fonts');
    if (fo) {
      for (const f of elements(fo.inner(), 'font')) {
        const inner = f.inner();
        const child = (n) => { for (const e of elements(inner, n)) return e; return null; };
        const sz = child('sz'), col = child('color'), nm = child('name');
        this.fonts.push({
          bold: !!child('b'), italic: !!child('i'), underline: !!child('u'),
          size: sz ? sz.attr('val') : '11',
          color: col ? (col.attr('rgb') || (col.attr('theme') !== undefined ? 'theme:' + col.attr('theme') : null)) : null,
          name: nm ? nm.attr('val') : 'Calibri',
        });
      }
    }

    this.fills = [];
    const fl = firstElement(this.xml, 'fills');
    if (fl) {
      for (const f of elements(fl.inner(), 'fill')) {
        const pf = (() => { for (const e of elements(f.inner(), 'patternFill')) return e; return null; })();
        if (!pf) { this.fills.push(null); continue; }
        const type = pf.attr('patternType') || 'none';
        const fg = (() => { for (const e of elements(pf.inner(), 'fgColor')) return e; return null; })();
        this.fills.push(type === 'none' ? null : { type, rgb: fg ? (fg.attr('rgb') || null) : null });
      }
    }

    this.borders = [];
    const bd = firstElement(this.xml, 'borders');
    if (bd) {
      for (const b of elements(bd.inner(), 'border')) {
        const inner = b.inner();
        const edge = (n) => {
          for (const e of elements(inner, n)) {
            const st = e.attr('style');
            return st && st !== 'none' ? st : null;
          }
          return null;
        };
        this.borders.push({ left: edge('left'), right: edge('right'), top: edge('top'), bottom: edge('bottom') });
      }
    }

    this.customFmts = new Map();     // code -> id
    for (const nf of elements(this.xml, 'numFmt')) {
      this.customFmts.set(nf.attr('formatCode') || '', parseInt(nf.attr('numFmtId'), 10));
    }
    this.nextFmtId = Math.max(FIRST_CUSTOM_FMT - 1, ...[...this.customFmts.values()]) + 1;
  }

  /** Index of a font matching `want`, creating one if needed. */
  fontFor(want) {
    const same = (f) => f.bold === !!want.bold && f.italic === !!want.italic
      && f.underline === !!want.underline && String(f.size) === String(want.size)
      && (f.color || null) === (want.color || null) && (f.name || null) === (want.name || null);
    for (let i = 0; i < this.fonts.length; i++) if (same(this.fonts[i])) return i;
    const p = this.p;
    const parts = [];
    if (want.bold) parts.push(`<${p}b/>`);
    if (want.italic) parts.push(`<${p}i/>`);
    if (want.underline) parts.push(`<${p}u/>`);
    parts.push(`<${p}sz val="${encodeAttr(want.size || '11')}"/>`);
    if (want.color) {
      parts.push(want.color.startsWith('theme:')
        ? `<${p}color theme="${want.color.slice(6)}"/>`
        : `<${p}color rgb="${encodeAttr(want.color)}"/>`);
    }
    if (want.name) parts.push(`<${p}name val="${encodeAttr(want.name)}"/>`);
    this.newFonts.push(`<${p}font>${parts.join('')}</${p}font>`);
    this.fonts.push({ ...want, bold: !!want.bold, italic: !!want.italic, underline: !!want.underline });
    this.dirty = true;
    return this.fonts.length - 1;
  }

  /** Index of a solid fill of this colour, creating one if needed.
   *  `null` means "no fill", which is always index 0 in a valid file. */
  fillFor(rgb) {
    if (!rgb) return 0;
    const want = rgb.replace('#', '').toUpperCase();
    const full = want.length === 6 ? 'FF' + want : want;
    for (let i = 0; i < this.fills.length; i++) {
      const f = this.fills[i];
      if (f && f.type === 'solid' && (f.rgb || '').toUpperCase() === full) return i;
    }
    const p = this.p;
    // bgColor indexed="64" is what Excel writes and some readers require it
    this.newFills.push(
      `<${p}fill><${p}patternFill patternType="solid">` +
      `<${p}fgColor rgb="${full}"/><${p}bgColor indexed="64"/>` +
      `</${p}patternFill></${p}fill>`);
    this.fills.push({ type: 'solid', rgb: full });
    this.dirty = true;
    return this.fills.length - 1;
  }

  /** Index of a border with these edges, creating one if needed. */
  borderFor(want) {
    const eq = (a, b) => (a || null) === (b || null);
    for (let i = 0; i < this.borders.length; i++) {
      const b = this.borders[i];
      if (eq(b.left, want.left) && eq(b.right, want.right)
          && eq(b.top, want.top) && eq(b.bottom, want.bottom)) return i;
    }
    const p = this.p;
    const edge = (n, st) => (st ? `<${p}${n} style="${st}"><${p}color auto="1"/></${p}${n}>` : `<${p}${n}/>`);
    this.newBorders.push(
      `<${p}border>${edge('left', want.left)}${edge('right', want.right)}` +
      `${edge('top', want.top)}${edge('bottom', want.bottom)}<${p}diagonal/></${p}border>`);
    this.borders.push({ ...want });
    this.dirty = true;
    return this.borders.length - 1;
  }

  /** Id for a custom number format code, creating one if needed. */
  numFmtFor(code) {
    if (this.customFmts.has(code)) return this.customFmts.get(code);
    const id = this.nextFmtId++;
    this.customFmts.set(code, id);
    this.newFmts.push(`<${this.p}numFmt numFmtId="${id}" formatCode="${encodeAttr(code)}"/>`);
    this.dirty = true;
    return id;
  }

  /**
   * Derive a new xf from an existing one plus changes.
   * @param base  index of the cell's current xf (0 when it has none)
   * @param chg   { bold, italic, underline, numFmtId, numFmtCode, horizontal }
   * @returns the xf index to put in the cell's s= attribute
   */
  derive(base, chg) {
    const cur = this.xfs[base] || { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, horizontal: null, wrap: false };
    const curFont = this.fonts[cur.fontId] || { size: '11', name: 'Calibri' };

    const wantFont = {
      ...curFont,
      bold: chg.bold === undefined ? !!curFont.bold : !!chg.bold,
      italic: chg.italic === undefined ? !!curFont.italic : !!chg.italic,
      underline: chg.underline === undefined ? !!curFont.underline : !!chg.underline,
      size: chg.fontSize === undefined ? curFont.size : chg.fontSize,
      color: chg.fontColor === undefined ? curFont.color
           : (chg.fontColor === null ? null : ('FF' + chg.fontColor.replace('#', '').toUpperCase()).slice(-8)),
    };
    const fontId = this.fontFor(wantFont);

    let numFmtId = cur.numFmtId;
    if (chg.numFmtCode !== undefined) numFmtId = this.numFmtFor(chg.numFmtCode);
    else if (chg.numFmtId !== undefined) numFmtId = chg.numFmtId;

    const fillId = chg.fill === undefined ? cur.fillId : this.fillFor(chg.fill);
    const borderId = chg.border === undefined ? cur.borderId
      : this.borderFor(chg.border === null
          ? { left: null, right: null, top: null, bottom: null }
          : { left: chg.border, right: chg.border, top: chg.border, bottom: chg.border });

    const horizontal = chg.horizontal === undefined ? cur.horizontal : chg.horizontal;
    const want = { numFmtId, fontId, fillId, borderId, horizontal, wrap: cur.wrap };

    for (let i = 0; i < this.xfs.length; i++) {
      const x = this.xfs[i];
      if (x.numFmtId === want.numFmtId && x.fontId === want.fontId && x.fillId === want.fillId
          && x.borderId === want.borderId && (x.horizontal || null) === (want.horizontal || null)
          && !!x.wrap === !!want.wrap) return i;
    }

    const p = this.p;
    const al = (want.horizontal || want.wrap)
      ? `<${p}alignment${want.horizontal ? ` horizontal="${want.horizontal}"` : ''}${want.wrap ? ' wrapText="1"' : ''}/>`
      : '';
    this.newXfs.push(
      `<${p}xf numFmtId="${want.numFmtId}" fontId="${want.fontId}" fillId="${want.fillId}" ` +
      `borderId="${want.borderId}" xfId="0"` +
      ` applyNumberFormat="1" applyFont="1"${al ? ' applyAlignment="1"' : ''}` +
      (al ? `>${al}</${p}xf>` : '/>'));
    this.xfs.push(want);
    this.dirty = true;
    return this.xfs.length - 1;
  }

  /** The properties an xf index resolves to, for the renderer. */
  describe(i) {
    const xf = this.xfs[i];
    if (!xf) return null;
    const f = this.fonts[xf.fontId] || {};
    const fl = this.fills[xf.fillId];
    const bd = this.borders[xf.borderId];
    return {
      bold: !!f.bold, italic: !!f.italic, numFmtId: xf.numFmtId, horizontal: xf.horizontal,
      size: f.size ? parseFloat(f.size) : 11,
      color: f.color && !String(f.color).startsWith('theme:')
        ? '#' + String(f.color).slice(-6) : null,
      fill: fl && fl.rgb ? '#' + fl.rgb.slice(-6) : null,
      border: bd && (bd.left || bd.right || bd.top || bd.bottom) ? bd : null,
    };
  }

  /** New styles.xml, or null if nothing changed. */
  serialize() {
    if (!this.dirty) return null;
    let out = this.xml;
    const p = this.p;

    const insertBefore = (closeTag, payload) => {
      const i = out.lastIndexOf(closeTag);
      if (i < 0) return false;
      out = out.slice(0, i) + payload + out.slice(i);
      return true;
    };
    const bumpCount = (tag, add) => {
      const re = new RegExp(`(<${p.replace(':', '\\:')}${tag}\\b[^>]*\\bcount=")(\\d+)(")`);
      out = out.replace(re, (m, a, n, b) => a + (parseInt(n, 10) + add) + b);
    };

    if (this.newFmts.length) {
      // <numFmts> is optional; create it before <fonts> when absent.
      if (out.includes(`<${p}numFmts`)) {
        insertBefore(`</${p}numFmts>`, this.newFmts.join(''));
        bumpCount('numFmts', this.newFmts.length);
      } else {
        const i = out.indexOf(`<${p}fonts`);
        if (i >= 0) {
          out = out.slice(0, i)
            + `<${p}numFmts count="${this.newFmts.length}">${this.newFmts.join('')}</${p}numFmts>`
            + out.slice(i);
        }
      }
    }
    if (this.newFonts.length) {
      insertBefore(`</${p}fonts>`, this.newFonts.join(''));
      bumpCount('fonts', this.newFonts.length);
    }
    if (this.newFills.length) {
      insertBefore(`</${p}fills>`, this.newFills.join(''));
      bumpCount('fills', this.newFills.length);
    }
    if (this.newBorders.length) {
      insertBefore(`</${p}borders>`, this.newBorders.join(''));
      bumpCount('borders', this.newBorders.length);
    }
    if (this.newXfs.length) {
      insertBefore(`</${p}cellXfs>`, this.newXfs.join(''));
      bumpCount('cellXfs', this.newXfs.length);
    }
    return out;
  }
}

/* A minimal styles.xml, for a workbook that somehow has none. */
export const DEFAULT_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '</styleSheet>';
