"""Generate src/core/text/metrics.js -- advance widths for the PDF base-14 fonts.

TWO INDEPENDENT SOURCES, cross-checked, because a width table is the one input
that silently rots a whole document: a wrong number does not throw, it just
breaks the line in the wrong place, and it does so identically on screen and in
the PDF (they share the table), so nothing ever looks inconsistent.

  Source 1: the AFM metrics for the base-14 fonts (URW's metric-compatible
            clones, shipped with matplotlib). These ARE what a PDF viewer uses
            when the font is not embedded.
  Source 2: the TrueType hmtx table of the Windows fonts the browser will
            actually paint with (Arial / Times New Roman / Courier New).

Where they disagree the AFM wins (it is the PDF's own answer) and the
disagreement is printed, so a divergence is a fact we know rather than one
somebody discovers inside a document.
"""
import os, re, struct, json

AFM_DIR = r"C:\Users\zacha\AppData\Roaming\Python\Python314\site-packages\matplotlib\mpl-data\fonts\afm"
WIN = r"C:\Windows\Fonts"

# base-14 name -> (URW afm basename, windows ttf the browser will render)
FONTS = {
    "Helvetica":             ("phvr8a",  "arial.ttf"),
    "Helvetica-Bold":        ("phvb8a",  "arialbd.ttf"),
    "Helvetica-Oblique":     ("phvro8a", "ariali.ttf"),
    "Helvetica-BoldOblique": ("phvbo8a", "arialbi.ttf"),
    "Times-Roman":           ("ptmr8a",  "times.ttf"),
    "Times-Bold":            ("ptmb8a",  "timesbd.ttf"),
    "Times-Italic":          ("ptmri8a", "timesi.ttf"),
    "Times-BoldItalic":      ("ptmbi8a", "timesbi.ttf"),
    "Courier":               ("pcrr8a",  "cour.ttf"),
    "Courier-Bold":          ("pcrb8a",  "courbd.ttf"),
    "Courier-Oblique":       ("pcrro8a", "couri.ttf"),
    "Courier-BoldOblique":   ("pcrbo8a", "courbi.ttf"),
}


def read_afm(base):
    """glyph name -> width, from an AFM file."""
    path = os.path.join(AFM_DIR, base + ".afm")
    out = {}
    with open(path, "r", encoding="latin-1") as f:
        started = False
        for line in f:
            if line.startswith("StartCharMetrics"):
                started = True
                continue
            if line.startswith("EndCharMetrics"):
                break
            if not started:
                continue
            m = re.search(r"WX\s+(-?\d+)\s*;.*?\bN\s+(\S+)\s*;", line)
            if m:
                out[m.group(2)] = int(m.group(1))
    return out


def read_ttf(path):
    """Return width(unicode) -> advance in 1/1000 em, from a TrueType file."""
    d = open(path, "rb").read()
    off = 0
    numTables = struct.unpack(">H", d[off + 4:off + 6])[0]
    tables = {}
    for i in range(numTables):
        p = off + 12 + i * 16
        tag = d[p:p + 4].decode("latin-1")
        o, ln = struct.unpack(">II", d[p + 8:p + 16])
        tables[tag] = (o, ln)
    ho = tables["head"][0]
    upem = struct.unpack(">H", d[ho + 18:ho + 20])[0]
    hho = tables["hhea"][0]
    numH = struct.unpack(">H", d[hho + 34:hho + 36])[0]
    mo = tables["hmtx"][0]
    adv = [struct.unpack(">H", d[mo + i * 4:mo + i * 4 + 2])[0] for i in range(numH)]

    co = tables["cmap"][0]
    nt = struct.unpack(">H", d[co + 2:co + 4])[0]
    sub = None
    for i in range(nt):
        pid, eid, o = struct.unpack(">HHI", d[co + 4 + i * 8: co + 12 + i * 8])
        if (pid, eid) in ((3, 1), (3, 10), (0, 3), (0, 4)):
            sub = co + o
            if (pid, eid) == (3, 1):
                break
    fmt = struct.unpack(">H", d[sub:sub + 2])[0]
    cmap = {}
    if fmt == 4:
        segX2 = struct.unpack(">H", d[sub + 6:sub + 8])[0]
        seg = segX2 // 2
        ends = struct.unpack(">%dH" % seg, d[sub + 14:sub + 14 + segX2])
        starts = struct.unpack(">%dH" % seg, d[sub + 16 + segX2:sub + 16 + 2 * segX2])
        deltas = struct.unpack(">%dh" % seg, d[sub + 16 + 2 * segX2:sub + 16 + 3 * segX2])
        rob = sub + 16 + 3 * segX2
        ros = struct.unpack(">%dH" % seg, d[rob:rob + segX2])
        for i in range(seg):
            for c in range(starts[i], min(ends[i], 0xFFFF) + 1):
                if ros[i] == 0:
                    g = (c + deltas[i]) & 0xFFFF
                else:
                    gp = rob + i * 2 + ros[i] + (c - starts[i]) * 2
                    if gp + 2 > len(d):
                        continue
                    g = struct.unpack(">H", d[gp:gp + 2])[0]
                    if g:
                        g = (g + deltas[i]) & 0xFFFF
                if g:
                    cmap[c] = g
    else:
        raise SystemExit("unexpected cmap format %d in %s" % (fmt, path))

    def width(cp):
        g = cmap.get(cp)
        if g is None:
            return None
        a = adv[g] if g < len(adv) else adv[-1]
        return round(a * 1000.0 / upem)
    return width


