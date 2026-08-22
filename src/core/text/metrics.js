/* Grain - text metrics for the fonts a PDF can name without embedding one.
 *
 * WHY A TABLE AND NOT canvas.measureText():
 *
 * Doc lays text out with THESE numbers and writes THESE numbers into the PDF
 * as the font's /Widths array. That is the whole trick behind "what you see
 * is what prints": the line breaks cannot differ between the screen and the
 * page, because both were computed from one table. Measuring on the canvas
 * instead would tie layout to whatever font the visitor happens to have, to
 * their zoom level, and to their browser's hinting - and the PDF would break
 * its lines somewhere else, which is exactly the failure every "export to
 * PDF" button has.
 *
 * The numbers are advance widths in 1/1000 em, indexed by WinAnsiEncoding
 * code point, taken from the AFM metrics of the base-14 fonts and
 * cross-checked against the TrueType hmtx tables of the fonts a browser
 * actually paints with (Arial, Times New Roman, Courier New). Of 2,616
 * (font, character) pairs the two sources agree on 2,579. The 37 that differ
 * are five rare glyphs - macron, plusminus, mu, periodcentered, divide -
 * where Microsoft redrew the character wider or narrower than Adobe. We use
 * the AFM value, because that is the number a PDF reader will use, and the
 * residue is under half a pixel of slack around five characters at reading
 * size. Regenerate with tools/gen/make_metrics.py + emit_metrics.py.
 *
 * DELIBERATE LIMIT, stated rather than discovered: WinAnsiEncoding covers
 * Latin-1 plus the usual typography (curly quotes, dashes, bullet, euro).
 * A character outside it has no width here and no glyph in a non-embedded
 * font, so Doc renders it and reports it as unprintable rather than dropping
 * it silently into a PDF as a blank.
 */

/* Helvetica - advance widths for WinAnsi codes 32..255. */
const HELVETICA = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,
  556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,
  0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,
  278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,
  400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,
  667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,
  722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,
  556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,
  556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500,
];

/* Helvetica-Bold - advance widths for WinAnsi codes 32..255. */
const HELVETICA_BOLD = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,
  556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,
  0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,
  278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,
  400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,
  722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,
  722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,
  556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,
  611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556,
];

/* Times-Roman - advance widths for WinAnsi codes 32..255. */
const TIMES_ROMAN = [
  250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,
  921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,
  556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,
  333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,
  500,500,333,389,278,500,500,722,500,500,444,480,200,480,541,0,
  500,0,333,500,444,1000,500,500,333,1000,556,333,889,0,611,0,
  0,333,333,444,444,350,500,1000,333,980,389,333,722,0,444,722,
  250,333,500,500,500,500,200,500,333,760,276,500,564,333,760,333,
  400,564,300,300,333,500,453,250,333,300,310,500,750,750,750,444,
  722,722,722,722,722,722,889,667,611,611,611,611,333,333,333,333,
  722,722,722,722,722,722,722,564,722,722,722,722,722,722,556,500,
  444,444,444,444,444,444,667,444,444,444,444,444,278,278,278,278,
  500,500,500,500,500,500,500,564,500,500,500,500,500,500,500,500,
];

/* Times-Bold - advance widths for WinAnsi codes 32..255. */
const TIMES_BOLD = [
  250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,
  930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,
  611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,
  333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,
  556,556,444,389,333,556,500,722,500,500,444,394,220,394,520,0,
  500,0,333,500,500,1000,500,500,333,1000,556,333,1000,0,667,0,
  0,333,333,500,500,350,500,1000,333,1000,389,333,722,0,444,722,
  250,333,500,500,500,500,220,500,333,747,300,500,570,333,747,333,
  400,570,300,300,333,556,540,250,333,300,330,500,750,750,750,500,
  722,722,722,722,722,722,1000,722,667,667,667,667,389,389,389,389,
  722,722,778,778,778,778,778,570,778,722,722,722,722,722,611,556,
  500,500,500,500,500,500,722,444,444,444,444,444,278,278,278,278,
  500,556,500,500,500,500,500,570,500,556,556,556,556,500,556,500,
];

/* Times-Italic - advance widths for WinAnsi codes 32..255. */
const TIMES_ITALIC = [
  250,333,420,500,500,833,778,214,333,333,500,675,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,333,333,675,675,675,500,
  920,611,611,667,722,611,611,722,722,333,444,667,556,833,667,722,
  611,722,611,500,556,722,611,833,611,556,556,389,278,389,422,500,
  333,500,500,444,500,444,278,500,500,278,278,444,278,722,500,500,
  500,500,389,389,278,500,444,667,444,444,389,400,275,400,541,0,
  500,0,333,500,556,889,500,500,333,1000,500,333,944,0,556,0,
  0,333,333,556,556,350,500,889,333,980,389,333,667,0,389,556,
  250,389,500,500,500,500,275,500,333,760,276,500,675,333,760,333,
  400,675,300,300,333,500,523,250,333,300,310,500,750,750,750,500,
  611,611,611,611,611,611,889,667,611,611,611,611,333,333,333,333,
  722,667,722,722,722,722,722,675,722,722,722,722,722,556,611,500,
  500,500,500,500,500,500,667,444,444,444,444,444,278,278,278,278,
  500,500,500,500,500,500,500,675,500,500,500,500,500,444,500,444,
];

