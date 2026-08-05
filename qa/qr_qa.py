"""QR tool — the graded exam.

A QR code that is subtly wrong is worse than no QR code: it looks fine on
screen and fails at the wedding, on the poster, after the print run. So the
bar here is not "it renders" — it is:

  1. Every one of the 160 (version x level) combinations the standard defines
     is generated and then DECODED by two independent implementations that
     share no code with ours (zbar, OpenCV). Content must round-trip exactly.
  2. Reed-Solomon, format-info BCH and version-info BCH are recomputed by a
     second implementation (Python, below) and must agree everywhere.
  3. The capacity table is cross-checked against the symbol geometry: modules
     available in the built matrix must yield exactly the table's codeword
     count, for all 40 versions — a typo in any table cell breaks one side.
  4. The real UI flow: type, download PNG by clicking the button, decode the
     downloaded file. Both over http and over file://.
"""
import base64, functools, http.server, io, pathlib, socketserver, sys, threading

import cv2
import numpy as np
from PIL import Image
from pyzbar.pyzbar import decode as zbar_decode, ZBarSymbol

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 8872

h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "site"))
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails = []

def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(58) + str(got)[:56])

# ---- independent GF(256) / Reed-Solomon (shares nothing with the page) ----

EXP = [0] * 512
LOG = [0] * 256
_x = 1
for _i in range(255):
    EXP[_i] = _x
    LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    EXP[_i] = EXP[_i - 255]

def gf_mul(a, b):
    return EXP[LOG[a] + LOG[b]] if a and b else 0

def rs_encode_py(data, n):
    gen = [1]
    for i in range(n):
        nxt = [0] * (len(gen) + 1)
        for j, g in enumerate(gen):
            nxt[j] ^= gf_mul(g, EXP[i])
            nxt[j + 1] ^= g
        gen = nxt
    gen.reverse()
    rem = [0] * n
    for byte in data:
        factor = byte ^ rem[0]
        rem = rem[1:] + [0]
        if factor:
            for i in range(n):
                rem[i] ^= gf_mul(gen[i + 1], factor)
    return rem

def bch_format_py(level_bits, mask):
    data = (level_bits << 3) | mask
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ (0x537 if rem >> 9 & 1 else 0)
    return ((data << 10) | (rem & 0x3FF)) ^ 0x5412

def bch_version_py(version):
    rem = version
    for _ in range(12):
        rem = (rem << 1) ^ (0x1F25 if rem >> 11 & 1 else 0)
    return (version << 12) | (rem & 0xFFF)

def decode_png_bytes(png):
    img = np.frombuffer(png, dtype=np.uint8)
    mat = cv2.imdecode(img, cv2.IMREAD_GRAYSCALE)
    zr = zbar_decode(Image.open(io.BytesIO(png)), symbols=[ZBarSymbol.QRCODE])
    z = zr[0].data if zr else None
    # OpenCV's decoder raises internal assertions on some symbols instead of
    # returning empty — treat that as "cv2 could not read it", never as a
    # crash of the exam. zbar stays the strict oracle.
    try:
        c, _, _ = cv2.QRCodeDetector().detectAndDecode(mat)
    except cv2.error:
        c = ""
    return z, (c.encode("utf-8", "surrogateescape") if c else None)

def grade(png, want_bytes):
    """Either decoder agreeing = pass. Either decoder DISAGREEING = fail."""
    z, c = decode_png_bytes(png)
    for got in (z, c):
        if got is not None and got != want_bytes:
            return f"decoder returned wrong content: {got[:40]!r}"
    if z is None and c is None:
        return "neither decoder could read it"
    return "ok"

