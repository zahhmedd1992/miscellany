"""Passwords tool — driven like a person would, graded like an auditor would.

Two claims are being tested, and they are different kinds of claim:
  1. Behaviour: generation honours every option, the clipboard works, the UI
     holds together at phone width — checked in a real browser, over http AND
     over file:// (the double-clicked download is the artefact that matters).
  2. Mathematics: the distribution is uniform (chi-square on the page's own
     randBelow) and the entropy figure is EXACT — recomputed here with
     Python's unbounded integers, a second implementation agreeing with the
     page's BigInt one. One implementation asserting is a press release.
"""
import http.server, socketserver, threading, functools, math, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 8871

h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "site"))
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails = []

def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(56) + str(got)[:60])

# ---- the independent entropy implementation (Python ints are exact) ----

CLASSES = {
    "lower": "abcdefghijklmnopqrstuvwxyz",
    "upper": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "digit": "0123456789",
    "sym":   "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
}
LOOKALIKE = set("Il1O0o|")

def class_sizes(selected, no_amb):
    sizes = []
    for k in selected:
        chars = CLASSES[k]
        if no_amb:
            chars = "".join(c for c in chars if c not in LOOKALIKE)
        sizes.append(len(chars))
    return sizes

def count_valid(sizes, length):
    total = sum(sizes)
    count = 0
    for mask in range(1 << len(sizes)):
        excluded = sum(s for i, s in enumerate(sizes) if mask >> i & 1)
        bits = bin(mask).count("1")
        count += (-1) ** bits * (total - excluded) ** length
    return count

def log2_exact(n):
    b = n.bit_length()
    if b <= 53:
        return math.log2(n)
    return (b - 53) + math.log2(n >> (b - 53))

