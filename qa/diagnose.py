"""Why does one keystroke blank both views? Evidence, not theory."""
import http.server, socketserver, threading, functools, pathlib, json

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = 8792
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "src"))
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()

from patchright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    pg = b.new_page(viewport={"width": 1600, "height": 900})
    logs = []
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    pg.goto(f"http://127.0.0.1:{PORT}/compose.html", wait_until="networkidle")
    pg.wait_for_timeout(300)
    cdp = pg.context.new_cdp_session(pg)

    def ev(x):
        r = cdp.send("Runtime.evaluate", {"expression": x, "returnByValue": True})
        if "exceptionDetails" in r:
            return {"THREW": r["exceptionDetails"].get("text"),
                    "detail": str(r["exceptionDetails"].get("exception", {}).get("description", ""))[:600]}
        return r["result"].get("value")

    # instrument: count draws, record the deepest re-entry and any throw
    print(ev("""(() => {
      const M = miscellany;
      window.__d = {deck:0, grid:0, depth:0, max:0, sets:[], threw:null};
      const wrap = (obj, key, tag) => {
        const orig = obj[key].bind(obj);
        obj[key] = function(...a) {
          __d[tag]++; __d.depth++; __d.max = Math.max(__d.max, __d.depth);
          try { return orig(...a); }
          catch (e) { __d.threw = __d.threw || (tag + ': ' + (e && e.stack || e)); throw e; }
          finally { __d.depth--; }
        };
      };
      wrap(M.deck, 'draw', 'deck');
      wrap(M.grid, 'draw', 'grid');
      const s = M.doc.set.bind(M.doc);
      M.doc.set = function(id, raw, ctx) {
        if (__d.depth > 0) __d.sets.push(id + ' @depth' + __d.depth);
        return s(id, raw, ctx);
      };
      return 'instrumented';
    })()"""))

    print(ev("""(() => {
      try { miscellany.doc.set('main!B6', '260000'); return 'edit ok'; }
      catch (e) { return 'edit THREW: ' + (e && e.message); }
    })()"""))

    print(json.dumps(ev("""JSON.stringify({
      draws_deck: __d.deck, draws_grid: __d.grid, max_depth: __d.max,
      sets_during_draw: __d.sets.slice(0, 8),
      total_sets_during_draw: __d.sets.length,
      threw: __d.threw ? __d.threw.split('\\n').slice(0,3).join(' | ') : null,
      nodes: miscellany.doc.nodes.size,
      probe_still_there: miscellany.doc.nodes.has('__chartprobe__!A1'),
      grid_paints: typeof miscellany.grid.draw,
    })"""), indent=2))

    print("\nconsole:")
    for l in logs[:15]:
        print("  " + l[:220])
    b.close()
srv.shutdown()
