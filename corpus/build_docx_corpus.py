"""Build and LOCK the .docx test corpus.

Same discipline as `build_corpus.py` (xlsx) and `pdf/fetch_pdf_corpus.py`:
the corpus is fixed and published BEFORE the WordprocessingML reader exists.
Otherwise the person being graded picks the exam at grading time, and a binary
gate quietly becomes a vibe with a number on it.

Two tiers:
  A  real-world documents a normal person would actually have — government
     forms, university thesis templates, WHO report templates, standards-body
     working procedures, journal author templates.
  B  adversarial: chosen for GENERATOR DIVERSITY and FEATURE COVERAGE. Word,
     Google Docs, LibreOffice, pandoc, Aspose, POI and hand-rolled emitters all
     produce structurally different WordprocessingML for the same document.

CHARACTERISATION is the load-bearing part. Every file is measured by THIS
implementation — standard library only, `zipfile` + `xml.etree`, namespace-aware
parsing. Deliberately NOT python-docx: an inherited model would make the oracle
non-independent, and the whole point is that two implementations built on
different strategies must agree. The reader (JavaScript, an offset-preserving
scanner) will be asserted against these numbers EXACTLY.

Usage
  python corpus/build_docx_corpus.py                  verify on-disk hashes against the lock
  python corpus/build_docx_corpus.py --rebuild        full fetch + derive + characterise + write lock
  python corpus/build_docx_corpus.py --refetch        re-download every recorded URL, compare sha256
  python corpus/build_docx_corpus.py --recharacterise re-read from disk, ASSERT hashes unchanged,
                                                      recompute characterisation
  python corpus/build_docx_corpus.py --add-missing    fetch only slugs absent from the lock
  python corpus/build_docx_corpus.py --gates          run and report the sanity gates
  python corpus/build_docx_corpus.py --publish        regenerate ../CORPUS_DOCX.md from the lock
  python corpus/build_docx_corpus.py --verify-docs    assert every published number matches the lock
"""

import hashlib
import io
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
FILES = HERE / "docx" / "files"
LOCK = HERE / "docx.json"
LOCK_DATE = "2026-08-22"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36")
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# ---------------------------------------------------------------------------
# Namespaces.
#
# TRAP #1, and it is not the xlsx trap wearing a hat. OOXML ships in TWO
# conformance classes with DIFFERENT namespace URIs for the same elements:
#
#   transitional  http://schemas.openxmlformats.org/wordprocessingml/2006/main
#   strict        http://purl.oclc.org/ooxml/wordprocessingml/main
#
# Word writes transitional by default and strict on request ("Strict Open XML
# Document" in the Save-As dialog). A reader that hardcodes the transitional URI
# opens a strict file, finds zero paragraphs, and reports success. Matching on
# local name alone is the opposite failure: <m:r> (a math run) and <w:r> (a text
# run) share a local name and mean different things.
#
# So: match local name AND require the namespace to be one of the known WML URIs.
# ---------------------------------------------------------------------------
WML = {
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
}
WP_DRAWING = {
    "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing",
}
OMML = {
    "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "http://purl.oclc.org/ooxml/officeDocument/math",
}
PKG_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"


def split(tag):
    """'{uri}local' -> (uri, local). ElementTree hands back Clark notation, which
    is prefix-agnostic by construction — the prefix a producer chose is already
    resolved away. That is exactly the property the xlsx characteriser lacked."""
    if tag.startswith("{"):
        uri, _, local = tag[1:].partition("}")
        return uri, local
    return "", tag


def is_w(el, *names):
    uri, local = split(el.tag)
    return uri in WML and local in names


# ---------------------------------------------------------------------------
# Tier A — representative. Real documents from public / government /
# institutional sources. Spread deliberately across issuer families so one
# producer's quirks cannot dominate: US federal, US state, universities, WHO,
# a standards body, journal publishers, an EU agency, an NGO.
# ---------------------------------------------------------------------------
CANDIDATES = [
    # --- US federal ---
    ("va-ibc-minutes", "https://www.research.va.gov/programs/biosafety/Example-VA-IBC-Meeting-Minutes-Template.docx",
     "US Dept of Veterans Affairs — institutional biosafety committee meeting minutes"),
    ("usda-perf-report", "https://www.ams.usda.gov/sites/default/files/media/Performance_Report_Annual_Template_FY22.docx",
     "USDA Agricultural Marketing Service — annual performance report template"),
    ("doj-mou-fillable", "https://cops.usdoj.gov/pdf/tribal_training/MOU_MOA/Templates_and_Reference_Documents/Fillable_Template_MOU.docx",
     "US DOJ COPS Office — fillable memorandum of understanding"),
    ("arpah-policy", "https://arpa-h.gov/sites/default/files/2024-10/Administrative%20and%20National%20Policy%20Template.docx",
     "ARPA-H — administrative and national policy template"),
    # --- US state ---
    ("in-dhs-minutes", "https://www.in.gov/dhs/files/Meeting-Minutes-Template.docx",
     "Indiana Dept of Homeland Security — meeting minutes template"),
    ("or-oha-minutes", "https://www.oregon.gov/oha/PH/PREVENTIONWELLNESS/SAFELIVING/CHILDDEATHREVIEWPREVENTION/CountyToolkit/Agenda-Minutes-Template.docx",
     "Oregon Health Authority — agenda and minutes template"),
    ("sc-annual-report", "https://ed.sc.gov/sites/scdoe/assets/2022%20Annual%20Report%20Template.docx",
     "South Carolina Dept of Education — school annual report template"),
    ("ky-pbm-policy", "https://insurance.ky.gov/ppc/documents/PBM%20External%20Annual%20Report%20Policy.docx",
     "Kentucky Dept of Insurance — pharmacy benefit manager reporting policy"),
    # --- universities (.edu) ---
    ("gatech-thesis", "https://grad.gatech.edu/sites/default/files/documents/gatechthesis_word_-_08262016.docx",
     "Georgia Tech — graduate thesis template"),
    ("mtu-thesis", "https://www.mtu.edu/gradschool/policies-procedures/theses-dissertations/formatting/docs/thesis-template.docx",
     "Michigan Tech — thesis template (large, image-heavy)"),
    ("baylor-dissertation", "https://graduate.baylor.edu/sites/g/files/ecbvkj1751/files/2024-08/New%20Dissertation_Thesis%20Model%202024.docx",
     "Baylor University — dissertation / thesis model"),
    # --- WHO (three different hosts / production pipelines) ---
    ("who-pqs-lab", "https://extranet.who.int/prequal/sites/default/files/document_files/PQS%20lab%20report%20template.docx",
     "WHO Prequalification — laboratory report template"),
    ("who-phsa-long", "https://healthcluster.who.int/docs/librariesprovider16/meeting-reports/updated-phsa-long-form-template-english-june-2019.docx?sfvrsn=81cd6a71_3",
     "WHO Health Cluster — public health situation analysis, long form"),
    ("who-steps-country", "https://cdn.who.int/media/docs/default-source/ncds/ncd-surveillance/steps/steps-country-report-template.docx?sfvrsn=ade98ee1_4",
     "WHO STEPS — NCD surveillance country report template"),
    # --- standards body: 3GPP publishes its governing documents as Word ---
    ("3gpp-working-proc", "https://ftp.3gpp.org/Information/Working_Procedures/3GPP_WP.docx",
     "3GPP — Working Procedures (governing document of the partnership)"),
    ("3gpp-working-proc-rm", "https://ftp.3gpp.org/Information/Working_Procedures/3GPP_WP_rm.docx",
     "3GPP — Working Procedures, REVISION-MARKED (real-world tracked changes)"),
    # --- journal / conference publishers ---
    ("acm-taps-template", "https://www.acm.org/binaries/content/assets/publications/taps/acm_submission_template.docx",
     "ACM — TAPS primary article submission template"),
    ("plos-strobe-mr", "https://journals.plos.org/plosone/s/file?id=ecd5/STROBE-MR-checklist-fillable.docx",
     "PLOS ONE — STROBE-MR reporting checklist, fillable"),
    # --- EU agency ---
    ("ema-orphan-app", "https://www.ema.europa.eu/en/documents/template-form/template-sections-e-scientific-part-application-orphan-designation_en.docx",
     "European Medicines Agency — orphan designation application, scientific part"),
    # --- NGO, non-Latin script ---
    ("iawg-arabic", "https://cdn.iawg.rygn.io/documents/12-Template-I-Arabic-Language.docx?v=1581033254",
     "Inter-Agency Working Group — Arabic-language training template (RTL, 1.7MB)"),
]

