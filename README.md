# Miscellany — Sheet

A spreadsheet built on Grain, the shared substrate every Miscellany app will use.
Opens and saves real Excel files without wrecking them.

## Run it

```
cd src
python -m http.server 9195
```
Open <http://127.0.0.1:9195/index.html>

ES modules need a server; `file://` will not work. **No build step, no npm install,
no dependencies at all** — that is the point, not an accident.

## Test it

```
node test/core.test.mjs             # 107 — decimal, coercion, formulas, recalc, cycles
node test/numfmt.test.mjs           #  53 — Excel number format codes
node test/layout.test.mjs           #  21 — text wrapping, overflow, hang guards
node test/clipboard.test.mjs        #  22 — TSV parsing, payloads, paste translation
node test/stylewrite.test.mjs       #  42 — deriving styles, fills, borders, splice-append
node test/structural.test.mjs       #  45 — insert/delete rows/columns, widths, heights
node test/corpus.read.test.mjs      # 174 — reads all 49 corpus files, exact counts
node test/corpus.roundtrip.test.mjs # 153 — byte-identical round trip, isolated edits, style preservation
node test/agreement.mjs             # grades every formula against Excel's own cached results
python corpus/build_corpus.py       # re-hashes the corpus against its lock
```

617 assertions. See `CORPUS.md` for what the corpus is and why it is locked.

The edited outputs are additionally validated by **Python's `zipfile`** — an
implementation that is not ours — which verifies every entry's CRC and the central
directory. 49/49 clean. Our own reader accepting our own writer proves less than it
looks like it does.

## Try these

| | |
|---|---|
| **Open .xlsx** | load any workbook — try `corpus/files/nrel-atb.xlsx` (39 sheets, 233k formulas) or `census-const.xlsx`. It is read in the tab; nothing is uploaded. |
| **Save .xlsx** | writes it back. The status bar reports how many parts came back byte-for-byte. |
| **Ctrl+C / X / V** | copy, cut, paste. Formulas shift their relative references by how far the paste moved; the system clipboard gets plain values, so pasting into Excel or an email works. |
| **drag a column border** | resize — and it is written back to the file. Double-click to auto-fit. Click a header to select the whole column or row. |
| **Ctrl+B / Ctrl+I, $ , %** | bold, italic, currency, thousands, percent, alignment — and they save back into the file. |
| **Fill / text colour, borders, size** | a 20-colour palette, borders on or off, bigger and smaller text — all written back too. |
| **Insert / delete rows and columns** | every formula in the *whole workbook* follows, including ones on other sheets. Merges and column widths move with them. |
| **Ctrl+K** | the command palette — commands not on the toolbar are one keystroke away |
| **Simple mode** | toggles the toolbar between 8 and 14 buttons. Same code, different JSON profile. |
| **Show API** | HTTP routes + MCP tool definitions, generated from the command list. Nothing hand-written. |
| `=0.1+0.2` | returns exactly `0.3`. Excel returns `0.30000000000000004`. |
| type `MAR1` | stays text. Excel makes it a date, which has corrupted published genomics data for twenty years. |

## The engine is graded by the files themselves

Excel caches the number it computed next to every formula, so any real workbook is an exam
we did not write. `test/agreement.mjs` runs it:

```
  5 workbooks · 223,601 graded formula cells
  agreement with Excel : 223,596 / 223,601  (100.00%)
  Excel's own errors reproduced : 1,790 / 1,790
```

That includes NREL's Annual Technology Baseline — 353,513 cells, 233,410 formulas, 39
sheets — reproduced **exactly**, including all 1,790 cells where Excel itself errors.

Five cells remain, all in one adversarial fixture, and they are a **published baseline**
rather than a hidden allowlist: defined names, whole-row references (`SUM(8:9)`) and array
functions (`TRANSPOSE`) are not implemented. The gate fails the moment that count rises.

It started at 19%. The gap was three defects, and the tool that found them reports ROOT
disagreements — cells that differ from Excel while all of their inputs agree — because the
150,000 cells downstream of a root are propagation, and chasing those is how you spend a
day fixing nothing.

## The claim, and how to check it yourself

Open `corpus/files/adv-pivot.xlsx` — a workbook with 23 pivot-table parts we cannot
display at all. Change one cell. Save. Then:

```
node --input-type=module -e "…"    # see test/corpus.roundtrip.test.mjs
```

**55 parts in, 54 back byte-identical, 1 changed — the sheet you edited.** All 23 pivot
parts untouched. That is `preserve-unknown`: we model what we understand, keep the rest
as opaque bytes, and put it back exactly. Every wrapper library discards what it doesn't
model, which is why *"I opened it in the free one and it wrecked my file"* is the single
biggest reason people don't leave Excel.

## Layout