def build_names():
    """unicode -> Adobe glyph name, for everything WinAnsiEncoding can hold."""
    names = {
        0x20: "space", 0x21: "exclam", 0x22: "quotedbl", 0x23: "numbersign",
        0x24: "dollar", 0x25: "percent", 0x26: "ampersand", 0x27: "quotesingle",
        0x28: "parenleft", 0x29: "parenright", 0x2A: "asterisk", 0x2B: "plus",
        0x2C: "comma", 0x2D: "hyphen", 0x2E: "period", 0x2F: "slash",
        0x30: "zero", 0x31: "one", 0x32: "two", 0x33: "three", 0x34: "four",
        0x35: "five", 0x36: "six", 0x37: "seven", 0x38: "eight", 0x39: "nine",
        0x3A: "colon", 0x3B: "semicolon", 0x3C: "less", 0x3D: "equal",
        0x3E: "greater", 0x3F: "question", 0x40: "at", 0x5B: "bracketleft",
        0x5C: "backslash", 0x5D: "bracketright", 0x5E: "asciicircum",
        0x5F: "underscore", 0x60: "grave", 0x7B: "braceleft", 0x7C: "bar",
        0x7D: "braceright", 0x7E: "asciitilde",
        0xA0: "space", 0xA1: "exclamdown", 0xA2: "cent", 0xA3: "sterling",
        0xA4: "currency", 0xA5: "yen", 0xA6: "brokenbar", 0xA7: "section",
        0xA8: "dieresis", 0xA9: "copyright", 0xAA: "ordfeminine",
        0xAB: "guillemotleft", 0xAC: "logicalnot", 0xAD: "hyphen",
        0xAE: "registered", 0xAF: "macron", 0xB0: "degree", 0xB1: "plusminus",
        0xB2: "twosuperior", 0xB3: "threesuperior", 0xB4: "acute", 0xB5: "mu",
        0xB6: "paragraph", 0xB7: "periodcentered", 0xB8: "cedilla",
        0xB9: "onesuperior", 0xBA: "ordmasculine", 0xBB: "guillemotright",
        0xBC: "onequarter", 0xBD: "onehalf", 0xBE: "threequarters",
        0xBF: "questiondown", 0xC0: "Agrave", 0xC1: "Aacute",
        0xC2: "Acircumflex", 0xC3: "Atilde", 0xC4: "Adieresis", 0xC5: "Aring",
        0xC6: "AE", 0xC7: "Ccedilla", 0xC8: "Egrave", 0xC9: "Eacute",
        0xCA: "Ecircumflex", 0xCB: "Edieresis", 0xCC: "Igrave", 0xCD: "Iacute",
        0xCE: "Icircumflex", 0xCF: "Idieresis", 0xD0: "Eth", 0xD1: "Ntilde",
        0xD2: "Ograve", 0xD3: "Oacute", 0xD4: "Ocircumflex", 0xD5: "Otilde",
        0xD6: "Odieresis", 0xD7: "multiply", 0xD8: "Oslash", 0xD9: "Ugrave",
        0xDA: "Uacute", 0xDB: "Ucircumflex", 0xDC: "Udieresis", 0xDD: "Yacute",
        0xDE: "Thorn", 0xDF: "germandbls", 0xE0: "agrave", 0xE1: "aacute",
        0xE2: "acircumflex", 0xE3: "atilde", 0xE4: "adieresis", 0xE5: "aring",
        0xE6: "ae", 0xE7: "ccedilla", 0xE8: "egrave", 0xE9: "eacute",
        0xEA: "ecircumflex", 0xEB: "edieresis", 0xEC: "igrave", 0xED: "iacute",
        0xEE: "icircumflex", 0xEF: "idieresis", 0xF0: "eth", 0xF1: "ntilde",
        0xF2: "ograve", 0xF3: "oacute", 0xF4: "ocircumflex", 0xF5: "otilde",
        0xF6: "odieresis", 0xF7: "divide", 0xF8: "oslash", 0xF9: "ugrave",
        0xFA: "uacute", 0xFB: "ucircumflex", 0xFC: "udieresis", 0xFD: "yacute",
        0xFE: "thorn", 0xFF: "ydieresis",
        0x2022: "bullet", 0x2020: "dagger", 0x2021: "daggerdbl",
        0x2026: "ellipsis", 0x2014: "emdash", 0x2013: "endash",
        0x0192: "florin", 0x2039: "guilsinglleft", 0x203A: "guilsinglright",
        0x2030: "perthousand", 0x201E: "quotedblbase", 0x201C: "quotedblleft",
        0x201D: "quotedblright", 0x2018: "quoteleft", 0x2019: "quoteright",
        0x201A: "quotesinglbase", 0x2122: "trademark",
        0x0152: "OE", 0x0153: "oe", 0x0160: "Scaron", 0x0161: "scaron",
        0x0178: "Ydieresis", 0x017D: "Zcaron", 0x017E: "zcaron",
        0x20AC: "Euro", 0x02C6: "circumflex", 0x02DC: "tilde",
    }
    for c in range(0x41, 0x5B):
        names[c] = chr(c)
    for c in range(0x61, 0x7B):
        names[c] = chr(c)
    return names


