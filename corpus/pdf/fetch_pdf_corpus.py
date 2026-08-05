"""Fetch and lock the PDF corpus — BEFORE the reader is written, same
discipline as the xlsx corpus: the person being graded must not pick the
exam at grading time.

Selection axes: PDF version (1.2 → 1.7), xref style (classic tables, xref
streams, hybrid), object streams or not, generator diversity (Acrobat, Word,
LaTeX, InDesign, government printing pipelines), forms, scans, large files.
All U.S. government sources — stable URLs, public domain.
"""
import hashlib, json, pathlib, re, sys, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
FILES = HERE / "files"
FILES.mkdir(parents=True, exist_ok=True)

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"}

SOURCES = {
    # IRS — Acrobat-era form pipelines, AcroForm fields
    "irs-f1040.pdf": "https://www.irs.gov/pub/irs-pdf/f1040.pdf",
    "irs-fw9.pdf": "https://www.irs.gov/pub/irs-pdf/fw9.pdf",
    "irs-fw4.pdf": "https://www.irs.gov/pub/irs-pdf/fw4.pdf",
    "irs-p15.pdf": "https://www.irs.gov/pub/irs-pdf/p15.pdf",
    "irs-i1040gi.pdf": "https://www.irs.gov/pub/irs-pdf/i1040gi.pdf",
    # Federal Reserve — publication pipeline
    "frb-mpr-2025.pdf": "https://www.federalreserve.gov/monetarypolicy/files/20250620_mprfullreport.pdf",
    "frb-beigebook.pdf": "https://www.federalreserve.gov/monetarypolicy/files/BeigeBook_20250115.pdf",
    # GAO / CBO — report pipelines
    "gao-hicp.pdf": "https://www.gao.gov/assets/gao-25-107121.pdf",
    "cbo-outlook.pdf": "https://www.cbo.gov/system/files/2025-01/60870-Outlook-2025.pdf",
    # BLS / Census
    "bls-cpi.pdf": "https://www.bls.gov/news.release/pdf/cpi.pdf",
    "census-acs.pdf": "https://www2.census.gov/library/publications/2022/acs/acs-50.pdf",
    # Treasury / NIST / NREL / DOE
    "treasury-mts.pdf": "https://fiscaldata.treasury.gov/static-data/published-reports/mts/MonthlyTreasuryStatement_202506.pdf",
    "nist-sp800-63b.pdf": "https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-63b.pdf",
    "nist-fips180-4.pdf": "https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf",
    "nrel-atb-summary.pdf": "https://www.nrel.gov/docs/fy24osti/88332.pdf",
    # GPO / govinfo — congressional printing pipeline
    "govinfo-crpt.pdf": "https://www.govinfo.gov/content/pkg/CRPT-118hrpt529/pdf/CRPT-118hrpt529.pdf",
    "govinfo-plaw.pdf": "https://www.govinfo.gov/content/pkg/PLAW-117publ58/pdf/PLAW-117publ58.pdf",
    # Supreme Court — WordPerfect/PDF pipeline, older conventions
    "scotus-slip.pdf": "https://www.supremecourt.gov/opinions/24pdf/23-1122_886b.pdf",
    # HUD / FHFA
    "fhfa-hpi.pdf": "https://www.fhfa.gov/document/hpi_202412.pdf",
    # State Dept / older-style docs
    "state-visa-bulletin.pdf": "https://travel.state.gov/content/dam/visas/Bulletins/visabulletin_July2025.pdf",
    # IRS prior-year archive — 1990s Acrobat output: PDF 1.2/1.3, classic xref
    "irs-prior-f1040-1996.pdf": "https://www.irs.gov/pub/irs-prior/f1040--1996.pdf",
    "irs-prior-f1040-2001.pdf": "https://www.irs.gov/pub/irs-prior/f1040--2001.pdf",
    "irs-prior-p17-1999.pdf": "https://www.irs.gov/pub/irs-prior/p17--1999.pdf",
    # NIST legacy pubs — old print pipeline
    "nist-legacy-fips46-3.pdf": "https://nvlpubs.nist.gov/nistpubs/Legacy/FIPS/fipspub46-3.pdf",
    # govinfo Federal Register daily + an enrolled bill — GPO pipeline
    "govinfo-fr-daily.pdf": "https://www.govinfo.gov/content/pkg/FR-2024-01-02/pdf/FR-2024-01-02.pdf",
    "govinfo-bill-enr.pdf": "https://www.govinfo.gov/content/pkg/BILLS-117hr3684enr/pdf/BILLS-117hr3684enr.pdf",
}

