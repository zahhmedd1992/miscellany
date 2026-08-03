"""Proof of the one claim the architecture rests on.

Type a number into a spreadsheet cell. The slide next to it moves — its chart,
its KPI and its subtitle — with no synchronisation code anywhere, because the
slide's objects are nodes in the same graph and the scheduler already walks
dependents. The same walk that updates =SUM().

This drives the real UI with real keystrokes. It does not call into the graph;
if the claim only held through the API it would not be worth making.

Run: C:\\Python314\\python qa/live_update.py
"""

import http.server, socketserver, threading, functools, pathlib, sys, json

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 8791


def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "src"))
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    from patchright.sync_api import sync_playwright

    srv = serve()
    fails = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel="chrome", headless=True)
            pg = b.new_page(viewport={"width": 1600, "height": 900},
                            device_scale_factor=2)
            errs = []
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errs.append(str(e)))

            # An external request from a tool that promises your file never
            # leaves your machine is a broken promise, so it is a test.
            external = []
            pg.on("request", lambda r: None if "127.0.0.1" in r.url or r.url.startswith("data:")
                  else external.append(r.url))

            pg.goto(f"http://127.0.0.1:{PORT}/compose.html", wait_until="networkidle")
            pg.wait_for_timeout(400)

            cdp = pg.context.new_cdp_session(pg)

            def ev(expr):
                # The isolated world patchright evaluates in cannot see page
                # globals; the CDP main world can.
                r = cdp.send("Runtime.evaluate",
                             {"expression": expr, "returnByValue": True, "awaitPromise": True})
                if "exceptionDetails" in r:
                    raise RuntimeError(r["exceptionDetails"].get("text", "eval failed"))
                return r["result"].get("value")

            # ---- instruments -------------------------------------------
            # The first version of this test asserted only on the document and
            # passed with flying colours on a page whose grid and slide had
            # both gone blank. A stack overflow cannot report itself — there
            # is no stack left to run the handler on — so "no console errors"
            # proved nothing. These two read what a person would see.

            ev("""(() => {
              window.__paints = {deck: 0, grid: 0};
              for (const [o, k] of [[miscellany.deck,'deck'], [miscellany.grid,'grid']]) {
                const orig = o.draw.bind(o);
                o.draw = function (...a) { __paints[k]++; return orig(...a); };
              }
              return 1;
            })()""")

            def pixels(canvas_id, region=None):
                """Ink and accent-colour pixel counts for a canvas region."""
                r = region or "0,0,c.width,c.height"
                return json.loads(ev(f"""(() => {{
                  const c = document.querySelector('{canvas_id}');
                  const g = c.getContext('2d');
                  const d = g.getImageData({r}).data;
                  let ink = 0, accent = 0;
                  for (let i = 0; i < d.length; i += 4) {{
                    const R = d[i], G = d[i+1], B = d[i+2];
                    if (!(R > 232 && G > 228 && B > 222)) ink++;
                    // the bar colour #9A3B1B
                    if (R > 120 && R < 190 && G < 95 && B < 65) accent++;
                  }}
                  return JSON.stringify({{ink, accent}});
                }})()"""))

            def bars():
                """Height in pixels of each bar, measured off the canvas.

                Not a total: the y-axis rescales when a value grows, so the
                other bars get shorter and the total ink can FALL while the
                edited bar rises. Ratios between bars are what survive that.
                """
                return json.loads(ev("""(() => {
                  const c = document.querySelector('.deck-canvas');
                  const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                  const col = new Array(c.width).fill(0);
                  for (let y = 0; y < c.height; y++)
                    for (let x = 0; x < c.width; x++) {
                      const i = (y * c.width + x) * 4;
                      const R = d[i], G = d[i+1], B = d[i+2];
                      if (R > 120 && R < 190 && G < 95 && B < 65) col[x]++;
                    }
                  const runs = [];
                  let cur = null;
                  for (let x = 0; x < c.width; x++) {
                    if (col[x] > 4) { cur = cur || {a: x, h: 0}; cur.h = Math.max(cur.h, col[x]); }
                    else if (cur) { if (cur.h > 10) runs.push(cur.h); cur = null; }
                  }
                  if (cur && cur.h > 10) runs.push(cur.h);
                  return JSON.stringify(runs);
                })()"""))

            def read():
                return json.loads(ev("""JSON.stringify({
                  b6:   miscellany.doc.raw('main!B6'),
                  tot:  miscellany.doc.value('main!B7').d.toString(),
                  kpi:  miscellany.doc.value('deck:s1/kpi').d.toString(),
                  sub:  miscellany.doc.value('deck:s1/sub').s,
                  best: miscellany.doc.value('deck:s1/kpi2').s,
                  bars: miscellany.doc.value('deck:s1/chart').values.map(v=>v.d.toString()),
                  deps: [...miscellany.doc.nodes.get('main!B6').dependents]
                })"""))

            def shot(name):
                pg.screenshot(path=str(OUT / f"{name}.png"))

            before = read()
            px_before = {"grid": pixels('.sh-grid'), "slide": pixels('.deck-canvas')}
            bars_before = bars()
            ev("__paints.deck = 0; __paints.grid = 0")
            shot("01-before")

            # --- the edit: real keystrokes into the real grid ---------------
            # click cell B6 (September revenue) and type a new number
            box = pg.locator(".sh-grid").bounding_box()
            # grid geometry comes from the app itself, not from guessed pixels
            xy = ev("""(() => {
              const g = miscellany.grid;
              const x = g.colX(1) + g.width(1)/2, y = g.rowY(5) + 10;
              return JSON.stringify({x, y});
            })()""")
            xy = json.loads(xy)
            pg.mouse.click(box["x"] + xy["x"], box["y"] + xy["y"])
            pg.wait_for_timeout(120)
            pg.keyboard.type("260000")
            pg.keyboard.press("Enter")
            pg.wait_for_timeout(400)

            after = read()
            px_after = {"grid": pixels('.sh-grid'), "slide": pixels('.deck-canvas')}
            bars_after = bars()
            paints = json.loads(ev("JSON.stringify(__paints)"))
            shot("02-after")

            # --- what must have happened ------------------------------------
            def t(name, got, want):
                ok = str(got) == str(want)
                if not ok:
                    fails.append(f"{name}\n      want: {want}\n      got : {got}")
                print(("  ok   " if ok else "  FAIL ") + name.ljust(46) + str(got))

            print("\n  the sheet")
            t("B6 took the keystrokes", after["b6"], "260000")
            t("total recalculated", after["tot"], "529650")

            print("\n  the slide — nobody told it")
            t("chart's last bar followed", after["bars"][2], "260000")
            t("chart's other bars did not move", after["bars"][:2], before["bars"][:2])
            t("KPI recomputed", after["kpi"] != before["kpi"], "True")
            t("subtitle recomputed", after["sub"], "Total revenue $529,650 across 3 months")
            t("best month flipped to September", after["best"], "September")

            print("\n  why it happened")
            # Exactly the objects whose formulas name B6 — the chart's range
            # and the subtitle's COUNT(). Read from the graph, not from a list
            # someone has to remember to update.
            deck_deps = sorted(d for d in after["deps"] if d.startswith("deck:"))
            t("slide objects are dependents of B6", deck_deps,
              ["deck:s1/chart", "deck:s1/sub"])
            t("the KPI is NOT — it depends on B9", "deck:s1/kpi" in deck_deps, "False")
            t("no console errors", errs or "none", "none")
            t("no external requests", external or "none", "none")

            # The subtitle proves TEXT() now reaches the format engine, and the
            # KPI proves a quoted % is decoration rather than a scaler.
            print("\n  the two core bugs this view found")
            t("TEXT() reaches numfmt", "$529,650" in after["sub"], "True")
            # Formatted through the object's OWN numFmt, compared against the
            # cell it reads. If the quoted % still scaled, this reads 100x high.
            kpi = json.loads(ev("""(async () => {
              const m = await import('/core/numfmt.js');
              const n = miscellany.doc.nodes.get('deck:s1/kpi');
              return JSON.stringify({
                shown: m.formatValue(n.value, n.meta.object.numFmt).text,
                cell:  miscellany.doc.value('main!B9').d.toString(),
              });
            })()"""))
            t('slide KPI equals cell B9', kpi["shown"], kpi["cell"] + "%")
            t('0.0"%" is decoration, not a scaler', float(kpi["shown"][:-1]) < 100, "True")

            # ---- and what a person actually sees ---------------------------
            print("\n  on screen")
            # A canvas drawn through a stale backing store looks fine in a
            # screenshot thumbnail and is wrong by a factor of two: mounting
            # the second pane halved the first one's width with no window
            # resize event, so the grid kept a 3200px store in an 800px box
            # and drew every column at half scale.
            for sel in ('.sh-grid', '.deck-canvas'):
                scale = json.loads(ev(f"""(() => {{
                  const c = document.querySelector('{sel}');
                  const r = c.getBoundingClientRect();
                  return JSON.stringify({{ratio: c.width / r.width, dpr: devicePixelRatio}});
                }})()"""))
                t(f"{sel} backing store matches its box",
                  abs(scale["ratio"] - scale["dpr"]) < 0.02, "True")
                # ...and the box has to fill its pane. Checking only the
                # backing store passes happily on a canvas that is half the
                # height it should be, which is exactly what happened: a
                # canvas is a replaced element, so height:auto took an
                # intrinsic 2:1 ratio instead of stretching.
                fill = json.loads(ev(f"""(() => {{
                  const c = document.querySelector('{sel}');
                  const p = c.closest('.gr-pane-body').getBoundingClientRect();
                  const r = c.getBoundingClientRect();
                  return JSON.stringify({{w: r.width / p.width, h: r.height / p.height}});
                }})()"""))
                t(f"{sel} fills its pane", fill["w"] > 0.98 and fill["h"] > 0.5, "True")
            # Painting must not mutate the document: if it does, drawing
            # re-enters drawing. Two apps, one edit — a handful of repaints,
            # not hundreds.
            t("grid repainted, a bounded number of times",
              1 <= paints["grid"] <= 6, "True")
            t("slide repainted, a bounded number of times",
              1 <= paints["deck"] <= 6, "True")
            t("grid still has ink on it", px_after["grid"]["ink"] > 20000, "True")
            t("slide still has ink on it", px_after["slide"]["ink"] > 20000, "True")
            t("grid is as full as before",
              px_after["grid"]["ink"] > px_before["grid"]["ink"] * 0.8, "True")
            t("three bars, before and after", [len(bars_before), len(bars_after)], [3, 3])
            # September was 1.21x July's height; at 260,000 it must be ~2.02x.
            # A ratio, because the axis rescales underneath both.
            r0 = bars_before[2] / bars_before[0]
            r1 = bars_after[2] / bars_after[0]
            t("September's bar grew against July's", round(r1 / r0, 2) > 1.5, "True")
            t("it grew by the right amount",
              abs(r1 - (260000 / 128400)) < 0.06, "True")
            print()
            print(f"       repaints  grid={paints['grid']} slide={paints['deck']}"
                  f"   bar px {bars_before} -> {bars_after}"
                  f"   Sep/Jul {r0:.2f} -> {r1:.2f} (want {260000/128400:.2f})")

            b.close()
    finally:
        srv.shutdown()

    print()
    if fails:
        for f in fails:
            print("  x " + f + "\n")
        sys.exit(1)
    print(f"  all green — screenshots in {OUT}\n")


if __name__ == "__main__":
    main()
