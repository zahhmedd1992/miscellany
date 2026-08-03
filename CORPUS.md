# CORPUS — the Stage 1 round-trip exam

**Locked 2026-08-02. 49 files — Tier A 25 representative, Tier B 24 adversarial.**

> Fixed and published **before** a single line of the OOXML reader was written.
> Otherwise the person being graded picks the exam at grading time, and a binary
> gate quietly becomes a vibe with a number on it.

Do not add, remove, or replace an entry to make a gate pass. Additions go to a
`corpus-v2` with its own lock date and its own published result.

```
python corpus/build_corpus.py     # re-hashes every file against the lock
node test/corpus.read.test.mjs    # runs the reader across all of it
```

## The gate

| Tier | What it proves | Pass condition |
|---|---|---|
| **A** — representative | normal work survives | open → save → reopen in Excel: **zero** value or visual difference in every feature we claim to support |
| **B** — adversarial | the weird survives | same, **plus every byte we do not model comes back identical** (preserve-unknown) |

Half B is what makes half A honest. Without it, "zero diff on supported features"
is satisfied by supporting almost nothing.

### The gate must be exact, not approximate

`corpus.json` records `cellsWithValue` and `cellsWithFormula` per file, counted by a
**separate implementation** (Python, different XML strategy). The reader test asserts
**exact equality** against those numbers. Two independent implementations agreeing is
evidence; one implementation asserting is a press release.

This is not theoretical. The first version of that test asserted only *"reader saw more
than zero cells"* — and passed a reader that silently dropped **116,491 of 233,410**
formulas in `nrel-atb`. A gate loose enough to pass a broken build is not a gate.

## What the corpus actually exercises

| Feature | Files |
|---|---|
| Formulas | 7 |
| Merged cells | 28 |
| Charts | 2 |
| **Pivot tables** — we will not support these for years, so they must survive untouched | 3 |
| Excel Table objects | 1 |
| Shared string table | 46 |
| Style tables | 49 |
| Cell comments | 2 |
| Drawings / images | 6 |
| External workbook links | 4 |
| Array formulas | 1 |
| **Namespace-prefixed XML** (`<x:c>` not `<c>`) | 12 |
| **Shared-formula references** (written once, referenced N times) | 116,491 across the corpus |

## Two traps this step caught before the reader shipped

**1. Namespace prefixes — 12 of 49 files.** OOXML permits any prefix.
Excel writes `<worksheet><c>`; ClosedXML and LibreOffice write `<x:worksheet><x:c>`.
My first characteriser string-matched `"<c "` and reported four of these files as
**empty**. A reader with the same assumption opens a quarter of the corpus as a blank
sheet and reports success.

**2. Shared formulas — 116,491 references.** Excel writes a filled-down formula
*once*, on the anchor cell, as `<f t="shared" ref="J24:J28" si="0">…</f>`. Every other
cell in the range carries only `<f t="shared" si="0"/>` — **no formula text at all**.
Treating a text-less `<f>` as "no formula" drops them silently. The file still opens,
still looks right, and half the model is gone. Expanding them requires translating the
anchor's relative references by the cell offset, which is its own trap: `LOG10(A1)`
contains the substring `G10`, and `"A1"` inside quotes is text.

Both were found during corpus construction and reader testing — the cheapest possible
moments — because the corpus is characterised rather than merely counted.

## Tier A — representative (25)

Issuers, with counts — **the concentration is the corpus's main weakness and is stated rather than
left to be counted**: www.eia.gov (11) · databank.worldbank.org (3) · www.fhfa.gov (3) · www.bea.gov (2) · www.census.gov (2) · data.openei.org (1) · www.huduser.gov (1) · www.federalreserve.gov (1) · www2.census.gov (1).

11 of 25 come from EIA (6 electricity tables + 5 AEO tables), so one generator's quirks are
over-represented. Tier B exists partly to offset this: its files come from four different
producers. Any corpus-v2 should widen issuers before it adds volume.

