"""A real Word document, through the real buttons, on the live site.

Everything else about .docx is tested in Node against the corpus. This is the
one check that the BUTTONS are wired to it: pick a file with the file input,
type into the document, press Save, catch the download, and then verify the
saved bytes with Python's zipfile — which is not our code.

Run: python qa/live_docx_qa.py
"""
import pathlib, sys, tempfile, zipfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "docx" / "files"
SITE = "https://miscellany.io"
WML = {"http://schemas.openxmlformats.org/wordprocessingml/2006/main",
       "http://purl.oclc.org/ooxml/wordprocessingml/main"}

fails = []


def t(name, got, want=True):
    ok = str(got) == str(want)
    if not ok:
        fails.append(f"{name}\n      want: {want}\n      got : {got}")
    print(("  ok   " if ok else "  FAIL ") + name.ljust(56) + str(got)[:52])


def text_of(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
        return "".join(
            (e.text or "") for e in root.iter()
            if e.tag.startswith("{") and e.tag.split("}")[0][1:] in WML
            and e.tag.split("}")[1] == "t"), z.namelist()


def main():
    source = SRC / "va-ibc-minutes.docx"
    if not source.exists():
        print("  corpus file missing — run: python corpus/build_docx_corpus.py")
        return
    before, parts_before = text_of(source)

    from patchright.sync_api import sync_playwright
    tmp = pathlib.Path(tempfile.mkdtemp())
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport={"width": 1400, "height": 950}, accept_downloads=True)
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.goto(f"{SITE}/app/doc.html", wait_until="load")
        pg.wait_for_timeout(1500)
        cdp = pg.context.new_cdp_session(pg)

        def ev(expr):
            r = cdp.send("Runtime.evaluate",
                         {"expression": expr, "returnByValue": True, "awaitPromise": True})
            if "exceptionDetails" in r:
                return "THREW: " + str(r["exceptionDetails"].get("text"))
            return r["result"].get("value")

        # the real button opens a real file picker
        with pg.expect_file_chooser() as fc:
            pg.click("button:has-text('Open .docx')")
        fc.value.set_files(str(source))
        pg.wait_for_timeout(2500)

        t("the document opened", ev("!!miscellany.view.docx"))
        t("with its paragraphs", ev("miscellany.view.blocks.length > 40"))
        t("and it says what it kept but cannot show",
          ev("document.querySelector('.gr-save').textContent.includes('kept but not shown')"))
        pg.screenshot(path=str(ROOT / "qa" / "out" / "live-05-docx.png"))

        # type into it, through the keyboard
        ev("""(()=>{ const v = miscellany.view;
          const b = v.blocks.find(x => x.kind==='para' && x.text.trim().length > 3);
          v.caret = {id: b.id, off: b.text.length}; v.anchor = null;
          v.input.focus(); return b.id; })()""")
        pg.keyboard.type(" EDITED-LIVE")
        pg.wait_for_timeout(700)
        t("the edit reached the document",
          ev("miscellany.view.blocks.some(b => (b.text||'').includes('EDITED-LIVE'))"))

        with pg.expect_download() as dl:
            pg.click("button:has-text('Save .docx')")
        saved = tmp / "out.docx"
        dl.value.save_as(str(saved))
        t("a file came back", saved.exists() and saved.stat().st_size > 5000, True)
        t("no console errors", [e for e in errs if "cloudflareinsights" not in e
                                and "Content Security Policy" not in e], [])
        b.close()

    # ---- verified by something that is not us --------------------------
    after, parts_after = text_of(saved)
    t("Python's zipfile opens it", zipfile.ZipFile(saved).testzip(), None)
    t("every part survived", parts_after, parts_before)
    t("the edit is in it exactly once", after.count("EDITED-LIVE"), 1)
    t("and nothing else in the text moved", len(after) - len(before), len(" EDITED-LIVE"))

    with zipfile.ZipFile(source) as a, zipfile.ZipFile(saved) as c:
        differ = [n for n in a.namelist() if n != "word/document.xml" and a.read(n) != c.read(n)]
    t("only the document part changed", differ, [])
    print(f"\n  {saved}")

    if fails:
        print(f"  {len(fails)} FAILED")
        for f in fails:
            print("   x " + f)
        sys.exit(1)
    print("  a real Word document, edited on the live site: all green")


main()
