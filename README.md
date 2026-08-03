# Miscellany

Free, modular software that composes. A spreadsheet and a slide deck that share
one document — so a figure on a slide **is** the number in the sheet, not a copy
of it.

**Live: <https://miscellany.io>** — [Sheet](https://miscellany.io/app/) ·
[Deck](https://miscellany.io/app/deck) ·
[both, one document](https://miscellany.io/app/compose)

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
npm test                        # 679 assertions across nine suites

python corpus/build_corpus.py   # fetch the 49-workbook corpus (SHA256-locked)
node test/agreement.mjs         # grade the formula engine against Excel's answers
```

The corpus is **not** redistributed here. `corpus/corpus.json` pins every file
by SHA256 and `build_corpus.py` fetches them from their original public sources.

Browser suites drive the real interface (needs `patchright`):
`qa/sheet_rehost.py`, `qa/deck_standalone.py`, `qa/live_update.py`,
`qa/one_document.py`.

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
src/apps/sheet/    grid, editor, .xlsx open/save, styles, structural edits
src/apps/deck/     slides, objects, charts
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

## Licence

[MPL-2.0](LICENSE). Use it for anything, build anything on top of it, and if you
improve these files, publish those improvements.