# ---------------------------------------------------------------------------
# Tier B — adversarial. Two origins:
#
#   downloaded  a real file from an OSS test suite, fetched from a stable raw
#               URL. These carry authentic producer fingerprints — a file Word
#               wrote is not a file pandoc wrote.
#   derived     built HERE, by deterministic code in this script, from a Tier A
#               or Tier B file that is itself locked by URL + sha256. Derived
#               entries are byte-reproducible on a fresh clone; a file produced
#               by running Word or pandoc locally would NOT be (both stamp
#               timestamps, rsids and GUIDs into every save), so nothing in this
#               corpus depends on a local install.
# ---------------------------------------------------------------------------
POI = "https://raw.githubusercontent.com/apache/poi/trunk/test-data/document/"
TIKA = ("https://raw.githubusercontent.com/apache/tika/main/tika-parsers/"
        "tika-parsers-standard/tika-parsers-standard-modules/"
        "tika-parser-microsoft-module/src/test/resources/test-documents/")
PANDOC = "https://raw.githubusercontent.com/jgm/pandoc/main/test/docx/"
PANDOC_GOLD = "https://raw.githubusercontent.com/jgm/pandoc/main/test/docx/golden/"
MAMMOTH = "https://raw.githubusercontent.com/mwilliamson/mammoth.js/master/test/test-data/"
D2P = "https://raw.githubusercontent.com/ShayHill/docx2python/master/tests/resources/"
DOCXTPL = "https://raw.githubusercontent.com/elapouya/python-docx-template/master/tests/templates/"
DOCXTEMPLATER = "https://raw.githubusercontent.com/open-xml-templating/docxtemplater/master/examples/"
ASPOSE = "https://raw.githubusercontent.com/aspose-words/Aspose.Words-for-.NET/master/Examples/Data/"

# Every entry below earned its slot by covering something NO other file in the
# corpus covers. Anything that merely duplicated existing coverage was cut —
# a 40-file corpus where 25 files prove the same thing is a 15-file corpus with
# a marketing problem. What each one is for is stated, and the claim is checkable
# against its row in docx.json.
ADVERSARIAL = [
    # ---- generator diversity: different producers, structurally different XML ----
    ("adv-google-docs", D2P + "test-docx2python-conversion-google_docs.docx",
     "GOOGLE DOCS export — 9 parts, and NO docProps at all, so `generator` is genuinely absent"),
    ("adv-libreoffice-lin", POI + "saut_page.docx",
     "LIBREOFFICE 25.8 on Linux, and the largest file here at 2.9MB — generator and scale at once"),
    ("adv-libreoffice-win", D2P + "libreoffice_conversion.docx",
     "LIBREOFFICE 7.1 on Windows — 1,322 paragraphs, text boxes, anchored images"),
    ("adv-apple-pages", D2P + "created-in-pages-bulleted-lists.docx",
     "APPLE PAGES export — a producer nobody tests against, also with no docProps"),
    ("adv-wps-office", TIKA + "testWPSAttachment.docx",
     "WPS OFFICE (Kingsoft) — a non-Microsoft suite, and its document.xml has no text at all"),
    ("adv-word-mac-move", PANDOC + "track_changes_move.docx",
     "WORD FOR MAC, carrying a tracked MOVE (paired moveFrom / moveTo, not ins+del)"),
    ("adv-pandoc-tables", PANDOC_GOLD + "tables.docx",
     "PANDOC output — note it declares itself `Microsoft Word 12.0.0`; the generator string lies"),
    # ---- the namespace itself is the hazard ----
    ("adv-strict-ooxml", MAMMOTH + "strict-format.docx",
     "STRICT OOXML — the whole document is in purl.oclc.org/ooxml/..., not schemas.openxmlformats.org"),
    ("adv-prefix-ns0", PANDOC + "ns0-reference.docx",
     "Every WML element under the prefix `ns0:` instead of `w:` — found in the wild, not synthesised"),
    ("adv-alt-doc-path", PANDOC + "alternate_document_path.docx",
     "The main document part is NOT at word/document.xml — it must be resolved through _rels/.rels"),
    # ---- feature omnibus and structural extremes ----
    ("adv-all-features", TIKA + "testWORD_2006ml.docx",
     "One file carrying tables, lists, images, headers, footnotes, endnotes, comments, tracked "
     "changes, content controls, OMML, a text box, an embedded object and anchored images"),
    ("adv-deep-tables", POI + "deep-table-cell.docx",
     "5,000 tables nested 4,999 deep — element depth 15,004. A recursive reader dies here"),
    ("adv-merged-cells", D2P + "merged_cells.docx",
     "Horizontal (gridSpan) and vertical (vMerge) cell merges"),
    ("adv-header-footer-only", POI + "headerFooter.docx",
     "ALL of its text lives in header/footer parts — document.xml has zero characters, legitimately"),
    ("adv-many-paragraphs", D2P + "imagedata_without_rid.docx",
     "31,190 paragraphs / 800,115 characters / 661 tables — the scale failure mode, and an "
     "image relationship that does not resolve"),
    ("adv-page-setups", ASPOSE + "Rendering.docx",
     "THREE different page setups in one document, one of them LANDSCAPE — plus a footnote, "
     "an endnote and two text boxes"),
    ("adv-comments-many", D2P + "comments.docx",
     "Eight comments — anchored by commentRangeStart/End marks that are siblings of the text, "
     "not parents of it"),
    ("adv-hebrew-rtl", DOCXTEMPLATER + "expected-loop-hebrew.docx",
     "Hebrew — right-to-left text, and a third distinct spelling of the generator (`Microsoft word`)"),
]

# Derived adversarial files. Each is a deterministic transform of a source that
# is itself locked by URL + sha256, so `--rebuild` reproduces them byte-for-byte
# on any machine. Nothing here depends on a local Word or LibreOffice install:
# both stamp timestamps, rsids and GUIDs into every save, so a locally-generated
# file could never be re-verified against a hash.
#
# TRAP #2, and it INVERTS the xlsx one. In SpreadsheetML the ordinary case is a
# default namespace (<worksheet><c>) and the prefix (<x:c>) is the surprise. In
# WordprocessingML it is the other way round: essentially every producer writes
# `w:`, so a reader can accumulate a hardcoded dependence on the literal string
# "w:" and never once be caught by a real file. adv-prefix-ns0 above proves a
# non-`w` prefix occurs naturally; these two prove the no-prefix case as well.
DERIVED = [
    ("adv-prefix-default", "adv-pandoc-tables", "reprefix", "",
     "The WML namespace as the DEFAULT namespace — <p>, <r>, <t>, no prefix on any element"),
    ("adv-prefix-exotic", "adv-pandoc-tables", "reprefix", "zzz",
     "Every WML element under the prefix `zzz:` — a prefix no producer would ever pick"),
]


# ---------------------------------------------------------------------------
# Zero-text exemptions.
#
# The gate was written as "textChars > 0 for every file — a zero is either a
# broken download or a broken characteriser". Two files fail it and are NEITHER.
# There is a third case the gate did not anticipate: a perfectly valid .docx
# whose document.xml genuinely contains no <w:t> at all.
#
# So the exemption is not a waiver, it is a NARROWER assertion. Each entry names
# the reason AND a predicate that must still hold. If a future download silently
# becomes a 404 page or the characteriser regresses, the predicate stops holding
# and the gate fails again. An exemption that cannot go stale is the only kind
# worth granting.
# ---------------------------------------------------------------------------
ZERO_TEXT_EXPECTED = {
    "adv-header-footer-only": (
        "Body is one empty <w:p/> plus a sectPr referencing six header/footer parts. "
        "All 54 characters live in word/header2.xml and word/footer2.xml. Verified "
        "independently by raw regex: 0 <*:t> elements in document.xml.",
        lambda f: f["textCharsOtherParts"] > 0 and f["hasHeaders"] and f["hasFooters"],
    ),
    "adv-wps-office": (
        "WPS Office wrote a document whose single run holds a <w:object> — a VML "
        "shape wrapping an OLE embedding. Five oleObject*.bin parts, and no <w:t> "
        "anywhere in the package. Verified independently by raw regex: 0 <*:t>.",
        lambda f: f["objects"] > 0 and f["embeddings"] > 0 and f["textCharsOtherParts"] == 0,
    ),
}


