"""Every bundled single-file download, opened from disk: it must PAINT.

make-single changed (it now carries the entry's body); Sheet and Deck are
canvas apps, so 'paints' means a real canvas wider than its 300px default —
the check that caught a missing stylesheet once. PDF is DOM, so 'paints'
means its drop zone exists and the app module ran (window.misc).
"""
import pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
fails = []

def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(56) + str(got)[:56])

CHECKS = {
    "miscellany-sheet.html": "(() => { const c = document.querySelector('canvas'); return !!c && c.width > 300; })()",
    "miscellany-deck.html": "(() => { const c = document.querySelector('canvas'); return !!c && c.width > 300; })()",
    "miscellany-pdf.html": "!!document.getElementById('pick') && !!window.misc && typeof misc.buildPdf === 'function'",
}

from patchright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    for name, probe in CHECKS.items():
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        errs, ext = [], []
        pg.on("console", lambda m, e=errs: e.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda x, e=errs: e.append(str(x)))
        pg.on("request", lambda r, x=ext: None if r.url.startswith(("file:", "data:", "blob:")) else x.append(r.url))
        pg.goto((ROOT / "dist" / "download" / name).as_uri(), wait_until="load")
        pg.wait_for_timeout(900)
        cdp = pg.context.new_cdp_session(pg)
        r = cdp.send("Runtime.evaluate", {"expression": probe, "returnByValue": True})
        t(f"{name}: paints/boots from disk", r["result"].get("value"))
        t(f"{name}: zero network attempts", ext, [])
        t(f"{name}: zero console errors", errs, [])
        pg.close()
    b.close()

print(f"\n{'  ALL GREEN' if not fails else f'  {len(fails)} FAILURE(S)'}")
for f in fails:
    print("  x " + f)
sys.exit(1 if fails else 0)
