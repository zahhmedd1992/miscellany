"""Sheet, after it was re-hosted on the shell.

app.js went from 1,339 lines to 51. Nothing here checks the line count — it
checks that the spreadsheet still does everything it did: typing, undo,
formatting, opening a real .xlsx, switching sheets, and writing the file back
with preserve-unknown intact.

Node tests cannot reach any of this. The app layer only exists in a browser.
"""
import http.server, socketserver, threading, functools, pathlib, sys, json

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 8794
BOOK = ROOT / "corpus" / "files" / "nrel-atb.xlsx"          # 4.9 MB, 12 sheets
if not BOOK.exists():
    BOOK = sorted((ROOT / "corpus" / "files").glob("*.xlsx"))[0]

h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "src"))
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails = []


def t(name, got, want):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(46) + str(got)[:72])


try:
    from patchright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport={"width": 1600, "height": 900}, device_scale_factor=2)
        errs, external = [], []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("request", lambda r: None if "127.0.0.1" in r.url or r.url.startswith("data:")
              else external.append(r.url))

        pg.goto(f"http://127.0.0.1:{PORT}/index.html", wait_until="networkidle")
        pg.wait_for_timeout(400)
        cdp = pg.context.new_cdp_session(pg)

        def ev(x, wait=False):
            r = cdp.send("Runtime.evaluate",
                         {"expression": x, "returnByValue": True, "awaitPromise": wait})
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"])[:400])
            return r["result"].get("value")

        ev("localStorage.clear()")
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(400)
        cdp = pg.context.new_cdp_session(pg)

        print("\n  the shell's chrome, which Sheet no longer builds")
        t("toolbar generated", ev("document.querySelectorAll('.gr-tool').length >= 12"), True)
        t("formula bar is Sheet's own", ev("!!document.querySelector('.sh-finput')"), True)
        t("document name field", ev("!!document.querySelector('.gr-docname')"), True)
        t("both apps are registered", ev("[...miscellany.shell.apps.keys()].join(',')"), "sheet,deck")

        print("\n  typing, with real keystrokes")
        box = pg.locator(".sh-grid").bounding_box()
        xy = json.loads(ev("""(() => { const g = miscellany.grid;
          return JSON.stringify({x: g.colX(1) + g.width(1)/2, y: g.rowY(4) + 10}); })()"""))
        pg.mouse.click(box["x"] + xy["x"], box["y"] + xy["y"])
        pg.wait_for_timeout(120)
        pg.keyboard.type("999")
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(250)
        t("the cell took the value", ev("miscellany.doc.raw('main!B5')"), "999")
        # 128400 + 999 + 155900
        t("the total followed", ev("miscellany.doc.value('main!B7').d.toString()"), "285299")

        print("\n  undo, which app.js no longer implements")
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(200)
        t("Ctrl+Z reverted it", ev("miscellany.doc.raw('main!B5')"), "141250")
        pg.keyboard.press("Control+Shift+z")
        pg.wait_for_timeout(200)
        t("redo restored it", ev("miscellany.doc.raw('main!B5')"), "999")
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(200)

        print("\n  two edits are two undo steps, not one merged step")
        # commitEdit and the formula bar both journal through host.batch().
        # One typed cell proves batch() runs; it does not prove consecutive
        # edits stay separate.
        ev("miscellany.grid.select(1, 4)")
        pg.wait_for_timeout(80)
        pg.keyboard.type("111"); pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
        pg.keyboard.type("222"); pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
        t("both cells took their values",
          [ev("miscellany.doc.raw('main!B5')"), ev("miscellany.doc.raw('main!B6')")],
          ["111", "222"])
        pg.keyboard.press("Control+z"); pg.wait_for_timeout(200)
        t("one undo reverts only the second",
          [ev("miscellany.doc.raw('main!B5')"), ev("miscellany.doc.raw('main!B6')")],
          ["111", "155900"])
        pg.keyboard.press("Control+z"); pg.wait_for_timeout(200)
        t("the second undo reverts the first",
          [ev("miscellany.doc.raw('main!B5')"), ev("miscellany.doc.raw('main!B6')")],
          ["141250", "155900"])

        print("\n  paste is one undo step, and a cut restores both ends")
        # applyPaste journals through host.batch(), not through run(), because
        # the browser only releases the clipboard to a real paste event.
        # paste lands on the SELECTION, and two Enters ago the caret moved on
        ev("miscellany.grid.select(1, 4)")
        pg.wait_for_timeout(80)
        ev("""miscellany.shell.surfaces.get('sheet')
                .applyPaste({tsv: '7\\t8'})""")
        pg.wait_for_timeout(250)
        t("paste overwrote two cells",
          [ev("miscellany.doc.raw('main!B5')"), ev("miscellany.doc.raw('main!C5')")],
          ["7", "8"])
        pg.keyboard.press("Control+z"); pg.wait_for_timeout(200)
        t("one undo restores both overwritten cells",
          [ev("miscellany.doc.raw('main!B5')"), ev("miscellany.doc.raw('main!C5')")],
          ["141250", "78900"])

        # cut A4:B4, paste it at A20 — the source clears and the target fills
        # in the SAME step, so one undo has to put both back.
        ev("""(() => {
          const g = miscellany.grid;
          g.anchor = {col: 0, row: 3}; g.sel = {col: 1, row: 3};
          miscellany.shell.surfaces.get('sheet').clipboard('cut');
          g.anchor = g.sel = {col: 0, row: 19};
        })()""")
        pg.wait_for_timeout(200)
        ev("""miscellany.shell.surfaces.get('sheet')
                .applyPaste({tsv: 'July\\t128400'})""")
        pg.wait_for_timeout(250)
        t("the cut source cleared",
          [ev("miscellany.doc.raw('main!A4')"), ev("miscellany.doc.raw('main!B4')")],
          ["", ""])
        t("and the target filled", ev("miscellany.doc.raw('main!A20')"), "July")
        pg.keyboard.press("Control+z"); pg.wait_for_timeout(250)
        t("one undo restores the cut source",
          [ev("miscellany.doc.raw('main!A4')"), ev("miscellany.doc.raw('main!B4')")],
          ["July", "128400"])
        t("and clears the paste target", ev("miscellany.doc.raw('main!A20')"), "")

        print("\n  formatting, and formatting is undoable now")
        # Enter moved the selection down a row, so name the cell explicitly
        # rather than assume where the caret ended up.
        ev("miscellany.grid.select(1, 4)")
        pg.wait_for_timeout(100)
        ev("miscellany.shell.run('fmt.bold')")
        pg.wait_for_timeout(150)
        t("bold applied", ev("!!(miscellany.doc.node('main!B5').meta||{})._styleChanged"), True)
        idx = ev("miscellany.doc.node('main!B5').meta.styleIndex")
        ev("miscellany.shell.run('edit.undo')")
        pg.wait_for_timeout(150)
        t("undo reverted the style, not the value",
          ev("(miscellany.doc.node('main!B5').meta||{}).styleIndex ?? 'none'") != idx, True)
        t("and the value is untouched", ev("miscellany.doc.raw('main!B5')"), "141250")

        print("\n  opening a real workbook")
        print(f"       {BOOK.name} · {BOOK.stat().st_size / 1e6:.1f} MB")
        pg.set_input_files("input[type=file]", str(BOOK))
        # Wait for the condition, not for a guessed number of seconds — a
        # 4.9 MB workbook takes as long as it takes.
        for _ in range(120):
            if ev("!!(miscellany.shell.surfaces.get('sheet').book)"):
                break
            pg.wait_for_timeout(1000)
        pg.wait_for_timeout(500)
        info = json.loads(ev("""JSON.stringify({
          nodes: miscellany.doc.nodes.size,
          sheets: miscellany.shell.surfaces.get('sheet').book
                  ? miscellany.shell.surfaces.get('sheet').book.sheets.length : 0,
          tabs: document.querySelectorAll('.sh-tab').length,
          status: document.querySelector('.gr-status').textContent,
          name: document.querySelector('.gr-docname').value,
        })"""))
        t("cells loaded", info["nodes"] > 1000, True)
        t("sheet tabs rendered", info["tabs"] == info["sheets"] and info["tabs"] > 0, True)
        t("the document took the file's name", info["name"] == BOOK.stem, True)
        t("status reports preserved parts", "parts kept untouched" in info["status"], True)
        t("autosave was turned off for a real file",
          ev("miscellany.shell._autosave"), False)
        print(f"       {info['nodes']:,} nodes · {info['sheets']} sheets · {info['name']}")

        # switching sheets must reload that sheet's geometry, not the first one's
        if info["tabs"] > 1:
            ev("document.querySelectorAll('.sh-tab')[1].click()")
            pg.wait_for_timeout(600)
            t("switching sheets moves the grid",
              ev("miscellany.grid.sheet") != ev("miscellany.shell.surfaces.get('sheet').book.sheets[0].name"),
              True)
            ev("document.querySelectorAll('.sh-tab')[0].click()")
            pg.wait_for_timeout(400)

        print("\n  writing it back out")
        with pg.expect_download(timeout=60000) as dl:
            ev("miscellany.shell.run('file.save.xlsx')")
        path = dl.value.path()
        size = pathlib.Path(path).stat().st_size
        # A save must not shrink the workbook: preserve-unknown means every
        # part we did not touch comes back, so the output is the same order
        # of magnitude as the input, not a stripped-down reconstruction.
        t("a file came out, and it is not a stripped reconstruction",
          size > BOOK.stat().st_size * 0.75, True)
        status = ev("document.querySelector('.gr-status').textContent")
        t("and it re-emitted the untouched parts byte-for-byte",
          "re-emitted byte-for-byte" in status, True)
        print(f"       {size:,} bytes · {status.strip()[-70:]}")

        print("\n  it draws")
        ink = ev("""(() => { const c = document.querySelector('.sh-grid');
          const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let n = 0; for (let i = 0; i < d.length; i += 4)
            if (!(d[i] > 232 && d[i+1] > 228 && d[i+2] > 222)) n++;
          return n; })()""")
        t("the grid has ink on it", ink > 40000, True)
        t("no console errors", errs or "none", "none")
        t("no external requests", external or "none", "none")

        pg.screenshot(path=str(OUT / "04-sheet-rehosted.png"))

        # the Both layout: same two apps, one document
        ev("miscellany.shell.setLayout(['sheet','deck'])")
        pg.wait_for_timeout(500)
        t("two panes mount together",
          ev("document.querySelectorAll('.gr-pane').length"), 2)
        pg.screenshot(path=str(OUT / "05-both.png"))
        b.close()
finally:
    srv.shutdown()

print()
if fails:
    for f in fails:
        print("  x " + f + "\n")
    sys.exit(1)
print("  all green\n")
