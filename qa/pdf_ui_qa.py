"""PDF tool UI — driven like a person, graded like the fidelity exam.

The flow tested is the one a human actually performs: pick a real IRS form
through the real file input, delete a page by clicking its x, rotate another
by clicking its arrow, press Save, and then GRADE THE DOWNLOADED FILE in
Python: page count via pikepdf, and every page pixel-compared under pdfium
to the exact source pages it should carry. Then the same again for a merge.

The bundled single-file download (make-single output) gets the same flow
from file:// — the bundler has broken a dynamic import before; only driving
the bundle itself proves it.
"""
import functools, hashlib, http.server, pathlib, socketserver, sys, threading, time

import pikepdf
import pypdfium2 as pdfium

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ROOT / "corpus" / "pdf" / "files"
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 8878

h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "dist"))
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails = []

def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(62) + str(got)[:50])

def render_hash(path, i, rotation=0):
    doc = pdfium.PdfDocument(str(path))
    page = doc.get_page(i)
    hsh = hashlib.sha256(bytes(page.render(scale=1.5, rotation=rotation).buffer)).hexdigest()
    page.close(); doc.close()
    return hsh

# an encrypted file, to prove refusal
enc_path = OUT / "tmp_encrypted.pdf"
with pikepdf.open(FILES / "irs-f1040.pdf") as pdf:
    pdf.save(enc_path, encryption=pikepdf.Encryption(owner="o", user="u"))