NAMES = build_names()


def winansi():
    """code (32..255) -> (unicode codepoint, glyph name). WinAnsiEncoding."""
    out = {}
    for code in range(32, 256):
        try:
            u = bytes([code]).decode("cp1252")
        except UnicodeDecodeError:
            continue
        cp = ord(u)
        nm = NAMES.get(cp)
        if nm is None:
            continue
        out[code] = (cp, nm)
    return out


WA = winansi()


def main():
    tables, notes, diffs = {}, [], 0
    for name, (afmbase, ttf) in FONTS.items():
        afm = read_afm(afmbase)
        ttfw = read_ttf(os.path.join(WIN, ttf))
        row, missing_afm = {}, []
        for code, (cp, gname) in WA.items():
            w = afm.get(gname)
            if w is None:
                missing_afm.append((code, gname))
                w = ttfw(cp) or 0
            row[code] = w
            t = ttfw(cp)
            if t is not None and t != w:
                diffs += 1
                if len(notes) < 30:
                    notes.append("%-22s U+%04X %-14s afm=%d ttf=%d" % (name, cp, gname, w, t))
        tables[name] = row
        if missing_afm:
            print("  %s: %d glyphs absent from the AFM, taken from %s: %s"
                  % (name, len(missing_afm), ttf,
                     ", ".join(g for _, g in missing_afm[:8])))

    print("\ncross-check: %d (font, code point) pairs where the Windows font "
          "disagrees with the AFM, of %d checked" % (diffs, len(FONTS) * len(WA)))
    for n in notes:
        print("   ", n)

    assert tables["Helvetica"][32] == 278, tables["Helvetica"][32]
    assert tables["Helvetica"][ord("A")] == 667
    assert tables["Times-Roman"][32] == 250
    assert tables["Times-Roman"][ord("A")] == 722
    assert all(v == 600 for v in tables["Courier"].values()), "Courier is monospaced"
    print("spot checks: Helvetica space=278 A=667 | Times space=250 A=722 | "
          "Courier all 600  OK")

    with open("tools/gen/metrics.json", "w", encoding="utf-8") as f:
        json.dump({"winansi": {str(k): list(v) for k, v in WA.items()},
                   "widths": tables}, f)
    print("wrote tools/gen/metrics.json  (%d fonts x %d codes)" % (len(tables), len(WA)))


main()