```
src/core/
  decimal.js      exact decimal arithmetic (BigInt mantissa + scale)
  value.js        the value model, coercion rules, input parsing
  graph.js        THE PRODUCT — node graph, dirty propagation, topological recalc
  formula.js      lexer, precedence-climbing parser, evaluator
  functions.js    the function library (58 so far, target ~120)
  format.js       General number display (display only — the stored value is exact)
  numfmt.js       Excel format codes: sections, placeholders, dates, colours
  dates.js        date-serial conversion (arithmetic, deliberately NOT in ooxml/)
  commands.js     command registry + its five projections
  ooxml/
    chart.js      chart definitions and drawing anchors (references, not pictures)
    stylewrite.js deriving new styles by APPENDING to styles.xml, never rebuilding it
    structural.js insert/delete rows and columns, as a skeleton edit not N cell writes
    zip.js        container reader — keeps entry order and original compressed bytes
    zipwrite.js   container writer — verbatim re-emit for untouched parts
    crc32.js      IEEE 802.3, because no browser API exposes one
    xml.js        offset-preserving, namespace-prefix-agnostic scanner
    refs.js       relative-reference translation (shared formulas, fill-down, paste)
    xlsx.js       workbook reader
    edit.js       surgical cell edits spliced into the original XML
src/apps/sheet/   Sheet's two answers: A1 → node id, and a canvas grid
                  (+ chartview.js — bar/line/area/pie rendered from live values)
src/app.js        wiring: 14 commands, 2 profiles, palette, xlsx open/save
```

`core/` knows nothing about spreadsheets. It cannot parse `B4:B16` — it asks Sheet.
Deck will reuse `core/` untouched and supply its own two answers. That split is the
whole architectural claim.

## The cross-app claim, in the console

```js
miscellany.graph.set('deck:board/s3/chart-1', '=SUM(main!B4:B6)')
miscellany.graph.set('main!B4', '1')
miscellany.graph.value('deck:board/s3/chart-1')      // recalculated
```

A node that is not a cell, in a document that is not a spreadsheet, depending on cells.
No integration code exists for it — it is the same dependency walk that updates `=SUM()`.

## Design rules this codebase follows

1. **Never inherit a model; freely use a mechanism.** DEFLATE and CRC-32 are mechanisms
   (one correct answer, no opinion). A workbook class, a cell's semantics, a function's
   edge cases are models — those we build.
2. **Values are never stored, only recomputed.** A cached value that disagrees with its
   formula is the most corrosive bug a spreadsheet can carry.
3. **Splice, never regenerate.** Regeneration loses attribute order, self-closing style,
   whitespace, entity choice, and everything unmodelled.
4. **Gate on exact equality against an independent implementation.** A "greater than
   zero" check once passed a reader that dropped 116,491 of 233,410 formulas.

## What a real workbook looks like

Open `corpus/files/fhfa-po-monthly.xlsx`. It renders with its own dates (`01-01-91`, not
serial `33239`), two-decimal number formats, the merged bold title spanning the sheet,
its real column widths and its real row heights — including the 6pt spacer rows the
authors used, because those are in the file.

Long text spills sideways into empty neighbours and stops the instant one is occupied,
exactly as Excel does; cells marked wrap get real word wrapping; and a number too wide for
its column becomes `######` rather than silently losing digits — because a truncated
number is a *wrong* number, while truncated text is merely truncated.

That required a **number format engine** (`numfmt.js`), because a format code is a small
language, not a setting: `#,##0.00_);[Red](#,##0.00)` means thousands-separated to two
decimals, then a space the width of a closing paren, with negatives red and parenthesised.
Built-in format ids 0–49 are *not written into the file at all*, so a reader that only
looks at `<numFmt>` elements renders every date in the workbook as a raw serial.

## Known gaps — honest list

- **No conditional formatting, data bars, or icon sets.** Preserved on save, not displayed.
- **Rich-text runs render in the cell's base font** — a bold word inside a mostly-plain
  cell loses its bolding (the text itself is intact).
- **Borders are all-or-nothing per cell** — no per-edge control, and no line-style or
  border-colour choice beyond thin black.
- **The colour palette is 20 presets**, not a full picker.
- **Editing writes inline strings**, not shared-string entries — deliberately, since
  appending to `sharedStrings.xml` would turn a one-cell edit into a whole-workbook diff.
- **58 functions**, not the ~120 Stage 1 targets. Adding one is about five lines.
- **Undo is delta-based** (a journal of changed cells), so depth is unlimited on any
  file size. Verified at 741,525 cells: 5 edits, 5 undo levels, exact restore and redo.
  `file.new` clears history rather than journalling a whole-document discard.
- **Capabilities are advisory, not enforced** — first-party code in one JS context.
  Stated in `commands.js` at the check itself so nobody mistakes it for a sandbox.
- **Charts render** — bar, line, area and pie, with axes, gridlines, legends and titles,
  resolved from the LIVE graph rather than the file's saved cache. Where a series has no
  resolvable data the chart says "no data in range" rather than drawing a plausible lie.
- **Pivot tables are preserved, not displayed.** That is the intended order.
