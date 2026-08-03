"""Build and LOCK the Stage 1 round-trip corpus.

The corpus must be fixed and published BEFORE the OOXML reader is written.
Otherwise the person being graded picks the exam at grading time, and the
"binary gate" is a vibe with a number on it.

This script downloads candidates from public government/institutional sources,
validates each is a real OOXML workbook, and CHARACTERISES it — how many
sheets, whether it has formulas, styles, merged cells, charts, pivot tables,
macros. Characterisation matters: a corpus of 25 trivial files would pass a
round-trip gate while proving nothing.

Output: files/ + corpus.json + ../CORPUS.md
Re-running with the lock in place verifies hashes instead of re-downloading.
"""

import hashlib, json, pathlib, re, sys, zipfile, io, urllib.request, urllib.error

HERE = pathlib.Path(__file__).parent
FILES = HERE / "files"
FILES.mkdir(exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Candidates. Deliberately spread across issuers so the corpus is not
# 25 files from one generator with one set of quirks.
CANDIDATES = [
    # World Bank
    ("wb-gdp", "https://databank.worldbank.org/data/download/GDP.xlsx", "World Bank — GDP by country"),
    ("wb-gdp-ppp", "https://databank.worldbank.org/data/download/GDP_PPP.xlsx", "World Bank — GDP PPP"),
    ("wb-pop", "https://databank.worldbank.org/data/download/POP.xlsx", "World Bank — population"),
    # EIA — Electric Power Monthly
    ("eia-elec-1-01", "https://www.eia.gov/electricity/monthly/xls/table_1_01.xlsx", "EIA — net generation"),
    ("eia-elec-1-02", "https://www.eia.gov/electricity/monthly/xls/table_1_02.xlsx", "EIA — generation by state"),
    ("eia-elec-2-01", "https://www.eia.gov/electricity/monthly/xls/table_2_01.xlsx", "EIA — consumption"),
    ("eia-elec-4-01", "https://www.eia.gov/electricity/monthly/xls/table_4_01.xlsx", "EIA — receipts/cost"),
    ("eia-elec-5-01", "https://www.eia.gov/electricity/monthly/xls/table_5_01.xlsx", "EIA — retail price"),
    ("eia-elec-6-01", "https://www.eia.gov/electricity/monthly/xls/table_6_01.xlsx", "EIA — capacity"),
    ("eia-elec-7-01", "https://www.eia.gov/electricity/monthly/xls/table_7_01.xlsx", "EIA — fossil fuel stocks"),
    ("eia-steo", "https://www.eia.gov/outlooks/steo/xls/all_tabs.xlsx", "EIA — Short-Term Energy Outlook, all tabs"),
    # BEA
    ("bea-gdp", "https://www.bea.gov/sites/default/files/2025-03/gdp4q24-3rd.xlsx", "BEA — GDP 4Q24 third estimate"),
    ("bea-pi", "https://www.bea.gov/sites/default/files/2025-03/pi0125.xlsx", "BEA — personal income"),
    # FHFA
    ("fhfa-metro", "https://www.fhfa.gov/hpi/download/quarterly_datasets/hpi_at_metro.xlsx", "FHFA — house price index by metro"),
    ("fhfa-state", "https://www.fhfa.gov/hpi/download/quarterly_datasets/hpi_at_state.xlsx", "FHFA — HPI by state"),
    ("fhfa-po-monthly", "https://www.fhfa.gov/hpi/download/monthly/hpi_po_monthly_hist.xlsx", "FHFA — purchase-only monthly"),
    # Federal Reserve
    ("frb-h15", "https://www.federalreserve.gov/datadownload/Output.aspx?rel=H15&series=bf17364827e38702b42a58cf8eaa3f78&lastobs=&from=&to=&filetype=spreadsheetml&label=include&layout=seriescolumn", "Federal Reserve — H.15 selected interest rates"),
    # NCUA / FDIC / financial regulators
    ("ncua-cu", "https://ncua.gov/files/publications/analysis/quarterly-data-summary-2024-Q4.xlsx", "NCUA — quarterly credit union data"),
    # Census
    ("census-hv", "https://www2.census.gov/programs-surveys/hhp/tables/2024/wk63/educ1_week63.xlsx", "Census — Household Pulse education"),
    ("census-const", "https://www.census.gov/construction/nrc/xls/newresconst.xlsx", "Census — new residential construction"),
    ("census-retail", "https://www.census.gov/retail/marts/www/timeseries.xlsx", "Census — advance retail sales"),
    # BTS / DOT
    ("bts-tsi", "https://www.bts.gov/sites/bts.dot.gov/files/legacy/table_01_11.xlsx", "BTS — transportation statistics"),
    # NOAA / NASA / science
    ("nasa-gistemp", "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.xlsx", "NASA GISS — global temperature index"),
    # EPA
    ("epa-ghg", "https://www.epa.gov/system/files/other-files/2024-04/us-ghg-inventory-2024-annex-tables.xlsx", "EPA — GHG inventory annex"),
    # Eurostat / OECD / international
    ("ecb-fx", "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip", "ECB — euro reference rates (zip)"),
    # USDA
    ("usda-wasde", "https://www.usda.gov/oce/commodity/wasde/wasde-report.xlsx", "USDA — WASDE"),
    # Treasury / fiscal
    ("treas-mts", "https://fiscaldata.treasury.gov/static-data/downloads/mts.zip", "Treasury — monthly statement (zip)"),
    # Energy labs
    ("nrel-atb", "https://data.openei.org/files/6006/2024%20v2%20Annual%20Technology%20Baseline%20Workbook%20Errata%207-19-2024.xlsx", "NREL — Annual Technology Baseline"),
    # HUD
    ("hud-fmr", "https://www.huduser.gov/portal/datasets/fmr/fmr2025/FY25_FMRs.xlsx", "HUD — Fair Market Rents"),
    # BLS via alternate host (www.bls.gov 403s from residential IPs)
    ("bls-cpi-sup", "https://download.bls.gov/pub/time.series/cu/cu.data.0.Current", "BLS — CPI (text, probe only)"),
    # CDC
    ("cdc-natality", "https://www.cdc.gov/nchs/data/nvsr/nvsr74/nvsr74-01-tables.xlsx", "CDC NCHS — natality tables"),
    # GSA / data.gov
    ("gsa-perdiem", "https://www.gsa.gov/system/files/FY2025-Per-Diem-Rates.xlsx", "GSA — per diem rates"),
    # DOE
    ("doe-vehicles", "https://afdc.energy.gov/files/u/data/data_source/10962/10962_ev_registration_counts_by_state_1-23-25.xlsx", "AFDC — EV registrations by state"),
    # IRS SOI
    ("irs-soi-zip", "https://www.irs.gov/pub/irs-soi/22zpallagi.csv", "IRS SOI — zip code data (csv, probe only)"),
    # --- second round: formula-heavy / multi-sheet real-world ---
    ("eia-aeo-1", "https://www.eia.gov/outlooks/aeo/excel/aeotab_1.xlsx", "EIA — Annual Energy Outlook table 1"),
    ("eia-aeo-2", "https://www.eia.gov/outlooks/aeo/excel/aeotab_2.xlsx", "EIA — AEO table 2"),
    ("eia-aeo-3", "https://www.eia.gov/outlooks/aeo/excel/aeotab_3.xlsx", "EIA — AEO table 3"),
    ("eia-aeo-8", "https://www.eia.gov/outlooks/aeo/excel/aeotab_8.xlsx", "EIA — AEO table 8"),
    ("eia-aeo-20", "https://www.eia.gov/outlooks/aeo/excel/aeotab_20.xlsx", "EIA — AEO table 20"),
    ("census-c30", "https://www.census.gov/construction/c30/xlsx/release.xlsx", "Census — construction spending"),
    ("bea-trade", "https://www.bea.gov/sites/default/files/2025-06/trad0425.xlsx", "BEA — international trade in goods & services"),
    ("frb-lbr", "https://www.federalreserve.gov/releases/lbr/current/lrg_bnk_lst.xlsx", "Federal Reserve — large commercial banks"),
    ("census-susb", "https://www2.census.gov/programs-surveys/susb/tables/2021/us_state_naics_detailedsizes_2021.xlsx", "Census SUSB — establishments by NAICS and size (4MB)"),
]

# Tier B — adversarial. Deliberately hard cases from OSS test suites, chosen
# because they are GENERATOR-DIVERSE (Excel, Google Sheets, LibreOffice all
# emit different OOXML) and because each isolates one feature that breaks
# naive readers. Tier A proves "normal work survives"; Tier B proves "the
# weird survives". Blending them into one number would hide both.
CX = "https://raw.githubusercontent.com/ClosedXML/ClosedXML/develop/ClosedXML.Tests/Resource/Examples/"
EJ = "https://raw.githubusercontent.com/exceljs/exceljs/master/spec/integration/data/"

ADVERSARIAL = [
    ("adv-1904-date", EJ + "1904.xlsx", "The 1904 date system — a whole different epoch"),
    ("adv-google-sheets", EJ + "hidden-test/google-sheets.xlsx", "Emitted by Google Sheets, not Excel"),
    ("adv-libre-2007", EJ + "hidden-test/libre-calc-as-excel-2007-365.xlsx", "Emitted by LibreOffice as Excel 2007"),
    ("adv-libre-ooxml", EJ + "hidden-test/libre-calc-as-office-open-xml-spreadsheet.xlsx", "LibreOffice as strict OOXML"),
    ("adv-formulas", EJ + "formulas.xlsx", "Formula variety"),
    ("adv-bogus-name", EJ + "bogus-defined-name.xlsx", "Malformed defined name — must not crash"),
    ("adv-date-issue", EJ + "dateIssue.xlsx", "Date serial edge cases"),
    ("adv-chart-sheet", EJ + "chart-sheet.xlsx", "A chart occupying its own sheet"),
    ("adv-images", EJ + "images.xlsx", "Embedded images (must survive untouched)"),
    ("adv-real-lineup", EJ + "1519293514-KRISHNAPATNAM_LINE_UP.xlsx", "Real shipping lineup workbook from the wild"),
    ("adv-merge-cells", CX + "Misc/MergeCells.xlsx", "Merged cells"),
    ("adv-formulas-eval", CX + "Misc/FormulasWithEvaluation.xlsx", "Formulas with cached results"),
    ("adv-data-validation", CX + "Misc/DataValidation.xlsx", "Data validation rules"),
    ("adv-hyperlinks", CX + "Misc/Hyperlinks.xlsx", "Hyperlinks"),
    ("adv-comments", CX + "Comments/AddingComments.xlsx", "Cell comments"),
    ("adv-cf-databar", CX + "ConditionalFormatting/CFDataBars.xlsx", "Conditional formatting — data bars"),
    ("adv-cf-iconset", CX + "ConditionalFormatting/CFIconSet.xlsx", "Conditional formatting — icon sets"),
    ("adv-cf-multi", CX + "ConditionalFormatting/CFMultipleConditions.xlsx", "Stacked conditional formats"),
    ("adv-basic-table", CX + "Misc/BasicTable.xlsx", "A real Excel Table object"),
    ("adv-loading-table", CX + "Loading/ChangingBasicTable.xlsx", "Table after edit"),
    # Pivot tables: the headline preserve-unknown case. We will not support
    # pivots for a long time, so they MUST survive a round trip untouched.
    ("adv-pivot", CX + "PivotTables/PivotTables.xlsx", "Pivot tables"),
    ("adv-pivot-cf", "https://raw.githubusercontent.com/ClosedXML/ClosedXML/develop/ClosedXML.Tests/Resource/Other/PivotTable/Save/Pivot_table_conditional_format.xlsx", "Pivot + conditional format"),
    ("adv-pivot-ext", "https://raw.githubusercontent.com/ClosedXML/ClosedXML/develop/ClosedXML.Tests/Resource/Other/PivotTable/Sources/PivotTable-AllSources-external-data.xlsx", "Pivot with an external data source"),
    ("adv-pivot-2col", "https://raw.githubusercontent.com/ClosedXML/ClosedXML/develop/ClosedXML.Tests/Resource/Other/PivotTable/Create/Add_one_column_and_two_values.xlsx", "Pivot, one column two values"),
]

NS_SKIP = {"[Content_Types].xml"}


def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def characterise(data):
    """Open as OOXML and report what features it actually exercises."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return None
    names = zf.namelist()
    if not any(n.endswith("workbook.xml") for n in names):
        return None

    feat = {
        "parts": len(names),
        "sheets": sum(1 for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n)),
        "sharedStrings": any("sharedStrings.xml" in n for n in names),
        "styles": any(n.endswith("xl/styles.xml") for n in names),
        "charts": any("/charts/" in n for n in names),
        "drawings": any("/drawings/" in n for n in names),
        "pivot": any("pivot" in n.lower() for n in names),
        "macros": any("vbaProject" in n for n in names),
        "tables": any("/tables/" in n for n in names),
        "externalLinks": any("externalLink" in n for n in names),
        "comments": any("comments" in n.lower() for n in names),
        "themes": any("theme" in n.lower() for n in names),
    }

    # Scan sheet XML for the things that actually break naive readers.
    #
    # TRAP, found here and worth every minute it cost: OOXML permits ANY
    # namespace prefix. Excel emits bare <c>, but ClosedXML and LibreOffice
    # emit <x:c> under <x:worksheet>. A reader that string-matches "<c " sees
    # ZERO cells in those files and reports success. My first characteriser
    # did exactly that and called four adversarial files empty.
    # Every tag match in the reader must allow an optional prefix.
    def count(x, tag):
        return len(re.findall(r"<(?:[A-Za-z_][\w.-]*:)?" + tag + r"[\s/>]", x))

    # EXACT counts the reader must reproduce. "cells" counts every <c>
    # element including ones that carry only a style; a reader legitimately
    # skips those. cellsWithValue and cellsWithFormula are the numbers a
    # correct reader must match EXACTLY — asserting only "reader != 0" let a
    # bug through that silently dropped 116,491 of 233,410 formulas.
    CELL_RE = re.compile(r"<(?:[\w.-]+:)?c(\s[^>]*?)?(/>|>(.*?)</(?:[\w.-]+:)?c>)", re.S)
    HAS_V = re.compile(r"<(?:[\w.-]+:)?(?:v|is)[\s>]")
    HAS_F = re.compile(r"<(?:[\w.-]+:)?f[\s>/]")

    formulas = merged = inline = dates = arrayf = cells = 0
    with_value = with_formula = shared_refs = 0
    for n in names:
        if not re.match(r"xl/worksheets/sheet\d+\.xml$", n):
            continue
        try:
            x = zf.read(n).decode("utf-8", "replace")
        except Exception:
            continue
        for m in CELL_RE.finditer(x):
            body = m.group(3) or ""
            hv = bool(HAS_V.search(body))
            hf = bool(HAS_F.search(body))
            if hv or hf:
                with_value += 1      # non-empty: the reader keeps value OR formula
            if hf:
                with_formula += 1
        for m in re.finditer(r"<(?:[\w.-]+:)?f(\s[^>]*?)?(/>|>(.*?)</(?:[\w.-]+:)?f>)", x, re.S):
            if 't="shared"' in (m.group(1) or "") and not m.group(3):
                shared_refs += 1
        cells += count(x, "c")
        formulas += count(x, "f")
        merged += count(x, "mergeCell")
        inline += x.count('t="inlineStr"')
        dates += x.count('t="d"')
        arrayf += x.count('t="array"')
    feat.update(cells=cells, formulas=formulas, mergedCells=merged,
                inlineStrings=inline, isoDates=dates, arrayFormulas=arrayf,
                cellsWithValue=with_value, cellsWithFormula=with_formula,
                sharedFormulaRefs=shared_refs)
    feat["prefixedXml"] = any(
        re.search(r"<[A-Za-z_][\w.-]*:worksheet", zf.read(n).decode("utf-8", "replace")[:400])
        for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n)
    )

    # Number formats declared in styles — the biggest source of visual drift.
    try:
        st = zf.read("xl/styles.xml").decode("utf-8", "replace")
        feat["numFmts"] = st.count("<numFmt ")
        feat["cellXfs"] = int(re.search(r'<cellXfs count="(\d+)"', st).group(1)) if re.search(r'<cellXfs count="(\d+)"', st) else 0
    except Exception:
        feat["numFmts"] = 0
        feat["cellXfs"] = 0
    return feat


def main():
    lock = HERE / "corpus.json"

    # Re-run characterisation from files already on disk. Used when the
    # characteriser itself was wrong (it was) — re-downloading would change
    # hashes if a source updated, which would silently break the lock.
    if "--recharacterise" in sys.argv and lock.exists():
        doc = json.loads(lock.read_text())
        for e in doc["files"]:
            data = (FILES / e["file"]).read_bytes()
            assert hashlib.sha256(data).hexdigest() == e["sha256"], e["file"]
            e["features"] = characterise(data)
        FEATURES = ["formulas", "mergedCells", "charts", "pivot", "macros", "tables",
                    "sharedStrings", "styles", "comments", "drawings", "externalLinks",
                    "inlineStrings", "arrayFormulas", "prefixedXml"]
        doc["coverage"] = {f: sum(1 for k in doc["files"] if k["features"].get(f)) for f in FEATURES}
        lock.write_text(json.dumps(doc, indent=2))
        print("re-characterised", len(doc["files"]), "files (hashes verified unchanged)")
        print("coverage:", {k: v for k, v in doc["coverage"].items() if v})
        return 0

    # Fetch only slugs not already locked. Never re-downloads an existing
    # entry, so locked hashes cannot drift when a source updates upstream.
    if "--add-missing" in sys.argv and lock.exists():
        doc = json.loads(lock.read_text())
        have = {e["slug"] for e in doc["files"]}
        added = 0
        for tier, items in (("A", CANDIDATES), ("B", ADVERSARIAL)):
            for slug, url, desc in items:
                if slug in have:
                    continue
                try:
                    data = fetch(url)
                except Exception as ex:
                    print(f"  -- {slug}: {type(ex).__name__} {getattr(ex,'code','')}")
                    continue
                feat = characterise(data)
                if feat is None:
                    print(f"  -- {slug}: not an OOXML workbook")
                    continue
                (FILES / f"{slug}.xlsx").write_bytes(data)
                doc["files"].append({
                    "slug": slug, "tier": tier, "file": f"{slug}.xlsx", "url": url,
                    "description": desc, "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(), "features": feat,
                })
                added += 1
                print(f"  OK [{tier}] {slug}: {feat['sheets']}sh {feat['cells']}c "
                      f"{feat['formulas']}f" + (", PIVOT" if feat["pivot"] else "")
                      + (", MACROS" if feat["macros"] else ""))
        FEATURES = ["formulas", "mergedCells", "charts", "pivot", "macros", "tables",
                    "sharedStrings", "styles", "comments", "drawings", "externalLinks",
                    "inlineStrings", "arrayFormulas", "prefixedXml"]
        doc["coverage"] = {f: sum(1 for k in doc["files"] if k["features"].get(f)) for f in FEATURES}
        doc["counts"] = {
            "tierA": sum(1 for e in doc["files"] if e["tier"] == "A"),
            "tierB": sum(1 for e in doc["files"] if e["tier"] == "B"),
            "total": len(doc["files"]),
        }
        lock.write_text(json.dumps(doc, indent=2))
        print(f"\nadded {added} | {doc['counts']}")
        print("coverage:", {k: v for k, v in doc["coverage"].items() if v})
        return 0

    if lock.exists() and "--rebuild" not in sys.argv:
        print("corpus.json exists — verifying hashes instead of re-downloading.")
        entries = json.loads(lock.read_text())["files"]
        bad = 0
        for e in entries:
            p = FILES / e["file"]
            if not p.exists():
                print(f"  MISSING {e['file']}"); bad += 1; continue
            h = hashlib.sha256(p.read_bytes()).hexdigest()
            if h != e["sha256"]:
                print(f"  HASH CHANGED {e['file']}"); bad += 1
        print(f"{len(entries)} entries, {bad} problems")
        return 1 if bad else 0

    kept, skipped = [], []

    def harvest(items, tier):
        for slug, url, desc in items:
            try:
                data = fetch(url)
            except Exception as ex:
                skipped.append((slug, url, f"{type(ex).__name__} {getattr(ex,'code','')}"))
                print(f"  -- {slug}: {type(ex).__name__} {getattr(ex,'code','')}")
                continue
            feat = characterise(data)
            if feat is None:
                skipped.append((slug, url, "not an OOXML workbook"))
                print(f"  -- {slug}: not an OOXML workbook ({len(data)} bytes)")
                continue
            name = f"{slug}.xlsx"
            (FILES / name).write_bytes(data)
            kept.append({
                "slug": slug, "tier": tier, "file": name, "url": url,
                "description": desc, "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "features": feat,
            })
            flags = "".join([
                ", CHARTS" if feat["charts"] else "",
                ", PIVOT" if feat["pivot"] else "",
                ", MACROS" if feat["macros"] else "",
                ", TABLES" if feat["tables"] else "",
                ", MERGED" if feat["mergedCells"] else "",
            ])
            print(f"  OK [{tier}] {slug}: {feat['sheets']}sh {feat['cells']}c "
                  f"{feat['formulas']}f {feat['numFmts']}nf{flags}")

    print("--- Tier A: representative (real files people open) ---")
    harvest(CANDIDATES, "A")
    print("--- Tier B: adversarial (deliberately hard, generator-diverse) ---")
    harvest(ADVERSARIAL, "B")

    a = [k for k in kept if k["tier"] == "A"]
    b = [k for k in kept if k["tier"] == "B"]

    # Coverage: which features does the corpus actually exercise? A corpus
    # that passes a round-trip gate while touching none of these proves nothing.
    FEATURES = ["formulas", "mergedCells", "charts", "pivot", "macros", "tables",
                "sharedStrings", "styles", "comments", "drawings", "externalLinks",
                "inlineStrings", "arrayFormulas"]
    coverage = {}
    for f in FEATURES:
        coverage[f] = sum(1 for k in kept if k["features"].get(f))

    out = {
        "locked": "2026-08-02",
        "note": "Fixed BEFORE the OOXML reader was written. Do not add, remove, or "
                "replace entries to make a gate pass. Additions go to corpus-v2 "
                "with its own lock date.",
        "gate": {
            "A": "every file: open, save, reopen in Excel -> zero value or visual "
                 "difference in any feature we claim to support",
            "B": "same, plus every byte we do NOT model survives identically "
                 "(preserve-unknown)",
        },
        "counts": {"tierA": len(a), "tierB": len(b), "total": len(kept)},
        "issuers": sorted({k["url"].split("/")[2] for k in a}),
        "coverage": coverage,
        "files": kept,
        "rejected": [{"slug": s, "url": u, "reason": r} for s, u, r in skipped],
    }
    lock.write_text(json.dumps(out, indent=2))
    print(f"\nTier A {len(a)} | Tier B {len(b)} | total {len(kept)} | rejected {len(skipped)}")
    print("issuers (A):", len(out["issuers"]))
    print("coverage:", {k: v for k, v in coverage.items() if v})
    return 0


if __name__ == "__main__":
    sys.exit(main())
