"""Validate our .docx output with implementations that are not ours.

Our reader accepting our writer proves less than it looks like. This checks
every file test/docx.roundtrip.test.mjs wrote with:

  1. Python's zipfile.testzip()  — every entry's CRC and the central directory
  2. Python's ElementTree        — the main part is well-formed XML
  3. a namespace-aware re-count  — the edit is present exactly once, and the
                                   part count is unchanged

Run: node test/docx.roundtrip.test.mjs && python qa/docx_foreign_check.py
"""
import pathlib, sys, zipfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out" / "docx"
SRC = ROOT / "corpus" / "docx" / "files"
MARK = "MISCELLANY_ROUNDTRIP_MARK"
WML = {
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
}

fails = []


def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    return ok


def main_part(zf):
    try:
        rels = ET.fromstring(zf.read("_rels/.rels"))
    except KeyError:
        return "word/document.xml"
    for r in rels:
        if (r.get("Type") or "").endswith("/officeDocument"):
            tgt = r.get("Target") or ""
            return tgt.lstrip("/")
    return "word/document.xml"


files = sorted(OUT.glob("*.edited.docx"))
if not files:
    print("  no outputs — run: node test/docx.roundtrip.test.mjs")
    sys.exit(1)

checked = 0
for f in files:
    slug = f.name[: -len(".edited.docx")]
    orig = SRC / f"{slug}.docx"
    try:
        zf = zipfile.ZipFile(f)
    except Exception as e:
        t(f"{slug}: opens as a zip", f"threw {e}", "ok")
        continue

    bad = zf.testzip()
    t(f"{slug}: every entry's CRC checks out", bad, None)

    part = main_part(zf)
    try:
        root = ET.fromstring(zf.read(part))
    except Exception as e:
        t(f"{slug}: {part} is well-formed XML", f"threw {e}", "ok")
        continue

    texts = [(e.text or "") for e in root.iter()
             if e.tag.startswith("{") and e.tag.split("}")[0][1:] in WML
             and e.tag.split("}")[1] == "t"]
    blob = "".join(texts)
    t(f"{slug}: the edit is present exactly once", blob.count(MARK), 1)

    if orig.exists():
        with zipfile.ZipFile(orig) as z0:
            t(f"{slug}: the part count is unchanged",
              len(zf.namelist()), len(z0.namelist()))
            t(f"{slug}: no part was renamed",
              sorted(zf.namelist()) == sorted(z0.namelist()), True)
            # every part except the main one is byte-identical
            differ = [n for n in z0.namelist()
                      if n != part and n in zf.namelist() and z0.read(n) != zf.read(n)]
            t(f"{slug}: only the document part changed", differ, [])
    zf.close()
    checked += 1

print(f"  checked {checked} edited documents with zipfile + ElementTree")
if fails:
    print(f"  {len(fails)} FAILED")
    for x in fails[:30]:
        print("   x " + x)
    sys.exit(1)
print("  foreign validation: all green")
