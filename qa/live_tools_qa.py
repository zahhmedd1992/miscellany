"""LIVE verification of miscellany.io after the 4-tool deploy.

curl is not trusted here — it has 200'd three broken apps on this site
before. Real browser, and four kinds of evidence:
  1. The front door: tally 6, six tools, no deleted strings resurrected.
  2. The RESPONSE HEADER on each /tool/ path: the per-tool CSP with the
     script's own sha256 must be the ONLY policy (the `!` detach in _headers
     is load-bearing; if it failed, two policies stack and the tools die).
  3. Each tool page FUNCTIONS live (not merely 200s), with no console errors
     other than the edge beacon our CSP refuses by design.
  4. Every Download button is actually clicked; the saved file must be
     byte-identical to the build (the edge spliced a beacon into a download
     here once) and must then WORK from disk with zero external requests.
"""
import hashlib, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
LIVE = "https://miscellany.io"

fails = []

def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(62) + str(got)[:52])

TOOLS = ["passwords", "qr", "verify", "encrypt"]
PROBES = {
    "passwords": "document.getElementById('out').textContent.length === 20 && misc.WORDS.length === 7776",
    "qr": "!!document.querySelector('#svgbox svg') && misc.encode('x', {level:'M'}).version === 1",
    "verify": "document.getElementById('selftest').textContent.includes('Self-test passed')",
    "encrypt": "misc.ROUNDS === 600000 && document.getElementById('e-go') !== null",
}
# NB: raw urllib gets a 403 here — Cloudflare challenges non-browser agents.
# All header checks therefore ride the real browser's navigation response,
# via headers_array() which preserves DUPLICATE headers — the exact thing
# the `!` detach test needs to see.

try:
    from patchright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        ctx = b.new_context(viewport={"width": 1280, "height": 900})
        pg = ctx.new_page()

        def watch(page):
            errs, third = [], []
            page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.on("response", lambda r: None if "miscellany.io" in r.url or r.url.startswith(("data:", "blob:"))
                    else third.append(r.url))
            return errs, third

        def real_errors(errs):
            # the edge injects a beacon + a challenge script; our CSP refuses
            # them, and that refusal is the system working. Anything else is a bug.
            return [e for e in errs if "Content Security Policy" not in e and "cloudflareinsights" not in e]

        print("\n  the front door, live")
        errs, third = watch(pg)
        pg.goto(f"{LIVE}/", wait_until="load")
        pg.wait_for_timeout(600)
        t("tally reads 6", pg.text_content('[data-tally="tools"]'), "6")
        h2s = pg.eval_on_selector_all("h2", "els => els.map(e => e.textContent)")
        t("six tools listed", h2s, "['Sheet', 'Deck', 'Passwords', 'QR', 'Verify', 'Encrypt']")
        t("front door: no real console errors", real_errors(errs), [])
        t("front door: no completed third-party responses", third, [])
        pg.screenshot(path=str(OUT / "live_front_door.png"), full_page=True)

        print("\n  each tool page functions, live")
        for slug in TOOLS:
            p2 = ctx.new_page()
            errs2, third2 = watch(p2)
            resp = p2.goto(f"{LIVE}/tool/{slug}", wait_until="load")
            p2.wait_for_timeout(700)
            csps = [h["value"] for h in resp.headers_array() if h["name"].lower() == "content-security-policy"]
            t(f"/tool/{slug}: exactly one CSP header", len(csps), 1)
            t(f"/tool/{slug}: CSP pins a script hash", any("sha256-" in c for c in csps))
            t(f"/tool/{slug}: site-wide script-src 'self' detached",
              not any("script-src 'self'" in c for c in csps))
            cdp = p2.context.new_cdp_session(p2)
            r = cdp.send("Runtime.evaluate", {"expression": PROBES[slug], "returnByValue": True, "awaitPromise": True})
            t(f"live /tool/{slug} FUNCTIONS", r["result"].get("value"))
            t(f"live /tool/{slug}: no real console errors", real_errors(errs2), [])
            t(f"live /tool/{slug}: no completed third-party responses", third2, [])
            p2.close()

        print("\n  the platform apps still paint")
        p3 = ctx.new_page()
        errs3, _ = watch(p3)
        p3.goto(f"{LIVE}/app/", wait_until="load")
        p3.wait_for_timeout(1200)
        canvas = p3.eval_on_selector("canvas", "c => c ? c.width > 300 : false")
        t("live /app/ paints a real canvas", canvas)
        t("live /app/: no real console errors", real_errors(errs3), [])
        p3.close()

        print("\n  every Download button, clicked, compared, then run from disk")
        for slug in TOOLS:
            with pg.expect_download(timeout=60000) as dl:
                pg.click(f'a[href="./download/miscellany-{slug}.html"]')
            saved = OUT / f"dl_{slug}.html"
            dl.value.save_as(str(saved))
            got = hashlib.sha256(saved.read_bytes()).hexdigest()
            want = hashlib.sha256((ROOT / "dist" / "download" / f"miscellany-{slug}.html").read_bytes()).hexdigest()
            t(f"clicked download {slug}: byte-identical to the build", got == want,
              True if got == want else f"edge tampering? {len(saved.read_bytes())} vs dist")

            p4 = b.new_page()
            errs4, ext4 = [], []
            p4.on("console", lambda m, e=errs4: e.append(m.text) if m.type == "error" else None)
            p4.on("pageerror", lambda e2, e=errs4: e.append(str(e2)))
            p4.on("request", lambda r2, x=ext4: None if r2.url.startswith(("file:", "data:", "blob:"))
                  else x.append(r2.url))
            p4.goto(saved.as_uri(), wait_until="load")
            p4.wait_for_timeout(600)
            cdp4 = p4.context.new_cdp_session(p4)
            r4 = cdp4.send("Runtime.evaluate", {"expression": PROBES[slug], "returnByValue": True, "awaitPromise": True})
            t(f"downloaded {slug} WORKS from disk", r4["result"].get("value"))
            t(f"downloaded {slug}: zero network attempts from disk", ext4, [])
            p4.close()

        b.close()
except Exception as e:
    import traceback
    traceback.print_exc()
    fails.append(f"harness: {type(e).__name__}: {e}")

print(f"\n{'  ALL GREEN — live site verified' if not fails else f'  {len(fails)} FAILURE(S)'}")
for f in fails:
    print("  x " + f)
sys.exit(1 if fails else 0)
