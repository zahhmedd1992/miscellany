# PROJECT_MEMORY — Miscellany Platform (195)

## Status

**2026-08-02 — BUILDING. Plan v3 emailed. D1–D7 all resolved from Zach's own brief.**
Working engine + grid at `src/`. Run: `cd src && python -m http.server 9195`.
Tests: `node test/core.test.mjs` → **97/97 green**.

### Zach's pushback on v2 §7 — the doctrine correction (IMPORTANT)

v2 said *"we do not write a font shaper, a zip parser, a PDF writer, or an Excel function
library — those are solved, commodity, and permissively licensed."* Zach rejected it:
**"if we pull from someone else's work then our starting point is where their analysis
concluded — not what our first principles, independent evaluation would have concluded."**

He was right, and the error was bigger than the sentence. Calling something "commodity"
states the conclusion as the premise. And it produced a **checkable contradiction**:
v2 chose ExcelJS (which silently drops what it doesn't model) four sections away from a
Stage 1 gate demanding zero-loss round-trip. **ExcelJS structurally cannot pass that gate.**
He found it from the premise alone, without seeing code.

**The rule that replaced it — use this going forward:**

> **Never inherit a MODEL. Freely use a MECHANISM.**
> A *model* is an opinion about what the thing is (ExcelJS's Workbook, HyperFormula's cell
> semantics, Yjs's `Y.Map`). Adopting one makes our architecture downstream of their
> analysis, permanently and invisibly. A *mechanism* has a provably correct answer and no
> opinion (DEFLATE, SHA-256, OpenType glyph shaping). There is no "our take on inflate."

**What moved:** .xlsx/.pptx I/O → BUILD (direct OOXML vs ECMA-376). Formula function
library → BUILD. Yjs → algorithm only, never its document model, and **deferred past
Stage 2** (a hand-rolled CRDT is *more* likely to lose data — that's the one place the
rule is deliberately not applied at full strength). Kept: zip/DEFLATE, text shaping, Tauri
as a host. **Cost: Stage 1 ~10–14 wk → ~18–24 wk. Told Zach the number.**

**The payoff is a better product, not just a purer one — `preserve-unknown`:** parse what
we model, keep the rest as opaque XML, write it back byte-for-byte. Open a workbook with a
pivot table we don't support → cells modelled, pivot XML untouched and returned intact.
*Nobody* has this, because every wrapper's job is to discard what it doesn't understand.
"I opened it in the free one and it wrecked my file" is the #1 reason people don't leave
Excel. That's the moat, and it exists only because we refused the shortcut.

### Decisions D1–D7 — resolved from Zach's brief, not asked again

D1 MPL-2.0 · D2 **the software IS miscellany.io** (changed from my two-wings rec — he wrote
"make miscellany.io the world's largest platform of free software"; Open Signal becomes
secondary) · D3 narrow+flawless · D4 both web and download · D5 third parties gated to
Stage 4 · D6 tasks-completable not app-count · D7 Miscellany / Grain / Sheet·Deck·Doc·…

---

## Decisions pending (D1–D7)

| # | Question | My rec | Why it matters |
|---|---|---|---|
| D1 | Our license | **MPL-2.0** | Genuinely Zach's — values call. File-level copyleft: forks of our files must publish; building proprietary on top is free. Threads both his pillars. Alts: Apache-2.0 (max adoption, forkable-closed) / AGPL (blocks the technical users he wants). |
| D2 | Brand collision with Open Signal | **Two wings, one brand** (Works + Software) | miscellany.io is live as "autonomous AI-authored works." Gates Stage 4 front door only — deferrable. |
| D3 | Sheet v1 scope | **Narrow + flawless** (~120 fns, the 95% surface) | Chasing pivots+macros doubles Stage 1 and risks broad-and-mediocre = worthless by his own rule. |
| D4 | Web or download | **Both, one codebase** | ~10% extra cost, ~2x the addressable users. Tauri ~10MB vs Electron ~150MB. |
| D5 | Third-party modules | **Yes, but not until Stage 4** | Only path to "largest"; also the only path to junk drawer + malware. Both his fears live here. |
| D6 | "Largest" metric | **Not app count** — tasks completable for $0, no account, no glue | App count = the playpen he explicitly rejected, and unwinnable (Debian: 60k pkgs). |
| D7 | Names | Miscellany / **Grain** / Sheet·Deck·Doc·Note·Form·Board | Cosmetic, fully reversible. |

---

## Key findings from research (2026-08-02)

**The wedge — verified, not marketing.** Univer (github.com/dream-num/univer, 14k stars,
Apache-2.0 core) is the closest existing thing to Zach's vision — canvas-based, sheets+docs+
slides interoperating on one engine. **But Univer Pro gates file import/export AND printing.**
Its free tier cannot open an .xlsx or print. That is the exact "open-core amputation" pattern,
and it's our positioning: *nothing here is ever gated.*

**The near-miss.** HyperFormula is the obvious formula engine — 400+ fns, mature. It is
**GPLv3 or paid**. Taking it forces the whole platform to GPLv3. Rejected.

**The load-bearing fact I nearly got wrong.** A comparison blog sold Formualizer as the
permissive answer. Advisor flagged it as vendor-adjacent copy. Checked registries directly:
**v0.7.1 · created 2026-01-30 · 1,266 total downloads · 22 versions in 6 mo · ~156 stars ·
single maintainer.** MIT/Apache-2.0 confirmed on both npm and crates.io. → Real, promising,
NOT safe to lean on unhedged. Changed the plan from "we stand on this" to "first implementation
behind a `FunctionPack` interface, two named fallbacks."

Corollary insight that improved the architecture: **we own the dependency graph and recalc
scheduler regardless**, because that graph is exactly the machinery that makes charts-on-slides
work. So only the *function library* (SUM, VLOOKUP…) is a swappable dependency. The hard part
was never outsourceable and shouldn't have been framed as such.

**SheetJS trap.** npm `xlsx` is frozen at 0.18.5 — the project moved to its own CDN. Chose
ExcelJS 4.4.0 (MIT) instead.

**Cost of "free" is genuinely ~$0/mo.** Static on Cloudflare, p2p CRDT sync, no accounts → no
DB → no breach liability. SignPath Foundation signs qualifying OSS free, which clears Windows
SmartScreen — that was the one place "free" looked like it would break for non-technical users.

---

## Advisor corrections that changed the plan

1. **Framework-first was a trap.** Original sketch had "Stage 0: build substrate, prove with a
   trivial app." A trivial app doesn't stress a node graph → abstraction designed against
   imagined requirements. **Changed to:** build Sheet and Grain together, extract Grain from
   working code, then validate the extraction by building Deck on it. An abstraction that
   survives two real consumers is real; one designed in advance is a guess. Also fixed: Stage 0
   as written produced nothing Zach could look at for weeks → now there's a ~2-week visible
   artifact.
2. **"Secure" was floating as an adjective.** If modules run in the same JS context, capability
   denial is a convention any module can bypass — that's documentation, not security. → Added
   the explicit 3-tier enforcement table with Stages 1–2 marked **advisory, NOT a sandbox**.
3. **License is Zach's decision, not mine to assume.** Presented as D1 with the tradeoff.
4. **Structure as decisions, not prose.** 40-page architecture doc → "review" becomes "approve
   on vibes." Decisions first, argument below.
5. **Two worked examples beat the architecture section.** Chart-on-slide + the ribbon config.
6. **Put a pace number on Stage 1** or the quality rule is sentiment, not a gate.

---

## Architecture in one paragraph (for future sessions)

**Grain** = node graph + command registry + capability manifest + view shell. Everything (cell,
shape, paragraph, field) is a node with value/formula/style/dependents, sharing ONE recalc
scheduler. A chart on a slide is an ordinary dependent of a range — so cross-app composition is
free, because it was never two apps. Every action is declared once in the registry and projects
automatically to keyboard, menu, Ctrl+K palette, script, HTTP endpoint, and MCP tool — the API
generates itself. The toolbar is a JSON profile over the registry (10 buttons visible, ~390
palette-only, zero forks). References are **stable node ids, not file paths** — which is why
this doesn't break the way PowerPoint linked charts do.

---

## What is actually built (2026-08-02)

`decimal.js` exact BigInt decimal · `value.js` value model + coercion + input parsing ·
`graph.js` **the node graph** (dirty propagation, Kahn topological recalc over the dirty
subgraph only, cycle → `#CIRC!`) · `formula.js` lexer + precedence-climbing parser +
evaluator with lazy IF/AND/OR/IFERROR · `functions.js` 58 functions · `commands.js`
registry + 5 projections · `sheet.js` A1→node-id expander + canvas grid · `app.js` 12
working commands, 2 profiles, Ctrl+K palette, localStorage autosave.

**Verified in a real browser, not asserted:** typing, drag-select with live Sum/Average/
Count, undo/redo, fill-down with relative-ref shifting, profile toggle 7↔12 buttons,
palette ranking, persistence across reload, zero console errors.

**The cross-app claim is tested, not just diagrammed** — `test/core.test.mjs` sets
`deck:board/s3/chart-1` = `=SUM(main!A1:A3)`, edits a cell, and asserts the non-cell node
recalculated. No integration code exists for it.

## Traps hit this session (all three were MY OWN TEST, not the code)

1. Test expected `SUM=120`; correct answer was 150. I'd mis-added.
2. "Undo is broken" — C7 already held `=SUM(C4:C6)` **in the demo data**, so the command
   overwrote it with an identical value. Undo was fine. Retested on an empty column.
3. `window.miscellany` undefined under patchright → **known quirk, isolated world can't
   see page globals.** Fix: `pg.context.new_cdp_session(pg)` + `Runtime.evaluate`
   (main world). See [[reference-patchright-quirks]].

Real bug found by the browser and nothing else: **typing "200000" produced "2200000"** —
`beginEdit` focuses the overlay input and the browser then delivers the *same* keystroke
to it. Needed `e.preventDefault()` on the seed branch. Silent; only visible by reading
the number. A DOM-presence check would have passed.

## Session 2 (08.02) — corpus LOCKED, OOXML reader WORKING

**Order was honoured: corpus fixed and published BEFORE a line of the reader.**

`corpus/` — 49 files, 15MB, SHA256-locked in `corpus.json`, published in `CORPUS.md`.
- **Tier A (25)** representative real-world across 7 issuers: World Bank, EIA, BEA, FHFA,
  Census, NREL, HUD, Federal Reserve.
- **Tier B (24)** adversarial, chosen for **generator diversity** — Excel vs Google Sheets
  vs LibreOffice vs ClosedXML all emit different OOXML. Includes 3 pivot-table files
  (preserve-unknown's headline case), the 1904 date system, merged cells, CF, comments.
- `build_corpus.py` has `--recharacterise` (re-reads from disk, asserts hashes unchanged)
  so a characteriser fix can never silently move the goalposts.

`src/core/ooxml/` — **zip.js** (central directory, zip64, keeps entry order + original
compressed bytes for verbatim re-emit; DEFLATE via platform `DecompressionStream`/`zlib`
= mechanism, zero deps) · **xml.js** (offset-preserving, prefix-agnostic scanner — NOT a
DOM, because splicing the original text is the only way to keep byte fidelity) ·
**refs.js** (relative-reference translation) · **xlsx.js** (workbook/sheets/sharedStrings/
styles/cells, date detection from number format, 1900 phantom-leap-day handled).

**`test/corpus.read.test.mjs` → 174/174, 49 files, 1,824,815 cells, 0 throws.**

### THE TWO TRAPS — both found because the corpus is characterised, not counted

1. **Namespace prefixes — 12 of 49 files.** OOXML permits ANY prefix. Excel writes
   `<worksheet><c>`; ClosedXML and LibreOffice write `<x:worksheet><x:c>`. My first
   characteriser string-matched `"<c "` and called four files EMPTY. A reader with the
   same assumption opens a quarter of the corpus blank and reports success. `xml.js`
   exists so this cannot recur.
2. **Shared formulas — 116,491 references.** Excel writes a filled-down formula ONCE on
   the anchor (`<f t="shared" ref="J24:J28" si="0">…</f>`); every other cell has only
   `<f t="shared" si="0"/>` with **no text**. I treated text-less `<f>` as "no formula"
   and **silently dropped 116,491 of nrel-atb's 233,410 formulas.** File opens, looks
   right, half the model gone.

### AND MY GATE WAS TOO LOOSE TO CATCH #2

The first `corpus.read.test.mjs` asserted only `reader != 0` and `reader <= expected*1.05`.
It reported **158/158 green on the broken reader.** I caught it only by refusing to accept
a pass — a 93% cell shortfall on `adv-real-lineup` looked wrong, and chasing it exposed the
formula bug next door.

**Fix, and the rule going forward:** `corpus.json` now records `cellsWithValue` and
`cellsWithFormula` counted by a **separate implementation** (Python, different XML
strategy), and the test asserts **exact equality**. Two independent implementations
agreeing is evidence; one asserting is a press release. → [[feedback-noop-run-is-not-a-test]]

Reference translation has its own 14 traps tested directly (`LOG10(A1)` contains `G10`;
`"A1"` in a string literal is text; `$F$14` held; off-sheet → `#REF!`) because **a
corrupted formula still computes** — the failure is invisible until someone trusts it.

## Session 3 (08.02) — WRITER done, preserve-unknown PROVEN, xlsx live in the UI

**`corpus.roundtrip.test.mjs`: 49/49 byte-identical untouched · 49/49 single-edit
isolated · 148 assertions.** Plus core 107, read 174. **429 total. ~4,060 LOC, zero deps.**

Built: `zipwrite.js` (verbatim re-emit of untouched entries) · `crc32.js` · `edit.js`
(splice a cell into the original sheet XML) · `format.js` (General number display).
Wired into the UI: **Open .xlsx / Save .xlsx, multi-sheet tab bar, 14 commands.**

**Verified end-to-end through the real browser UI, then independently in Node:** opened
`adv-pivot.xlsx` (23 pivot parts we cannot display), edited a cell, saved ->
**55 parts in, 54 byte-identical out, 1 changed (the sheet edited). All 23 pivot parts
untouched.** That is the whole doctrine, demonstrated rather than asserted.

### THREE MORE TRAPS - all found by refusing to accept a green/plausible result

3. **Central-directory order != physical order.** `hud-fmr`'s FIRST central-directory
   entry lives at byte 361,093. I emitted local headers in directory order. A zip has
   **two independent orderings**: emit payloads in PHYSICAL order, the directory in
   CENTRAL order, and map between them by the offsets actually written.
4. **`e.versionMadeBy || 20`.** `frb-lbr` legitimately stores 0; `0 || 20` rewrote it to
   20 and the file differed by exactly two bytes. **Falsy-zero defaults in a binary
   format are silent corruption.** Use `??`.
5. **Chart sheets have no `<sheetData>`.** `<sheets>` lists worksheets, chartsheets AND
   dialogsheets. Treating them all as worksheets throws on a perfectly valid file.
   Fixed by reading the relationship Type -> `sheet.kind`.

Also: **data descriptors.** A streaming writer sets flag `0x08` and appends a 12/16-byte
trailer AFTER the payload. Copying header+payload and stopping there is both a byte-diff
and malformed for strict readers.

### The float-noise defect I caught by LOOKING at the screenshot

Real Census data rendered as `-0.024000000000000021`. Not a bug in us - that is what the
source file literally stores (computed in binary floats). But Excel shows `-0.024`, so a
correct reader *looked broken*. Fixed with `format.js`: General = 11 significant digits,
**display only, stored value untouched and still exact in the formula bar.** Deliberate
divergence recorded: Excel's General switches to scientific based on COLUMN WIDTH, so one
number renders two ways in one sheet. We switch on magnitude - width should change what
fits, not what a number is.

**Every gate was green before I looked at that screenshot.** -> [[feedback-earn-every-number]]

### Score for the session: 5 of 8 bugs were my own instrument or expectation

`SUM=120` (mis-added) · "undo broken" (demo data already held the value) · patchright
isolated-world globals · cell-count shortfall (legitimate empty-styled cells) ·
`1.2345678901E+12` (11 sig digits IS correct). The three real ones were found by chasing
numbers that merely *looked* wrong.

### Large-file path — the bug my tests structurally could not reach

I only ever opened small workbooks (3,124 and 99 cells). The corpus contains
**census-susb at 741,525 cells**. Opening is fine; the failure appears on the first EDIT:
- `snapshot()` stringified the whole graph (~30MB) onto a 200-deep undo stack.
- `markDirty()` autosaved the whole workbook into localStorage, which caps ~5MB and
  throws `QuotaExceededError` **inside a setTimeout** where nothing is listening.
- `Ctrl+S` wrote localStorage and reported "saved" while the user's .xlsx was untouched —
  a successful save of the wrong thing.

Fixed: **undo is now a JOURNAL OF DELTAS** (`graph.beginJournal()` records `[id, oldRaw]`),
so depth is free and cost is proportional to what changed. localStorage autosave is
skipped entirely when a workbook is open (that file IS the document). `Ctrl+S` saves the
.xlsx when one is open. localStorage writes are wrapped so quota failures say so instead
of leaving the indicator lying.

**Verified in the browser at 741,525 cells: opens in ~8s, 5 edits → 5 undo levels →
exact restore → exact redo, zero console errors.**

### Independent validation of the WRITER

Our reader accepting our writer proves less than it looks like. All 49 edited outputs are
validated by **Python's `zipfile`** (`testzip()` checks every entry CRC + the central
directory) plus a foreign search for the edited cell. **49/49 clean.**

## Session 4 (08.02) — CELL FORMATTING: a real workbook now looks like itself

**482 assertions green** (core 107 · numfmt 53 · read 174 · roundtrip 148). ~4,770 LOC.

Built `numfmt.js` — the Excel format-code language: up to 4 sections
(positive;negative;zero;text), digit placeholders `#0?`, thousands and scaling commas,
percent, quoted literals, `_x` padding, `*x` fill, `[Red]`, `[$USD-409]`, and the full
date/time token set. Plus full style reading: fonts, fills, borders, alignment, THEME
COLOURS with tint, the legacy indexed palette, column widths (character units -> px per
ECMA-376 §18.3.1.13), row heights, and merged cells. Grid repainted in 7 passes.

### The traps

- **Built-in format ids 0-49 are NOT written into styles.xml.** A cell with `numFmtId=14`
  has no formatCode anywhere in the file. Reading only `<numFmt>` elements renders every
  date in the workbook as a raw serial. Needed the built-in table.
- **`stripModifiers` must be quote-aware.** A regex over the section treats the bracket in
  `"["@"]"` as a modifier and deletes the literal, so a format that prints a value in
  brackets prints nothing.
- **The TEXT section needs literal processing too.** Emitting the raw pattern turned an
  accounting format's `_(` padding into a visible `_(_)` in every RSE row of the Census
  workbook — a faithful reader looking like it prints garbage.
- **`ht` is authoritative whenever present**; `customHeight` only records whether the USER
  set it. Gating on it rendered a 48pt header row at the 15pt default.

### THE PROCESS FAILURE WORTH REMEMBERING

I "rewrote" `draw()` inside a bash command whose **shell quoting was malformed**. Bash
exited 2 with `unexpected EOF` — so the Python heredoc **never ran**. I then verified with
a separate `node -e "import(...)"` that printed **"module parses OK"**, and took that as
confirmation the rewrite had landed. It had only confirmed the OLD file still parsed.

I then spent four rounds diagnosing a "stale browser cache" and twice accused correct
render code of being wrong — because the running page was faithfully executing the file I
had never actually changed.

**Rules:** (1) a command that exits non-zero did NOT run its later stages, however
confident the earlier output looked; (2) verify a code change by grepping the CHANGED FILE
for the new marker, never by checking that something still parses; (3) put non-trivial
patch scripts in a FILE — this is the second time this session that bash quoting silently
ate a heredoc. -> [[feedback-kill-the-right-background-job]]

Twice more I accused the renderer when the file was right: rows 1-4 of `fhfa-po-monthly`
really ARE 6pt/73.7pt/7.5pt/48pt spacer and title rows. **Read the source file before
calling a render wrong.**

## Session 5 (08.02) — text overflow + wrapping; a Census sheet reads correctly end to end

**500 assertions** (core 107 · numfmt 53 · layout 13 · read 174 · roundtrip 153).
Nine varied workbooks swept in the browser, zero errors, incl. nrel-atb (39 sheets,
353,513 cells, 147 parts kept untouched).

Added: text overflow into adjacent EMPTY cells (stops the instant one is occupied; left
spills right, right spills left, centre both), real word wrapping for `wrapText` cells with
vertical alignment, and `######` for numbers too wide for their column.

### The regression I introduced and the rule that caught it

`######` fired on a comfortable `1,478.0`. Two causes, both mine:
1. **Accounting formats emit padding.** `_(* #,##0.0_)` renders `" 1,478.0 "` — 51px with
   padding, 44px without, against 46px available. **Padding is alignment, not content.**
   Judge fit on the TRIMMED text.
2. **Column widths were authored against Calibri's digit metrics; we render Inter.** A few
   percent of disagreement is OUR problem, not the file's — so a marginal overrun clips
   rather than blanks. 6% tolerance.

I found it by LOOKING at the render, then measured instead of guessing: probed the live
page for colW / textW / avail and the actual format code. The numbers said it fit, which
proved `res.text` was not what I assumed — the padding was invisible in the screenshot.

**Then I nearly shipped a test of nothing:** I extracted `numberOverflows()` and wrote 6
cases against it while `draw()` still had the rule inline. A green test guarding a function
nobody calls. Wired it before running. -> [[feedback-verify-the-verifier]]

## Session 6 (08.02) — CHARTS, and an honest measurement of the formula engine

Built `core/ooxml/chart.js` (chart definitions + drawing anchors) and
`apps/sheet/chartview.js` (bar/line/area/pie with axes, gridlines, legend, titles).
Charts are positioned from their twoCell/oneCell/absolute anchors and **resolved against
the LIVE graph**, not the file's cached values — the platform claim, made visible.
Verified rendering on nrel-atb: axes, gridlines, category labels and the rotated
"Levelized Cost of Energy ($/MWh)" axis title all correct.

### THE NUMBER THAT MATTERS

A chart drawn from wrong numbers is worse than no chart, so I measured against Excel's
OWN cached results: **223,593 formula cells in nrel-atb carry a cached number; we
reproduce 42,401 of them. 19%.**

That is the honest state of the formula engine on a deep financial model, and it would
have been very easy never to measure. Small workbooks are fine — the engine suite covers
the common surface — but this one is not.

**Roots found and fixed:**
1. **`_xlfn.` prefix.** Excel writes functions newer than the file's format version as
   `_xlfn.CONCAT`, `_xlfn.TEXTJOIN`. Treating that as an unknown name produced **3,420
   `#NAME?` cells**. The prefix is a compatibility marker, not part of the identity.
2. **Sheet-qualified error literals.** `'Solar - CSP'!#REF!` is an error VALUE left by a
   deleted range; the lexer failed on it and reported `#NAME?`, blaming the formula for the
   file's history.
3. **Missing functions**, found by censusing every formula rather than guessing:
   **SUMPRODUCT (4,725 uses)**, ROW, COLUMN, ADDRESS, UNICHAR, HYPERLINK — plus UNICODE,
   CHAR, CODE. `ROW()`/`COLUMN()` with no argument need the containing cell, so the graph
   now passes `api.self`.

Remaining: the disagreements propagate from fewer roots than their 1,703 distinct shapes
suggest. The next step is the same root analysis applied to VALUE disagreements rather
than errors — the error-root version is already written.

### Also fixed

**Default column width was 108px; Excel's is ~64px** (8.43 chars). Every sheet without
explicit widths rendered stretched, and anchored charts — whose extent is measured in
CELLS — were far too wide. Now 64, and `<sheetFormatPr defaultColWidth>` is honoured.

### The Python trap

`NEW.rstrip()[:-0]` is **`[:0]` — the empty string.** My patch inserted nothing AND deleted
the closing brace of the FUNCTIONS object. Caught immediately by a parse error, but `[:-0]`
is worth remembering: it does not mean "everything".

## Session 7 (08.02) — FORMULA ENGINE: 19% -> 100.00% against Excel's own answers

```
  5 workbooks · 223,601 graded formula cells
  agreement with Excel : 223,596 / 223,601  (100.00%)
  Excel's own errors reproduced : 1,790 / 1,790
```

NREL ATB — 353,513 cells, 233,410 formulas, 39 sheets — now reproduces EXACTLY.

**The tool that made it possible:** `test/agreement.mjs` reports ROOT disagreements — a cell
that differs from Excel while every one of its dependencies AGREES. 150,992 wrong cells
collapsed to 78 root patterns; the rest was propagation. Chasing symptoms would have burned
a day fixing nothing.

### THREE DEFECTS, EACH ENORMOUS

1. **The evaluation context was hardcoded to sheet `'main'`.** `makeGraph()` passed
   `{sheet: SHEET}` — a constant — so EVERY bare reference (`=S28`) on EVERY sheet resolved
   to `main!S28`. 18,953 root cells. Fixed by giving Graph a `contextOf(id)` callback so it
   asks per node; Sheet answers with `sheetOfId()`. **Both `_rewire` and `_safeEval` must use
   the NODE's context, never the caller's** — `set()` is invoked from everywhere.
   19% -> 62.9%.
2. **`REF_RE` made the `!` optional after a sheet name.** `AA255` backtracked to
   sheet="A", cell A255 — so every TWO-LETTER column reference without a sheet qualifier
   read from a sheet that does not exist. One character (`!?` -> `!`). 62.9% -> 100.0%.
3. **A formula's result is never blank.** `=A1` where A1 is empty shows 0 in Excel.
   Blankness still survives INSIDE evaluation so `ISBLANK`/`COUNTBLANK` are unaffected;
   only the top-level result of a formula becomes 0.

Earlier in the same hunt: `_xlfn.` prefix (3,420 #NAME?), sheet-qualified `#REF!`, and
SUMPRODUCT + 8 more functions found by censusing every formula in the workbook.

### THE LESSON

**Bugs 1 and 2 were invisible to 107 passing engine tests**, because every test used a
single sheet named `main` and single-letter columns. The fixtures could not express the
failure. Only a real 39-sheet workbook could — and only because the file carries Excel's
own answers, which turns any real workbook into a graded exam that costs nothing to run.
-> [[feedback-gate-exact-not-nonzero]] (size your fixtures to your real data)

Five cells remain, all in one adversarial fixture, recorded as a **published baseline** in
`agreement.mjs` with the reason for each (defined names, whole-row refs, array functions).
The gate fails if the count rises — it is not an allowlist that grows to stay green.

## Session 8 (08.02) — EDITING: clipboard and resize

Zach asked to start with editing rather than repo hygiene. Done:

**Clipboard** (`apps/sheet/clipboard.js`) — bound to the browser's own copy/cut/paste
EVENTS, not `navigator.clipboard`, because the events carry data with no permission prompt
and fire from the keystrokes users already know. **Two payloads at once:**
`text/plain` = displayed values as TSV (so Excel, Sheets, email all work) and
`application/x-grain` = RAW inputs + source anchor (so a paste back keeps formulas and
translates their relative references by the paste offset). A TSV-only clipboard loses every
formula; a private-format-only clipboard is a walled garden.

Verified with real keystrokes in a browser: copy D4:D6 (`=B4-C4`) → paste at G4 → `=E4-F4`,
source intact, system clipboard holds `55300\n62350\n74500`. **Cut does not clear the
source until the paste actually happens** (an abandoned cut destroys nothing), and the
dependent SUM recalculated 425550 → 297150. Undo restores both halves.

**Resize** — drag a column or row border (cursor switches), double-click to auto-fit,
click a header to select the whole column/row. Verified: 64 → 144 on a +80 drag, auto-fit
to 86.

`test/clipboard.test.mjs` — 22 assertions on TSV quoting/escaping and paste translation.
**530 total.** Agreement still 100.00%, round-trip still 49/49.

### My instrument, again (5th time this session)

"External TSV paste failed" — J10..K11 all empty. The paste path was fine; my test's
`\\t`/`\\n` did not survive Python -> JS as I assumed. Probing `decodePaste` directly
returned the right grid immediately. **When a feature fails only inside my harness, suspect
the harness first.**

### Known gap introduced

Resize is DISPLAY-ONLY — it does not write `<cols>` back, so a resize is lost on save.
Recorded in the README rather than half-implemented.

## Session 9 (08.02) — FORMATTING, with real styles.xml writeback

9 format commands (bold, italic, currency, percent, thousands, plain, 3 alignments).
**555 assertions.** Agreement 100.00%, round-trip 49/49.

**The model that makes it work:** a cell does not carry formatting, it carries an INDEX
into `cellXfs`. "Bold this" = "find or create an xf identical to this one but with a bold
font, and point the cell at it". `core/ooxml/stylewrite.js` does that, and **APPENDS by
splicing** — new `<font>`/`<numFmt>`/`<xf>` go in before the closing tag and the `count=`
attributes are bumped. The 104 xfs and 19 fonts already in a real workbook come back
byte-for-byte. Rebuilding the part from a model would discard every one of them, plus the
dxfs, table styles and extLst we do not model at all.

**Verified end to end in the browser, then independently in Node:** opened census-const,
selected B9:E15 → Currency, A9:A15 → Ctrl+B, saved. Result: **24 parts, exactly 2 changed**
(the sheet and styles.xml, both legitimately modelled). A9 bold with its text intact, B9
renders `$1,399.00`, and F9 just outside the selection kept its original accounting format.

An identical request REUSES an existing xf rather than growing the table on every
keystroke — bold on census-const resolved to the file's existing xf 12 and added nothing.

### Also fixed

The save status said "0 cells changed" after formatting 35 cells, because it only counted
VALUE changes. That reads as a failed save. Now reports values and formats separately.

## Session 10 (08.02) — INSERT / DELETE rows and columns

**589 assertions.** Agreement 100.00%, round-trip 49/49. ~6,900 LOC.

Two things move, and forgetting either silently corrupts the file:
1. the CELLS on the edited sheet shift, and
2. **every formula in the WHOLE WORKBOOK that points at that sheet** — including
   formulas on OTHER sheets, which is the part that is easy to miss because the edited
   sheet looks right afterwards. Verified: `Other!A1 = main!B7*2` became `= main!B8*2`.

**The rule is applied per REFERENCE, and that handles ranges for free.** Insert a row at 5
into `A1:A10`: A1 is above the cut so it stays, A10 is at/below so it becomes A11 — the
range GREW, which is right. Delete row 5: A1 stays, A10 -> A9, the range SHRANK. No
special case for the pair. A wholly-deleted range collapses `#REF!:#REF!` -> `#REF!`.

### THE PERFORMANCE BUG THAT WAS REALLY A DESIGN BUG

First version expressed a structural edit as the ordinary cell diff. Inserting one row into
a 3,124-cell sheet changed every cell id below it, so the save became thousands of
`setCellRaw` calls, each rescanning the whole part — **quadratic, and it timed out at 90
seconds.**

The change is to the SKELETON, not the contents. `core/ooxml/structural.js` renumbers rows
and cell refs in ONE pass and leaves styles, spans, custom heights and every unmodelled
element exactly where they were. **90s timeout -> 1.7s**, and the saved file has 24 parts
with exactly 1 changed. Merges shifted correctly (`A33:A34` -> `A34:A35`), cell count and
styles preserved.

Undo cannot express a structural edit as a delta journal, so the history is cleared —
stated rather than silently half-working.

### My own test, twice more

`t('below shifts', want, got)` with the arguments swapped (the function was right), and a
merge that collapses to one cell — I expected `A1:A1`, but Excel drops those and so do we.
**Running tally for the session: 7 of ~12 "bugs" were my instrument or my expectation.**

## Session 11 (08.02) — column widths and row heights persist

**600 assertions.** Agreement 100.00%, round-trip 49/49.

Resizing now writes back. Two traps, both caught by tests rather than by luck:

1. **The px -> chars inverse was wrong.** I wrote the obvious `(px - 5) / 7`; the real
   inverse of Excel's formula is `((px * 256 / MDW) - trunc(128/MDW)) / 256`. Mine sent
   59px to 54px, so every save would have narrowed the columns the user had just widened.
   Now round-trips within 1px across 20..600.
2. **Regenerating the whole `<cols>` element re-rounds untouched columns.** Column A drifted
   228 -> 227px on a save where I only dragged column B. Now only the columns the user
   ACTUALLY resized are written: the containing span is split so the untouched parts keep
   their original text verbatim. Verified on the real file: **0 of 13 untouched columns
   drifted.**

Same doctrine as everywhere else — do not rewrite what the user did not change.

## Session 12 (08.02) — fills, borders, text colour, font size

**617 assertions.** Agreement 100.00%, round-trip 49/49. 15 format commands.

`stylewrite.js` now derives fills and borders as well as fonts and number formats, and
every one of them APPENDS to its table rather than rebuilding it — a new `<fill>` goes in
before `</fills>` and the count is bumped, so the file's existing fills, borders, dxfs and
table styles are untouched.

**The bug this shape of code invites, and the test that guards it:** setting a fill must
not drop the bold the user applied a moment earlier. `derive()` starts from the cell's
CURRENT xf and changes only what was asked, and there are four assertions specifically for
"a later change keeps the earlier ones".

Verified end to end on census-const: fill `#FFF2CC`, text `#C00000`, size 12, thin border
applied to B9:F9 and saved → **2 parts changed** (sheet + styles), value intact, and B18
just below still has no fill and size 11.

UI: a 20-swatch preset palette rather than a full colour wheel — almost every real
formatting choice is one of these, and the wheel is a bigger UI than the value it adds.

## Session 13 (08.02) — DISTRIBUTION: repo, licence gate, front door

Repo initialised (46 files, `corpus/files/` excluded — reproducible from the committed
`corpus.json` lock). **LICENSE = MPL-2.0** per D1, with a plain-terms preamble. `package.json`
with `npm test` running all eight suites plus the agreement gate.

**`tools/check-licences.mjs` — the gate I promised three sessions ago and skipped.**
Two checks, and the second is the one that holds the line: (1) every declared dependency's
licence is on the allowlist; (2) **no source file imports a bare specifier**. A dependency
can arrive without touching package.json — a CDN URL, a vendored file, an import map — so
a gate that only reads package.json would not see it.

### The gate caught a real contradiction on its first run

The app loaded **Google Fonts**. So a tool whose entire pitch is "your file never leaves
your machine" was making a request to Google on every load, would not work offline, and
called itself zero-dependency. Removed — system font stack throughout. Verified in a
browser: **zero external requests** across landing page -> app -> opening a real workbook.
`ALLOWED_REMOTE` is now deliberately empty with a note that additions need an argument.

Also refined: a hyperlink is navigation, a resource is a fetch. The first version flagged
`<a href="https://mozilla.org/MPL/2.0/">` as a dependency — a gate that cries wolf gets
ignored. Now only `<link>/<script>/<img>/<iframe>` URLs count.

### Built

`site/index.html` — the front door, in the Miscellany warm-editorial identity, with an
"Honest about what is missing" section (75 functions not 500, charts read-only, no
collaboration, early). `tools/build-site.mjs` -> `dist/` (25 files, 289 KB): copies, then
VERIFIES self-containment rather than transforming anything.

### NOT DONE — needs Zach's go-ahead

Deploying to the live miscellany.io would replace the Open Signal front door that is there
now. That is outward-facing and his call, so `dist/` is built and verified but not pushed.

## Open threads / next actions
- [ ] Cell formatting: `Node.meta` exists in the model, the renderer ignores it.
- [ ] Formula *printer* (parser exists) — prerequisite for insert/delete row+column.
- [ ] Functions 58 → ~120.
- [ ] Repo + dependency-license CI check before any dependency is added.
- [ ] SignPath Foundation application once public (unknown lead time — start early).

---

# 2026-08-02 — Deck, and the shell (the "piecemeal" correction)

Zach: *"I would prefer we continue building only from scratch. Piece meal approaches cut at
the heart of this project."* He was right about where it had happened. The audit was blunt:
`src/apps/` held ONE app, `app.js` was 1,339 lines of Sheet-specific wiring (bigger than the
spreadsheet it wired), capabilities were `if (ctx.granted)` with nothing ever granting, and
the MCP bus was a preview page. I had built a spreadsheet and called it a platform.

## What the second app cost, honestly

    Sheet's own code       1,339 -> 1,048     (entry point 1,339 -> 48)
    core/shell.js                    620      written once, for every app
    Deck, complete                   712      entry point 34, page 15
    core reused unchanged          2,858

The headline is the entry point; the real number is **291** — how much of Sheet turned out
not to be about spreadsheets. The payoff is not in Sheet, it is that Deck got undo, redo,
the command palette, Ctrl+K search, a generated toolbar, autosave and a status bar without
implementing any of them.

## Eight core bugs, every one found by building the SECOND app

1. **TEXT() did not exist.** numfmt.js implemented the whole Excel format-code language from
   week one and no formula could reach it — formatting was something the grid VIEW did to a
   cell. A slide has no cells.
2. **A quoted literal was read as a token.** The pass that EMITS a format was quote-aware;
   every pass that DECIDES (percent scaling, scaling commas, decimal places, required digits)
   read the raw pattern. `0.0"%"` printed 45.2 as **4520.0%**. Fixed once with a skeleton.
3. **Painting mutated the document.** Deck resolved a chart's range by writing a scratch node
   mid-paint, so drawing re-entered drawing: one keystroke → **496 nested repaints and a
   stack overflow**. Nothing reported it — *an exhausted stack has no room to run an error
   handler* — so the console stayed empty while both views went blank. The graph now refuses
   a write from a change listener, by name.
4. **Setting a literal notified nobody.** Its value is assigned before recalc, so recalc
   compared the new value with itself. Sheet never noticed because it repaints itself; a
   SECOND view would simply not have updated.
5. **Formatting was invisible to undo** (`Graph.setMeta`). `node.meta` was assigned directly,
   so the journal came back empty and Undo reverted the change BEFORE the one you meant.
   Hit bold/fill/borders in Sheet and font size in Deck.
6. **The shell owns layout, so it owns resize.** Mounting a second pane halves the first's
   width and fires NO window resize event — the grid kept a 3200px backing store in an 800px
   box and drew every column at half scale. ResizeObserver per pane now.
7. **A canvas is a REPLACED element**: `height:auto` with top+bottom set does not stretch, it
   takes the intrinsic w/h-attribute ratio. Slide canvas sat 400px tall in a 773px pane.
8. **A saved deck lost every slide but the first.** The slide count was a counter on the
   VIEW; objects saved fine and the count went nowhere. Derived from the document now.
   Same counter also stranded the last slide when you deleted a middle one.

## The lesson that keeps repeating

**My own test was the bug ~10 times today**, and once catastrophically: `qa/live_update.py`
passed 17 assertions on a page whose grid and slide were both blank, because every assertion
read the MODEL. It now counts repaints and measures rendered pixels — September's bar against
July's, 1.21 → 2.02, against 260000/128400 = 2.02 expected. Same shape as bug 7: the first
guard checked the backing store matched the box, on a box that was itself wrong.

## Entry points (build output moved sheet/ -> app/)

`/index.html` front door · `/app/` Sheet · `/app/deck.html` Deck · `/app/compose.html` both
over one document. Sheet/Deck/Both are three tabs; `shell.mount(root, ['sheet','deck'])` is
the whole composition.

## Still open
- [ ] MCP/HTTP bus is still only a rendered preview — nothing serves it.
- [ ] Deploying `dist/` to live miscellany.io (would replace Open Signal front door) — Zach's call.
- [ ] Tauri desktop build + SignPath signing.
- [ ] Deck cannot open or save .pptx yet; a deck lives in localStorage or inside a workbook.

## Correction, same day: the shell was still built the piecemeal way

Zach pushed back again after the shell landed, and he was right. I read
"piecemeal" as "you only built one app" and answered by EXTRACTING a shell out
of app.js. But extraction-from-what-exists *is* the piecemeal method. I had
even written the doctrine down in `document.js` — *"an abstraction that
survives two real consumers is real, one designed in advance is a guess"* —
which is the piecemeal rule stated as a principle, and the advisor endorsed it.

It is the same sentence he used about ExcelJS in his second message: **if you
start from a concluded analysis, your ceiling is that analysis.** Last time the
concluded analysis was someone else's library. This time it was my own app.js.

**The checkable consequence.** app.js's answer to "what is a document?" is "an
.xlsx", and the shell inherited it:

- `compose.html` — the flagship "one document, two views" page — had **no
  storageKey**, so Ctrl+S silently did nothing and said nothing.
- Sheet and Deck had **separate** localStorage keys: two documents wearing one
  layout.
- The only file writer in the whole codebase was `ooxml/` — Excel's format.

So "usable individually or combined into one dual solution", the literal first
thing asked for, had **no file behind it**. The combined view shipped
unsaveable.

### Built from first principles: `core/docfile.js`, the `.grain` format

Derived from what the platform IS, not from what one app needed:

1. **A document is a graph of NODES**, not cells. `main!B4` and `deck:s1/kpi`
   are both just ids — a future app gets persistence the day it picks a prefix
   (test asserts this with a `form:` app that does not exist).
2. **Inputs only, never computed values.** A file that caches a result beside
   its formula can hold the two in disagreement. Opening recalculates. (.xlsx
   *does* cache them — which is exactly why real workbooks work as a graded
   exam in `test/agreement.mjs`. Useful in a corpus, wrong in our own format.)
3. **One node per line**, so a 350k-node document diffs, merges and blames.
4. **Preserve unknown** — records a newer build wrote are kept verbatim and
   written back. Same discipline as the zip work.
5. **Nothing executes.** No script, macro, include or external reference in the
   grammar. "Secure" has to mean something at the format level.

JSON per record so escaping is JSON's rules — a MECHANISM with a provably
correct answer. Every opinion in the file is ours.

`file.save.doc` / `file.open.doc` are SHELL commands, not app commands, because
the document is the shell's. `save()` with no storageKey now says so instead of
returning silently.

Proof in `qa/one_document.py`: build a sheet, put a deck on it, save one file,
wipe the tab, reopen — and the slide's figures are still **live** (editing after
opening still moves them). Plus a forged `miscellany/9` file with an unknown
record opens, warns, and round-trips that record back out.

  34 docfile assertions · 26+ browser assertions · sample file in
  `qa/out/one-document.grain` (36 lines, human-readable, sheet + deck together)

### The standing lesson
**My own test was the bug ~11 times today.** Worst case: 17 assertions passing
on a page whose grid and slide were both blank, because all of them read the
model. Second worst: a canvas-size guard that checked the backing store matched
the box — on a box that was itself wrong. Fix in both cases: measure what a
person would see, and DERIVE expected numbers from the document instead of
hand-computing constants into the test.

---

# 2026-08-05 — LOAN LIVE: tally 8. THE WHOLE RECOMMENDED SEQUENCE IS SHIPPED.

`site/tool/loan.html` (single-file small). 30/360 US w/ EOM rules · A/360 ·
A/365 · integer cents, stated half-up rule · extras + lump scenarios (savings
COMPUTED vs the no-extra schedule) · 0% safe · year subtotals · print CSS.
**Exam: independent Python mirror agrees on EVERY ROW of 8 trap configs;
numpy-financial (3rd leg) agrees on every payment; Σprincipal == loan to the
penny; payment == interest+principal each row.** The only divergence found
was the ORACLE forgetting `prev = date` (accrual window never advanced —
compounding day counts). ~9th "my instrument was the bug" of the project.
Deployed, purged, live-verified (tally 8, header CSP alone, download
byte-identical + computes from disk, zero net attempts).

**Standing observation: a MIDNIGHT AUTO-COMMIT JOB commits AND pushes this
repo (author Zach, "auto-commit: <date> 00:00"). Not in schtasks under
git/commit/backup — origin unidentified. It swept 30MB of corpus PDFs into
the public repo before the ignore existed (now untracked; history keeps
them — public-domain gov docs, bloat only, judged not worth a force-push).
Keep the tree ignore-clean by midnight.**

---

# 2026-08-05 — PDF TOOLKIT LIVE: tally 6 → 7 (the flagship shipped)

`/app/pdf.html` — merge, split/extract, reorder, rotate, delete, strip
metadata. Sheet-pattern (entry + modules in `src/core/pdf/` + `src/apps/pdf/`,
bundled download). **Corpus-first, same discipline as xlsx: 17 SHA-locked
gov PDFs (1.2→1.7, classic+stream+hybrid xrefs, objstms, forms, 13MB FR
daily, 1,039-page bills), page counts agreed by pikepdf AND pdfium before
our reader existed.**

- Reader: byte lexer · classic tables · xref streams (W/Index + PNG
  predictors) · hybrid /XRefStm · /Prev chains · object streams · page-tree
  inheritance. **Free entries record freedom, never a claim** (hybrid files
  mark free the objects their XRefStm defines). 133 read checks + EVERY live
  object parses.
- Writer: ONE page-list model expresses all ops. Single-source: untouched
  objects keep number + exact original bytes; objstm members emitted as their
  verbatim member bytes. Merge: only later docs renumbered (doc A stays
  byte-preserved); stream DATA verbatim always. AcroForm kept single-source
  (fields pruned via /P to surviving pages), dropped on merges (stated).
- **The exam is pixels: every op's output renders PIXEL-IDENTICAL under
  pdfium to its source pages, and pikepdf's checker reports no warnings NOT
  inherited from the source** (irs-i1040gi ships one quirky Flate stream —
  preserved quirk, not our bug). UI exam drives real clicks incl. clicked
  downloads; bundle does page surgery from file:// with zero net attempts.
- Traps: (1) encrypted files must be detected BEFORE objstm pre-decode or
  the refusal surfaces as a fake decompression error; (2) **make-single
  hardcoded `<body><div id=root>` — fine for canvas apps that build their own
  DOM, but it silently DISCARDED the PDF page's entire static body**; now
  carries the entry body verbatim (minus its module script tag), proven
  byte-equivalent for Sheet/Deck by bundles_smoke.py; (3) pikepdf 10.x:
  `check_pdf_syntax()` (instance method) is the qpdf --check equivalent.
- Live-verified: tally 7, tool functions at miscellany.io with a real IRS
  form, download byte-identical. Known live-check quirk: patchright teardown
  can raise "event loop already running" AFTER all assertions pass — rerun,
  don't chase.

v2 backlog (stated on-page): thumbnails (needs own renderer), outlines
carry-over, page numbers stamp, compress, encrypted-with-password open.

---

# 2026-08-04 — FOUR SINGLE-FILE TOOLS SHIPPED LIVE: tally 2 → 6

Zach set /goal "proceed with the recommended sequence." Shipped **Passwords, QR,
Verify, Encrypt** — each ONE self-contained html in `site/tool/`, served at
`/tool/<slug>` and downloadable at `/download/miscellany-<slug>.html` as the
SAME BYTES (stronger than Sheet's story: the page you use IS the file you
download IS the source — nothing bundled, nothing to reconcile).

## Architecture decisions that will outlive these four tools

- **Two-layer CSP.** In-file `<meta>` policy (`default-src 'none'; script-src
  'unsafe-inline'…`) makes even the DOWNLOADED copy refuse the network — closes
  the round-4 "no CSP on file://" hole. Served copy gets a per-path `_headers`
  rule: `! Content-Security-Policy` detaches the site-wide `script-src 'self'`
  (which would kill inline scripts), replaced with `script-src 'sha256-<hash of
  the file's one script>'` — an edge-injected inline script does not match and
  DOES NOT RUN. **`!` detach verified live via headers_array(): exactly one CSP
  header per tool path.** Both path forms again (.html 308s).
- **Build guards extended** (all proven by firing): forbidden-token scan on the
  tool file bytes, exactly-one-`<script>` check, meta-CSP-present check, CRLF
  check (the hash must match served bytes). TOOLS entries with `file:` skip the
  closure walk; downloads _headers rules cover them via the same TOOLS map.
- **QA pattern for smalls**: patchright + CDP MAIN-world evaluate (the page's
  own meta CSP blocks playwright's eval-based wait_for_function — poll via CDP
  instead), independent-implementation oracles, both http and file://, clicked
  downloads byte-compared then run from disk.

## The graded exams (each caught real bugs)

- **QR**: from-scratch ISO 18004 (GF(256)/RS, versions 1–40, 4 penalty rules,
  BCH format/version). Exam = OpenCV + zbar decoding ALL 160 version×level
  combos → **160/160 exact**, plus module-for-module identity with python-qrcode
  at v1 and v7. THREE traps: (1) alignment-pattern skip tested `fn[centre]`,
  which silently dropped every timing-line pattern from v7 up — caught by the
  geometry-vs-table cross-check (free modules ≡ table codewords, 40/40); (2)
  **format info is placed MSB-first from (8,0) — LSB-first produces a symbol no
  decoder reads while looking identical in a screenshot**; (3) zbar TRANSCODES
  UTF-8 it guesses is Shift-JIS (¥ for backslash) — cv2 is the UTF-8 oracle.
- **Passwords**: uniform-over-constrained-set generation (rejection sampling),
  entropy = exact BigInt inclusion–exclusion count — matches an independent
  Python implementation to 6 decimals in every configuration; chi-square clean.
  EFF large wordlist embedded (CC BY 3.0, attributed; structurally verified
  7776 words = complete 6^5 dice space).
- **Verify**: streaming SHA-256/SHA-1 from FIPS 180-4 (WebCrypto can't stream
  — a 6 GB ISO must not OOM); every displayed hash equals hashlib across
  0/1/55/56/63/64/65-byte padding edges and multi-slice files; in-page
  self-test (vectors + WebCrypto agreement) shown to the user.
  Trap: **a `<label>` is display:inline — the padded drop zone painted as a
  fragmented inline box** until display:block. Screenshot caught it; the DOM
  probe named it.
- **Encrypt**: AES-256-GCM + PBKDF2-SHA256×600k, format documented byte-by-byte
  in the file. Exam = INTEROP BOTH WAYS with Python `cryptography` (page-sealed
  → python opens; python-sealed → page opens through the real UI, UTF-8 name);
  tamper (one flipped byte) and wrong passphrase rejected cleanly. 1 GB stated
  limit (one-shot GCM), stated not discovered.

## Live verification (urllib gets 403 — CF challenges non-browser agents; all
checks ride the real browser): tally 6, six tools function at miscellany.io,
platform apps still paint, all four clicked downloads byte-identical to the
build and working from disk with zero network attempts. 153 platform tests
still green; licence gate clean.

Next per IDEA_QUEUE sequence: **PDF toolkit** (flagship), then amortization.

---

# 2026-08-04 — IDEA_QUEUE.md established

Zach asked for a rough idea list of what ships next. Wrote `IDEA_QUEUE.md` (project root):
a 5-criterion filter (broken status quo · fully local · narrow+flawless · **no maintenance
decay** · no inherited models), ~25 candidates in two tracks — Track B single-file tools
(private file surgery / subscription-scam counterparts / bank-grade calculators / text+data /
printables) and Track A Grain apps (Board → Note → Form → Doc-deferred) — an explicit
anti-queue (currency FX, tax tables, diagramming, video, comms), and a recommended next-5:
password gen → QR → hash+encrypt → **PDF toolkit (flagship)** → amortization. Awaiting
Zach's reaction; nothing queued as committed.

Landscape check (08.04): client-side PDF tools exist (TinyPDFTools, ClientPDF, Brevio…)
but ALL stand on pdf-lib — which rebuilds files and drops what it doesn't model, the
ExcelJS pattern. Preserve-unknown via PDF incremental updates + download-is-the-source
remain unclaimed ground. Single-file HTML tools are a hobbyist genre (HN, GitHub
collections) with no quality bar or brand — format validated, position open.

---

# 2026-08-02 — LIVE at miscellany.io

**Zach's go-ahead:** *"you can retire opensignal and post the latest."*

## What is where

| URL | Serves |
|---|---|
| `https://miscellany.io/` | the platform front door |
| `https://miscellany.io/app/` | Sheet |
| `https://miscellany.io/app/deck` | Deck (`.html` 308-redirects here) |
| `https://miscellany.io/app/compose` | Sheet + Deck over one document |
| `https://opensignal.miscellany.io` | **Open Signal — still live, untouched** |

- Root = CF **Pages project `miscellany-portal`**, production branch `main`,
  zone `739dbd1ed14d6f0df177389d69cc9dc9`, account `d8ecf569f9a29c4b52d667d15f71ecb6`.
- Deploy: `wrangler pages deploy dist --project-name=miscellany-portal --branch=main`
  with `CLOUDFLARE_API_TOKEN` from `~/AI/100_06.09.26_prospect-outreach-crm/.env`.
  **Always purge the zone cache after** (`purge_everything`).
- I did **not** delete the `open-signal` Pages project or its DNS. Retiring the front
  door ≠ deleting the publication, and only one of those is reversible.

## Two things a terminal cannot see

1. **curl returned 200 for every entry point while all three apps were broken.**
   `/app/app.js` came back as `text/html`; `deck.html`/`compose.html` were still
   serving the OLD Open Signal page. Cause: CF Pages **308-redirects `.html` to the
   extensionless form**, and the edge still held responses from when those paths did
   not exist. Only loading the live URLs in a real browser and reading the console
   found it. → reinforces [[reference-cloudflare-stale-assets]].

2. **Cloudflare injected an analytics beacon into every page** (`static.cloudflareinsights.com`),
   at the edge, with no change of ours — on a site whose headline promise is *"your file
   never leaves your machine."* Not shipping code that phones home is necessary and **not
   sufficient**.

## The fix: the browser enforces the promise

`tools/build-site.mjs` now generates `dist/_headers` with
`script-src 'self'; connect-src 'self'` (+ nosniff, no-referrer, permissions-policy,
COOP). **There is not one inline script in the project**, so this costs nothing.
Verified live: the beacon is attempted and **blocked**, 0 bytes leave.

⚠️ **Open for Zach:** the beacon is blocked but still *injected*, so devtools logs a CSP
refusal on every load. One toggle in the CF dashboard (Web Analytics → automatic setup)
removes it at source. My token has no RUM scope (`Authentication error` on `/rum/site_info`).

## Front door rewritten
Deck section, one-document-format section, the reuse claim as a checkable number,
and 3 new "Honest about what is missing" cards (no `.pptx`, Sheet charts read-only,
API generated but not served). Counts corrected to 76 functions / 679 assertions.
Links stay `.html` on purpose — extensionless only works on Pages, `.html` works when
you download the folder and open it locally.


## Open sourced 2026-08-02

**Repo: <https://github.com/zahhmedd1992/miscellany>** (public, MPL-2.0, `master`).
`gh` is authed as `zahhmedd1992`. Push with `git push origin HEAD`.

Zach looked at the live page and caught two things:

1. **"remember this is supposed to be open source"** — and there was no way to get
   the code. Worse, `LICENSE` was a 22-line *summary* whose text read *"if a copy of
   the MPL was not distributed with this file..."* — and it was not. GitHub could not
   detect the licence because the licence was not there. Fixed: full MPL-2.0 text in
   `LICENSE`, plain-terms explanation moved to `NOTICE` which says LICENSE governs.
2. **"you have too much commentary. get rid of the noise"** — front door cut from
   ~900 words to **306**. Deleted: three-paragraph claim boxes, the four-part "why it
   behaves differently" essay, the six-card grid. Kept: one sentence per app, the three
   numbers, an honest missing-list. README likewise rewritten and de-staled
   (58→76 functions, 617→679 assertions, capabilities now enforced not advisory).

`npm test` now runs on a fresh clone (agreement.mjs needs the corpus, which is fetched
via `corpus/build_corpus.py`, never redistributed).


## Front door, round 2 — 2026-08-04 (Zach's 4 marked-up edits)

Zach sent `edits-miscellany.io.md`: 4 notes bound to 15 elements. Applied in full,
built, verified, deployed, purged, re-verified live.

**What he cut** (notes 1 + 3): the standfirst, the "free and open source, MPL-2.0…"
note, the whole 4-button hero CTA row, the "One document" heading + paragraph, the
entire "What is missing" section, two of the three stat figures (100.00%, 0), and
four of six footer links (Sheet · Deck · Both · Open Signal).

**What he asked for** (notes 2 + 4):
- the surviving stat becomes *"a running tally of total software tools available"*
- Open + **Download source** buttons under each of Sheet and Deck — *"I do not want
  a user to have to go to github for the source"*

### The one judgement call: Compose is off the front door, and the tally is 2

Three independent deletions — the Compose button, the "One document" prose, the
footer "Both" link — all point the same way. So no soft re-link. `/app/compose.html`
still ships and still works; it is a second view of one document, not a third tool.

**The load-bearing constraint is that the number and the list cannot disagree.** Both
now come from one array, `TOOLS` in `tools/build-site.mjs`, which also drives zip
generation. `site/index.html` stays the literal, readable source (no injection — this
project's whole claim is "no bundler, no transform"); instead the build *verifies* it:
`<b data-tally="tools">N</b>` must equal `TOOLS.length`, every tool must have a
download link, and every `./…` href must resolve in `dist/`. Drift exits 1.
**Both guards were tested by making them fire.**

### Source downloads, without a bundler and without GitHub

`dist/source/miscellany-{sheet,deck}-source.zip`, generated at build time.

- `tools/make-zip.mjs` — ~60 lines. Node's own `deflateRawSync` + the app's own
  `crc32.js`, so there is one crc32 in the project. **Timestamps pinned** (2026-08-04
  12:00): a source archive whose hash moves because the tree was checked out on a
  different day is not verifiable. Falls back to STORED when deflate grows an entry.
- Contents are a **walked dependency closure**, not a hand list: `<link>`/`<script>`
  out of the entry HTML, then transitive JS imports (literal dynamic ones included,
  `node:` skipped). Sheet = 34 files, Deck = 22, each + README.txt + LICENSE + NOTICE
  under one top-level folder so unzipping does not spray into Downloads.
- `_headers` serves `/source/*` as `application/zip` + `Content-Disposition: attachment`.
- README.txt is **pure ASCII on purpose** — it is the file a stranger opens in whatever
  editor Windows hands them, and an em dash arriving as `â€"` makes a download look
  broken before they run anything. It leads with the file:// limitation, because
  double-clicking `index.html` yields a blank page (browsers refuse ES modules over
  file://) and that reads as "the download is broken".

### Why the hand-listed closure would have shipped broken

**`src/index.html` loads `apps/deck/deck.css` as well as its own** — Sheet can hold a
slide. Any curated file list drops it.

And the test that catches it is not obvious. With `sheet.css` missing the page still
renders every string a text assertion would look for — "Open .xlsx", "Save document",
the whole toolbar. **A text-only check passes on a visibly broken app.** The grid is a
`<canvas>`, so no DOM assertion can ever see a cell either.

What actually works: **FNV-1a over the whole canvas bitmap, zip-served vs dist-served.**
Sheet `1280x770 #40964088`, Deck `1280x764 #d528b170` — identical both sides. Removing
one CSS file collapses the canvas to its 300x150 default and the signature diverges;
removing one core module leaves no canvas at all. Both proven by deletion.
`scratchpad/verify.py`, `verify_live.py`.

### Live verification (curl was not trusted — it 200'd three broken apps here once)

Real browser: front door tally `2`, h2s `[Sheet, Deck]`, zero deleted strings still
present, no real console errors. Zips **downloaded by clicking the button**: CRC-valid,
byte-identical to the build. `/app/`, `/app/deck`, `/app/compose` all still paint.
The only console errors are the edge beacon our own CSP blocks.

Footer "Source" → **"GitHub"**: with two "Download source" buttons that deliberately
avoid GitHub, a link labelled "Source" pointing there was the exact confusion the
edit was meant to remove.

`npm test` after the change: **153 passed, 0 failed, 49/49 byte-identical**.


## Round 3 — 2026-08-04 — a leaner download, and source anyone's AI can audit

Zach: *"can the source code download be more simplified... so non technical users
aren't lost in the sauce"* and *"I want users to be able to have their own AI tools
review the source code so they don't worry that they are downloading a potentially
harmful file."*

### Leaner zip

Root went from 5 files to 4, and **every one now has an extension**. `LICENSE` and
`NOTICE` were extensionless, which on Windows means double-clicking gets you the
*"How do you want to open this file?"* dialog — precisely the moment a non-technical
person decides this was a mistake. NOTICE folded into README, LICENSE → `LICENSE.txt`
(full MPL text kept: a summary-instead-of-text already burned this project once).
README cut roughly in half and reordered to lead with running it.

Paths split so each artefact can carry its own headers:
`/download/miscellany-<tool>-source.zip` (`application/zip`, `attachment`) and
`/source/<tool>.txt` (`text/plain`, **`inline`** — it must render, or the whole
"read it without downloading anything" offer silently becomes a download).

### The whole source as one readable page

`/source/sheet.txt` (34 files, 353 KB) and `/source/deck.txt` (22 files, 194 KB).
Every file printed in full, `FILE n of N` headers, generated from the **same closure**
as the zip in the same pass. The page invites you to read one and then download the
other, so the build asserts they are the same source **byte for byte**, not merely the
same file list.

### Two bugs the guards caught, one of them mine

1. **`fs.writeFileSync(..., 'ascii')` corrupted the source.** Node's `ascii` encoding
   masks the high bit, so `/* Sheet — the entry point` shipped as `/* Sheet  the entry
   point`. The readable copy had quietly stopped being the code it claimed to be — the
   exact failure the feature exists to prevent. Fixed to `utf8`, and the byte-identity
   check now **reads the file back off disk** before comparing, because checking the
   in-memory string would have sailed straight through it. Re-tested by putting
   `'ascii'` back: 34 findings, exit 1.
2. **The no-networking claim is enforced, not asserted.** The build scans the exact
   closure bytes for `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
   `sendBeacon`, `eval(`, `new Function(`, `importScripts(` and refuses to publish on a
   hit. Proven by planting a `fetch(` and an `eval(` — both caught — and by planting
   `evaluate()`, which correctly does **not** trip it.

### ⚠️ The finding that changed the design: AI URL-fetch truncates silently

Handing `https://miscellany.io/source/deck.txt` (the **smaller** file, 194 KB) to an
AI's URL fetcher returned **13 of 22 files**. Not an error — a clean, confident partial
read. A security review of the first half of a codebase reads exactly like a review of
all of it.

Two consequences, both shipped:
- **"Save the page and attach the file" is now the headline instruction**, on the page
  and in the file. Attaching has no fetch limit; pasting a link does.
- **The file ends with `END OF SOURCE - N of N files`**, and the header tells the
  reader to ask their AI to quote it. The tested AI *did* report it could not see that
  line and said so unprompted — the marker turns a silent truncation into a detectable
  one. → [[reference-ai-url-fetch-truncation]]

### Also

- CF purge takes a few seconds to propagate: the verification screenshot taken
  immediately after `purge_everything` showed the **previous** copy while `curl` a
  moment later showed the new one. The deploy was fine; the instrument was early.
  Re-shoot before believing a stale-looking screenshot. → [[reference-cloudflare-stale-assets]]
- Zip pixel-signatures unchanged after slimming: Sheet `#40964088`, Deck `#d528b170`.


## Round 4 — 2026-08-04 — one file, and the edge was tampering with it

Zach, on the round-3 download: *"the download file still has so many files and
folders. are they really all necessary? can they be collapsed into eachother if
so? Also, how does a potential user know that what they are downloading is the
same as what the .txt is advertising? Do you understand the problem i am trying to
solve? Lastly, why create a new content section with all this verbage."*

He was right on all three, and the middle one reframes the feature. **Two artefacts
(a .txt to review, a .zip to run) makes the user reconcile them, and a SHA-256 is
not a reconciliation a non-technical person can perform.** The answer is not a
better hash. It is one file.

### `/download/miscellany-<tool>.html` — the whole app AND its whole source

34 files → 1 (Sheet, 353 KB); 22 → 1 (Deck, 194 KB). `tools/make-single.mjs`.
The .zip and the .txt are both gone, and so is `make-zip.mjs`.

- **Double-click runs it.** No server. An inline `<script>` has nothing to fetch,
  which is what ES modules over `file://` could never do — the entire reason
  round 3 needed a README teaching `python -m http.server`.
- **The same file is the source.** Readable, unminified, one module after another.
  Nothing to compare against anything: what you review is what runs.
- **No eval, no Function(), no blob loader.** A self-assembling file would look
  like obfuscation to the reviewing AI it exists to satisfy. The only edit from
  the repo is `import` → a local reference and `export` dropped from its
  declaration; the header comment says exactly that.
- **Each module keeps its own scope** — mandatory, not tidy: 11 top-level names
  collide across the 30 modules (`parse`, `MIME`, `SIG_LOC`, `textOf`, `C`, …).
  0 circular imports, so a topological order exists.

Page: the three-paragraph block is deleted. Each tool is now `[Open] [Download
source] (?)`, the `?` a `<details>` — 61 words, zero script, which the CSP
requires anyway.

### ⚠️⚠️ CLOUDFLARE WAS INJECTING A BEACON INTO THE DOWNLOADED FILE

The end-to-end test — click, save, open off the disk — caught this and nothing
else could have:

```
identical to the build: False        (+851 bytes)
network requests made: ['file:///C:/cdn-cgi/rum?']
```

The edge spliced `<script src="static.cloudflareinsights.com/beacon.min.js">`
into the download. **On the site that beacon is refused by our CSP. In a file in
somebody's Downloads folder there is no CSP** — so the artefact the front door
calls "the complete source, with no networking code in it" phoned home on open.
The claim would have been false in the one copy that matters.

**Fix, and it is structural rather than a setting:** an edge HTML rewriter does
not touch a response that is not HTML. `/download/*` now serves
`application/octet-stream`. Still HTML on disk, still double-clicks.
(The RUM dashboard toggle is still unreachable — `/rum/site_info` →
`Unable to authenticate request` on this token, unchanged since 08.02.)

**The rule had to be written for BOTH paths.** Pages 308-redirects `.html` to the
extensionless form, so a rule against `/download/x.html` alone lands on the
*redirect* and the file itself is served however the edge likes — which is how
the beacon got in on the first attempt at the fix. → [[reference-cloudflare-stale-assets]]

Two injections total, both CSP-blocked on the site: the analytics beacon **and**
a challenge-platform inline script (`__CF$cv$params`).

### Guards, all proven by making them fire

- every imported name must be exported by its target module — caught a regex bug:
  `[\s\S]*?` is non-greedy but still crosses newlines, so on `sheet.js` one match
  swallowed an export list *and* the re-export on the next line. `[^}]*` instead.
- **`shell.js` does `await import('./functions.js')` — a fetch.** In one file there
  is nothing to fetch; the command palette's "Function list" would have thrown for
  every user. Rewritten to `M["core/functions.js"]`, and driven through the real
  palette in the test (Ctrl+K → "function list" → alert: *76 functions*).
- forbidden-primitive scan runs on the **generated bundle**, not just its inputs —
  and on the CODE, since the header comment must name `fetch` and `eval` to
  promise they are absent.
- `localStorage` on `file://` verified separately from the pixel test **because the
  pixel test is blind to it**: dead storage → `shell.load()` false → the first-run
  document → the exact bytes a fresh served context also draws. Identical
  signatures on a half-broken app. Write, reload, confirm.

Pixel signatures from `file://` match the served app exactly: Sheet `#40964088`,
Deck `#d528b170`. `npm test` green.
