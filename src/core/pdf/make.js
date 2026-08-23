/* Write a PDF from scratch.
 *
 * The existing writer (core/pdf/writer.js) rearranges pages that already
 * exist and its whole discipline is to change as few bytes as possible. This
 * one is the other half: it makes pages that did not exist before, out of the
 * drawing instructions core/text/render.js produces.
 *
 * THE ONE DECISION WORTH EXPLAINING - why the fonts are not embedded.
 *
 * Embedding a font means shipping somebody's typeface inside every document
 * a visitor makes. Arial and Times New Roman are licensed, not free, so we
 * would be handing users a file they are not entitled to redistribute, from a
 * site whose entire claim is that nothing here is encumbered. The alternative
 * is the fourteen fonts every PDF reader is required to provide - and their
 * catch is that the reader supplies the metrics too, so a document laid out
 * against different numbers reflows when it is opened.
 *
 * So we supply the metrics: every font dictionary carries an explicit
 * /Widths array, and it is the SAME table core/text/metrics.js laid the text
 * out with. The reader is then not permitted to disagree about where the
 * words go. Nothing is embedded, nothing is licensed, and the page is the
 * page.
 *
 * Cost, stated plainly: WinAnsiEncoding covers Latin-1 and the usual
 * typography. Text outside it (Greek, Cyrillic, CJK) has no glyph in a
 * base-14 font, and Doc says so before it exports rather than writing a page
 * full of blanks.
 */

import { WIDTHS, familyOf } from '../text/metrics.js';

const enc = new TextEncoder();

/* PDF forbids exponent notation, and JS produces it eagerly — hence toFixed.
 * The trailing-zero trim must only run on a number that HAS a fractional
 * part: `(2e9).toFixed(4)` is "2000000000.0000", and stripping trailing zeros
 * from that gives "2", which is a different number by a factor of a billion.
 * Unreachable at page dimensions today; a landmine for whoever reuses this. */
const num = (n) => {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return n.toFixed(0);
  return n.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
};

/* Font descriptors for the base-14 faces. A reader that already has the font
 * ignores these; a reader substituting one uses them to pick something the
 * right shape, which is the difference between a substitution that looks like
 * the document and one that looks like a fax. */
const DESCRIPTORS = {
  sans:  { flags: 32, bbox: [-166, -225, 1000, 931], italic: 0, ascent: 718, descent: -207,
           cap: 718, stem: 88 },
  serif: { flags: 34, bbox: [-168, -218, 1000, 898], italic: 0, ascent: 683, descent: -217,
           cap: 662, stem: 84 },
  mono:  { flags: 33, bbox: [-23, -250, 715, 805], italic: 0, ascent: 629, descent: -157,
           cap: 562, stem: 51 },
};

/**
 * @param pages  [{ w, h, content: string, fonts: [[baseName, resName]],
 *                  images: Map<name, image>, gstates: Map<name, alpha> }]
 * @param meta   { title, author, subject, creator, date }
 * @returns Uint8Array
 */
