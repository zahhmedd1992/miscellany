"""The red-team findings that only exist in the running app.

Each check is named after the defect, and each was reproduced by an
adversarial reviewer against a green suite. Re-verified here against the
live app so a regression is visible.

Run: python qa/doc_redteam_qa.py
"""
import functools, http.server, pathlib, socketserver, sys, threading, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 9394

fails = []


def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(60) + str(got)[:48])


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def main():
    handler = functools.partial(Quiet, directory=str(ROOT / "src"))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    time.sleep(0.4)

    from patchright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport={"width": 1400, "height": 950})
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.goto(f"http://127.0.0.1:{PORT}/doc.html", wait_until="load")
        pg.wait_for_timeout(1200)
        cdp = pg.context.new_cdp_session(pg)

        def ev(expr):
            r = cdp.send("Runtime.evaluate",
                         {"expression": expr, "returnByValue": True, "awaitPromise": True})
            if "exceptionDetails" in r:
                return "THREW: " + str(r["exceptionDetails"].get("text"))
            return r["result"].get("value")

        # ---- 3. deleting a paragraph must not leave an empty one ----------
        t("deleting paragraphs leaves no blank line behind", ev("""(async()=>{
          const M = await import('./apps/doc/model.js');
          const {doc, shell} = miscellany; const v = miscellany.view;
          shell.run('file.new');
          let k = M.FIRST_KEY;
          const ids = [];
          for (const s of ['Introduction','One','Two','Three','Four']) {
            const id = M.bodyId(k); M.setPara(doc, id, s, undefined, {});
            ids.push(id); k = M.keyBetween(k, null);
          }
          v.dirty = true; v.relayout();
          // select paragraphs 1..3 and type over them
          v.anchor = {id: ids[1], off: 0};
          v.caret  = {id: ids[3], off: 5};
          v.insertText('X');
          v.relayout();
          const texts = v.blocks.filter(b=>b.kind==='para').map(b=>b.text);
          return JSON.stringify(texts);
        })()"""), '["Introduction","X","Four"]')

        t("backspacing into the previous paragraph leaves none either", ev("""(async()=>{
          const M = await import('./apps/doc/model.js');
          const {doc, shell} = miscellany; const v = miscellany.view;
          shell.run('file.new');
          let k = M.FIRST_KEY; const ids = [];
          for (const s of ['Alpha','Beta','Gamma']) {
            const id = M.bodyId(k); M.setPara(doc, id, s, undefined, {});
            ids.push(id); k = M.keyBetween(k, null);
          }
          v.dirty = true; v.relayout();
          v.caret = {id: ids[1], off: 0}; v.anchor = null;
          v.backspace();
          return JSON.stringify(v.blocks.filter(b=>b.kind==='para').map(b=>b.text));
        })()"""), '["AlphaBeta","Gamma"]')

        # ---- 6 + 7. table cells ------------------------------------------
        cell = ev("""(async()=>{
          const {doc, shell} = miscellany; const v = miscellany.view;
          shell.run('file.new');
          v.relayout();
          shell.run('doc.table', {rows: 2, cols: 2});
          v.relayout();
          const M = await import('./apps/doc/model.js');
          const tid = M.blockIds(doc).find(id => {
            const n = doc.nodes.get(id); return n && n.meta && n.meta.block;
          });
          const cid = tid + '/r0c0';
          // 6: Enter inside a cell
          v.caret = {id: cid, off: 6}; v.anchor = null;
          let threw = null;
          try { v.host.batch(()=>v.splitParagraph()); v.after(); }
          catch(e) { threw = e.message; }
          const afterEnter = doc.raw(cid);
          // 7: type over a selection inside a cell
          v.caret = {id: cid, off: 0}; v.anchor = null;
          const p = doc.raw(cid);
          v.anchor = {id: cid, off: 0}; v.caret = {id: cid, off: p.length};
          v.insertText('Z');
          return {threw, afterEnter, afterType: doc.raw(cid)};
        })()""")
        t("Enter inside a table cell does not throw",
          isinstance(cell, dict) and cell.get("threw"), None)
        t("and it breaks the line inside the cell",
          isinstance(cell, dict) and len(cell.get("afterEnter", "")) > len("Column 1"), True)
        t("typing over a selection in a cell replaces it",
          isinstance(cell, dict) and cell.get("afterType"), "Z")

        # ---- 5. find and replace reaches into tables -----------------------
        t("replace reaches table cells and reports the truth", ev("""(async()=>{
          const {doc, shell} = miscellany; const v = miscellany.view;
          const M = await import('./apps/doc/model.js');
          shell.run('file.new'); v.relayout();
          let k = M.FIRST_KEY;
          const id0 = M.bodyId(k); M.setPara(doc, id0, 'Results for Q2 are below.', undefined, {});
          v.caret = {id: id0, off: 0}; v.relayout();
          shell.run('doc.table', {rows: 1, cols: 2});
          v.relayout();
          const tid = M.blockIds(doc).find(id => {
            const n = doc.nodes.get(id); return n && n.meta && n.meta.block;
          });
          M.setPara(doc, tid + '/r0c0', 'Q2 revenue', undefined, {});
          M.setPara(doc, tid + '/r0c1', 'Q2 margin', undefined, {});
          v.dirty = true; v.relayout();
          const n = v.replaceAll('Q2', 'Q3');
          v.relayout();
          return {replaced: n, left: v.findNext('Q2'),
                  cells: [doc.raw(tid+'/r0c0'), doc.raw(tid+'/r0c1')]};
        })()"""), "{'replaced': 3, 'left': False, 'cells': ['Q3 revenue', 'Q3 margin']}")

        # ---- 14. deleting a live figure must take its node with it --------
        t("deleting a live figure removes its formula node", ev("""(async()=>{
          const M = await import('./apps/doc/model.js');
          const {doc, shell} = miscellany; const v = miscellany.view;
          shell.run('file.new'); v.relayout();
          const id = M.blockIds(doc)[0];
          v.caret = {id, off: 0}; v.anchor = null;
          v.insertText('AB');
          v.caret = {id, off: 1};
          shell.run('doc.field.insert', {formula: '=1+1', format: ''});
          v.relayout();
          /* "Removed" means holds no input, no meta and no dependencies —
           * the same definition the file format uses. Graph.set never deletes
           * a node from the map; what matters is that the field stops
           * carrying a formula, stops being recalculated, and stops being
           * written into the saved file. */
          const live = () => [...doc.nodes.entries()].filter(
            ([x, n]) => x.indexOf('/f') > 0 && (n.raw !== '' || n.meta || n.deps.size)
          ).length;
          const before = live();
          v.backspace();          // the caret is just after the field
          v.relayout();
          return {before, after: live()};
        })()"""), "{'before': 1, 'after': 0}")

        # ---- 10. undo coalescing must stop at a caret move ----------------
        t("moving the caret ends the undo run", ev("""(async()=>{
          const M = await import('./apps/doc/model.js');
          const {doc, shell} = miscellany; const v = miscellany.view;
          shell.run('file.new'); v.relayout();
          const id = M.blockIds(doc)[0];
          v.caret = {id, off: 0}; v.anchor = null;
          v.insertText('Dear Ms Whitfield,');
          v.caret = {id, off: 0};              // a click, in the same paragraph
          v.insertText('XX');
          const full = doc.raw(id);
          shell.run('edit.undo');
          return {full, afterOneUndo: doc.raw(id)};
        })()"""), "{'full': 'XXDear Ms Whitfield,', 'afterOneUndo': 'Dear Ms Whitfield,'}")

        # ---- 9. typing must not cost the whole document -------------------
        perf = ev("""(async()=>{
          const M = await import('./apps/doc/model.js');
          const {doc, shell} = miscellany; const v = miscellany.view;
          const out = [];
          for (const n of [50, 400, 1200]) {
            shell.run('file.new');
            let k = M.FIRST_KEY;
            const nodes = {};
            for (let i=0;i<n;i++){
              nodes['doc:body/p'+k] = {r:'Paragraph '+i+'. '+'word '.repeat(30), m:{para:{p:{}}}};
              k = M.keyBetween(k, null);
            }
            doc.loadJSON(nodes);
            v._lineCache.clear();
            v.dirty = true; v.relayout();
            const id = M.blockIds(doc)[0];
            v.caret = {id, off: 0}; v.anchor = null;
            const t0 = performance.now();
            for (let i=0;i<12;i++) v.insertText('a');
            out.push({n, pages: v.pages.length, ms: +((performance.now()-t0)/12).toFixed(1)});
          }
          return out;
        })()""")
        print("     typing cost:", perf)
        if isinstance(perf, list) and perf:
            biggest = perf[-1]
            per_page = biggest["ms"] / max(1, biggest["pages"])
            t(f"a keystroke stays responsive at {biggest['pages']} pages "
              f"({biggest['ms']} ms)", biggest["ms"] < 40, True)
            # Stated as what is true rather than as what would be nice: line
            # breaking is cached per paragraph, so a keystroke re-breaks one -
            # but PLACEMENT still walks every paragraph, so the cost is still
            # linear in document length, about eight times smaller than it was.
            t(f"and the cost per page is small ({per_page:.2f} ms/page)",
              per_page < 0.7, True)

        t("no page errors throughout", [e for e in errs if "favicon" not in e], [])
        b.close()
    httpd.shutdown()

    print()
    if fails:
        print(f"  {len(fails)} FAILED")
        for f in fails:
            print("   x " + f)
        sys.exit(1)
    print("  red-team regressions in the live app: all green")


main()