def fetch(name, url):
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"
    if not data.startswith(b"%PDF-"):
        return None, f"not a PDF ({data[:30]!r})"
    return data, None

def characterize(data):
    version = data[5:8].decode("ascii", "replace")
    has_xref_stream = b"/Type /XRef" in data or b"/Type/XRef" in data
    has_objstm = b"/Type /ObjStm" in data or b"/Type/ObjStm" in data
    has_classic = bool(re.search(rb"\nxref\r?\n", data[:len(data)]) or data.find(b"\nxref\n") != -1 or data.find(b"\rxref\r") != -1)
    encrypted = b"/Encrypt" in data
    acroform = b"/AcroForm" in data
    linearized = b"/Linearized" in data[:2048]
    startxrefs = data.count(b"startxref")
    return {
        "version": version, "bytes": len(data),
        "xrefStream": has_xref_stream, "objStm": has_objstm,
        "classicXref": has_classic, "encrypted": encrypted,
        "acroForm": acroform, "linearized": linearized,
        "startxrefCount": startxrefs,
        "sha256": hashlib.sha256(data).hexdigest(),
    }

def main():
    lock_path = HERE / "pdf_corpus.json"
    existing = json.loads(lock_path.read_text()) if lock_path.exists() else {}
    lock = {}
    ok = 0
    for name, url in SOURCES.items():
        dest = FILES / name
        if dest.exists() and name in existing:
            data = dest.read_bytes()
            if hashlib.sha256(data).hexdigest() == existing[name]["sha256"]:
                lock[name] = existing[name]
                ok += 1
                print(f"  kept    {name:26} {existing[name]['version']} {existing[name]['bytes']:>10,} B")
                continue
        data, err = fetch(name, url)
        if err:
            print(f"  MISS    {name:26} {err[:70]}")
            continue
        dest.write_bytes(data)
        info = characterize(data)
        info["url"] = url
        lock[name] = info
        ok += 1
        flags = "".join([
            "S" if info["xrefStream"] else "-", "O" if info["objStm"] else "-",
            "C" if info["classicXref"] else "-", "F" if info["acroForm"] else "-",
            "L" if info["linearized"] else "-", "E" if info["encrypted"] else "-",
        ])
        print(f"  fetched {name:26} {info['version']} {info['bytes']:>10,} B  [{flags}] xrefs={info['startxrefCount']}")
    lock_path.write_text(json.dumps(lock, indent=1, sort_keys=True))
    print(f"\n  {ok}/{len(SOURCES)} locked into pdf_corpus.json")
    vs = sorted({v["version"] for v in lock.values()})
    print(f"  versions: {vs}")
    print(f"  xref streams: {sum(1 for v in lock.values() if v['xrefStream'])}, "
          f"object streams: {sum(1 for v in lock.values() if v['objStm'])}, "
          f"classic: {sum(1 for v in lock.values() if v['classicXref'])}, "
          f"forms: {sum(1 for v in lock.values() if v['acroForm'])}, "
          f"encrypted: {sum(1 for v in lock.values() if v['encrypted'])}")
    return 0 if ok >= 12 else 1

if __name__ == "__main__":
    sys.exit(main())
