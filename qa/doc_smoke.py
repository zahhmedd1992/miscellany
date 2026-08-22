"""Doc in a real browser.

A canvas app cannot be checked by asserting on the DOM: there is no element
per paragraph, so every text assertion passes on a blank page. What is
checked here is what a person would check by looking - that the page painted,
that typing changes it, that a formula in a sentence shows a number, and that
the PDF the browser downloads opens.

Run: python qa/doc_smoke.py           (serves src/ itself)
"""
import http.server, functools, pathlib, socketserver, sys, threading, time, zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 9391

fails = []
def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(58) + str(got)[:60])


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(Quiet, directory=str(ROOT / "src"))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    httpd = serve()
    time.sleep(0.4)
    from patchright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport={"width": 1440, "height": 950})
        errs, ext = [], []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda x: errs.append(str(x)))
        pg.on("request", lambda r: None if r.url.startswith(
            ("http://127.0.0.1", "file:", "data:", "blob:")) else ext.append(r.url))

        pg.goto(f"http://127.0.0.1:{PORT}/doc.html", wait_until="load")
        pg.wait_for_timeout(1200)
        cdp = pg.context.new_cdp_session(pg)

        def ev(expr):
            r = cdp.send("Runtime.evaluate",
                         {"expression": expr, "returnByValue": True, "awaitPromise": True})
            if "exceptionDetails" in r:
                return "THREW: " + str(r["exceptionDetails"].get("text"))
            return r["result"].get("value")

        # 1. it painted
        t("canvas is sized to the pane", ev(
            "(()=>{const c=document.querySelector('.doc-canvas');return !!c&&c.width>600;})()"))
        t("pages were laid out", ev("miscellany.view.pages.length>=1"))
        t("the first-run document has paragraphs", ev("miscellany.view.blocks.length>=6"))

        # a page of paper has to be visibly WHITE against the desk, and the
        # text has to be visibly dark. A signature over the bitmap catches a
        # stylesheet that failed to load, which no text assertion can see.
        t("the paper is painted", ev("""(()=>{
          const c=document.querySelector('.doc-canvas');
          const g=c.getContext('2d');
          const d=g.getImageData(0,0,c.width,c.height).data;
          let white=0,dark=0;
          for(let i=0;i<d.length;i+=4){
            if(d[i]>245&&d[i+1]>245&&d[i+2]>240) white++;
            else if(d[i]<90&&d[i+1]<90&&d[i+2]<90) dark++;
          }
          return white>40000 && dark>300;
        })()"""))

        # 1b. THE CHECK THAT CATCHES A UNIT BUG.
        #
        # Every gate below passed while the page was unreadable: the canvas
        # font was set in `pt` inside a context already scaled to points, so
        # every word painted a third too large and overlapped the next. Layout
        # was right, the page count was right, the PDF was right - only the
        # picture was wrong, and nothing that reads the model can see that.
        #
        # Two independent ways of catching it, because one of them is cheap
        # and the other is what a person actually sees.
        t("the canvas agrees with our width table", ev("""(async()=>{
          const R = await import('./core/text/render.js');
          const M = await import('./core/text/metrics.js');
          const g = document.createElement('canvas').getContext('2d');
          g.font = R.cssFont('Times-Roman', 100);
          const painted = g.measureText('Hello world').width;
          const ours = M.textWidth('Times-Roman','Hello world',100);
          return Math.abs(painted - ours) / ours < 0.04;
        })()"""))

        t("no ink lands right of where layout put the last word", ev("""(()=>{
          const v = miscellany.view;
          let right = 0;
          for (const it of v.pages[0].items)
            if (it.t === 'text' && !it.chrome) right = Math.max(right, it.x + it.w0 || it.x);
          // recompute the true extent from the metrics rather than trusting a
          // field the renderer might not set
          right = 0;
          for (const it of v.pages[0].items) {
            if (it.t !== 'text' || it.chrome) continue;
            const w = (window.__tw || (window.__tw = null));
            right = Math.max(right, it.x + it.s.length * it.size);  // generous bound
          }
          const c = document.querySelector('.doc-canvas');
          const g = c.getContext('2d');
          const dpr = v.dpr || 1, z = v.zoom, pad = v.padX || 0;
          const limit = Math.round((pad + v.content.x + v.content.w + 3) * z * dpr);
          if (limit >= c.width) return true;                 // page wider than the view
          const d = g.getImageData(limit, 0, c.width - limit, c.height).data;
          let dark = 0;
          for (let i = 0; i < d.length; i += 4)
            if (d[i] < 120 && d[i+1] < 120 && d[i+2] < 120) dark++;
          return dark === 0;
        })()"""))

        # 2. the live figure actually resolved
        t("the live figure shows a computed number", ev("""(()=>{
          const v=miscellany.view;
          for(const p of v.pages) for(const it of p.items)
            if(it.t==='text' && /66\\.7%/.test(it.s)) return true;
          return false;
        })()"""))

        # 3. typing
        pg.click(".doc-canvas", position={"x": 300, "y": 120})
        pg.wait_for_timeout(150)
        before = ev("miscellany.view.blocks.map(b=>b.text||'').join('|').length")
        pg.keyboard.type("Hello Doc")
        pg.wait_for_timeout(350)
        t("typing reaches the document", ev(
            "miscellany.view.blocks.some(b=>(b.text||'').includes('Hello Doc'))"))
        t("and the document grew by exactly what was typed", ev(
            f"miscellany.view.blocks.map(b=>b.text||'').join('|').length - {before}"), 9)

        # 4. the shell's keyboard still reaches Doc (the trap the plan called
        #    out), and ONE Ctrl+Z undoes the whole run of typing.
        #
        #    The first version of this assertion only checked that the exact
        #    string "Hello Doc" was gone - and it passed while "Hello Do" was
        #    still on the page, because undo was one step per keystroke. An
        #    assertion that a partial undo satisfies is not an assertion.
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(300)
        t("one Ctrl+Z undoes the whole run of typing", ev(
            f"miscellany.view.blocks.map(b=>b.text||'').join('|').length"), before)
        t("and no trace of it is left", ev(
            "!/Hello|Doc$/.test(miscellany.view.blocks.map(b=>b.text||'').join(''))"
            .replace('Doc$', 'Hell')))
        pg.keyboard.press("Control+k")
        pg.wait_for_timeout(250)
        t("Ctrl+K opens the palette from inside the text pipe", ev(
            "document.querySelector('.gr-palette').classList.contains('on')"))
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(200)

        # 5. bold via the projected keymap.
        #    Sheet, Deck and Doc all declare Mod+B and all three are right;
        #    the shell scopes the map to the focused pane. Before that, the
        #    last app registered silently owned the key for the whole product.
        pg.click(".doc-canvas", position={"x": 300, "y": 120})
        pg.wait_for_timeout(120)
        t("Ctrl+B is scoped to the focused app",
          ev("miscellany.shell.keymap.get('b+mod')"), "doc.bold")
        ev("miscellany.view.selectAll()")
        pg.keyboard.press("Control+b")
        pg.wait_for_timeout(300)
        t("Ctrl+B bolds the selection", ev("""(()=>{
          const v=miscellany.view;
          return v.blocks.some(b=>(b.runs||[]).some(r=>r.b));
        })()"""))
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(250)

        # 6. blank paragraphs survive a save/reload cycle.
        #    docfile.serialise() drops any node whose input is empty AND whose
        #    meta is null - and an empty paragraph is exactly that. If Doc ever
        #    stops writing meta on every paragraph, every blank line in every
        #    saved document silently disappears.
        blanks = ev("""(async()=>{
          const {doc, shell}=miscellany;
          const df = await import('./core/docfile.js');
          const M  = await import('./apps/doc/model.js');
          const v  = miscellany.view;
          const last = M.blockIds(doc).slice(-1)[0];
          let k = M.keyOf(last), made = 0;
          for (let i=0;i<3;i++){ k = M.keyBetween(k,null);
            M.setPara(doc, M.bodyId(k), '', undefined, {}); made++; }
          const before = M.blockIds(doc).length;
          const text = df.serialise(doc.toJSON(), {name:'t'}, []);
          const back = df.parse(text);
          doc.loadJSON(back.nodes);
          const after = M.blockIds(doc).length;
          v.dirty = true; v.relayout();
          return {before, after, made, kept: before===after};
        })()""")
        t("blank paragraphs survive save and reload",
          isinstance(blanks, dict) and blanks.get("kept") and blanks.get("made") == 3,
          True)

        # 7. a PDF really comes out, and it is a PDF
        pdf = ev("""(async()=>{
          const {renderPdf}=await import('./apps/doc/pdfout.js');
          const bytes=renderPdf(miscellany.view,{title:'qa'});
          let head=''; for(let i=0;i<8;i++) head+=String.fromCharCode(bytes[i]);
          let tail=''; for(let i=bytes.length-8;i<bytes.length;i++) tail+=String.fromCharCode(bytes[i]);
          return {head, tail: tail.trim(), len: bytes.length,
                  pages: miscellany.view.pages.length};
        })()""")
        t("PDF export produces a PDF", isinstance(pdf, dict) and pdf.get("head", "").startswith("%PDF-"),
          True)
        if isinstance(pdf, dict):
            t("PDF ends with %%EOF", pdf.get("tail", "").endswith("%%EOF"))
            t("PDF is not empty", pdf.get("len", 0) > 3000, True)

        pg.screenshot(path=str(OUT / "doc-01-firstrun.png"))

        # 8. Sheet beside Doc, and a field that reads from it
        ev("miscellany.shell.setLayout(['doc','sheet'])")
        pg.wait_for_timeout(600)
        pg.screenshot(path=str(OUT / "doc-02-with-sheet.png"))
        t("both panes mounted", ev("miscellany.shell.surfaces.size"), 2)

        live = ev("""(()=>{
          const {doc, shell}=miscellany;
          doc.set('main!B4','1000'); doc.set('main!B5','2000'); doc.set('main!B6','3000');
          const v=shell.surfaces.get('doc').view;
          v.caret={id:v.blocks[1].id, off:0};
          shell.run('doc.field.insert',{formula:'=SUM(main!B4:B6)', format:'#,##0'});
          const shown=()=>{
            for(const p of v.pages) for(const it of p.items)
              if(it.t==='text' && it.s.includes('6,000')) return true;
            return false;
          };
          const first=shown();
          doc.set('main!B4','4000');
          v.relayout();
          let after=false;
          for(const p of v.pages) for(const it of p.items)
            if(it.t==='text' && it.s.includes('9,000')) after=true;
          return {first, after};
        })()""")
        t("a live figure in a sentence shows the sheet's total",
          isinstance(live, dict) and live.get("first"), True)
        t("and changes when the cell changes",
          isinstance(live, dict) and live.get("after"), True)
        pg.wait_for_timeout(300)
        pg.screenshot(path=str(OUT / "doc-03-live-figure.png"))

        # 9. compose: three apps, one document
        pg.goto(f"http://127.0.0.1:{PORT}/compose.html", wait_until="load")
        pg.wait_for_timeout(1400)
        cdp = pg.context.new_cdp_session(pg)
        t("compose mounts three apps", ev("miscellany.shell.apps.size"), 3)
        ev("miscellany.shell.setLayout(['sheet','doc'])")
        pg.wait_for_timeout(700)
        pg.screenshot(path=str(OUT / "doc-04-compose.png"))

        t("no console errors", [e for e in errs if "favicon" not in e], [])
        t("nothing left the machine", ext, [])
        b.close()
    httpd.shutdown()

    print()
    if fails:
        print(f"  {len(fails)} FAILED")
        for f in fails:
            print("   x " + f)
        sys.exit(1)
    print("  doc smoke: all green")


main()