def run(pg, label, cdp):
    def ev(x):
        r = cdp.send("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in r:
            raise RuntimeError(str(r["exceptionDetails"])[:400])
        return r["result"].get("value")

    print(f"\n  [{label}] the page and its promises")
    t(f"{label}: wordlist is complete in the page", ev("misc.WORDS.length"), 7776)
    t(f"{label}: first and last words match the EFF list",
      ev("misc.WORDS[0] + ' ' + misc.WORDS[7775]"), "abacus zoom")
    t(f"{label}: output filled on load, default length 20", ev("document.getElementById('out').textContent.length"), 20)
    t(f"{label}: default password touches all four classes",
      ev("(() => { const s = document.getElementById('out').textContent;"
         " return ['abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ','0123456789']"
         ".every(c => [...s].some(ch => c.includes(ch))) && [...s].some(ch => misc.CLASSES.sym.includes(ch)); })()"))

    print(f"\n  [{label}] generation honours every option")
    t(f"{label}: length option respected at 40",
      ev("misc.genPassword({length:40,lower:true,upper:true,digit:true,sym:true}).length"), 40)
    t(f"{label}: single-class password stays in its class",
      ev("[...misc.genPassword({length:16,digit:true})].every(c => '0123456789'.includes(c))"))
    t(f"{label}: look-alike exclusion holds over 200 draws",
      ev("(() => { for (let i=0;i<200;i++) { const s = misc.genPassword({length:12,lower:true,upper:true,digit:true,sym:true,noAmbiguous:true});"
         " if ([...s].some(c => 'Il1O0o|'.includes(c))) return false; } return true; })()"))
    t(f"{label}: every-class guarantee holds at the tightest length (4)",
      ev("(() => { for (let i=0;i<200;i++) { const s = misc.genPassword({length:4,lower:true,upper:true,digit:true,sym:true});"
         " const cs = [misc.CLASSES.lower,misc.CLASSES.upper,misc.CLASSES.digit,misc.CLASSES.sym];"
         " if (!cs.every(c => [...s].some(ch => c.includes(ch)))) return false; } return true; })()"))
    t(f"{label}: passphrase word count and separator",
      ev("misc.genPassphrase({words:6,sep:'-'}).split('-').length"), 6)
    t(f"{label}: passphrase words all come from the list",
      ev("misc.genPassphrase({words:8,sep:' '}).split(' ').every(w => misc.WORDS.includes(w))"))
    t(f"{label}: capitalize transforms, digit appends",
      ev("(() => { const s = misc.genPassphrase({words:3,sep:'.',capitalize:true,digit:true});"
         " const parts = s.split('.'); const last = parts[parts.length-1];"
         " return parts.length === 3 && /[0-9]$/.test(last) && parts.every(p => /^[A-Z]/.test(p)); })()"))

    print(f"\n  [{label}] the mathematics, against a second implementation")
    for sel, no_amb, length in [
        (["lower", "upper", "digit", "sym"], False, 20),
        (["lower", "upper", "digit", "sym"], True, 20),
        (["lower", "digit"], False, 14),
        (["digit"], False, 6),
        (["lower", "upper", "digit", "sym"], False, 4),
    ]:
        sizes = class_sizes(sel, no_amb)
        want = round(log2_exact(count_valid(sizes, length)), 6)
        opts = "{" + ",".join(f"{k}:true" for k in sel) + f",noAmbiguous:{str(no_amb).lower()},length:{length}" + "}"
        got = ev(f"Math.round(misc.passwordBits({opts}) * 1e6) / 1e6")
        t(f"{label}: exact bits {'+'.join(sel)}{'/noamb' if no_amb else ''} L={length} = {want}", got, want)
    want_pp = round((5 * math.log2(7776)), 6)
    t(f"{label}: passphrase bits, 5 words = {want_pp}",
      ev("Math.round(misc.passphraseBits({words:5}) * 1e6) / 1e6"), want_pp)
    want_ppd = round((5 * math.log2(7776) + math.log2(10)), 6)
    t(f"{label}: passphrase bits, 5 words + digit = {want_ppd}",
      ev("Math.round(misc.passphraseBits({words:5,digit:true}) * 1e6) / 1e6"), want_ppd)
    shown = ev("document.getElementById('strength').textContent")
    m = re.search(r"([\d.]+) bits of entropy", shown)
    full = round(log2_exact(count_valid(class_sizes(["lower","upper","digit","sym"], False), 20)), 1)
    t(f"{label}: the figure SHOWN equals the recomputed one ({full})", m and float(m.group(1)), full)

    print(f"\n  [{label}] uniformity — chi-square on the page's own sampler")
    counts = ev("(() => { const c = new Array(26).fill(0); for (let i=0;i<130000;i++) c[misc.randBelow(26)]++; return c; })()")
    n, k = sum(counts), len(counts)
    chi2 = sum((o - n / k) ** 2 / (n / k) for o in counts)
    t(f"{label}: chi-square over 26 buckets x 130k draws < 60 (25 dof)", chi2 < 60, True)
    print(f"         chi2 = {chi2:.1f}")

    return ev

try:
    from patchright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)

        # ---- served over http, clipboard permissions granted ----
        ctx = b.new_context(viewport={"width": 1280, "height": 900},
                            permissions=["clipboard-read", "clipboard-write"])
        pg = ctx.new_page()
        errs, external = [], []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("request", lambda r: None if "127.0.0.1" in r.url or r.url.startswith("data:")
              else external.append(r.url))
        pg.goto(f"http://127.0.0.1:{PORT}/tool/passwords.html", wait_until="load")
        pg.wait_for_timeout(300)
        cdp = pg.context.new_cdp_session(pg)
        ev = run(pg, "http", cdp)

        print("\n  [http] the clipboard, driven through the real button")
        pg.click("#copy")
        pg.wait_for_timeout(200)
        t("http: Copy button gives feedback", pg.text_content("#copy") in ("Copied", "Press Ctrl+C"))
        clip = ev("navigator.clipboard.readText()")
        t("http: clipboard holds exactly the shown password", clip == ev("document.getElementById('out').textContent"))

        print("\n  [http] tabs and the passphrase panel")
        pg.click("#tab-pp")
        pg.wait_for_timeout(150)
        t("http: passphrase mode renders 5 dash-joined words",
          ev("document.getElementById('out').textContent.split('-').length"), 5)
        pg.click("#tab-pw")
        pg.wait_for_timeout(150)

        print("\n  [http] nothing left the machine, nothing errored")
        t("http: zero external requests", external, [])
        t("http: zero console errors", errs, [])

        pg.set_viewport_size({"width": 390, "height": 844})
        pg.wait_for_timeout(200)
        t("http: no horizontal scroll at phone width",
          ev("document.scrollingElement.scrollWidth <= window.innerWidth"))
        pg.screenshot(path=str(OUT / "passwords_mobile.png"), full_page=True)
        pg.set_viewport_size({"width": 1280, "height": 900})
        pg.wait_for_timeout(200)
        pg.screenshot(path=str(OUT / "passwords_desktop.png"), full_page=True)
        ctx.close()

        # ---- the double-clicked file, exactly as a stranger runs it ----
        pg2 = b.new_page(viewport={"width": 1280, "height": 900})
        errs2, external2 = [], []
        pg2.on("console", lambda m: errs2.append(m.text) if m.type == "error" else None)
        pg2.on("pageerror", lambda e: errs2.append(str(e)))
        pg2.on("request", lambda r: None if r.url.startswith(("file:", "data:"))
               else external2.append(r.url))
        pg2.goto((ROOT / "site" / "tool" / "passwords.html").as_uri(), wait_until="load")
        pg2.wait_for_timeout(300)
        cdp2 = pg2.context.new_cdp_session(pg2)
        run(pg2, "file", cdp2)
        print("\n  [file] nothing left the machine, nothing errored")
        t("file: zero external requests", external2, [])
        t("file: zero console errors", errs2, [])

        b.close()
except Exception as e:
    fails.append(f"harness: {type(e).__name__}: {e}")
    print(f"\n  HARNESS ERROR: {type(e).__name__}: {e}")

srv.shutdown()
print(f"\n{'  ALL GREEN' if not fails else f'  {len(fails)} FAILURE(S)'}")
for f in fails:
    print("  x " + f)
sys.exit(1 if fails else 0)
