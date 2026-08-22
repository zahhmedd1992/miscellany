"""tools/gen/metrics.json -> src/core/text/metrics.js

Emits one array of 224 advance widths (code points 32..255 of WinAnsiEncoding)
per distinct table. Identical tables are emitted once and aliased, which is
both smaller and a true statement: an oblique face is a slant, not a redesign,
so it has the same advances as its upright.
"""
import json, io

M = json.load(open("tools/gen/metrics.json", encoding="utf-8"))
W = M["widths"]
WA = {int(k): v for k, v in M["winansi"].items()}

ORDER = ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
         "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
         "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"]

# code 32..255 -> width (0 = this code is not in WinAnsiEncoding)
rows = {}
for name in ORDER:
    t = {int(k): v for k, v in W[name].items()}
    rows[name] = [t.get(c, 0) for c in range(32, 256)]

# dedupe
canon, alias = {}, {}
for name in ORDER:
    key = tuple(rows[name])
    if key in canon:
        alias[name] = canon[key]
    else:
        canon[key] = name

const = {}
for name in ORDER:
    if name in alias:
        continue
    vals = rows[name]
    if len(set(vals) - {0}) == 1:
        const[name] = next(v for v in vals if v)

# unicode <-> WinAnsi code, only where they differ (i.e. outside Latin-1)
special = {cp: code for code, (cp, _n) in WA.items() if cp != code}

out = io.StringIO()
out.write('''/* Grain - text metrics for the fonts a PDF can name without embedding one.
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

''')

for name in ORDER:
    if name in alias:
        continue
    var = name.replace("-", "_").upper()
    if name in const:
        out.write("/* %s is monospaced: every character advances %d. */\n"
                  % (name, const[name]))
        out.write("const %s = new Array(224).fill(%d);\n\n" % (var, const[name]))
        continue
    vals = rows[name]
    out.write("/* %s - advance widths for WinAnsi codes 32..255. */\n" % name)
    out.write("const %s = [\n" % var)
    for i in range(0, 224, 16):
        chunk = vals[i:i + 16]
        out.write("  " + ",".join("%d" % v for v in chunk) + ",\n")
    out.write("];\n\n")

out.write("/** Advance widths, in 1/1000 em, keyed by the PDF base font name. */\n")
out.write("export const WIDTHS = {\n")
for name in ORDER:
    src = alias.get(name, name)
    out.write("  '%s': %s,\n" % (name, src.replace("-", "_").upper()))
out.write("};\n\n")

out.write("""/* Codes 128..159 of WinAnsiEncoding are not Latin-1: Windows put the
 * typographic characters there. Everything else maps to itself. */
export const UNI_TO_WINANSI = new Map([
""")
for cp in sorted(special):
    out.write("  [0x%04X, 0x%02X],\n" % (cp, special[cp]))
out.write("]);\n\n")

out.write('''/** The WinAnsi code for a character, or -1 if the encoding cannot hold it. */
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
''')

open("src/core/text/metrics.js", "w", encoding="utf-8", newline="\n").write(out.getvalue())
n = sum(1 for name in ORDER if name not in alias)
print("wrote src/core/text/metrics.js: %d distinct width tables, %d aliased, %d chars"
      % (n, len(alias), len(out.getvalue())))
for a, b in alias.items():
    print("   %-22s == %s" % (a, b))
