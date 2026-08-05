"""Loan tool — graded to the cent.

Three legs, none of them ours twice over:
  1. An independent Python implementation of the stated arithmetic contract
     (integer cents, half-up per period, named day counts) must agree with
     the page's schedule ROW BY ROW, every field, for eight configurations
     chosen to hit the traps: EOM anchors, Actual/360 vs /365, extra and
     lump payments, a 0% rate, an odd tiny loan.
  2. numpy-financial's pmt() must agree with every non-zero payment amount.
  3. The accounting identities must hold exactly: principal portions sum to
     the loan to the penny, payment == interest + principal on every row,
     the final balance is zero, never negative.
"""
import functools, http.server, math, pathlib, socketserver, sys, threading

import numpy_financial as npf

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 8879

h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "site"))
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails = []

def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(62) + str(got)[:50])

# ---- the independent implementation ------------------------------------

def rnd(x):        # half-up for positives, matching Math.round
    return int(x + 0.5)

def add_months(y, m, d, anchor, count):
    mm = m + count
    yy = y + (mm - 1) // 12
    mm = (mm - 1) % 12 + 1
    # days in month, via the same trick the page uses
    import calendar
    dim = calendar.monthrange(yy, mm)[1]
    return (yy, mm, min(anchor, dim))

def days_between(a, b):
    import datetime
    return (datetime.date(*b) - datetime.date(*a)).days

def payment_cents(principal, annual, n):
    if annual == 0:
        return rnd(principal / n)
    r = annual / 100 / 12
    return rnd(principal * r / (1 - (1 + r) ** -n))

def py_schedule(amount, annual, months, basis, start, extra=0, lump=0, lump_at=1):
    pay = payment_cents(amount, annual, months)
    anchor = start[2]
    prev = add_months(start[0], start[1], start[2], anchor, -1)
    bal, rows = amount, []
    tot_i = tot_p = 0
    k = 0
    while k < months and bal > 0:
        k += 1
        date = add_months(start[0], start[1], start[2], anchor, k - 1)
        if basis == "30/360":
            interest = rnd(bal * annual / 1200)
        else:
            days = days_between(prev, date)
            interest = rnd(bal * annual / 100 * days / (360 if basis == "A/360" else 365))
        ex = extra + (lump if k == lump_at else 0)
        payment = pay
        principal = payment - interest
        if principal < 0:
            principal, payment = 0, interest
        if bal <= principal:
            principal, ex, payment = bal, 0, interest + bal
        elif bal <= principal + ex:
            ex = bal - principal
        elif k == months:
            ex = min(ex, max(0, bal - principal))
            principal = bal - ex
            payment = interest + principal
        bal -= principal + ex
        tot_i += interest
        tot_p += payment + ex
        rows.append(dict(k=k, date=list(date), payment=payment, interest=interest,
                         principal=principal, extra=ex, bal=bal))
        prev = date   # the accrual window advances — forgetting this line made
                      # the oracle compound day counts and "refute" a correct page
    return dict(rows=rows, payCents=pay, totalInterest=tot_i, totalPaid=tot_p)

CONFIGS = [
    ("classic 30yr mortgage", dict(amountCents=200_000_00, annualPct=6.0, months=360, basis="30/360", start=[2026, 9, 1])),
    ("20yr at 7.125", dict(amountCents=350_000_00, annualPct=7.125, months=240, basis="30/360", start=[2026, 10, 15])),
    ("commercial A/360, EOM anchor", dict(amountCents=1_000_000_00, annualPct=8.0, months=60, basis="A/360", start=[2026, 1, 31])),
    ("A/365, EOM anchor", dict(amountCents=1_000_000_00, annualPct=8.0, months=60, basis="A/365", start=[2026, 1, 31])),
    ("extra 200/mo", dict(amountCents=200_000_00, annualPct=6.0, months=360, basis="30/360", start=[2026, 9, 1], extraCents=200_00)),
    ("lump 10k at #24", dict(amountCents=200_000_00, annualPct=6.0, months=360, basis="30/360", start=[2026, 9, 1], lumpCents=10_000_00, lumpAt=24)),
    ("zero percent", dict(amountCents=12_000_00, annualPct=0.0, months=12, basis="30/360", start=[2026, 9, 1])),
    ("odd tiny loan", dict(amountCents=99_99, annualPct=4.375, months=6, basis="30/360", start=[2026, 12, 31])),
]

