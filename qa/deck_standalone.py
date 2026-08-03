"""Deck on its own, driven like a person would drive it.

The claim being tested is not "the page loads" — it is that a second app got
undo, a command palette, a keyboard map, a toolbar and a status bar without
writing any of them, because the shell is real.
"""
import http.server, socketserver, threading, functools, pathlib, sys, json

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 8793

h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "src"))
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails = []


def t(name, got, want):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(48) + str(got)[:70])


try:
    from patchright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport={"width": 1500, "height": 880}, device_scale_factor=2)
        errs, external = [], []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("request", lambda r: None if "127.0.0.1" in r.url or r.url.startswith("data:")
              else external.append(r.url))

        pg.goto(f"http://127.0.0.1:{PORT}/deck.html", wait_until="networkidle")
        pg.wait_for_timeout(400)
        cdp = pg.context.new_cdp_session(pg)

        def ev(x):
            r = cdp.send("Runtime.evaluate", {"expression": x, "returnByValue": True})
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"])[:400])
            return r["result"].get("value")

        # start from a known state rather than whatever a previous run stored
        ev("localStorage.clear(); miscellany.shell.run('file.new')")
        pg.wait_for_timeout(150)

        print("\n  the shell gave Deck its chrome, unwritten by Deck")
        t("toolbar rendered from the registry",
          ev("document.querySelectorAll('.gr-tool').length > 4"), True)
        t("status bar present", ev("!!document.querySelector('.gr-status')"), True)
        t("palette present", ev("!!document.querySelector('.gr-palette')"), True)
        # the shell contributed these three; Deck never defined them
        t("undo/redo/new came from the shell",
          ev("['edit.undo','edit.redo','file.new'].every(i => !!miscellany.shell.reg.get(i))"), True)
        t("Deck's own commands are all registered",
          ev("miscellany.shell.reg.all().filter(c => c.id.startsWith('deck.')).length"), 14)

        # --- drive it: add a slide, add a text box, type into it ------------
        pg.wait_for_timeout(100)
        ev("miscellany.shell.run('deck.slide.add')")
        pg.wait_for_timeout(120)
        t("a slide was added", ev("miscellany.shell.surface.view.slides"), 2)

        ev("miscellany.shell.run('deck.text.add', {text: '=1+1'})")
        pg.wait_for_timeout(150)
        sel = ev("miscellany.shell.surface.view.sel")
        t("a text box was added and selected", bool(sel), True)
        t("its formula evaluated",
          ev(f"String(miscellany.doc.value({json.dumps(sel)}).d.toNumber())"), "2")

        # --- undo, which Deck never implemented ----------------------------
        before = ev("miscellany.shell.undoStack.length")
        t("the write was journalled automatically", before >= 2, True)
        ev("miscellany.shell.run('edit.undo')")
        pg.wait_for_timeout(150)
        t("undo removed the text box",
          ev(f"miscellany.doc.raw({json.dumps(sel)})"), "")
        ev("miscellany.shell.run('edit.redo')")
        pg.wait_for_timeout(150)
        t("redo put it back",
          ev(f"miscellany.doc.raw({json.dumps(sel)})"), "=1+1")

        # --- formatting is undoable too ------------------------------------
        # node.meta changes (font size here, bold on a cell in Sheet) never
        # reached the journal, so Undo silently reverted the change BEFORE the
        # one you meant. Both apps had it; neither failed loudly.
        size0 = ev(f"miscellany.doc.node({json.dumps(sel)}).meta.object.size")
        ev("miscellany.shell.run('deck.text.bigger')")
        pg.wait_for_timeout(120)
        t("font size grew",
          ev(f"miscellany.doc.node({json.dumps(sel)}).meta.object.size"), size0 + 6)
        ev("miscellany.shell.run('edit.undo')")
        pg.wait_for_timeout(120)
        t("undo reverts formatting, not the edit before it",
          ev(f"miscellany.doc.node({json.dumps(sel)}).meta.object.size"), size0)
        t("and the value it should not have touched is intact",
          ev(f"miscellany.doc.raw({json.dumps(sel)})"), "=1+1")

        # --- the palette, by keyboard --------------------------------------
        pg.keyboard.press("Control+k")
        pg.wait_for_timeout(200)
        t("Ctrl+K opened the palette",
          ev("document.querySelector('.gr-palette').classList.contains('on')"), True)
        pg.keyboard.type("chart")
        pg.wait_for_timeout(200)
        t("search ranks the chart command first",
          ev("document.querySelector('.gr-plist li .pt').textContent"), "Chart")
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(120)

        # --- capabilities are enforced, not decorative ---------------------
        denied = ev("""(() => {
          const s = miscellany.shell;
          s.revoke('doc.write');
          try { s.run('deck.slide.add'); return 'ALLOWED'; }
          catch (e) { return e.message; }
          finally { s.grant('doc.write'); }
        })()""")
        t("a revoked capability blocks the command",
          "capability denied: doc.write" in str(denied), True)
        t("and it is restored afterwards",
          ev("miscellany.shell.granted.has('doc.write')"), True)

        # --- it draws -------------------------------------------------------
        ink = ev("""(() => {
          const c = document.querySelector('.deck-canvas');
          const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4)
            if (!(d[i] > 232 && d[i+1] > 228 && d[i+2] > 222)) n++;
          return n;
        })()""")
        t("the slide actually has ink on it", ink > 15000, True)
        t("no console errors", errs or "none", "none")
        t("no external requests", external or "none", "none")

        pg.screenshot(path=str(OUT / "03-deck-standalone.png"))
        b.close()
finally:
    srv.shutdown()

print()
if fails:
    for f in fails:
        print("  x " + f + "\n")
    sys.exit(1)
print(f"  all green — {OUT / '03-deck-standalone.png'}\n")
