"""The PDF writer's fidelity exam. Byte-identity is the wrong gate for a
rewritten container, so the gates are the ones that matter to a human:

  1. STRUCTURE: pikepdf (qpdf) opens every output and its checker reports
     no errors — an independent implementation's opinion, not ours.
  2. PIXELS: pdfium renders every surviving page of every output and the
     bitmap must hash IDENTICAL to the same page rendered from the source.
     A dropped font, a lost resource, a broken content stream — all of it
     lands in the pixels. (Big files are sampled: first 10, 3 middle, last 3.)
  3. MAPPING: delete/extract/reverse/merge assert the page-to-page map,
     not just counts.
"""
import hashlib, pathlib, subprocess, sys

import pikepdf
import pypdfium2 as pdfium

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ROOT / "corpus" / "pdf" / "files"
OUT = ROOT / "qa" / "out" / "pdfops"
OUT.mkdir(parents=True, exist_ok=True)

fails = []

def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(64) + str(got)[:48])

def run_op(op, *paths):
    out = OUT / f"{op.replace('=','_').replace(':','_').replace(',','_').replace('-','_')}__{paths[0].stem}.pdf"
    r = subprocess.run(["node", str(ROOT / "tools" / "pdf-op.mjs"), op, *map(str, paths), str(out)],
                       capture_output=True, text=True, cwd=str(ROOT), timeout=600)
    if r.returncode != 0:
        raise RuntimeError(f"pdf-op {op} on {paths[0].name}: {r.stderr.strip()[:300]}")
    return out

_render_cache = {}
def render_hash(path, page_index, rotation=0):
    key = (str(path), page_index, rotation)
    if key in _render_cache:
        return _render_cache[key]
    doc = pdfium.PdfDocument(str(path))
    page = doc.get_page(page_index)
    bmp = page.render(scale=1.5, rotation=rotation)
    h = hashlib.sha256(bytes(bmp.buffer)).hexdigest()
    page.close(); doc.close()
    _render_cache[key] = h
    return h