# ---------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------
def fetch(url, timeout=90):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------------------
# derive
# ---------------------------------------------------------------------------
def reprefix(data, new_prefix):
    """Rewrite word/document.xml so every WordprocessingML element carries
    `new_prefix` ("" = make WML the default namespace) instead of whatever the
    producer used. Everything else in the package is copied byte-for-byte.

    This is a legitimate OOXML transform, not a strawman: XML namespace prefixes
    are not part of the infoset. Word opens the result without a repair prompt —
    recorded per entry as `validatedBy`."""
    zin = zipfile.ZipFile(io.BytesIO(data))
    part = main_document_part(zin)
    xml = zin.read(part).decode("utf-8")

    # Find the prefix currently bound to the WML namespace.
    m = re.search(r'xmlns:([A-Za-z_][\w.\-]*)="(%s)"' % "|".join(re.escape(u) for u in WML), xml)
    if not m:
        raise ValueError("no prefixed WML namespace declaration to rewrite")
    old, uri = m.group(1), m.group(2)

    # Swap the declaration.
    if new_prefix:
        xml = xml.replace(f'xmlns:{old}="{uri}"', f'xmlns:{new_prefix}="{uri}"', 1)
    else:
        xml = xml.replace(f'xmlns:{old}="{uri}"', f'xmlns="{uri}"', 1)

    # Swap element names: <old:x ...>, </old:x>. Attribute names in the same
    # namespace (w:val, w:rsidR) must move too — an attribute's prefix binds to
    # the same declaration, and dropping it to "no prefix" would change its
    # meaning (unprefixed attributes are in NO namespace), so when new_prefix is
    # "" the attributes keep an explicit prefix via a second declaration.
    tag_re = re.compile(r'(</?)%s:' % re.escape(old))
    if new_prefix:
        xml = tag_re.sub(r'\g<1>%s:' % new_prefix, xml)
        xml = re.sub(r'(\s)%s:' % re.escape(old), r'\g<1>%s:' % new_prefix, xml)
    else:
        # Keep `old` bound as well, for attributes, then null out element prefixes.
        xml = xml.replace(f'xmlns="{uri}"', f'xmlns="{uri}" xmlns:{old}="{uri}"', 1)
        xml = tag_re.sub(r'\g<1>', xml)

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            payload = xml.encode("utf-8") if info.filename == part else zin.read(info.filename)
            # Fixed timestamp: a derived entry must be byte-reproducible.
            ni = zipfile.ZipInfo(info.filename, date_time=(1980, 1, 1, 0, 0, 0))
            ni.compress_type = zipfile.ZIP_DEFLATED
            ni.external_attr = info.external_attr
            zout.writestr(ni, payload)
    return out.getvalue()


DERIVERS = {"reprefix": reprefix}


# ---------------------------------------------------------------------------
# characterise
# ---------------------------------------------------------------------------
def main_document_part(zf):
    """Resolve the main document part through the package relationships rather
    than assuming `word/document.xml`.

    TRAP #3: the path is a convention, not a rule. OPC says find the part whose
    relationship type ends in `/officeDocument` from `_rels/.rels`. Producers
    that honour the spec but not the convention exist, and so do macro-enabled
    files where the part is named differently."""
    try:
        rels = ET.fromstring(zf.read("_rels/.rels"))
    except Exception:
        rels = None
    if rels is not None:
        for rel in rels:
            t = rel.get("Type", "")
            if t.endswith("/officeDocument"):
                target = rel.get("Target", "").lstrip("/")
                if target in zf.namelist():
                    return target
                # Targets may be relative to the package root.
                alt = target.split("/")[-1]
                for n in zf.namelist():
                    if n.endswith("/" + alt) or n == alt:
                        return n
    for guess in ("word/document.xml", "word/document2.xml"):
        if guess in zf.namelist():
            return guess
    raise KeyError("no main document part")


def _prefix_of(xml_text, local):
    """The prefix a producer actually wrote on `<local ...>`, read from the raw
    bytes. ElementTree resolves prefixes away — correct for counting, useless for
    reporting what a byte-level reader will actually meet."""
    m = re.search(r'<([A-Za-z_][\w.\-]*:)?%s[\s/>]' % re.escape(local), xml_text)
    if not m:
        return None
    return (m.group(1) or ":")[:-1]