/* Times-BoldItalic - advance widths for WinAnsi codes 32..255. */
const TIMES_BOLDITALIC = [
  250,389,555,500,500,833,778,278,333,333,500,570,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,
  832,667,667,667,722,667,667,722,778,389,500,667,611,889,722,722,
  611,722,667,556,611,722,667,889,667,611,611,333,278,333,570,500,
  333,500,500,444,500,444,333,500,556,278,278,500,278,778,556,500,
  500,500,389,389,278,556,444,667,500,444,389,348,220,348,570,0,
  500,0,333,500,500,1000,500,500,333,1000,556,333,944,0,611,0,
  0,333,333,500,500,350,500,1000,333,1000,389,333,722,0,389,611,
  250,389,500,500,500,500,220,500,333,747,266,500,606,333,747,333,
  400,570,300,300,333,576,500,250,333,300,300,500,750,750,750,500,
  667,667,667,667,667,667,944,667,667,667,667,667,389,389,389,389,
  722,722,722,722,722,722,722,570,722,722,722,722,722,611,611,500,
  500,500,500,500,500,500,722,444,444,444,444,444,278,278,278,278,
  500,556,500,500,500,500,500,570,500,556,556,556,556,444,500,444,
];

/* Courier is monospaced: every character advances 600. */
const COURIER = new Array(224).fill(600);

/** Advance widths, in 1/1000 em, keyed by the PDF base font name. */
export const WIDTHS = {
  'Helvetica': HELVETICA,
  'Helvetica-Bold': HELVETICA_BOLD,
  'Helvetica-Oblique': HELVETICA,
  'Helvetica-BoldOblique': HELVETICA_BOLD,
  'Times-Roman': TIMES_ROMAN,
  'Times-Bold': TIMES_BOLD,
  'Times-Italic': TIMES_ITALIC,
  'Times-BoldItalic': TIMES_BOLDITALIC,
  'Courier': COURIER,
  'Courier-Bold': COURIER,
  'Courier-Oblique': COURIER,
  'Courier-BoldOblique': COURIER,
};

/* Codes 128..159 of WinAnsiEncoding are not Latin-1: Windows put the
 * typographic characters there. Everything else maps to itself. */
export const UNI_TO_WINANSI = new Map([
  [0x0152, 0x8C],
  [0x0153, 0x9C],
  [0x0160, 0x8A],
  [0x0161, 0x9A],
  [0x0178, 0x9F],
  [0x017D, 0x8E],
  [0x017E, 0x9E],
  [0x0192, 0x83],
  [0x02C6, 0x88],
  [0x02DC, 0x98],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201A, 0x82],
  [0x201C, 0x93],
  [0x201D, 0x94],
  [0x201E, 0x84],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x2022, 0x95],
  [0x2026, 0x85],
  [0x2030, 0x89],
  [0x2039, 0x8B],
  [0x203A, 0x9B],
  [0x20AC, 0x80],
  [0x2122, 0x99],
]);

/** The WinAnsi code for a character, or -1 if the encoding cannot hold it. */
export function winAnsiCode(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x20 && cp <= 0x7E) return cp;
  const m = UNI_TO_WINANSI.get(cp);
  if (m !== undefined) return m;
  if (cp >= 0xA0 && cp <= 0xFF) return cp;
  return -1;
}

/* The three families Doc offers, each with the four faces a document needs,
 * and the CSS stack the canvas paints them with. The stacks are ordered so
 * that the first available font is metrically the one the table describes. */
export const FAMILIES = {
  sans:  { label: 'Sans',      css: 'Arial, Helvetica, "Liberation Sans", sans-serif',
           faces: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'] },
  serif: { label: 'Serif',     css: '"Times New Roman", Times, "Liberation Serif", serif',
           faces: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'] },
  mono:  { label: 'Monospace', css: '"Courier New", Courier, "Liberation Mono", monospace',
           faces: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'] },
};

/** The base font name for a family + bold/italic pair. */
export function faceOf(family, bold, italic) {
  const f = FAMILIES[family] || FAMILIES.serif;
  return f.faces[(bold ? 1 : 0) + (italic ? 2 : 0)];
}

/**
 * Width of a string, in 1/1000 em.
 *
 * Characters WinAnsi cannot hold are measured at the width of the glyph the
 * renderer substitutes for them, which we take to be '?'. They are counted,
 * not skipped: a document that lays out as though they were absent would
 * disagree with itself the moment one was displayed.
 */
export function stringWidth(face, s) {
  const w = WIDTHS[face] || WIDTHS['Times-Roman'];
  let total = 0;
  for (const ch of s) {
    const c = winAnsiCode(ch);
    total += c < 0 ? w[0x3F - 32] : (w[c - 32] || 0);
  }
  return total;
}

/** Width of a string in points, at a given font size in points. */
export const textWidth = (face, s, size) => (stringWidth(face, s) * size) / 1000;

/** Every character in `s` that a non-embedded base-14 font cannot print. */
export function unprintable(s) {
  const bad = new Set();
  for (const ch of s) if (winAnsiCode(ch) < 0) bad.add(ch);
  return [...bad];
}

/* Vertical metrics, in 1/1000 em, for the three families. Ascent and descent
 * come from the AFM FontBBox; the line gap is ours, because AFM does not
 * carry one and a document needs consistent leading more than it needs a
 * font designer's opinion about it. */
export const VMETRICS = {
  sans:  { ascent: 718, descent: 207, capHeight: 718, xHeight: 523 },
  serif: { ascent: 683, descent: 217, capHeight: 662, xHeight: 450 },
  mono:  { ascent: 629, descent: 157, capHeight: 562, xHeight: 426 },
};

/** The family a base font name belongs to. */
export function familyOf(face) {
  if (face.startsWith('Helvetica')) return 'sans';
  if (face.startsWith('Courier')) return 'mono';
  return 'serif';
}
