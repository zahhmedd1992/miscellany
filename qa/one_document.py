"""One document, saved as one file.

"Usable individually or combined into one dual solution" was the first thing
asked for, and until now it was true of the screen and false of everything
underneath it: compose.html had no storage at all, so Ctrl+S did nothing and
said nothing; Sheet and Deck kept separate localStorage keys, so they were two
documents wearing one layout.

This drives the real UI: build a sheet, put a deck on it that reads from the
sheet, save the whole thing to a file, wipe the tab, open the file back, and
check the slide's figures are still LIVE — not copies.
"""
import http.server, socketserver, threading, functools, pathlib, sys, json, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 8802

h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "src"))
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(0.4)

fails = []


def t(name, got, want):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(48) + str(got)[:66])


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

        pg.goto(f"http://127.0.0.1:{PORT}/compose.html", wait_until="networkidle")
        pg.wait_for_timeout(500)
        cdp = pg.context.new_cdp_session(pg)

        def ev(x):
            r = cdp.send("Runtime.evaluate", {"expression": x, "returnByValue": True})
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"])[:400])
            return r["result"].get("value")

        ev("localStorage.clear()")
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(600)
        cdp = pg.context.new_cdp_session(pg)

        print("\n  Ctrl+S used to do nothing at all here")
        t("the combined page now has storage",
          ev("miscellany.shell.storageKey"), "miscellany.doc.v1")
        t("Save document is a real command",
          ev("!!miscellany.shell.reg.get('file.save.doc')"), True)

        print("\n  edit the sheet; the slide follows")
        ev("miscellany.doc.set('main!B6', '260000')")
        pg.wait_for_timeout(300)
        t("the KPI moved", ev("miscellany.doc.value('deck:s1/kpi').d.toString()"), "55.9")
        t("the subtitle moved", ev("miscellany.doc.value('deck:s1/sub').s"),
          "Total revenue $529,650 across 3 months")

        print("\n  save the whole document to one file")
        with pg.expect_download(timeout=30000) as dl:
            ev("miscellany.shell.run('file.save.doc')")
        path = pathlib.Path(dl.value.path())
        text = path.read_text(encoding="utf-8")
        saved = OUT / "one-document.grain"
        saved.write_text(text, encoding="utf-8")

        lines = text.strip().split("\n")
        t("it is a Miscellany document", lines[0], "miscellany/1")
        t("it holds the sheet", any('"main!B6"' in l for l in lines), True)
        t("and the deck, in the same file", any('"deck:s1/kpi"' in l for l in lines), True)
        t("one node per line, so it diffs", len(lines) > 15, True)
        # inputs only: the file must not contain the computed total
        t("no computed values are stored", "529650" in text, False)
        t("the formula that produces it is", "=SUM(B4:B6)" in text, True)
        print(f"       {len(text):,} bytes · {len(lines)} lines · {saved}")

        print("\n  wipe the tab and open the file back")
        ev("localStorage.clear()")
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(600)
        cdp = pg.context.new_cdp_session(pg)
        t("the reloaded page is back to its demo value",
          ev("miscellany.doc.raw('main!B6')"), "155900")

        # open the saved file through the real command, via the real input
        ev("miscellany.shell.run('file.open.doc')")
        pg.wait_for_timeout(200)
        pg.set_input_files("input[type=file][accept='.grain']", str(saved))
        pg.wait_for_timeout(900)

        t("the sheet came back", ev("miscellany.doc.raw('main!B6')"), "260000")
        t("the document name came back",
          ev("document.querySelector('.gr-docname').value"), "Q3 Revenue Model")
        print("\n  and the slide is LIVE, not a copy")
        t("the KPI recomputed on open",
          ev("miscellany.doc.value('deck:s1/kpi').d.toString()"), "55.9")
        t("the chart is bound to the range again",
          ev("miscellany.doc.value('deck:s1/chart').values.map(v=>v.d.toString()).join(',')"),
          "128400,141250,260000")
        # The real test of "live": edit AFTER opening. The expected figure is
        # read off the sheet rather than typed here — a hand-computed constant
        # in a test is one more thing that can be wrong, and has been.
        was = ev("miscellany.doc.value('deck:s1/kpi').d.toString()")
        ev("miscellany.doc.set('main!B6', '400000')")
        pg.wait_for_timeout(300)
        t("editing after opening still moves the slide",
          ev("miscellany.doc.value('deck:s1/kpi').d.toString()") != was, True)
        t("and the slide agrees with the cell it reads",
          ev("miscellany.doc.value('deck:s1/kpi').d.toString()"),
          ev("miscellany.doc.value('main!B9').d.toString()"))
        t("and the chart followed",
          ev("miscellany.doc.value('deck:s1/chart').values[2].d.toString()"), "400000")

        print("\n  a document from a newer build loses nothing")
        # an older build must not strip what a newer one wrote
        future = saved.with_name("future.grain")
        future.write_text(
            text.replace("miscellany/1", "miscellany/9").rstrip("\n")
            + '\n{"section":"comments","body":"from a later version"}\n',
            encoding="utf-8")
        ev("miscellany.shell.run('file.open.doc')")
        pg.wait_for_timeout(200)
        pg.set_input_files("input[type=file][accept='.grain']", str(future))
        pg.wait_for_timeout(900)
        t("it opened anyway", ev("miscellany.doc.raw('main!B6')"), "260000")
        t("and said what it kept",
          "kept untouched" in ev("document.querySelector('.gr-status').textContent"), True)
        with pg.expect_download(timeout=30000) as dl2:
            ev("miscellany.shell.run('file.save.doc')")
        rewritten = pathlib.Path(dl2.value.path()).read_text(encoding="utf-8")
        t("re-saving puts the unknown record back",
          '"section":"comments"' in rewritten, True)

        t("no console errors", errs or "none", "none")
        t("no external requests", external or "none", "none")
        pg.screenshot(path=str(OUT / "06-one-document.png"))
        b.close()
finally:
    srv.shutdown()

print()
if fails:
    for f in fails:
        print("  x " + f + "\n")
    sys.exit(1)
print("  all green\n")