def sample(n):
    if n <= 90:
        return list(range(n))
    return list(range(10)) + [n // 2 - 1, n // 2, n // 2 + 1] + [n - 3, n - 2, n - 1]

def _warnings(path):
    # check_pdf_syntax (pikepdf 10.x) decodes every stream and surfaces
    # qpdf's warnings — the qpdf --check equivalent. Paths and offsets are
    # stripped so source and output messages compare.
    with pikepdf.open(path) as pdf:
        return sorted(w.split("): ", 1)[-1] for w in pdf.check_pdf_syntax()), len(pdf.pages)

def check_clean(path, label, src=None):
    got, n = _warnings(path)
    if src is not None:
        # irs-i1040gi ships a quirky Flate stream that qpdf warns about in
        # the ORIGINAL; preserving it verbatim preserves the warning. The
        # gate is therefore: no warnings we did not inherit.
        had, _ = _warnings(src)
        new = [w for w in got if w not in had]
        t(f"{label}: qpdf reports no NEW warnings", new[:2], [])
    else:
        t(f"{label}: qpdf check clean", got[:2], [])
    return n

corpus = sorted(FILES.glob("*.pdf"))
print(f"\n  NO-OP round trip: {len(corpus)} files — structure + pixels")
for src in corpus:
    try:
        out = run_op("noop", src)
    except RuntimeError as e:
        fails.append(str(e)); print("  FAIL " + str(e)[:110]); continue
    with pikepdf.open(src) as s:
        n_src = len(s.pages)
    n_out = check_clean(out, f"noop {src.stem}", src)
    t(f"noop {src.stem}: page count {n_src}", n_out, n_src)
    bad = []
    for i in sample(n_src):
        if render_hash(src, i) != render_hash(out, i):
            bad.append(i + 1)
    t(f"noop {src.stem}: pages render IDENTICAL ({len(sample(n_src))} sampled)", bad[:8], [])

print("\n  DELETE page 2 — mapping, on three shapes of file")
for name in ["irs-fw9.pdf", "nist-fips180-4.pdf", "state-visa-bulletin.pdf"]:
    src = FILES / name
    out = run_op("delete=2", src)
    n = check_clean(out, f"delete {src.stem}", src)
    with pikepdf.open(src) as s:
        t(f"delete {src.stem}: one page fewer", n, len(s.pages) - 1)
    src_map = [0] + list(range(2, n + 1))
    bad = [i for i in range(min(n, 12)) if render_hash(out, i) != render_hash(src, src_map[i])]
    t(f"delete {src.stem}: surviving pages render IDENTICAL", bad, [])

print("\n  EXTRACT 2-3")
for name in ["irs-fw4.pdf", "treasury-mts.pdf"]:
    src = FILES / name
    out = run_op("extract=2-3", src)
    n = check_clean(out, f"extract {src.stem}", src)
    t(f"extract {src.stem}: two pages", n, 2)
    bad = [i for i in range(2) if render_hash(out, i) != render_hash(src, i + 1)]
    t(f"extract {src.stem}: pages are src 2,3 exactly", bad, [])

print("\n  REVERSE")
src = FILES / "state-visa-bulletin.pdf"
out = run_op("reverse", src)
n = check_clean(out, "reverse visa", src)
bad = [i for i in range(n) if render_hash(out, i) != render_hash(src, n - 1 - i)]
t("reverse visa-bulletin: mapping exact", bad, [])

print("\n  ROTATE page 1 by 90")
for name in ["irs-f1040.pdf", "irs-prior-f1040-1996.pdf"]:
    src = FILES / name
    out = run_op("rotate=1:90", src)
    check_clean(out, f"rotate {src.stem}", src)
    t(f"rotate {src.stem}: page 1 out == page 1 src rendered at 90°",
      render_hash(out, 0) == render_hash(src, 0, rotation=90))
    t(f"rotate {src.stem}: page 2 untouched", render_hash(out, 1) == render_hash(src, 1))

print("\n  MERGE f1040 + fw9")
out = run_op("merge", FILES / "irs-f1040.pdf", FILES / "irs-fw9.pdf")
n = check_clean(out, "merge f1040+fw9")
t("merge: 2 + 6 = 8 pages", n, 8)
bad = []
for i in range(2):
    if render_hash(out, i) != render_hash(FILES / "irs-f1040.pdf", i):
        bad.append(("A", i + 1))
for i in range(6):
    if render_hash(out, 2 + i) != render_hash(FILES / "irs-fw9.pdf", i):
        bad.append(("B", i + 1))
t("merge: all 8 pages render IDENTICAL to their sources", bad, [])

print("\n  MERGE across generations: 1996 form + 2025 form")
out = run_op("merge", FILES / "irs-prior-f1040-1996.pdf", FILES / "irs-f1040.pdf")
n = check_clean(out, "merge 1996+2025")
t("merge generations: 4 pages", n, 4)
bad = []
for i in range(2):
    if render_hash(out, i) != render_hash(FILES / "irs-prior-f1040-1996.pdf", i):
        bad.append(("1996", i + 1))
    if render_hash(out, 2 + i) != render_hash(FILES / "irs-f1040.pdf", i):
        bad.append(("2025", i + 1))
t("merge generations: pixels identical", bad, [])

print("\n  STRIP METADATA")
src = FILES / "irs-fw9.pdf"
out = run_op("stripmeta", src)
check_clean(out, "stripmeta fw9", src)
with pikepdf.open(out) as pdf:
    t("stripmeta: docinfo gone", len(dict(pdf.docinfo)), 0)
    t("stripmeta: no XMP /Metadata in catalog", "/Metadata" in pdf.Root, False)
with pikepdf.open(src) as pdf:
    t("stripmeta: source HAD metadata (test is real)", len(dict(pdf.docinfo)) > 0)
bad = [i for i in range(6) if render_hash(out, i) != render_hash(src, i)]
t("stripmeta: pixels untouched", bad, [])

print("\n  ACROFORM survives single-source ops")
src = FILES / "irs-fw4.pdf"
out = run_op("extract=1-1", src)
with pikepdf.open(src) as a, pikepdf.open(out) as b:
    t("fw4 source has a form", "/AcroForm" in a.Root)
    t("extracted page keeps a form", "/AcroForm" in b.Root)
    if "/AcroForm" in a.Root and "/AcroForm" in b.Root:
        t("fields pruned, not dropped: 0 < kept <= source",
          0 < len(b.Root.AcroForm.Fields) <= len(a.Root.AcroForm.Fields))

print(f"\n{'  ALL GREEN' if not fails else f'  {len(fails)} FAILURE(S)'}")
for f in fails[:20]:
    print("  x " + f)
sys.exit(1 if fails else 0)