| Slug | Source | Sheets | Values | Formulas | Bytes |
|---|---|---:|---:|---:|---:|
| `census-susb` | Census SUSB — establishments by NAICS and size (4MB) | 2 | 741,525 | 0 | 3,985,135 |
| `fhfa-metro` | FHFA — house price index by metro | 1 | 504,308 | 0 | 2,897,909 |
| `nrel-atb` | NREL — Annual Technology Baseline | 39 | 353,513 | 233,410 | 4,993,193 |
| `hud-fmr` | HUD — Fair Market Rents | 2 | 66,740 | 0 | 362,523 |
| `frb-lbr` | Federal Reserve — large commercial banks | 1 | 45,608 | 0 | 263,941 |
| `fhfa-state` | FHFA — HPI by state | 1 | 41,826 | 0 | 263,268 |
| `bea-trade` | BEA — international trade in goods & services | 32 | 23,700 | 0 | 1,242,113 |
| `bea-gdp` | BEA — GDP 4Q24 third estimate | 21 | 13,520 | 0 | 189,584 |
| `fhfa-po-monthly` | FHFA — purchase-only monthly | 1 | 8,947 | 0 | 70,809 |
| `eia-aeo-2` | EIA — AEO table 2 | 1 | 4,682 | 0 | 55,934 |
| `eia-aeo-3` | EIA — AEO table 3 | 1 | 3,408 | 0 | 45,285 |
| `census-const` | Census — new residential construction | 5 | 3,124 | 0 | 45,088 |
| `eia-aeo-8` | EIA — AEO table 8 | 1 | 2,221 | 0 | 34,621 |
| `eia-aeo-1` | EIA — Annual Energy Outlook table 1 | 1 | 1,609 | 0 | 28,460 |
| `census-c30` | Census — construction spending | 4 | 1,587 | 0 | 32,932 |
| `eia-aeo-20` | EIA — AEO table 20 | 1 | 1,386 | 0 | 26,009 |
| `wb-pop` | World Bank — population | 1 | 1,128 | 0 | 29,454 |
| `wb-gdp` | World Bank — GDP by country | 1 | 1,122 | 0 | 31,622 |
| `wb-gdp-ppp` | World Bank — GDP PPP | 1 | 1,104 | 0 | 31,808 |
| `eia-elec-6-01` | EIA — capacity | 1 | 750 | 0 | 18,754 |
| `eia-elec-1-01` | EIA — net generation | 1 | 733 | 0 | 19,882 |
| `eia-elec-4-01` | EIA — receipts/cost | 1 | 603 | 0 | 18,761 |
| `eia-elec-1-02` | EIA — generation by state | 1 | 585 | 0 | 16,042 |
| `eia-elec-7-01` | EIA — fossil fuel stocks | 1 | 315 | 0 | 15,737 |
| `eia-elec-5-01` | EIA — retail price | 1 | 279 | 0 | 15,971 |

## Tier B — adversarial (24)

Chosen for **generator diversity** — Excel, Google Sheets, LibreOffice and ClosedXML
all emit different OOXML — and because each isolates one thing that breaks naive readers.

| Slug | What it isolates | Sheets | Values | Prefixed |
|---|---|---:|---:|:-:|
| `adv-1904-date` | The 1904 date system — a whole different epoch | 3 | 1 |  |
| `adv-google-sheets` | Emitted by Google Sheets, not Excel | 1 | 5 |  |
| `adv-libre-2007` | Emitted by LibreOffice as Excel 2007 | 1 | 5 |  |
| `adv-libre-ooxml` | LibreOffice as strict OOXML | 1 | 5 |  |
| `adv-formulas` | Formula variety | 1 | 4 |  |
| `adv-bogus-name` | Malformed defined name — must not crash | 1 | 1 |  |
| `adv-date-issue` | Date serial edge cases | 1 | 2 |  |
| `adv-chart-sheet` | A chart occupying its own sheet | 1 | 28 |  |
| `adv-images` | Embedded images (must survive untouched) | 1 | 0 |  |
| `adv-real-lineup` | Real shipping lineup workbook from the wild | 2 | 164 |  |
| `adv-merge-cells` | Merged cells | 1 | 4 | yes |
| `adv-formulas-eval` | Formulas with cached results | 1 | 37 | yes |
| `adv-data-validation` | Data validation rules | 6 | 6 | yes |
| `adv-hyperlinks` | Hyperlinks | 2 | 14 | yes |
| `adv-comments` | Cell comments | 11 | 5 | yes |
| `adv-cf-databar` | Conditional formatting — data bars | 1 | 36 | yes |
| `adv-cf-iconset` | Conditional formatting — icon sets | 1 | 4 | yes |
| `adv-cf-multi` | Stacked conditional formats | 1 | 0 | yes |
| `adv-basic-table` | A real Excel Table object | 1 | 21 | yes |
| `adv-loading-table` | Table after edit | 1 | 21 | yes |
| `adv-pivot` | Pivot tables | 11 | 99 | yes |
| `adv-pivot-cf` | Pivot + conditional format | 1 | 20 |  |
| `adv-pivot-ext` | Pivot with an external data source | 1 | 6 |  |
| `adv-pivot-2col` | Pivot, one column two values | 2 | 4 | yes |

## Rejected candidates

Recorded so the sourcing is auditable — a corpus is only as honest as what it left out.

| Slug | Reason |
|---|---|
| `eia-elec-2-01` | not an OOXML workbook |
| `eia-steo` | HTTPError 404 |
| `bea-pi` | HTTPError 404 |
| `frb-h15` | not an OOXML workbook |
| `ncua-cu` | HTTPError 404 |
| `census-hv` | HTTPError 404 |
| `census-retail` | HTTPError 404 |
| `bts-tsi` | HTTPError 403 |
| `nasa-gistemp` | HTTPError 404 |
| `epa-ghg` | HTTPError 404 |
| `ecb-fx` | not an OOXML workbook |
| `usda-wasde` | HTTPError 404 |
| `treas-mts` | HTTPError 503 |
| `bls-cpi-sup` | HTTPError 403 |
| `cdc-natality` | HTTPError 403 |
| `gsa-perdiem` | HTTPError 404 |
| `doe-vehicles` | HTTPError 404 |
| `irs-soi-zip` | not an OOXML workbook |

Most rejections are dead URLs or bot protection (`bls.gov`, `cbo.gov`, `imf.org`,
`cdc.gov`, `nrc.gov` all 403 residential IPs). **None were rejected for being inconvenient.**
