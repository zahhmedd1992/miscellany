"""Verify + Encrypt tools — graded against independent implementations.

Verify: every displayed hash is recomputed with Python's hashlib on the same
bytes, across sizes chosen to land on every block-boundary edge case
(55/56/63/64/65 bytes — where padding bugs live) and on multi-slice files.

Encrypt: the .sealed format's whole point is that you are not locked in — so
the exam is interop, both directions. A file sealed by the page is opened in
Python with the `cryptography` library using nothing but the documented
format; a file sealed BY Python is opened through the page's real UI. Plus:
wrong passphrase fails cleanly, and a single flipped ciphertext byte is
rejected outright (GCM authentication).
"""
import functools, hashlib, http.server, os, pathlib, socketserver, sys, threading

from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
TMP = OUT / "tmp"
TMP.mkdir(exist_ok=True)
PORT = 8875
ROUNDS = 600000
MAGIC = b"MSEAL1\n"

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

def py_unseal(blob, passphrase):
    assert blob[:7] == MAGIC, "bad magic"
    salt, iv, cipher = blob[7:23], blob[23:35], blob[35:]
    key = PBKDF2HMAC(SHA256(), 32, salt, ROUNDS).derive(passphrase.encode())
    plain = AESGCM(key).decrypt(iv, cipher, None)
    name_len = int.from_bytes(plain[:4], "little")
    return plain[4:4 + name_len].decode(), plain[4 + name_len:]

def py_seal(name, data, passphrase):
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(SHA256(), 32, salt, ROUNDS).derive(passphrase.encode())
    plain = len(name.encode()).to_bytes(4, "little") + name.encode() + data
    return MAGIC + salt + iv + AESGCM(key).encrypt(iv, plain, None)