export function buildDocument(pages, meta = {}) {
  const objs = [];                 // 1-based; objs[i] is object i+1
  const put = (body) => { objs.push(body); return objs.length; };
  const ref = (n) => `${n} 0 R`;

  const catalogNum = 1;            // reserved, filled at the end
  objs.push(null);
  const pagesNum = 2;
  objs.push(null);

  /* fonts, shared across the document - the registry hands out one resource
   * name per base font, so two pages using Helvetica point at one object */
  const fontObj = new Map();
  const fontFor = (base) => {
    if (fontObj.has(base)) return fontObj.get(base);
    const fam = familyOf(base);
    const d = DESCRIPTORS[fam];
    const widths = WIDTHS[base];
    const descNum = put(
      `<< /Type /FontDescriptor /FontName /${base} /Flags ${d.flags} ` +
      `/FontBBox [${d.bbox.join(' ')}] /ItalicAngle ${/Italic|Oblique/.test(base) ? -12 : 0} ` +
      `/Ascent ${d.ascent} /Descent ${d.descent} /CapHeight ${d.cap} /StemV ${d.stem} >>`);
    const n = put(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding ` +
      `/FirstChar 32 /LastChar 255 /Widths [${widths.join(' ')}] ` +
      `/FontDescriptor ${ref(descNum)} >>`);
    fontObj.set(base, n);
    return n;
  };

  const pageNums = [];
  for (const p of pages) {
    const fonts = [];
    for (const [base, res] of p.fonts || []) fonts.push(`/${res} ${ref(fontFor(base))}`);

    const xo = [];
    for (const [name, img] of p.images || []) xo.push(`/${name} ${ref(imageObj(img, put))}`);

    const gs = [];
    for (const [name, a] of p.gstates || []) {
      gs.push(`/${name} << /Type /ExtGState /ca ${num(a)} /CA ${num(a)} >>`);
    }

    const bytes = enc.encode(p.content);
    const contentNum = put({ dict: `<< /Length ${bytes.length} >>`, stream: bytes });

    const res = `<< /ProcSet [/PDF /Text /ImageC] ` +
      (fonts.length ? `/Font << ${fonts.join(' ')} >> ` : '') +
      (xo.length ? `/XObject << ${xo.join(' ')} >> ` : '') +
      (gs.length ? `/ExtGState << ${gs.join(' ')} >> ` : '') + `>>`;

    pageNums.push(put(
      `<< /Type /Page /Parent ${ref(pagesNum)} ` +
      `/MediaBox [0 0 ${num(p.w)} ${num(p.h)}] /Resources ${res} ` +
      `/Contents ${ref(contentNum)} >>`));
  }

  objs[pagesNum - 1] =
    `<< /Type /Pages /Count ${pageNums.length} /Kids [${pageNums.map(ref).join(' ')}] >>`;
  objs[catalogNum - 1] = `<< /Type /Catalog /Pages ${ref(pagesNum)} >>`;

  const infoNum = put(
    `<< ${meta.title ? `/Title (${lit(meta.title)}) ` : ''}` +
    `${meta.author ? `/Author (${lit(meta.author)}) ` : ''}` +
    `${meta.subject ? `/Subject (${lit(meta.subject)}) ` : ''}` +
    `/Producer (Miscellany Doc) /Creator (Miscellany Doc) ` +
    `/CreationDate (${pdfDate(meta.date)}) >>`);

  /* ---- assemble ---- */
  const chunks = [];
  let len = 0;
  const push = (u8) => { chunks.push(u8); len += u8.length; };
  push(enc.encode('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'));

  const offsets = new Array(objs.length + 1).fill(0);
  for (let i = 0; i < objs.length; i++) {
    offsets[i + 1] = len;
    const o = objs[i];
    push(enc.encode(`${i + 1} 0 obj\n`));
    if (o && o.stream) {
      push(enc.encode(o.dict + '\nstream\n'));
      push(o.stream);
      push(enc.encode('\nendstream'));
    } else {
      push(enc.encode(String(o)));
    }
    push(enc.encode('\nendobj\n'));
  }

  const xrefAt = len;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${ref(catalogNum)} ` +
          `/Info ${ref(infoNum)} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  push(enc.encode(xref));

  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** An image XObject. JPEG bytes go in verbatim; raw pixels go in as-is. */
function imageObj(img, put) {
  if (img._obj) return img._obj;
  const common =
    `/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
    `/ColorSpace /${img.gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8`;
  let smaskRef = '';
  if (img.smask) {
    const sn = put({
      dict: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
            `/ColorSpace /DeviceGray /BitsPerComponent 8 ` +
            (img.smaskFilter ? `/Filter /${img.smaskFilter} ` : '') +
            `/Length ${img.smask.length} >>`,
      stream: img.smask,
    });
    smaskRef = ` /SMask ${sn} 0 R`;
  }
  const n = put({
    dict: `<< ${common}${smaskRef} ` +
          (img.filter ? `/Filter /${img.filter} ` : '') +
          `/Length ${img.bytes.length} >>`,
    stream: img.bytes,
  });
  img._obj = n;
  return n;
}

const lit = (s) => String(s).replace(/([()\\])/g, '\\$1').replace(/[^\x20-\x7E]/g, '?');

function pdfDate(d) {
  const t = d instanceof Date ? d : new Date(d || Date.now());
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `D:${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}` +
         `${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
}