def characterise(data):
    """Measure one .docx. Returns None if it is not a readable OOXML document —
    a rejection with a reason, never a silently-zero row."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        # Branch on the actual magic. A password-protected .docx is not a
        # damaged zip — it is an OLE/CFB compound file (D0 CF 11 E0) with the
        # real package encrypted inside it, so "corrupt" would be the wrong
        # diagnosis and would send someone hunting a download bug that is not there.
        if data[:4] == bytes((0xD0, 0xCF, 0x11, 0xE0)):
            return None, ("OLE/CFB compound file, not a zip — this is a "
                          "password-protected .docx; the OOXML package is encrypted inside it")
        if data[:2] == b"PK":
            return None, "starts with PK but the zip is unreadable (truncated or damaged archive)"
        return None, f"not a zip (leading bytes {data[:4]!r})"
    names = zf.namelist()
    try:
        part = main_document_part(zf)
    except KeyError:
        return None, "no main document part"
    try:
        raw = zf.read(part)
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        return None, f"document XML will not parse: {e}"
    except Exception as e:
        return None, f"cannot read {part}: {type(e).__name__}"

    uri, local = split(root.tag)
    if local != "document" or uri not in WML:
        return None, f"root element is {{{uri}}}{local}, not a WML document"

    text = raw.decode("utf-8", "replace")

    # ---- body ----------------------------------------------------------
    body = None
    for child in root:
        if is_w(child, "body"):
            body = child
            break
    body_paras = sum(1 for c in body if is_w(c, "p")) if body is not None else 0

    # ---- document-order walk -------------------------------------------
    # A single pre-order pass. `.iter()` yields document order, which is what
    # makes textSha256 meaningful: a reordering that leaves textChars unchanged
    # still moves the hash.
    counts = dict.fromkeys(
        ("allParagraphs", "runs", "tables", "tableCells", "tableRows", "hyperlinks",
         "sections", "numberedParas", "drawings", "inlineImages", "floatingImages",
         "textBoxes", "sdt", "insertions", "deletions", "moveFrom", "moveTo",
         "fldSimple", "instrText", "footnoteRefs", "endnoteRefs", "commentRefs",
         "objects", "altChunks", "breaks", "bookmarks", "omml", "rtlRuns",
         "emptyTextEls", "preserveSpaceEls", "deletedTextChars",
         "gridSpan", "vMerge", "altContent", "canvas"), 0)
    max_ilvl = -1
    chunks = []
    for el in root.iter():
        uri, local = split(el.tag)
        if uri in WML:
            if local == "p":
                counts["allParagraphs"] += 1
                # numPr must hang off THIS paragraph's own pPr. Using a subtree
                # search would mark a paragraph numbered because a paragraph in
                # a nested table inside it is numbered.
                for pr in el:
                    if is_w(pr, "pPr"):
                        for x in pr:
                            if is_w(x, "numPr"):
                                counts["numberedParas"] += 1
                                # w:ilvl is 0-based; >0 proves a MULTI-level list,
                                # which "has a numPr" alone does not.
                                for lv in x:
                                    if is_w(lv, "ilvl"):
                                        v = next((v for k, v in lv.attrib.items()
                                                  if k.endswith("}val") or k == "val"), None)
                                        if v is not None and v.isdigit():
                                            max_ilvl = max(max_ilvl, int(v))
                                break
                        break
            elif local == "r":
                counts["runs"] += 1
            elif local == "t":
                # xml:space semantics preserved exactly as stored: take the
                # character data verbatim. No strip, no collapse, and an empty
                # <w:t/> contributes the empty string rather than being skipped.
                chunks.append(el.text or "")
                if not el.text:
                    counts["emptyTextEls"] += 1
                if el.get("{http://www.w3.org/XML/1998/namespace}space") == "preserve":
                    counts["preserveSpaceEls"] += 1
            elif local == "delText":
                counts["deletedTextChars"] += len(el.text or "")
            elif local == "tbl":
                counts["tables"] += 1
            elif local == "tc":
                counts["tableCells"] += 1
            elif local == "tr":
                counts["tableRows"] += 1
            elif local == "hyperlink":
                counts["hyperlinks"] += 1
            elif local == "sectPr":
                counts["sections"] += 1
            elif local == "drawing":
                counts["drawings"] += 1
            elif local == "txbxContent":
                counts["textBoxes"] += 1
            elif local == "sdt":
                counts["sdt"] += 1
            elif local == "ins":
                counts["insertions"] += 1
            elif local == "del":
                counts["deletions"] += 1
            elif local == "moveFrom":
                counts["moveFrom"] += 1
            elif local == "moveTo":
                counts["moveTo"] += 1
            elif local == "fldSimple":
                counts["fldSimple"] += 1
            elif local == "instrText":
                counts["instrText"] += 1
            elif local == "footnoteReference":
                counts["footnoteRefs"] += 1
            elif local == "endnoteReference":
                counts["endnoteRefs"] += 1
            elif local == "commentReference":
                counts["commentRefs"] += 1
            elif local == "object":
                counts["objects"] += 1
            elif local == "altChunk":
                counts["altChunks"] += 1
            elif local == "br":
                counts["breaks"] += 1
            elif local == "bookmarkStart":
                counts["bookmarks"] += 1
            elif local == "rtl":
                counts["rtlRuns"] += 1
            elif local == "gridSpan":
                counts["gridSpan"] += 1
            elif local == "vMerge":
                counts["vMerge"] += 1
        elif local == "wpc" and uri.endswith("/wordprocessingCanvas"):
            counts["canvas"] += 1
        elif local == "AlternateContent" and uri.endswith("/markup-compatibility/2006"):
            # mc:AlternateContent holds a Choice AND a Fallback that describe the
            # SAME content two ways. Both carry <w:t>. A reader that honours
            # markup compatibility sees each string once; a flat scan sees it
            # twice. textChars counts every <w:t> as stored, so this number is
            # deliberately the flat one — see the report.
            counts["altContent"] += 1
        elif uri in WP_DRAWING:
            if local == "inline":
                counts["inlineImages"] += 1
            elif local == "anchor":
                counts["floatingImages"] += 1
        elif uri in OMML and local in ("oMath", "oMathPara"):
            counts["omml"] += 1

    blob = "".join(chunks)

    # ---- nested tables --------------------------------------------------
    # A <w:tbl> whose ancestor chain passes through a <w:tc>. "More than one
    # table" is NOT the same thing — two tables side by side are not nested, and
    # nesting is the case that breaks a reader that flattens by document order.
    # ITERATIVE, with an explicit stack, and not as a style preference:
    # `deep-table-cell.docx` nests tables about a thousand deep, and the obvious
    # recursive walk dies with RecursionError before it counts anything. Any
    # reader that recurses over the element tree has the same cliff — and a
    # thousand-deep document is a valid document.
    nested_tables = 0
    max_depth = 0
    stack = [(root, False, 0)]
    while stack:
        el, in_cell, depth = stack.pop()
        max_depth = max(max_depth, depth)
        for c in el:
            uri_c, loc_c = split(c.tag)
            wml = uri_c in WML
            if wml and loc_c == "tbl" and in_cell:
                nested_tables += 1
            stack.append((c, in_cell or (wml and loc_c == "tc"), depth + 1))

    # ---- text living OUTSIDE the main document part ---------------------
    # textChars deliberately measures document.xml only, because that is the
    # part a reader parses first and the number the reader test asserts. But a
    # file whose visible text lives entirely in a header is NOT broken, and a
    # bare "textChars == 0" cannot tell that apart from a failed download. So
    # measure the other parts too, and put the diagnosis in the lock where it is
    # auditable rather than in prose where it is a claim.
    other = {}
    for n in names:
        if not re.search(r"/(header\d*|footer\d*|footnotes|endnotes|comments)\.xml$", n):
            continue
        try:
            r = ET.fromstring(zf.read(n))
        except Exception:
            continue
        c = sum(len(e.text or "") for e in r.iter() if is_w(e, "t"))
        if c:
            other[n] = c

    # Script coverage, measured from the text rather than assumed from a filename.
    def has_range(lo, hi):
        return any(lo <= ord(ch) <= hi for ch in blob)
    rtl_text = has_range(0x0590, 0x05FF) or has_range(0x0600, 0x06FF) or has_range(0x0750, 0x077F)
    non_latin = rtl_text or has_range(0x0400, 0x04FF) or has_range(0x3000, 0x9FFF) \
        or has_range(0xAC00, 0xD7AF) or has_range(0x0900, 0x097F) or has_range(0x0370, 0x03FF)

    # ---- other parts ---------------------------------------------------
    def count_in(partname, *locals_):
        if partname not in names:
            return 0
        try:
            r = ET.fromstring(zf.read(partname))
        except Exception:
            return 0
        return sum(1 for e in r.iter() if is_w(e, *locals_))

    base = part.rsplit("/", 1)[0] if "/" in part else ""
    def sib(n):
        return f"{base}/{n}" if base else n

    styles = count_in(sib("styles.xml"), "style")
    footnotes = count_in(sib("footnotes.xml"), "footnote")
    endnotes = count_in(sib("endnotes.xml"), "endnote")
    comments = count_in(sib("comments.xml"), "comment")

    # Page setup across sections — differing size or orientation is its own
    # class of reader bug (a landscape section mid-document).
    setups = set()
    for el in root.iter():
        if is_w(el, "sectPr"):
            for c in el:
                if is_w(c, "pgSz"):
                    w = c.get("{%s}w" % split(c.tag)[0]) or ""
                    h = c.get("{%s}h" % split(c.tag)[0]) or ""
                    o = c.get("{%s}orient" % split(c.tag)[0]) or "portrait"
                    setups.add(f"{w}x{h}/{o}")

    media = [n for n in names if re.search(r"(^|/)media/", n)]
    embeddings = [n for n in names if re.search(r"(^|/)embeddings/", n)]

    prefix = _prefix_of(text, "body")
    prefix_p = _prefix_of(text, "p")

    feat = {
        # --- exactly the fields the reader test will assert against ---
        "parts": len(names),
        "partNames": sorted(names),
        "bodyParagraphs": body_paras,
        "allParagraphs": counts["allParagraphs"],
        "runs": counts["runs"],
        "textChars": len(blob),
        "textSha256": hashlib.sha256(blob.encode("utf-8")).hexdigest(),
        "tables": counts["tables"],
        "tableCells": counts["tableCells"],
        "hyperlinks": counts["hyperlinks"],
        "footnotes": footnotes,
        "endnotes": endnotes,
        "comments": comments,
        "images": len(media),
        "sections": counts["sections"],
        "numberedParas": counts["numberedParas"],
        "styles": styles,
        "prefix": prefix if prefix is not None else "",
        "generator": read_generator(zf, names),
        # --- supporting detail: coverage, and the traps ---
        "documentPart": part,
        "conformance": "strict" if uri == "http://purl.oclc.org/ooxml/wordprocessingml/main" else "transitional",
        "prefixParagraph": prefix_p if prefix_p is not None else "",
        "tableRows": counts["tableRows"],
        "nestedTables": nested_tables,
        "maxElementDepth": max_depth,
        "drawings": counts["drawings"],
        "inlineImages": counts["inlineImages"],
        "floatingImages": counts["floatingImages"],
        "textBoxes": counts["textBoxes"],
        "sdt": counts["sdt"],
        "insertions": counts["insertions"],
        "deletions": counts["deletions"],
        "moveFrom": counts["moveFrom"],
        "moveTo": counts["moveTo"],
        "deletedTextChars": counts["deletedTextChars"],
        "fldSimple": counts["fldSimple"],
        "instrText": counts["instrText"],
        "footnoteRefs": counts["footnoteRefs"],
        "endnoteRefs": counts["endnoteRefs"],
        "commentRefs": counts["commentRefs"],
        "objects": counts["objects"],
        "embeddings": len(embeddings),
        "altChunks": counts["altChunks"],
        "bookmarks": counts["bookmarks"],
        "omml": counts["omml"],
        "rtlRuns": counts["rtlRuns"],
        "gridSpan": counts["gridSpan"],
        "vMerge": counts["vMerge"],
        "altContent": counts["altContent"],
        "canvas": counts["canvas"],
        "maxListLevel": max_ilvl,
        "emptyTextEls": counts["emptyTextEls"],
        "preserveSpaceEls": counts["preserveSpaceEls"],
        "textCharsOtherParts": sum(other.values()),
        "textCharsByOtherPart": dict(sorted(other.items())),
        "nonLatin": non_latin,
        "rtlText": rtl_text,
        "pageSetups": sorted(setups),
        "distinctPageSetups": len(setups),
        "hasHeaders": any(re.search(r"header\d*\.xml$", n) for n in names),
        "hasFooters": any(re.search(r"footer\d*\.xml$", n) for n in names),
        "hasNumbering": any(n.endswith("numbering.xml") for n in names),
        "hasTheme": any("/theme/" in n for n in names),
        "hasSettings": any(n.endswith("settings.xml") for n in names),
        "hasCustomXml": any(n.startswith("customXml/") for n in names),
        "hasMacros": any("vbaProject" in n for n in names),
        "hasGlossary": any("/glossary/" in n for n in names),
    }
    return feat, None


def read_generator(zf, names):
    for cand in ("docProps/app.xml",):
        if cand in names:
            try:
                r = ET.fromstring(zf.read(cand))
            except Exception:
                return "unknown"
            for e in r.iter():
                if split(e.tag)[1] == "Application":
                    return (e.text or "unknown").strip() or "unknown"
    return "unknown"


# ---------------------------------------------------------------------------
# coverage
# ---------------------------------------------------------------------------
COVERAGE_KEYS = [
    ("tables", lambda f: f["tables"] > 0),
    ("nestedTables", lambda f: f["nestedTables"] > 0),
    ("mergedCells", lambda f: f["gridSpan"] + f["vMerge"] > 0),
    ("numberedOrBulletedLists", lambda f: f["numberedParas"] > 0),
    ("multiLevelLists", lambda f: f["maxListLevel"] > 0),
    ("drawingCanvas", lambda f: f["canvas"] > 0),
    ("inlineImages", lambda f: f["inlineImages"] > 0),
    ("floatingImages", lambda f: f["floatingImages"] > 0),
    ("images", lambda f: f["images"] > 0),
    ("headers", lambda f: f["hasHeaders"]),
    ("footers", lambda f: f["hasFooters"]),
    ("footnotes", lambda f: f["footnoteRefs"] > 0),
    ("endnotes", lambda f: f["endnoteRefs"] > 0),
    ("hyperlinks", lambda f: f["hyperlinks"] > 0),
    ("comments", lambda f: f["comments"] > 0),
    ("trackedChanges", lambda f: f["insertions"] + f["deletions"] + f["moveFrom"] + f["moveTo"] > 0),
    ("contentControls", lambda f: f["sdt"] > 0),
    ("fields", lambda f: f["fldSimple"] + f["instrText"] > 0),
    ("multiSection", lambda f: f["sections"] > 1),
    ("differingPageSetup", lambda f: f["distinctPageSetups"] > 1),
    ("customStyles", lambda f: f["styles"] > 0),
    ("themeFonts", lambda f: f["hasTheme"]),
    ("nonLatinText", lambda f: f["nonLatin"]),
    ("rightToLeft", lambda f: f["rtlText"]),
    ("embeddedObject", lambda f: f["objects"] > 0 or f["embeddings"] > 0),
    ("equationOMML", lambda f: f["omml"] > 0),
    ("textBoxOrCanvas", lambda f: f["textBoxes"] > 0),
    ("strictConformance", lambda f: f["conformance"] == "strict"),
    ("nonWPrefix", lambda f: f["prefix"] != "w"),
    ("preserveSpace", lambda f: f["preserveSpaceEls"] > 0),
    ("largeFile", lambda f: f.get("_bytes", 0) > 1_000_000),
]


def coverage_of(entries):
    out = {}
    for name, test in COVERAGE_KEYS:
        hits = []
        for e in entries:
            f = dict(e["features"])
            f["_bytes"] = e["bytes"]
            try:
                if test(f):
                    hits.append(e["slug"])
            except Exception:
                pass
        out[name] = hits
    return out


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
def build(argv):
    FILES.mkdir(parents=True, exist_ok=True)
    kept, rejected = [], []

    def keep(slug, tier, url, desc, data, origin, extra=None):
        feat, why = characterise(data)
        if feat is None:
            rejected.append({"slug": slug, "url": url, "reason": why})
            print(f"  -- {slug}: {why}")
            return None
        name = f"{slug}.docx"
        (FILES / name).write_bytes(data)
        entry = {
            "slug": slug, "tier": tier, "file": name, "url": url,
            "description": desc, "origin": origin, "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "features": feat,
        }
        if extra:
            entry.update(extra)
        kept.append(entry)
        flags = "".join([
            "T" if feat["tables"] else "-", "L" if feat["numberedParas"] else "-",
            "I" if feat["images"] else "-", "H" if feat["hasHeaders"] else "-",
            "F" if feat["footnoteRefs"] else "-", "C" if feat["comments"] else "-",
            "R" if feat["insertions"] + feat["deletions"] else "-",
            "S" if feat["sdt"] else "-", "M" if feat["omml"] else "-",
        ])
        print(f"  OK [{tier}] {slug:26} {feat['allParagraphs']:>6}p {feat['runs']:>6}r "
              f"{feat['textChars']:>8}ch [{flags}] {feat['prefix'] or '(default)':>7} "
              f"{feat['generator'][:28]}")
        return entry

    print("--- Tier A: representative (documents a person would actually have) ---")
    for slug, url, desc in CANDIDATES:
        try:
            data = fetch(url)
        except Exception as ex:
            rejected.append({"slug": slug, "url": url,
                             "reason": f"{type(ex).__name__} {getattr(ex, 'code', '')}".strip()})
            print(f"  -- {slug}: {type(ex).__name__} {getattr(ex, 'code', '')}")
            continue
        keep(slug, "A", url, desc, data, "downloaded")

    print("--- Tier B: adversarial (generator diversity + feature coverage) ---")
    for slug, url, desc in ADVERSARIAL:
        try:
            data = fetch(url)
        except Exception as ex:
            rejected.append({"slug": slug, "url": url,
                             "reason": f"{type(ex).__name__} {getattr(ex, 'code', '')}".strip()})
            print(f"  -- {slug}: {type(ex).__name__} {getattr(ex, 'code', '')}")
            continue
        keep(slug, "B", url, desc, data, "downloaded")

    print("--- Tier B: derived (deterministic transforms of locked sources) ---")
    by_slug = {e["slug"]: e for e in kept}
    for slug, src, kind, arg, desc in DERIVED:
        if src not in by_slug:
            rejected.append({"slug": slug, "url": None, "reason": f"source {src} not in corpus"})
            print(f"  -- {slug}: source {src} missing")
            continue
        src_data = (FILES / by_slug[src]["file"]).read_bytes()
        try:
            data = DERIVERS[kind](src_data, arg)
        except Exception as ex:
            rejected.append({"slug": slug, "url": None, "reason": f"derive failed: {ex}"})
            print(f"  -- {slug}: derive failed: {ex}")
            continue
        keep(slug, "B", None, desc, data, "derived", {
            "derivedFrom": src,
            "command": f"python corpus/build_docx_corpus.py --rebuild  "
                       f"# {kind}({src}, {arg!r}) — see DERIVERS in this file",
            "sourceSha256": by_slug[src]["sha256"],
        })

    write_lock(kept, rejected)
    return 0


def write_lock(kept, rejected):
    a = [k for k in kept if k["tier"] == "A"]
    b = [k for k in kept if k["tier"] == "B"]
    cov = coverage_of(kept)
    doc = {
        "locked": LOCK_DATE,
        "note": "Fixed BEFORE the WordprocessingML reader was written. Do not add, "
                "remove, or replace entries to make a gate pass. Additions go to "
                "docx-corpus-v2 with its own lock date and its own published result.",
        "gate": {
            "A": "every file: open, save, reopen in Word -> zero text or visual "
                 "difference in any feature we claim to support",
            "B": "same, plus every byte we do NOT model survives identically "
                 "(preserve-unknown)",
            "exact": "the reader must reproduce bodyParagraphs, allParagraphs, runs, "
                     "textChars, textSha256, tables, tableCells and numberedParas "
                     "EXACTLY. Not 'more than zero'. A gate loose enough to pass a "
                     "broken build is not a gate.",
        },
        "counts": {"tierA": len(a), "tierB": len(b), "total": len(kept),
                   "bytes": sum(k["bytes"] for k in kept)},
        "issuers": sorted({k["url"].split("/")[2] for k in a if k.get("url")}),
        "generators": sorted({k["features"]["generator"] for k in kept}),
        "coverage": {k: len(v) for k, v in cov.items()},
        "coverageFiles": cov,
        "files": kept,
        "rejected": rejected,
    }
    LOCK.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"\nTier A {len(a)} | Tier B {len(b)} | total {len(kept)} | "
          f"rejected {len(rejected)} | {doc['counts']['bytes']:,} bytes")
    print("generators:", len(doc["generators"]))
    print("coverage:", {k: v for k, v in doc["coverage"].items() if v})
    return doc


# ---------------------------------------------------------------------------
# modes
# ---------------------------------------------------------------------------
def recharacterise():
    """Re-read every file FROM DISK, assert the sha256 is unchanged, then
    recompute. The assertion is the point: it makes it impossible for a
    characteriser fix to silently move the goalposts by quietly pulling a newer
    upstream file underneath the numbers."""
    doc = json.loads(LOCK.read_text(encoding="utf-8"))
    for e in doc["files"]:
        data = (FILES / e["file"]).read_bytes()
        got = hashlib.sha256(data).hexdigest()
        assert got == e["sha256"], f"{e['file']}: hash moved {e['sha256'][:12]} -> {got[:12]}"
        feat, why = characterise(data)
        assert feat is not None, f"{e['file']}: {why}"
        e["features"] = feat
    cov = coverage_of(doc["files"])
    doc["coverage"] = {k: len(v) for k, v in cov.items()}
    doc["coverageFiles"] = cov
    doc["generators"] = sorted({e["features"]["generator"] for e in doc["files"]})
    LOCK.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"re-characterised {len(doc['files'])} files (all hashes verified unchanged)")
    print("coverage:", {k: v for k, v in doc["coverage"].items() if v})
    return 0


def verify():
    doc = json.loads(LOCK.read_text(encoding="utf-8"))
    bad = 0
    for e in doc["files"]:
        p = FILES / e["file"]
        if not p.exists():
            print(f"  MISSING {e['file']}")
            bad += 1
            continue
        if hashlib.sha256(p.read_bytes()).hexdigest() != e["sha256"]:
            print(f"  HASH CHANGED {e['file']}")
            bad += 1
    print(f"{len(doc['files'])} entries, {bad} problems")
    return 1 if bad else 0


def refetch():
    """Re-download every recorded URL and compare against the locked sha256.
    Derived entries have no URL; they are rebuilt from their locked source, which
    proves the transform is still deterministic."""
    doc = json.loads(LOCK.read_text(encoding="utf-8"))
    by_slug = {e["slug"]: e for e in doc["files"]}
    same = moved = gone = 0
    for e in doc["files"]:
        if e["origin"] == "derived":
            # Look the recipe up in DERIVED rather than re-deriving it from the
            # slug. Guessing the argument from the name is how a rename silently
            # turns a verification into a tautology.
            recipe = next((d for d in DERIVED if d[0] == e["slug"]), None)
            if recipe is None:
                print(f"  GONE   {e['slug']:26} no recipe in DERIVED")
                gone += 1
                continue
            _, src_slug, kind, arg, _ = recipe
            src = by_slug[src_slug]
            src_data = (FILES / src["file"]).read_bytes()
            if hashlib.sha256(src_data).hexdigest() != e.get("sourceSha256", src["sha256"]):
                print(f"  MOVED  {e['slug']:26} its SOURCE file changed")
                moved += 1
                continue
            data = DERIVERS[kind](src_data, arg)
        else:
            try:
                data = fetch(e["url"])
            except Exception as ex:
                print(f"  GONE   {e['slug']:26} {type(ex).__name__} {getattr(ex, 'code', '')}")
                gone += 1
                continue
        if hashlib.sha256(data).hexdigest() == e["sha256"]:
            same += 1
        else:
            print(f"  MOVED  {e['slug']:26} upstream bytes changed "
                  f"({e['bytes']:,} -> {len(data):,})")
            moved += 1
    print(f"\n{same} identical, {moved} upstream-changed, {gone} unreachable, "
          f"of {len(doc['files'])}")
    return 1 if moved or gone else 0


def add_missing():
    doc = json.loads(LOCK.read_text(encoding="utf-8"))
    have = {e["slug"] for e in doc["files"]}
    added = 0
    for tier, items in (("A", CANDIDATES), ("B", ADVERSARIAL)):
        for slug, url, desc in items:
            if slug in have:
                continue
            try:
                data = fetch(url)
            except Exception as ex:
                print(f"  -- {slug}: {type(ex).__name__} {getattr(ex, 'code', '')}")
                continue
            feat, why = characterise(data)
            if feat is None:
                print(f"  -- {slug}: {why}")
                continue
            (FILES / f"{slug}.docx").write_bytes(data)
            doc["files"].append({
                "slug": slug, "tier": tier, "file": f"{slug}.docx", "url": url,
                "description": desc, "origin": "downloaded", "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "features": feat,
            })
            added += 1
            print(f"  OK [{tier}] {slug}")
    cov = coverage_of(doc["files"])
    doc["coverage"] = {k: len(v) for k, v in cov.items()}
    doc["coverageFiles"] = cov
    doc["counts"] = {"tierA": sum(1 for e in doc["files"] if e["tier"] == "A"),
                     "tierB": sum(1 for e in doc["files"] if e["tier"] == "B"),
                     "total": len(doc["files"]),
                     "bytes": sum(e["bytes"] for e in doc["files"])}
    LOCK.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"\nadded {added} | {doc['counts']}")
    return 0


def gates():
    """The sanity gates. Every one of these exists because its absence would let
    a broken corpus or a broken characteriser look healthy."""
    doc = json.loads(LOCK.read_text(encoding="utf-8"))
    files = doc["files"]
    fails = []

    # 1. opens as a zip and has a main document part
    for e in files:
        data = (FILES / e["file"]).read_bytes()
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
            main_document_part(zf)
        except Exception as ex:
            fails.append(f"G1 {e['slug']}: {type(ex).__name__}")
    print(f"G1 opens as zip + has a main document part      "
          f"{'PASS' if not fails else 'FAIL'}  ({len(files)} files)")

    # 2. textChars > 0 for every file, except where a zero is diagnosed AND the
    #    diagnosis is re-proved here from the file itself.
    n0 = [e for e in files if e["features"]["textChars"] == 0]
    g2 = []
    for e in n0:
        ex = ZERO_TEXT_EXPECTED.get(e["slug"])
        if not ex:
            g2.append(f"G2 {e['slug']}: textChars == 0 and undiagnosed")
        elif not ex[1](e["features"]):
            g2.append(f"G2 {e['slug']}: zero-text diagnosis no longer holds")
    for slug in ZERO_TEXT_EXPECTED:
        hit = [e for e in files if e["slug"] == slug]
        if hit and hit[0]["features"]["textChars"] != 0:
            g2.append(f"G2 {slug}: exemption is stale — the file now has text")
    print(f"G2 textChars > 0, or a zero re-proved from the file "
          f"{'PASS' if not g2 else 'FAIL'}  "
          f"({len(files) - len(n0)}/{len(files)} nonzero; "
          f"{len(n0)} diagnosed: {[e['slug'] for e in n0]})")
    fails += g2

    # 3. no two files share a sha256
    seen = {}
    dupes = []
    for e in files:
        if e["sha256"] in seen:
            dupes.append((seen[e["sha256"]], e["slug"]))
        seen[e["sha256"]] = e["slug"]
    print(f"G3 no two files share a sha256                  "
          f"{'PASS' if not dupes else 'FAIL'}"
          + (f"  {dupes}" if dupes else ""))
    fails += [f"G3 duplicate: {a} == {b}" for a, b in dupes]

    # 4. characterisation is deterministic — run it twice, compare everything
    drift = []
    for e in files:
        data = (FILES / e["file"]).read_bytes()
        f1, _ = characterise(data)
        f2, _ = characterise(data)
        if json.dumps(f1, sort_keys=True) != json.dumps(f2, sort_keys=True):
            drift.append(e["slug"])
        if json.dumps(f1, sort_keys=True) != json.dumps(e["features"], sort_keys=True):
            drift.append(e["slug"] + " (differs from lock)")
    print(f"G4 characterising twice gives identical numbers "
          f"{'PASS' if not drift else 'FAIL'}"
          + (f"  {drift}" if drift else ""))
    fails += [f"G4 {s}" for s in drift]

    # 5. total size
    total = sum(e["bytes"] for e in files)
    ok5 = total < 60 * 1024 * 1024
    print(f"G5 corpus under ~60MB                           "
          f"{'PASS' if ok5 else 'FAIL'}  ({total / 1024 / 1024:.1f} MB)")
    if not ok5:
        fails.append(f"G5 {total} bytes")

    # 6. every locked file is present and unchanged
    bad = [e["slug"] for e in files
           if not (FILES / e["file"]).exists()
           or hashlib.sha256((FILES / e["file"]).read_bytes()).hexdigest() != e["sha256"]]
    print(f"G6 on-disk bytes match the lock                 "
          f"{'PASS' if not bad else 'FAIL'}" + (f"  {bad}" if bad else ""))
    fails += [f"G6 {s}" for s in bad]

    print(f"\n{'ALL GATES PASS' if not fails else 'FAILURES: ' + '; '.join(fails)}")
    return 1 if fails else 0



# ---------------------------------------------------------------------------
# publish
# ---------------------------------------------------------------------------
def publish():
    """Regenerate CORPUS_DOCX.md from docx.json.

    Every number in the published document is DERIVED here rather than typed. A
    hand-written corpus table drifts the moment an entry is added, and every
    visual check still passes — the table just quietly stops describing the
    corpus it claims to describe."""
    import collections
    d = json.loads(LOCK.read_text(encoding="utf-8"))
    files = d["files"]
    A = [e for e in files if e["tier"] == "A"]
    Bt = [e for e in files if e["tier"] == "B"]
    cov, covf = d["coverage"], d["coverageFiles"]
    gens = collections.Counter(e["features"]["generator"] for e in files)
    issuers = collections.Counter(e["url"].split("/")[2] for e in A if e.get("url"))
    total_mb = d["counts"]["bytes"] / 1024 / 1024
    empties = sum(e["features"]["emptyTextEls"] for e in files)
    preserves = sum(e["features"]["preserveSpaceEls"] for e in files)
    q = chr(34)

    def short(g, n=60):
        return (g[:n] + chr(0x2026)) if len(g) > n else g

    L = []
    w = L.append
    w("# CORPUS_DOCX " + chr(0x2014) + " the WordprocessingML reader exam")
    w("")
    w("**Locked " + d["locked"] + ". " + str(d["counts"]["total"]) + " files "
      + chr(0x2014) + " Tier A " + str(d["counts"]["tierA"]) + " representative, Tier B "
      + str(d["counts"]["tierB"]) + " adversarial. " + f"{total_mb:.1f}" + " MB.**")
    w("")
    w("> Fixed and published **before** a single line of the .docx reader was written.")
    w("> Otherwise the person being graded picks the exam at grading time, and a binary")
    w("> gate quietly becomes a vibe with a number on it.")
    w("")
    w("Do not add, remove, or replace an entry to make a gate pass. Additions go to a")
    w("`docx-corpus-v2` with its own lock date and its own published result.")
    w("")
    w("```")
    w("python corpus/build_docx_corpus.py                   # re-hash every file against the lock")
    w("python corpus/build_docx_corpus.py --gates           # the six sanity gates")
    w("python corpus/build_docx_corpus.py --refetch         # re-download every URL, compare sha256")
    w("python corpus/build_docx_corpus.py --recharacterise  # re-measure from disk, hashes asserted")
    w("```")
    w("")
    w("The files themselves are **not committed** (`corpus/docx/files/` is gitignored).")
    w("`corpus/docx.json` is the lock and it *is* committed " + chr(0x2014)
      + " the script re-fetches and re-verifies every byte from it.")
    w("")
    w("> **What a `MOVED` line from `--refetch` means.** All " + str(d["counts"]["total"])
      + " verified identical on " + d["locked"] + ". They will not stay that way: "
      + str(len(A)) + " Tier A files come from live")
    w("> `.gov` / `.edu` / `who.int` URLs that get republished without notice. `MOVED` does **not**")
    w("> mean the corpus is broken " + chr(0x2014) + " it means upstream changed and the bytes on "
      "disk are now the only")
    w("> copy of what was graded. Because `corpus/docx/files/` is gitignored, **once one of those")
    w("> URLs rots a fresh clone can no longer rebuild the full Tier A.** The fix is to archive the")
    w("> " + f"{total_mb:.1f}" + " MB somewhere durable " + chr(0x2014) + " never to re-fetch and "
      "re-lock, which would silently change the exam.")
    w("")
    w("## The gate")
    w("")
    w("| Tier | What it proves | Pass condition |")
    w("|---|---|---|")
    w("| **A** " + chr(0x2014) + " representative | normal work survives | open "
      + chr(0x2192) + " save " + chr(0x2192) + " reopen in Word: **zero** text or visual "
      "difference in every feature we claim to support |")
    w("| **B** " + chr(0x2014) + " adversarial | the weird survives | same, **plus every "
      "byte we do not model comes back identical** (preserve-unknown) |")
    w("")
    w("Half B is what makes half A honest. Without it, " + q + "zero diff on supported "
      "features" + q + " is satisfied by supporting almost nothing.")
    w("")
    w("### The gate must be exact, not approximate")
    w("")
    w("`docx.json` records `bodyParagraphs`, `allParagraphs`, `runs`, `textChars`,")
    w("`textSha256`, `tables`, `tableCells` and `numberedParas` per file, counted by a")
    w("**separate implementation** " + chr(0x2014) + " Python, `zipfile` + `xml.etree`, "
      "namespace-aware parsing, deliberately not python-docx. The reader test must assert")
    w("**exact equality**. Two independent implementations agreeing is evidence; one")
    w("implementation asserting is a press release.")
    w("")
    w("`textSha256` exists because a single total cannot catch reordering. It is the")
    w("SHA-256 of the concatenation, in document order, of the character data of every")
    w("`<w:t>` in the main document part " + chr(0x2014) + " no trimming, no whitespace "
      "collapsing, and an empty `<w:t/>` contributing the empty string. The corpus holds")
    w(str(empties) + " empty `<w:t/>` elements and " + f"{preserves:,}" + " carrying "
      "`xml:space=" + q + "preserve" + q + "`, so both decisions are load-bearing.")
    w("")
    w("## Generators " + chr(0x2014) + " the point of Tier B")
    w("")
    w(str(len(gens)) + " distinct `<Application>` strings. Producers emit structurally "
      "different WordprocessingML for the same document, so a corpus from one producer")
    w("proves one producer.")
    w("")
    w("| `<Application>` | Files |")
    w("|---|---:|")
    for g, c in gens.most_common():
        w("| `" + short(g) + "` | " + str(c) + " |")
    w("")
    w("**Read that table with suspicion, which is the lesson.** `Microsoft Word 12.0.0`")
    w("is *pandoc* " + chr(0x2014) + " it copies the metadata of its reference document. "
      "`unknown` is not a lookup failure: Google Docs and Apple Pages ship no")
    w("`docProps/app.xml` at all. **The generator string is a claim, not an observation.**")
    w("")
    w("## What the corpus actually exercises")
    w("")
    w("| Feature | Files | Example |")
    w("|---|---:|---|")
    for k, n in cov.items():
        ex = "`" + covf[k][0] + "`" if covf[k] else "**none " + chr(0x2014) + " see the report**"
        w("| " + k + " | " + str(n) + " | " + ex + " |")
    w("")
    w("## Tier A " + chr(0x2014) + " representative (" + str(len(A)) + ")")
    w("")
    w("Issuer families, with counts " + chr(0x2014) + " **stated rather than left to be "
      "counted**: " + " · ".join(h + " (" + str(c) + ")" for h, c in issuers.most_common()) + ".")
    w("")
    w(str(len(issuers)) + " distinct hosts across " + str(len(A)) + " files. The xlsx corpus "
      "took 11 of 25 from a single issuer and said so; this one was built not to repeat that.")
    w("")
    w("| Slug | Source | Paras | Runs | Chars | Tables | Bytes |")
    w("|---|---|---:|---:|---:|---:|---:|")
    for e in sorted(A, key=lambda x: -x["features"]["textChars"]):
        f = e["features"]
        w("| `" + e["slug"] + "` | " + e["description"] + " | " + f"{f['allParagraphs']:,}"
          + " | " + f"{f['runs']:,}" + " | " + f"{f['textChars']:,}" + " | "
          + str(f["tables"]) + " | " + f"{e['bytes']:,}" + " |")
    w("")
    w("## Tier B " + chr(0x2014) + " adversarial (" + str(len(Bt)) + ")")
    w("")
    w("Chosen for **generator diversity** and because each isolates one thing that breaks")
    w("naive readers. `origin: derived` entries are deterministic transforms of a locked")
    w("source, built by code in `build_docx_corpus.py`, so they are byte-reproducible on a")
    w("fresh clone " + chr(0x2014) + " nothing here depends on a local Word or LibreOffice install.")
    w("")
    w("| Slug | What it isolates | Origin | Prefix | Paras | Chars | Bytes |")
    w("|---|---|---|:-:|---:|---:|---:|")
    for e in Bt:
        f = e["features"]
        pfx = "`" + f["prefix"] + "`" if f["prefix"] else "*(default)*"
        w("| `" + e["slug"] + "` | " + e["description"] + " | " + e["origin"] + " | " + pfx
          + " | " + f"{f['allParagraphs']:,}" + " | " + f"{f['textChars']:,}" + " | "
          + f"{e['bytes']:,}" + " |")
    w("")
    w("## Rejected candidates")
    w("")
    w("Recorded so the sourcing is auditable " + chr(0x2014) + " a corpus is only as honest "
      "as what it left out.")
    w("")
    w("| Slug | Leading bytes | Reason |")
    w("|---|---|---|")
    for r in d.get("rejected", []):
        w("| `" + r["slug"] + "` | `" + r.get("magic", "?") + "` | " + r["reason"] + " |")
    w("")
    w("## Coverage targets NOT met")
    w("")
    for k, v in d.get("notFound", {}).items():
        w("**" + k + "** " + chr(0x2014) + " " + v)
        w("")
    w("---")
    w("")
    w("Full traps, per-file numbers, and the notes a reader author needs before writing")
    w("one: **`corpus/DOCX_CORPUS_REPORT.md`**.")
    w("")

    body = "\n".join(L)
    out = HERE.parent / "CORPUS_DOCX.md"
    out.write_text(body, encoding="utf-8")
    print("wrote " + str(out) + " (" + f"{len(body):,}"
          + " chars, every number derived from docx.json)")
    return 0



# ---------------------------------------------------------------------------
# verify the published documents against the lock
# ---------------------------------------------------------------------------
# Prose is the unasserted surface. Every table in CORPUS_DOCX.md is generated by
# publish(), but DOCX_CORPUS_REPORT.md is written by hand, and a hand-typed
# number is wrong the moment an entry changes — while every visual check still
# passes. This mode parses the per-file table back OUT of the report and asserts
# each cell against docx.json, then re-checks the named prose claims.
#
# It is not hypothetical: the first draft of that table had ~30 invented cells
# and a fact attached to the wrong file. This is what caught it.
# Each entry MIRRORS a specific sentence in DOCX_CORPUS_REPORT.md. The constant and
# the sentence are two copies of one fact and only the constant is checked, so if you
# change a value here you must change the sentence it mirrors too — otherwise this
# checker passes while the prose is wrong.
PROSE_CLAIMS = [
    ("total files", lambda d, F: d["counts"]["total"], 40),
    ("Tier A", lambda d, F: d["counts"]["tierA"], 20),
    ("Tier B", lambda d, F: d["counts"]["tierB"], 20),
    ("distinct generators", lambda d, F: len(d["generators"]), 8),
    ("min parts", lambda d, F: min(e["features"]["parts"] for e in d["files"]), 3),
    ("max parts", lambda d, F: max(e["features"]["parts"] for e in d["files"]), 910),
    ("files with prefix w", lambda d, F: sum(1 for e in d["files"] if e["features"]["prefix"] == "w"), 37),
    ("strict-conformance files", lambda d, F: sum(1 for e in d["files"] if e["features"]["conformance"] == "strict"), 1),
    ("acm w:r", lambda d, F: F["acm-taps-template"]["runs"], 2148),
    ("gatech w:r", lambda d, F: F["gatech-thesis"]["runs"], 793),
    ("deep-tables nested", lambda d, F: F["adv-deep-tables"]["nestedTables"], 4999),
    ("deep-tables depth", lambda d, F: F["adv-deep-tables"]["maxElementDepth"], 15004),
    ("delText chars total", lambda d, F: sum(e["features"]["deletedTextChars"] for e in d["files"]), 192),
    ("altContent in adv-all-features", lambda d, F: F["adv-all-features"]["altContent"], 19),
    ("altContent total", lambda d, F: sum(e["features"]["altContent"] for e in d["files"]), 46),
    ("preserve-space elements", lambda d, F: sum(e["features"]["preserveSpaceEls"] for e in d["files"]), 13261),
    ("empty w:t elements", lambda d, F: sum(e["features"]["emptyTextEls"] for e in d["files"]), 43),
    ("footnote==2 and refs==0", lambda d, F: sum(1 for e in d["files"]
        if e["features"]["footnotes"] == 2 and e["features"]["footnoteRefs"] == 0), 17),
    ("footnote excess of exactly 2", lambda d, F: sum(1 for e in d["files"]
        if e["features"]["footnotes"] - e["features"]["footnoteRefs"] == 2), 23),
    ("baylor sectPr", lambda d, F: F["baylor-dissertation"]["sections"], 7),
    ("baylor distinct setups", lambda d, F: F["baylor-dissertation"]["distinctPageSetups"], 1),
    ("page-setups sectPr", lambda d, F: F["adv-page-setups"]["sections"], 7),
    ("page-setups distinct", lambda d, F: F["adv-page-setups"]["distinctPageSetups"], 3),
    ("max styles", lambda d, F: max(e["features"]["styles"] for e in d["files"]), 157),
    ("max hyperlinks", lambda d, F: max(e["features"]["hyperlinks"] for e in d["files"]), 49),
    ("max list level", lambda d, F: max(e["features"]["maxListLevel"] for e in d["files"]), 12),
    ("many-paragraphs merges", lambda d, F: F["adv-many-paragraphs"]["gridSpan"]
        + F["adv-many-paragraphs"]["vMerge"], 6657),
    ("many-paragraphs cells", lambda d, F: F["adv-many-paragraphs"]["tableCells"], 25241),
    ("many-paragraphs images", lambda d, F: F["adv-many-paragraphs"]["images"], 164),
    ("wps objects", lambda d, F: F["adv-wps-office"]["objects"], 9),
    ("wps embeddings", lambda d, F: F["adv-wps-office"]["embeddings"], 10),
    ("drawing canvases", lambda d, F: sum(e["features"]["canvas"] for e in d["files"]), 0),
    ("3gpp text hashes equal", lambda d, F: F["3gpp-working-proc"]["textSha256"]
        == F["3gpp-working-proc-rm"]["textSha256"], True),
    ("prefix trio text hashes equal", lambda d, F: len({F[s]["textSha256"] for s in
        ("adv-pandoc-tables", "adv-prefix-default", "adv-prefix-exotic")}), 1),
]

REPORT_COLUMNS = ["parts", "bodyParagraphs", "allParagraphs", "runs", "textChars",
                  "textSha256", "tables", "tableCells", "hyperlinks", "footnotes",
                  "endnotes", "comments", "images", "sections", "numberedParas", "styles"]


def verify_docs():
    d = json.loads(LOCK.read_text(encoding="utf-8"))
    F = {e["slug"]: e["features"] for e in d["files"]}
    bad = []

    report = HERE / "DOCX_CORPUS_REPORT.md"
    rows = 0
    if report.exists():
        for line in report.read_text(encoding="utf-8").splitlines():
            if not line.startswith("| `"):
                continue
            cells = [c.strip().strip("`") for c in line.strip().strip("|").split("|")]
            slug = cells[0]
            if slug not in F or len(cells) < 20:
                continue
            rows += 1
            vals = cells[4:20]          # Parts .. Sty
            for col, got in zip(REPORT_COLUMNS, vals):
                want = F[slug][col]
                if col == "textSha256":
                    ok = str(want).startswith(got)
                else:
                    ok = str(want) == got.replace(",", "")
                if not ok:
                    bad.append(f"{report.name}: {slug}.{col} says {got!r}, lock says {want!r}")
    print(f"per-file table: {rows} rows x {len(REPORT_COLUMNS)} columns checked against the lock")

    for name, fn, want in PROSE_CLAIMS:
        got = fn(d, F)
        if got != want:
            bad.append(f"prose claim {name!r}: doc says {want}, lock says {got}")
    print(f"prose claims:   {len(PROSE_CLAIMS)} checked")

    if bad:
        print(f"\n{len(bad)} MISMATCH(ES):")
        for b in bad:
            print("  " + b)
        return 1
    print("\nEVERY published number matches the lock.")
    return 0


def main():
    argv = sys.argv[1:]
    if "--recharacterise" in argv and LOCK.exists():
        return recharacterise()
    if "--refetch" in argv and LOCK.exists():
        return refetch()
    if "--gates" in argv and LOCK.exists():
        return gates()
    if "--publish" in argv and LOCK.exists():
        return publish()
    if "--verify-docs" in argv and LOCK.exists():
        return verify_docs()
    if "--add-missing" in argv and LOCK.exists():
        return add_missing()
    if LOCK.exists() and "--rebuild" not in argv:
        print("docx.json exists — verifying hashes instead of re-downloading.")
        return verify()
    return build(argv)


if __name__ == "__main__":
    sys.exit(main())