try:
    from patchright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)

        # ================= VERIFY =================
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        errs, external = [], []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("request", lambda r: None if "127.0.0.1" in r.url or r.url.startswith(("data:", "blob:"))
              else external.append(r.url))
        pg.goto(f"http://127.0.0.1:{PORT}/tool/verify.html", wait_until="load")
        pg.wait_for_timeout(600)
        cdp = pg.context.new_cdp_session(pg)

        def ev(x):
            r = cdp.send("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True})
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"])[:500])
            return r["result"].get("value")

        print("\n  [verify] self-test and vectors")
        t("self-test badge reports PASSED", "Self-test passed" in ev("document.getElementById('selftest').textContent"))
        t("hashText('abc') is the FIPS vector",
          ev("misc.hashText('abc').sha256"),
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")

        print("\n  [verify] real files through the real picker, vs hashlib")
        import random
        random.seed(20260804)
        sizes = [0, 1, 55, 56, 63, 64, 65, 1000, 5 * 1024 * 1024, 33 * 1024 * 1024 + 17]
        paths = []
        for s in sizes:
            path = TMP / f"blob_{s}.bin"
            path.write_bytes(random.randbytes(s))
            paths.append(path)
        # NB: playwright's wait_for_function is eval-based, and the page's own
        # meta CSP refuses eval — which is the CSP doing its job. Poll through
        # CDP main-world instead.
        import time
        def wait_until(expr, timeout=120):
            deadline = time.time() + timeout
            while time.time() < deadline:
                if ev(expr):
                    return
                time.sleep(0.15)
            raise TimeoutError(expr)

        for path in paths:
            data = path.read_bytes()
            pg.set_input_files("#pick", str(path))
            wait_until("(document.querySelector('.file code[data-h=\"256\"]')?.textContent || '').length === 64")
            got256 = ev("document.querySelector('.file code[data-h=\"256\"]').textContent")
            got1 = ev("document.querySelector('.file code[data-h=\"1\"]').textContent")
            t(f"sha256 of {path.name} ({len(data)} B)", got256, hashlib.sha256(data).hexdigest())
            t(f"sha1   of {path.name}", got1, hashlib.sha1(data).hexdigest())

        print("\n  [verify] the compare field")
        top256 = ev("document.querySelector('.file code[data-h=\"256\"]').textContent")
        spaced = " ".join(top256.upper()[i:i+8] for i in range(0, 64, 8))
        pg.fill("#expected", spaced)
        pg.wait_for_timeout(150)
        t("uppercase + spaces still matches",
          ev("document.querySelector('.file [data-badge=\"256\"]').textContent"), "matches")
        pg.fill("#expected", ("0" if top256[0] != "0" else "1") + top256[1:])
        pg.wait_for_timeout(150)
        t("one wrong hex digit reads DIFFERENT",
          ev("document.querySelector('.file [data-badge=\"256\"]').textContent"), "DIFFERENT")

        t("[verify] zero external requests", external, [])
        t("[verify] zero console errors", errs, [])
        pg.set_viewport_size({"width": 390, "height": 844})
        pg.wait_for_timeout(200)
        t("[verify] no horizontal scroll at phone width",
          ev("document.scrollingElement.scrollWidth <= window.innerWidth"))
        pg.screenshot(path=str(OUT / "verify_mobile.png"), full_page=True)
        pg.set_viewport_size({"width": 1280, "height": 900})
        pg.wait_for_timeout(200)
        pg.screenshot(path=str(OUT / "verify_desktop.png"), full_page=True)
        pg.close()

        # ================= ENCRYPT =================
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        errs2, external2 = [], []
        pg.on("console", lambda m: errs2.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs2.append(str(e)))
        pg.on("request", lambda r: None if "127.0.0.1" in r.url or r.url.startswith(("data:", "blob:"))
              else external2.append(r.url))
        pg.goto(f"http://127.0.0.1:{PORT}/tool/encrypt.html", wait_until="load")
        pg.wait_for_timeout(300)
        cdp = pg.context.new_cdp_session(pg)

        print("\n  [encrypt] page seals -> Python opens (format interop, direction 1)")
        secret = TMP / "quarterly numbers.xlsx"
        payload = random.randbytes(2 * 1024 * 1024)
        secret.write_bytes(payload)
        passphrase = "correct-horse-battery-staple-42"
        pg.set_input_files("#e-file", str(secret))
        pg.fill("#e-pass", passphrase)
        pg.fill("#e-pass2", passphrase)
        with pg.expect_download(timeout=120000) as dl:
            pg.click("#e-go")
        sealed_path = TMP / "page_sealed.bin"
        dl.value.save_as(str(sealed_path))
        sealed = sealed_path.read_bytes()
        t("download is named after the original", dl.value.suggested_filename, "quarterly numbers.xlsx.sealed")
        t("sealed size = payload + name + 51 bytes overhead + tag",
          len(sealed), 7 + 16 + 12 + 4 + len(secret.name.encode()) + len(payload) + 16)
        name, plain = py_unseal(sealed, passphrase)
        t("python recovers the original name", name, "quarterly numbers.xlsx")
        t("python recovers the exact bytes", plain == payload)

        print("\n  [encrypt] Python seals -> page opens (direction 2)")
        py_sealed = TMP / "py_sealed.sealed"
        original = random.randbytes(300000)
        py_sealed.write_bytes(py_seal("réport final.pdf", original, "hunter2 hunter2"))
        pg.click("#tab-dec")
        pg.set_input_files("#d-file", str(py_sealed))
        pg.fill("#d-pass", "hunter2 hunter2")
        with pg.expect_download(timeout=120000) as dl2:
            pg.click("#d-go")
        recovered = TMP / "recovered.bin"
        dl2.value.save_as(str(recovered))
        t("page recovers python's original name (utf-8)", dl2.value.suggested_filename, "réport final.pdf")
        t("page recovers python's exact bytes", recovered.read_bytes() == original)

        print("\n  [encrypt] wrong passphrase and tampering fail CLEANLY")
        import time
        def wait_until2(expr, timeout=90):
            deadline = time.time() + timeout
            while time.time() < deadline:
                if ev(expr):
                    return
                time.sleep(0.15)
            raise TimeoutError(expr)

        pg.fill("#d-pass", "wrong passphrase")
        pg.click("#d-go")
        wait_until2("document.getElementById('d-status').className.includes('err')")
        t("wrong passphrase says so",
          "Wrong passphrase" in ev("document.getElementById('d-status').textContent"))
        tampered = bytearray(sealed)
        tampered[100] ^= 0xFF
        tampered_path = TMP / "tampered.sealed"
        tampered_path.write_bytes(bytes(tampered))
        pg.set_input_files("#d-file", str(tampered_path))
        pg.fill("#d-pass", passphrase)
        ev("document.getElementById('d-status').className = 'status'; document.getElementById('d-status').textContent = ''")
        pg.click("#d-go")
        wait_until2("document.getElementById('d-status').className.includes('err')")
        t("one flipped byte is rejected outright",
          "altered" in ev("document.getElementById('d-status').textContent")
          or "Wrong passphrase" in ev("document.getElementById('d-status').textContent"))

        print("\n  [encrypt] guardrails")
        pg.click("#tab-enc")
        pg.fill("#e-pass", "abc")
        pg.fill("#e-pass2", "abd")
        pg.click("#e-go")
        pg.wait_for_timeout(200)
        t("mismatched confirmation is caught",
          "differ" in ev("document.getElementById('e-status').textContent"))
        t("short passphrase draws the warning",
          "short" in ev("document.getElementById('e-hint').textContent"))

        t("[encrypt] zero external requests", external2, [])
        t("[encrypt] zero console errors", errs2, [])
        pg.set_viewport_size({"width": 390, "height": 844})
        pg.wait_for_timeout(200)
        t("[encrypt] no horizontal scroll at phone width",
          ev("document.scrollingElement.scrollWidth <= window.innerWidth"))
        pg.screenshot(path=str(OUT / "encrypt_mobile.png"), full_page=True)
        pg.set_viewport_size({"width": 1280, "height": 900})
        pg.wait_for_timeout(200)
        pg.screenshot(path=str(OUT / "encrypt_desktop.png"), full_page=True)
        pg.close()

        # ================= file:// for both =================
        print("\n  [file] both tools from a double-click")
        for tool, probe in [
            ("verify", "misc.hashText('abc').sha256 === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'"),
            ("encrypt", "(async () => { const f = new File([new Uint8Array([1,2,3,4,5])], 'x.bin');"
                        " const sealed = await misc.seal(f, 'pw', () => {});"
                        " const back = await misc.unseal(sealed, 'pw', () => {});"
                        " return back.name === 'x.bin' && Array.from(back.bytes).join(',') === '1,2,3,4,5'; })()"),
        ]:
            pg = b.new_page()
            errsF, externalF = [], []
            pg.on("console", lambda m: errsF.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errsF.append(str(e)))
            pg.on("request", lambda r: None if r.url.startswith(("file:", "data:", "blob:"))
                  else externalF.append(r.url))
            pg.goto((ROOT / "site" / "tool" / f"{tool}.html").as_uri(), wait_until="load")
            pg.wait_for_timeout(500)
            cdpF = pg.context.new_cdp_session(pg)
            r = cdpF.send("Runtime.evaluate", {"expression": probe, "returnByValue": True, "awaitPromise": True})
            t(f"file: {tool} works from disk", r["result"].get("value"))
            t(f"file: {tool} zero external requests", externalF, [])
            t(f"file: {tool} zero console errors", errsF, [])
            pg.close()

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