try:
    from patchright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport={"width": 1280, "height": 950})
        errs, external = [], []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("request", lambda r: None if "127.0.0.1" in r.url or r.url.startswith(("data:", "blob:"))
              else external.append(r.url))
        pg.goto(f"http://127.0.0.1:{PORT}/tool/loan.html", wait_until="load")
        pg.wait_for_timeout(300)
        cdp = pg.context.new_cdp_session(pg)

        def ev(x):
            r = cdp.send("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True})
            if "exceptionDetails" in r:
                raise RuntimeError(str(r["exceptionDetails"])[:500])
            return r["result"].get("value")

        print("\n  known truth and the third oracle")
        t("$200k, 6%, 30y payment is EXACTLY $1,199.10",
          ev("misc.paymentCents(20000000, 6, 360)"), 119910)

        print("\n  eight configurations, row by row, against the independent implementation")
        import json
        for label, cfg in CONFIGS:
            js = ev(f"(() => {{ const s = misc.schedule({json.dumps(cfg)});"
                    " return {rows: s.rows.map(r => ({k: r.k, date: r.date, payment: r.payment,"
                    " interest: r.interest, principal: r.principal, extra: r.extra, bal: r.bal})),"
                    " payCents: s.payCents, totalInterest: s.totalInterest, totalPaid: s.totalPaid}; })()")
            py = py_schedule(cfg["amountCents"], cfg["annualPct"], cfg["months"], cfg["basis"],
                             cfg["start"], cfg.get("extraCents", 0), cfg.get("lumpCents", 0), cfg.get("lumpAt", 1))
            t(f"{label}: payment agrees", js["payCents"], py["payCents"])
            t(f"{label}: row count agrees", len(js["rows"]), len(py["rows"]))
            diff = None
            for a, bb in zip(js["rows"], py["rows"]):
                if a != bb:
                    diff = (a, bb)
                    break
            t(f"{label}: EVERY row identical to the cent", diff is None, True)
            if diff:
                print(f"       js: {diff[0]}\n       py: {diff[1]}")
            t(f"{label}: total interest agrees", js["totalInterest"], py["totalInterest"])

            # identities
            paid_principal = sum(r["principal"] + r["extra"] for r in js["rows"])
            t(f"{label}: principal sums to the loan exactly", paid_principal, cfg["amountCents"])
            t(f"{label}: final balance is zero", js["rows"][-1]["bal"], 0)
            t(f"{label}: payment == interest + principal on every row",
              all(r["payment"] == r["interest"] + r["principal"] for r in js["rows"]))
            t(f"{label}: balance never negative", all(r["bal"] >= 0 for r in js["rows"]))

            if cfg["annualPct"] > 0:
                want_pmt = rnd(-float(npf.pmt(cfg["annualPct"] / 100 / 12, cfg["months"], cfg["amountCents"] / 100)) * 100)
                t(f"{label}: numpy-financial agrees on the payment", js["payCents"], want_pmt)

        print("\n  the UI path: typed inputs produce the same figures")
        pg.fill("#amount", "200,000")
        pg.fill("#rate", "6.000")
        pg.fill("#years", "30")
        pg.fill("#start", "2026-09-01")
        pg.wait_for_timeout(250)
        tiles = ev("document.getElementById('tiles').textContent")
        t("payment tile shows $1,199.10", "$1,199.10" in tiles)
        t("payoff tile shows Aug 1, 2056", "Aug 1, 2056" in tiles)
        t("schedule renders 360 rows + 31 year-subtotal rows",
          ev("document.querySelectorAll('#sched tbody tr').length"), 360 + 31)
        pg.fill("#extra", "200")
        pg.wait_for_timeout(250)
        t("savings tile appears with extra payments",
          "interest saved" in ev("document.getElementById('tiles').textContent"))
        saved_js = ev("(() => { const a = misc.schedule({amountCents: 20000000, annualPct: 6, months: 360, basis: '30/360', start: [2026,9,1]});"
                      " const b = misc.schedule({amountCents: 20000000, annualPct: 6, months: 360, basis: '30/360', start: [2026,9,1], extraCents: 20000});"
                      " return a.totalInterest - b.totalInterest; })()")
        a = py_schedule(200_000_00, 6.0, 360, "30/360", [2026, 9, 1])
        bb = py_schedule(200_000_00, 6.0, 360, "30/360", [2026, 9, 1], extra=200_00)
        t("interest-saved figure agrees with Python", saved_js, a["totalInterest"] - bb["totalInterest"])

        print("\n  hygiene")
        t("zero external requests", external, [])
        t("zero console errors", errs, [])
        pg.set_viewport_size({"width": 390, "height": 844})
        pg.wait_for_timeout(250)
        t("no horizontal scroll at phone width",
          ev("document.scrollingElement.scrollWidth <= window.innerWidth"))
        pg.screenshot(path=str(OUT / "loan_mobile.png"), full_page=False)
        pg.set_viewport_size({"width": 1280, "height": 950})
        pg.wait_for_timeout(250)
        pg.screenshot(path=str(OUT / "loan_desktop.png"))
        pg.close()

        pg2 = b.new_page()
        errs2, ext2 = [], []
        pg2.on("console", lambda m: errs2.append(m.text) if m.type == "error" else None)
        pg2.on("pageerror", lambda e: errs2.append(str(e)))
        pg2.on("request", lambda r: None if r.url.startswith(("file:", "data:", "blob:")) else ext2.append(r.url))
        pg2.goto((ROOT / "site" / "tool" / "loan.html").as_uri(), wait_until="load")
        pg2.wait_for_timeout(400)
        cdp2 = pg2.context.new_cdp_session(pg2)
        r = cdp2.send("Runtime.evaluate", {"expression": "misc.paymentCents(20000000, 6, 360)", "returnByValue": True})
        t("file: works from disk", r["result"].get("value"), 119910)
        t("file: zero external requests", ext2, [])
        t("file: zero console errors", errs2, [])
        pg2.close()
        b.close()
except Exception as e:
    import traceback
    traceback.print_exc()
    fails.append(f"harness: {type(e).__name__}: {e}")

srv.shutdown()
print(f"\n{'  ALL GREEN' if not fails else f'  {len(fails)} FAILURE(S)'}")
for f in fails[:14]:
    print("  x " + f)
sys.exit(1 if fails else 0)
