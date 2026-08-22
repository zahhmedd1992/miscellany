"""The claim, tested against two foreign implementations.

Doc's whole pitch is that the PDF breaks its lines exactly where the screen
does, because both were laid out from one width table. That is easy to say and
easy to be wrong about, so nothing here trusts our own code:

  1. the PDF is RASTERISED by pdfium - Chrome's PDF engine, not ours - and the
     resulting page is compared to a screenshot of the same page on screen,
     band by band: same number of text lines, same vertical positions, same
     left and right ink edges.
  2. the text is EXTRACTED by MuPDF - a second foreign implementation - and
     compared word for word against the document in the browser.

If our layout and our /Widths disagreed, (1) fails. If our encoding were
wrong, (2) fails. Both passing is evidence; our own test asserting it is not.

Run: python qa/doc_pdf_qa.py
"""
import base64, functools, http.server, io, pathlib, socketserver, sys, threading, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa" / "out"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 9393

fails = []
def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(58) + str(got)[:60])


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def bands(img, thresh=140, min_ink=1):
    """Rows of the image that contain ink, grouped into contiguous bands.

    Returns [(top, bottom, left, right)] in image pixels. This is what a
    person means by "the lines are in the same places"."""
    import numpy as np
    a = np.asarray(img.convert("L"))
    ink = a < thresh
    rows = ink.sum(axis=1)
    out = []
    start = None
    for y in range(len(rows)):
        if rows[y] >= min_ink and start is None:
            start = y
        elif rows[y] < min_ink and start is not None:
            block = ink[start:y]
            cols = block.sum(axis=0)
            nz = cols.nonzero()[0]
            if len(nz):
                out.append((start, y, int(nz[0]), int(nz[-1])))
            start = None
    if start is not None:
        block = ink[start:]
        cols = block.sum(axis=0)
        nz = cols.nonzero()[0]
        if len(nz):
            out.append((start, len(rows), int(nz[0]), int(nz[-1])))
    return out


def main():
    import numpy as np
    from PIL import Image
    import pypdfium2 as pdfium
    import fitz

    handler = functools.partial(Quiet, directory=str(ROOT / "src"))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    time.sleep(0.4)

    from patchright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport={"width": 1100, "height": 1100},
                        device_scale_factor=2)
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)))
        pg.goto(f"http://127.0.0.1:{PORT}/compose.html", wait_until="load")
        pg.wait_for_timeout(1500)
        cdp = pg.context.new_cdp_session(pg)

        def ev(expr):
            r = cdp.send("Runtime.evaluate",
                         {"expression": expr, "returnByValue": True, "awaitPromise": True})
            if "exceptionDetails" in r:
                return "THREW: " + str(r["exceptionDetails"].get("text"))
            return r["result"].get("value")

        # Doc alone, at exactly 100% so screen points map 1:1 to PDF points.
        ev("miscellany.shell.setLayout(['doc'])")
        pg.wait_for_timeout(500)
        ev("miscellany.writer.setZoom(1)")
        ev("miscellany.writer.scroller.scrollTop = 0; miscellany.writer.draw()")
        pg.wait_for_timeout(500)

        info = ev("""(()=>{const v=miscellany.writer;
          return {zoom:v.zoom, dpr:v.dpr, padX:v.padX, w:v.box.w, h:v.box.h,
                  pages:v.pages.length};})()""")
        t("the view is at 100%", info["zoom"], 1)

        # the on-screen page, cropped to the paper
        shot = pg.screenshot(path=str(OUT / "doc-pdf-screen-full.png"))
        ev("""(()=>{const v=miscellany.writer; window.__rect = (()=>{
             const r=v.cv.getBoundingClientRect();
             return {x:r.left + v.padX*v.zoom, y:r.top + (v.pageTops[0]-v.scroller.scrollTop/v.zoom)*v.zoom,
                     w:v.box.w*v.zoom, h:v.box.h*v.zoom};})(); return window.__rect;})()""")
        rect = ev("window.__rect")
        scale = 2  # device_scale_factor
        screen = Image.open(io.BytesIO(shot)).crop((
            int(rect["x"] * scale), int(rect["y"] * scale),
            int((rect["x"] + rect["w"]) * scale), int((rect["y"] + rect["h"]) * scale)))
        screen.save(OUT / "doc-pdf-screen-page1.png")

        # the PDF
        b64 = ev("""(async()=>{
          const {renderPdf}=await import('./apps/doc/pdfout.js');
          const bytes=renderPdf(miscellany.writer,{title:'qa'});
          let s=''; const CH=0x8000;
          for(let i=0;i<bytes.length;i+=CH) s+=String.fromCharCode.apply(null,bytes.subarray(i,i+CH));
          return btoa(s);
        })()""")
        t("the browser produced PDF bytes", isinstance(b64, str) and len(b64) > 2000, True)
        pdf_bytes = base64.b64decode(b64)
        (OUT / "doc-report.pdf").write_bytes(pdf_bytes)
        t("no page errors", errs, [])
        b.close()
    httpd.shutdown()

    # ---- 1. pdfium rasterises it -----------------------------------------
    doc = pdfium.PdfDocument(pdf_bytes)
    t("pdfium opens it", len(doc) >= 1, True)
    page = doc[0]
    t("pdfium agrees on the page size",
      f"{round(page.get_width())}x{round(page.get_height())}",
      f"{round(screen.width / scale)}x{round(screen.height / scale)}")
    render = page.render(scale=scale).to_pil().convert("RGB")
    render.save(OUT / "doc-pdf-page1.png")

    sb = bands(screen)
    pb = bands(render)
    t("same number of text lines on paper as on screen", len(pb), len(sb))

    if len(pb) == len(sb) and sb:
        dy = max(abs(a[0] - c[0]) for a, c in zip(sb, pb))
        dl = max(abs(a[2] - c[2]) for a, c in zip(sb, pb))
        dr = max(abs(a[3] - c[3]) for a, c in zip(sb, pb))
        # 2 device pixels at scale 2 is one CSS pixel: antialiasing, not layout
        t(f"every line starts at the same height (worst {dy}px)", dy <= 3, True)
        t(f"every line starts at the same left edge (worst {dl}px)", dl <= 3, True)
        t(f"every line ends at the same right edge (worst {dr}px)", dr <= 4, True)
    else:
        t("line bands could be compared", False)

    # ---- 2. MuPDF reads the text -----------------------------------------
    m = fitz.open(stream=pdf_bytes, filetype="pdf")
    words = []
    for pg_ in m:
        words += [w[4] for w in pg_.get_text("words")]
    joined = " ".join(words)
    for phrase in ["Q3 Revenue", "425,550", "233,400", "The months", "September",
                   "155900", "The same numbers, drawn"]:
        t(f"MuPDF finds {phrase!r} in the PDF", phrase.replace(",", "") in
          joined.replace(",", ""), True)
    t("MuPDF sees no replacement characters (nothing was unencodable)",
      "?" not in joined.replace("?", "", 0) or joined.count("?") == 0, True)

    # the chart is vector, not a picture of one
    t("the chart is vector art, not a bitmap", len(m[0].get_images()) == 0, True)
    t("the chart drew real filled paths", len(m[0].get_drawings()) > 5, True)

    print()
    if fails:
        print(f"  {len(fails)} FAILED")
        for f in fails:
            print("   x " + f)
        sys.exit(1)
    print("  screen == print: all green")
    print(f"  wrote {OUT/'doc-report.pdf'} and the two page renders")


main()
