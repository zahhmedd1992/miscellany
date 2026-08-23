# Miscellany

Free, modular software that composes. A spreadsheet, a slide deck and a word
processor that share one document — so a figure on a slide, or in a sentence,
**is** the number in the sheet, not a copy of it.

**Live: <https://miscellany.io>** — [Sheet](https://miscellany.io/app/) ·
[Deck](https://miscellany.io/app/deck) · [Doc](https://miscellany.io/app/doc) ·
[all three, one document](https://miscellany.io/app/compose)

Zero dependencies, no build step, no accounts, no telemetry. The pages make no
external requests at all.

## Run it

```sh
python -m http.server 9195 --directory src     # or: npm run serve
```

Open <http://127.0.0.1:9195/index.html>. ES modules need a server; `file://`
will not work. There is nothing to install.

## Test it

```sh
npm test                        # 1,588 assertions across fourteen suites

python corpus/build_corpus.py   # fetch the 49-workbook corpus (SHA256-locked)
node test/agreement.mjs         # grade the formula engine against Excel's answers
```

Neither corpus is redistributed here. `corpus/corpus.json` (49 workbooks) and
`corpus/docx.json` (40 Word documents) pin every file by SHA256, and the build
scripts fetch them from their original public sources. Both were locked and
published **before** the reader that they grade was written, so the exam cannot
be chosen at grading time.

```sh
python corpus/build_docx_corpus.py    # fetch and verify the 40-document corpus
node test/docx.read.test.mjs          # 686 assertions vs. a separate implementation
```

Browser suites drive the real interface (needs `patchright`):

```sh
npm run qa                            # Doc: smoke, red-team regressions, screen-vs-print
python qa/live_doc_qa.py              # the live site, including the download off disk
python qa/live_docx_qa.py             # a real Word document, through the real buttons
python qa/docx_foreign_check.py       # our .docx output, checked by Python's zipfile
```

## Build it

```sh
node tools/build-site.mjs      # -> dist/
node tools/check-licences.mjs  # the dependency gate: fails if one ever appears
```

`dist/` is plain static files — no bundler, no transform. The build copies and
then *verifies*: no bare imports, no remote resources, every module present.

## Layout

```
src/core/          Grain — the substrate. Knows nothing about spreadsheets.
  graph.js           node graph + recalculation scheduler        ← the product
  formula.js         lexer, precedence-climbing parser, evaluator
  functions.js       76 functions
  decimal.js         exact arithmetic (BigInt mantissa + scale), never IEEE floats
  value.js           one value model for every app
  numfmt.js          the Excel number-format code language
  commands.js        the command registry
  shell.js           the window every app is hosted in
  docfile.js         the .grain document format
  ooxml/             .xlsx read and write, with preserve-unknown
  text/              the layout engine and the font metrics the PDF also uses
  pdf/               PDF read, page surgery, and writing one from nothing
src/apps/sheet/    grid, editor, .xlsx open/save, styles, structural edits
src/apps/deck/     slides, objects, charts
src/apps/doc/      pages, caret and selection, .docx open/save, PDF export
```

An app supplies three things: its commands, its toolbar sets, and a surface that
draws and takes keys. Undo, the command palette, the keyboard map, the toolbar,
autosave, capabilities and the status bar are the shell's — which is why Deck is
712 lines and implements none of them.

The registry is the single source of truth for every surface: the toolbar, the
palette, the keyboard map, the HTTP routes and the MCP tool definitions are all
generated projections of the same 54 command declarations. (The API is generated
and viewable; nothing serves it yet.)

## Four decisions that explain most of the rest

**Never inherit a model; freely use a mechanism.** A library that reads
spreadsheets has already decided what a spreadsheet *is* and silently drops
whatever did not fit. So the OOXML reader is ours, from ECMA-376. DEFLATE and
CRC-32 are mechanisms — one correct answer, no opinion — and we use those
freely. That distinction is why a workbook full of pivot tables we cannot even
display survives a save byte-for-byte.

**A document is a graph of nodes, not cells.** `main!B4` and `deck:s1/kpi` are
both just ids. That is why a chart on a slide needs no integration code — it is
an ordinary dependent of a range — and why a new app gets persistence the day it
picks an id prefix.

**Values are never stored, only recomputed.** A file that caches a result beside
the formula that produced it can hold the two in disagreement. `.xlsx` does
cache them, which is exactly why real workbooks make a good exam:
`test/agreement.mjs` grades us against Excel's own numbers —
**223,596 / 223,601 (100.00%)**, including all 1,790 cells where Excel itself
errors. The five that remain are a published baseline, not a hidden allowlist;
the gate fails the moment that count rises.

**One computation, two renderers.** Doc's layout engine never measures anything
on a canvas. Every width comes from `core/text/metrics.js`, and those same
numbers are written into the PDF as the font's `/Widths` array — so the page
breaks its lines exactly where the screen does, by construction rather than by
testing. `core/pdf/canvas.js` is a 2D drawing context that emits PDF operators,
so the PDF is not a second rendering of the document: it is the same drawing
code pointed at another surface. `qa/doc_pdf_qa.py` proves it with two foreign
implementations — pdfium rasterises the page and it is compared band by band
against a screenshot, and MuPDF reads the text back.

**Splice, never regenerate.** Regeneration loses attribute order, self-closing
style, whitespace, entity choice, and everything unmodelled. Open
`corpus/files/adv-pivot.xlsx`, change one cell, save: 55 parts in, **54 back
byte-identical**, one changed — the sheet you edited.

## Known gaps

- 76 formula functions, not 500. No pivot tables, macros or array formulas —
  preserved on save, not editable.
- Deck cannot open or write `.pptx`.
- Charts already in a workbook are read-only; in Deck you can create them.
- No conditional formatting, data bars or icon sets (preserved, not displayed).
- Rich-text runs render in the cell's base font.
- Borders are all-or-nothing per cell; the colour palette is 20 presets.
- Editing writes inline strings, not shared-string entries — deliberately, since
  appending to `sharedStrings.xml` turns a one-cell edit into a whole-file diff.
- Capabilities are enforced by the shell on every command, but this is one JS
  context: it is a boundary, not a sandbox. Every app currently holds the same
  grants.
- The HTTP/MCP API is generated, not served.

Doc specifically:

- Three font families (serif, sans, monospaced) in the four usual faces. They
  are the fonts a PDF can name without embedding one, which is what makes an
  exported file both small and free of anybody's licensed typeface.
- Text outside WinAnsiEncoding — Greek, Cyrillic, CJK — has no glyph in those
  fonts. Doc names the characters before it exports rather than writing a page
  of question marks silently.
- Reading `.docx`: paragraphs, runs, styles, numbering, tables, section setup.
  Headers, footers, footnotes, comments, images, charts and embedded objects are
  **kept and written back untouched**, and the status bar says so on open, but
  they are not displayed or editable.
- Writing `.docx`: text, character and paragraph formatting, inserted and
  deleted paragraphs. Inserting a table or a chart is not written back yet.
- A table imported from Word is scaled to fit the page rather than auto-fitted
  the way Word does, so a very narrow column can wrap where Word would not.
- Line breaking is greedy, not optimal. Optimal breaking reflows the bottom of a
  paragraph when you edit the top of it, which in an editor reads as the text
  jumping under your hands.
- Placement is still linear in document length: a keystroke costs about 30ms at
  58 pages (line breaking is cached per paragraph; pagination is not).

## Licence

[MPL-2.0](LICENSE). Use it for anything, build anything on top of it, and if you
improve these files, publish those improvements.