try:
    from patchright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport={"width": 1280, "height": 950})
        errs, external = [], []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("request", lambda r: None if "127.0.0.1" in r.url or r.url.startswith(("data:", "blob:"))
              else external.append(r.url))
        pg.goto(f"http://127.0.0.1:{PORT}/app/pdf.html", wait_until="load")
        pg.wait_for_timeout(300)
        cdp = pg.context.new_cdp_session(pg)

        def ev(x):
            r = cdp.send("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True})
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"])[:400])
            return r["result"].get("value")

        def wait_until(expr, timeout=60):
            deadline = time.time() + timeout
            while time.time() < deadline:
                if ev(expr):
                    return
                time.sleep(0.15)
            raise TimeoutError(expr)

        print("\n  load a real form through the real picker")
        pg.set_input_files("#pick", str(FILES / "irs-fw9.pdf"))
        wait_until("document.querySelectorAll('.page').length === 6")
        t("6 page cards for fw9", ev("document.querySelectorAll('.page').length"), 6)
        t("count line reads right", ev("document.getElementById('count').textContent"), "6 pages from 1 file")
        t("card 1 names the file and page",
          "irs-fw9.pdf — page 1 of 6" in ev("document.querySelector('.page .what b').textContent"))

        print("\n  edit: delete page 2, rotate page 1")
        pg.click('.page[data-i="1"] button[data-act="del"]')
        wait_until("document.querySelectorAll('.page').length === 5")
        t("5 cards after delete", ev("document.querySelectorAll('.page').length"), 5)
        pg.click('.page[data-i="0"] button[data-act="rot"]')
        pg.wait_for_timeout(150)
        t("rotation shows on card 1", "rotated 90°" in ev("document.querySelector('.page .what span').textContent"))

        print("\n  save, then grade the actual downloaded file")
        with pg.expect_download(timeout=120000) as dl:
            pg.click("#save")
        saved = OUT / "ui_fw9_edited.pdf"
        dl.value.save_as(str(saved))
        t("download named after the source", dl.value.suggested_filename, "irs-fw9 (edited).pdf")
        with pikepdf.open(saved) as pdf:
            t("saved file has 5 pages", len(pdf.pages), 5)
        src = FILES / "irs-fw9.pdf"
        t("page 1 == source page 1 rotated 90°", render_hash(saved, 0) == render_hash(src, 0, rotation=90))
        bad = [k for k in range(1, 5) if render_hash(saved, k) != render_hash(src, k + 1)]
        t("pages 2-5 == source pages 3-6, pixel-identical", bad, [])

        print("\n  merge: add a second file and save again")
        pg.set_input_files("#pick", str(FILES / "irs-f1040.pdf"))
        wait_until("document.querySelectorAll('.page').length === 7")
        t("7 cards after adding f1040", ev("document.querySelectorAll('.page').length"), 7)
        with pg.expect_download(timeout=120000) as dl2:
            pg.click("#save")
        merged = OUT / "ui_merged.pdf"
        dl2.value.save_as(str(merged))
        t("merged download is combined.pdf", dl2.value.suggested_filename, "combined.pdf")
        with pikepdf.open(merged) as pdf:
            t("merged has 7 pages", len(pdf.pages), 7)
        t("merged page 1 keeps the rotation", render_hash(merged, 0) == render_hash(src, 0, rotation=90))
        bad = [k for k in range(1, 5) if render_hash(merged, k) != render_hash(src, k + 1)]
        bad += [("f", k) for k in range(2) if render_hash(merged, 5 + k) != render_hash(FILES / "irs-f1040.pdf", k)]
        t("all merged pages pixel-identical to their sources", bad, [])

        print("\n  keep-range and encrypted refusal")
        pg.fill("#range", "1-2")
        pg.click("#applyrange")
        wait_until("document.querySelectorAll('.page').length === 2")
        t("keep 1-2 leaves 2 cards", ev("document.querySelectorAll('.page').length"), 2)
        pg.set_input_files("#pick", str(enc_path))
        pg.wait_for_timeout(600)
        t("encrypted file refused with a plain sentence",
          "password-protected" in ev("document.getElementById('status').textContent"))
        t("refusal added no cards", ev("document.querySelectorAll('.page').length"), 2)

        print("\n  hygiene")
        t("zero external requests", external, [])
        t("zero console errors", errs, [])
        pg.set_viewport_size({"width": 390, "height": 844})
        pg.wait_for_timeout(200)
        t("no horizontal scroll at phone width",
          ev("document.scrollingElement.scrollWidth <= window.innerWidth"))
        pg.screenshot(path=str(OUT / "pdf_ui_mobile.png"), full_page=True)
        pg.set_viewport_size({"width": 1280, "height": 950})
        pg.wait_for_timeout(200)
        pg.screenshot(path=str(OUT / "pdf_ui_desktop.png"), full_page=True)
        pg.close()

        print("\n  the BUNDLED single file, from a double-click")
        pg2 = b.new_page(viewport={"width": 1280, "height": 950})
        errs2, ext2 = [], []
        pg2.on("console", lambda m: errs2.append(m.text) if m.type == "error" else None)
        pg2.on("pageerror", lambda e: errs2.append(str(e)))
        pg2.on("request", lambda r: None if r.url.startswith(("file:", "data:", "blob:"))
               else ext2.append(r.url))
        pg2.goto((ROOT / "dist" / "download" / "miscellany-pdf.html").as_uri(), wait_until="load")
        pg2.wait_for_timeout(400)
        cdp2 = pg2.context.new_cdp_session(pg2)

        def ev2(x):
            r = cdp2.send("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True})
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"])[:400])
            return r["result"].get("value")

        pg2.set_input_files("#pick", str(FILES / "irs-fw4.pdf"))
        deadline = time.time() + 60
        while time.time() < deadline and not ev2("document.querySelectorAll('.page').length === 5"):
            time.sleep(0.15)
        t("bundle: 5 cards for fw4", ev2("document.querySelectorAll('.page').length"), 5)
        pg2.click('.page[data-i="4"] button[data-act="del"]')
        pg2.wait_for_timeout(200)
        with pg2.expect_download(timeout=120000) as dl3:
            pg2.click("#save")
        bsaved = OUT / "bundle_fw4_edited.pdf"
        dl3.value.save_as(str(bsaved))
        with pikepdf.open(bsaved) as pdf:
            t("bundle: saved 4 pages", len(pdf.pages), 4)
        bad = [k for k in range(4) if render_hash(bsaved, k) != render_hash(FILES / "irs-fw4.pdf", k)]
        t("bundle: pages pixel-identical", bad, [])
        t("bundle: zero network attempts", ext2, [])
        t("bundle: zero console errors", errs2, [])
        pg2.close()
        b.close()
except Exception as e:
    import traceback
    traceback.print_exc()
    fails.append(f"harness: {type(e).__name__}: {e}")

srv.shutdown()
print(f"\n{'  ALL GREEN' if not fails else f'  {len(fails)} FAILURE(S)'}")
for f in fails:
    print("  x " + f)
sys.exit(1 if fails else 0)