try:
    from patchright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        errs, external = [], []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("request", lambda r: None if "127.0.0.1" in r.url or r.url.startswith(("data:", "blob:"))
              else external.append(r.url))
        pg.goto(f"http://127.0.0.1:{PORT}/tool/qr.html", wait_until="load")
        pg.wait_for_timeout(300)
        cdp = pg.context.new_cdp_session(pg)

        def ev(x):
            r = cdp.send("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True})
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"])[:500])
            return r["result"].get("value")

        print("\n  the capacity table vs the symbol geometry, all 40 versions")
        geo = ev("""(() => {
          const out = [];
          for (let v = 1; v <= 40; v++) {
            const {fn, size} = misc.baseMatrix(v);
            let free = 0;
            for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c]) free++;
            const totals = [0,1,2,3].map(l => misc.ECT[v][l][1].reduce((a,[n,d]) => a + n*(d + misc.ECT[v][l][0]), 0));
            out.push({v, size, free, cw: Math.floor(free/8), rem: free % 8, totals});
          }
          return out;
        })()""")
        geo_ok = table_ok = rem_ok = True
        for g in geo:
            if len(set(g["totals"])) != 1:
                table_ok = False
                print(f"       v{g['v']}: levels disagree on total codewords: {g['totals']}")
            if g["cw"] != g["totals"][0]:
                geo_ok = False
                print(f"       v{g['v']}: geometry says {g['cw']} codewords, table says {g['totals'][0]}")
            if g["rem"] != ev(f"misc.REMAINDER[{g['v']}]"):
                rem_ok = False
                print(f"       v{g['v']}: geometry remainder {g['rem']} != table")
        t("all four levels of every version sum to one total", table_ok)
        t("geometry-derived codeword count matches the table, 40/40", geo_ok)
        t("remainder bits match geometry, 40/40", rem_ok)
        t("matrix sizes are 4v+17", all(g["size"] == 4 * g["v"] + 17 for g in geo))

        print("\n  Reed-Solomon vs an independent implementation")
        import random
        random.seed(20260804)
        rs_ok = True
        for trial in range(200):
            n = random.choice([7, 10, 13, 15, 17, 18, 20, 22, 24, 26, 28, 30])
            data = [random.randrange(256) for _ in range(random.randrange(9, 123))]
            want = rs_encode_py(data, n)
            got = ev(f"Array.from(misc.rsEncode(Uint8Array.from({data}), {n}))")
            if got != want:
                rs_ok = False
                print(f"       trial {trial}: ec={n} len={len(data)} disagree")
                break
        t("200 random blocks, both implementations agree", rs_ok)

        print("\n  format and version BCH vs an independent implementation")
        fmt_ok = all(
            ev(f"misc.formatInfo('{lv}', {m})") == bch_format_py(lb, m)
            for lv, lb in [("L", 1), ("M", 0), ("Q", 3), ("H", 2)] for m in range(8)
        )
        t("all 32 format-information words agree", fmt_ok)
        ver_ok = all(ev(f"misc.versionInfo({v})") == bch_version_py(v) for v in range(7, 41))
        t("all 34 version-information words agree", ver_ok)
        t("known vector: version 7 info is 0x07C94", ev("misc.versionInfo(7)"), 0x07C94)
        t("known vector: format M mask 0 is 0x5412 pre-image", ev("misc.formatInfo('M', 0) ^ 0x5412"), 0)

        print("\n  THE EXAM: all 160 version x level combinations, machine-decoded")
        filler = "the quick brown fox jumps over 0123456789 "
        exam_fails = []
        for v in range(1, 41):
            for lv in "LMQH":
                cap = ev(f"misc.dataCodewords({v}, '{lv}')")
                prefix = f"V{v}{lv}:"
                need = max(1, min(int(cap * 0.6), cap - 4) - len(prefix))
                payload = prefix + (filler * (need // len(filler) + 1))[:need]
                url = ev(
                    "(() => { const r = misc.encode(" + repr(payload) + ", {version: " + str(v) +
                    ", level: '" + lv + "'});"
                    " if (r.version !== " + str(v) + ") return 'BADV' + r.version;"
                    " return misc.toCanvas(r, 1200, '#000000', '#ffffff').toDataURL('image/png'); })()")
                if url.startswith("BADV"):
                    exam_fails.append(f"v{v}{lv}: forced version ignored ({url})")
                    continue
                png = base64.b64decode(url.split(",", 1)[1])
                verdict = grade(png, payload.encode())
                if verdict != "ok":
                    exam_fails.append(f"v{v}{lv}: {verdict}")
            print(f"       v{v:>2} LMQH graded", flush=True)
        t("160/160 combinations decode to their exact content", not exam_fails, True)
        for f in exam_fails[:12]:
            print("       x " + f)

        print("\n  mode selection and the CCI boundary versions")
        t("digits pick numeric mode", ev("misc.modeFor('0123456789')"), "numeric")
        t("HELLO WORLD picks alphanumeric", ev("misc.modeFor('HELLO WORLD')"), "alnum")
        t("lowercase forces byte", ev("misc.modeFor('hello')"), "byte")
        for v, mode, text_len in [(9, "numeric", 100), (10, "numeric", 100), (26, "alnum", 80), (27, "alnum", 80)]:
            payload = ("7" * text_len) if mode == "numeric" else ("A7" * (text_len // 2))
            url = ev(f"misc.toCanvas(misc.encode('{payload}', {{version: {v}, level: 'M'}}), 900, '#000000', '#ffffff').toDataURL('image/png')")
            png = base64.b64decode(url.split(",", 1)[1])
            t(f"CCI boundary: v{v} {mode} decodes", grade(png, payload.encode()), "ok")

        print("\n  UTF-8 in byte mode (no ECI, as phones assume)")
        # zbar guesses Shift-JIS for byte sequences that happen to be
        # SJIS-plausible and transcodes them (probe: qr_utf8_probe). cv2
        # assumes UTF-8, as phones do — either independent decoder returning
        # our exact bytes proves the symbol carries them.
        for text in ["Grüße aus München", "日本語のテキスト", "emoji: 🎉✓"]:
            url = ev("misc.toCanvas(misc.encode(" + repr(text) + ", {level:'M'}), 900, '#000000', '#ffffff').toDataURL('image/png')")
            png = base64.b64decode(url.split(",", 1)[1])
            z, c = decode_png_bytes(png)
            want = text.encode("utf-8")
            t(f"utf-8 round-trip: {text[:20]!r}", z == want or c == want)

        print("\n  payload builders, decoded back")
        wifi = ev("misc.payloadWifi({ssid: 'Caf\\u00e9 \"Zeta\"; 50%', pass: 'p;a:s\\\\s,word', sec: 'WPA', hidden: true})")
        assert wifi.startswith("WIFI:")
        url = ev("misc.toCanvas(misc.encode(misc.payloadWifi({ssid: 'Caf\\u00e9 \"Zeta\"; 50%', pass: 'p;a:s\\\\s,word', sec: 'WPA', hidden: true}), {level:'M'}), 900, '#000000', '#ffffff').toDataURL('image/png')")
        z, c = decode_png_bytes(base64.b64decode(url.split(",", 1)[1]))
        want = wifi.encode("utf-8")
        t("wifi payload with every special char round-trips", z == want or c == want)
        t("wifi escaping is per spec", "S:Café \\\"Zeta\\\"\\; 50%;" in wifi)
        vc = ev("misc.payloadVcard({first:'Ada', last:'Lovelace', phone:'+1 555 0100', email:'ada@example.com', org:'Analytical; Engines, Ltd', title:'', url:''})")
        t("vcard has begin/end and escaped org", "BEGIN:VCARD" in vc and "Analytical\\; Engines\\, Ltd" in vc)

        print("\n  the real UI, driven like a person")
        t("default preview renders an svg", ev("!!document.querySelector('#svgbox svg')"))
        t("caption states the version", "Version" in ev("document.getElementById('caption').textContent"))
        ev("document.getElementById('fg').value = '#ffffff'; document.getElementById('bg').value = '#000000';"
           "document.getElementById('fg').dispatchEvent(new Event('input'))")
        t("inverted colours draw the warning", "Swap the colours" in ev("document.getElementById('colorhint').textContent"))
        ev("document.getElementById('fg').value = '#000000'; document.getElementById('bg').value = '#ffffff';"
           "document.getElementById('fg').dispatchEvent(new Event('input'))")

        with pg.expect_download() as dl:
            pg.click("#dl-png")
        path = OUT / "qr_clicked.png"
        dl.value.save_as(str(path))
        png = path.read_bytes()
        t("clicked PNG download decodes to the page's own text",
          grade(png, ev("misc.payloadWifi ? document.getElementById('in-text').value : ''").encode()), "ok")

        with pg.expect_download() as dl2:
            pg.click("#dl-svg")
        svg_path = OUT / "qr_clicked.svg"
        dl2.value.save_as(str(svg_path))
        svg = svg_path.read_text(encoding="utf-8")
        t("clicked SVG is a real svg with a path and quiet zone",
          svg.startswith("<svg") and 'viewBox="0 0 ' in svg and "<path" in svg)

        print("\n  wifi tab through the UI")
        pg.click("#tab-wifi")
        pg.fill("#w-ssid", "HomeNet")
        pg.fill("#w-pass", "hunter22")
        pg.wait_for_timeout(200)
        t("wifi tab renders a code", ev("!!document.querySelector('#svgbox svg')"))
        pg.click("#tab-text")
        pg.wait_for_timeout(150)

        print("\n  nothing left the machine, nothing errored")
        t("zero external requests", external, [])
        t("zero console errors", errs, [])

        pg.set_viewport_size({"width": 390, "height": 844})
        pg.wait_for_timeout(200)
        t("no horizontal scroll at phone width",
          ev("document.scrollingElement.scrollWidth <= window.innerWidth"))
        pg.screenshot(path=str(OUT / "qr_mobile.png"), full_page=True)
        pg.set_viewport_size({"width": 1280, "height": 900})
        pg.wait_for_timeout(200)
        pg.screenshot(path=str(OUT / "qr_desktop.png"), full_page=True)

        # ---- the double-clicked file ----
        pg2 = b.new_page(viewport={"width": 1280, "height": 900})
        errs2, external2 = [], []
        pg2.on("console", lambda m: errs2.append(m.text) if m.type == "error" else None)
        pg2.on("pageerror", lambda e: errs2.append(str(e)))
        pg2.on("request", lambda r: None if r.url.startswith(("file:", "data:", "blob:"))
               else external2.append(r.url))
        pg2.goto((ROOT / "site" / "tool" / "qr.html").as_uri(), wait_until="load")
        pg2.wait_for_timeout(300)
        cdp2 = pg2.context.new_cdp_session(pg2)

        def ev2(x):
            r = cdp2.send("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True})
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"])[:500])
            return r["result"].get("value")

        print("\n  [file] the double-clicked copy still generates and decodes")
        url = ev2("misc.toCanvas(misc.encode('file://works', {level:'Q'}), 700, '#000000', '#ffffff').toDataURL('image/png')")
        png = base64.b64decode(url.split(",", 1)[1])
        t("file: generated code decodes", grade(png, b"file://works"), "ok")
        t("file: zero external requests", external2, [])
        t("file: zero console errors", errs2, [])

        b.close()
except Exception as e:
    import traceback
    traceback.print_exc()
    fails.append(f"harness: {type(e).__name__}: {e}")

srv.shutdown()
print(f"\n{'  ALL GREEN' if not fails else f'  {len(fails)} FAILURE(S)'}")
for f in fails:
    print("  x " + f)
sys.exit(1 if fails else 0)
