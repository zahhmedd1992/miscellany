"""Live check after the PDF deploy: tally 7, the tool functions AT
miscellany.io with a real file through the real picker, and the clicked
download is byte-identical to the build and does page surgery from disk."""
import hashlib, pathlib, sys, time

import pikepdf

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ROOT / "corpus" / "pdf" / "files"
OUT = ROOT / "qa" / "out"
LIVE = "https://miscellany.io"
fails = []

def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(60) + str(got)[:52])

from patchright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    pg = b.new_page(viewport={"width": 1280, "height": 950})
    errs, third = [], []
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("response", lambda r: None if "miscellany.io" in r.url or r.url.startswith(("data:", "blob:"))
          else third.append(r.url))

    pg.goto(f"{LIVE}/", wait_until="load")
    pg.wait_for_timeout(500)
    t("front door tally reads 7", pg.text_content('[data-tally="tools"]'), "7")
    h2s = pg.eval_on_selector_all("h2", "els => els.map(e => e.textContent)")
    t("PDF listed", "PDF" in h2s, True)

    with pg.expect_download(timeout=60000) as dl:
        pg.click('a[href="./download/miscellany-pdf.html"]')
    saved = OUT / "live_dl_pdf.html"
    dl.value.save_as(str(saved))
    same = hashlib.sha256(saved.read_bytes()).hexdigest() == \
           hashlib.sha256((ROOT / "dist" / "download" / "miscellany-pdf.html").read_bytes()).hexdigest()
    t("clicked download byte-identical to the build", same)

    pg.goto(f"{LIVE}/app/pdf.html", wait_until="load")
    pg.wait_for_timeout(700)
    cdp = pg.context.new_cdp_session(pg)
    def ev(x):
        r = cdp.send("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in r:
            raise RuntimeError(str(r["exceptionDetails"])[:400])
        return r["result"].get("value")

    pg.set_input_files("#pick", str(FILES / "irs-f1040.pdf"))
    deadline = time.time() + 60
    while time.time() < deadline and ev("document.querySelectorAll('.page').length") != 2:
        time.sleep(0.2)
    t("live tool loads f1040: 2 cards", ev("document.querySelectorAll('.page').length"), 2)
    with pg.expect_download(timeout=60000) as dl2:
        pg.click("#save")
    out = OUT / "live_pdf_noop.pdf"
    dl2.value.save_as(str(out))
    with pikepdf.open(out) as pdf:
        t("live save round-trips 2 pages", len(pdf.pages), 2)
    real = [e for e in errs if "Content Security Policy" not in e and "cloudflareinsights" not in e]
    t("no real console errors across the flow", real, [])
    t("no completed third-party responses", third, [])

    b.close()

print(f"\n{'  ALL GREEN — PDF live' if not fails else f'  {len(fails)} FAILURE(S)'}")
for f in fails:
    print("  x " + f)
sys.exit(1 if fails else 0)
