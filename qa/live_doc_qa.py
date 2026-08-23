"""The live site, in a real browser.

curl has returned 200 for every entry point on this site while all three apps
were broken — Cloudflare Pages 308-redirects `/x.html` and the edge held
responses from before those paths existed. So this loads the real URLs and
reads the console, and it clicks the real download button and opens the saved
file off the disk, because that is the only check that has ever caught the
beacon the edge splices into HTML responses.

Run: python qa/live_doc_qa.py
"""
import pathlib, sys, tempfile

OUT = pathlib.Path(__file__).resolve().parent / "out"
OUT.mkdir(parents=True, exist_ok=True)
SITE = "https://miscellany.io"

fails = []


def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(56) + str(got)[:52])


def main():
    from patchright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)

        # ---- the front door ------------------------------------------------
        pg = b.new_page(viewport={"width": 1400, "height": 1000})
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.goto(SITE, wait_until="load")
        pg.wait_for_timeout(900)
        t("the tally says 9", pg.inner_text('b[data-tally="tools"]'), "9")
        names = pg.eval_on_selector_all("section h2", "els => els.map(e => e.textContent)")
        t("Doc is listed", "Doc" in names, True)
        t("in the order the page intends",
          ",".join(names), "Sheet,Deck,Doc,PDF,Passwords,QR,Verify,Encrypt,Loan")
        pg.screenshot(path=str(OUT / "live-01-frontdoor.png"), full_page=True)

        # ---- the app -------------------------------------------------------
        pg2 = b.new_page(viewport={"width": 1400, "height": 950})
        e2, ext = [], []
        pg2.on("pageerror", lambda x: e2.append(str(x)))
        pg2.on("console", lambda m: e2.append(m.text) if m.type == "error" else None)
        pg2.on("request", lambda r: None if r.url.startswith((SITE, "data:", "blob:"))
               else ext.append(r.url))
        pg2.goto(f"{SITE}/app/doc.html", wait_until="load")
        pg2.wait_for_timeout(1800)
        cdp = pg2.context.new_cdp_session(pg2)

        def ev(expr):
            r = cdp.send("Runtime.evaluate",
                         {"expression": expr, "returnByValue": True, "awaitPromise": True})
            if "exceptionDetails" in r:
                return "THREW: " + str(r["exceptionDetails"].get("text"))
            return r["result"].get("value")

        t("Doc boots on the live site", ev("!!window.miscellany && miscellany.view.pages.length >= 1"))
        t("and paints its page", ev(
            "(()=>{const c=document.querySelector('.doc-canvas');return !!c&&c.width>600;})()"))
        t("the live figure resolves", ev("""(()=>{
          for (const p of miscellany.view.pages) for (const it of p.items)
            if (it.t === 'text' && /66\\.7%/.test(it.s)) return true;
          return false;
        })()"""))
        pg2.screenshot(path=str(OUT / "live-02-doc.png"))

        real = [x for x in e2 if "cloudflareinsights" not in x and "Content Security Policy" not in x
                and "favicon" not in x]
        t("no console errors of ours", real, [])
        t("nothing was fetched off-site", [u for u in ext if "cloudflareinsights" not in u], [])

        # ---- the download, saved and opened off the disk -------------------
        tmp = pathlib.Path(tempfile.mkdtemp())
        pg3 = b.new_page(viewport={"width": 1280, "height": 900})
        pg3.goto(SITE, wait_until="load")
        with pg3.expect_download() as dl:
            pg3.click('a[href="./download/miscellany-doc.html"]')
        saved = tmp / "miscellany-doc.html"
        dl.value.save_as(str(saved))
        built = pathlib.Path(__file__).resolve().parent.parent / "dist" / "download" / "miscellany-doc.html"
        t("the downloaded file is byte-identical to the build",
          saved.read_bytes() == built.read_bytes(), True)
        t("and carries no beacon", b"cloudflareinsights" in saved.read_bytes(), False)

        pg4 = b.new_page(viewport={"width": 1280, "height": 900})
        e4, ex4 = [], []
        pg4.on("pageerror", lambda x: e4.append(str(x)))
        pg4.on("console", lambda m: e4.append(m.text) if m.type == "error" else None)
        pg4.on("request", lambda r: None if r.url.startswith(("file:", "data:", "blob:"))
               else ex4.append(r.url))
        pg4.goto(saved.as_uri(), wait_until="load")
        pg4.wait_for_timeout(1600)
        cdp4 = pg4.context.new_cdp_session(pg4)
        r = cdp4.send("Runtime.evaluate", {
            "expression": "(()=>{const c=document.querySelector('.doc-canvas');"
                          "return c ? c.width : 0;})()", "returnByValue": True})
        t("the saved file runs from the disk", r["result"].get("value") > 600, True)
        t("and reaches the network not at all", ex4, [])
        t("with no errors", [x for x in e4 if "favicon" not in x], [])
        pg4.screenshot(path=str(OUT / "live-03-download.png"))

        # ---- compose -------------------------------------------------------
        pg5 = b.new_page(viewport={"width": 1500, "height": 950})
        e5 = []
        pg5.on("pageerror", lambda x: e5.append(str(x)))
        pg5.goto(f"{SITE}/app/compose.html", wait_until="load")
        pg5.wait_for_timeout(1800)
        cdp5 = pg5.context.new_cdp_session(pg5)
        r = cdp5.send("Runtime.evaluate",
                      {"expression": "miscellany.shell.apps.size", "returnByValue": True})
        t("compose serves all three apps", r["result"].get("value"), 3)
        cdp5.send("Runtime.evaluate",
                  {"expression": "miscellany.shell.setLayout(['sheet','doc'])",
                   "returnByValue": True})
        pg5.wait_for_timeout(900)
        pg5.screenshot(path=str(OUT / "live-04-compose.png"))
        t("compose has no page errors", e5, [])

        b.close()

    print()
    if fails:
        print(f"  {len(fails)} FAILED")
        for f in fails:
            print("   x " + f)
        sys.exit(1)
    print("  live site: all green")


main()
