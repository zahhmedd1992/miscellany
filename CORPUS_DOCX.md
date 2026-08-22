# CORPUS_DOCX — the WordprocessingML reader exam

**Locked 2026-08-22. 40 files — Tier A 20 representative, Tier B 20 adversarial. 11.7 MB.**

> Fixed and published **before** a single line of the .docx reader was written.
> Otherwise the person being graded picks the exam at grading time, and a binary
> gate quietly becomes a vibe with a number on it.

Do not add, remove, or replace an entry to make a gate pass. Additions go to a
`docx-corpus-v2` with its own lock date and its own published result.

```
python corpus/build_docx_corpus.py                   # re-hash every file against the lock
python corpus/build_docx_corpus.py --gates           # the six sanity gates
python corpus/build_docx_corpus.py --refetch         # re-download every URL, compare sha256
python corpus/build_docx_corpus.py --recharacterise  # re-measure from disk, hashes asserted
```

The files themselves are **not committed** (`corpus/docx/files/` is gitignored).
`corpus/docx.json` is the lock and it *is* committed — the script re-fetches and re-verifies every byte from it.

## The gate

| Tier | What it proves | Pass condition |
|---|---|---|
| **A** — representative | normal work survives | open → save → reopen in Word: **zero** text or visual difference in every feature we claim to support |
| **B** — adversarial | the weird survives | same, **plus every byte we do not model comes back identical** (preserve-unknown) |

Half B is what makes half A honest. Without it, "zero diff on supported features" is satisfied by supporting almost nothing.

### The gate must be exact, not approximate

`docx.json` records `bodyParagraphs`, `allParagraphs`, `runs`, `textChars`,
`textSha256`, `tables`, `tableCells` and `numberedParas` per file, counted by a
**separate implementation** — Python, `zipfile` + `xml.etree`, namespace-aware parsing, deliberately not python-docx. The reader test must assert
**exact equality**. Two independent implementations agreeing is evidence; one
implementation asserting is a press release.

`textSha256` exists because a single total cannot catch reordering. It is the
SHA-256 of the concatenation, in document order, of the character data of every
`<w:t>` in the main document part — no trimming, no whitespace collapsing, and an empty `<w:t/>` contributing the empty string. The corpus holds
43 empty `<w:t/>` elements and 13,261 carrying `xml:space="preserve"`, so both decisions are load-bearing.

## Generators — the point of Tier B

8 distinct `<Application>` strings. Producers emit structurally different WordprocessingML for the same document, so a corpus from one producer
proves one producer.

| `<Application>` | Files |
|---|---:|
| `Microsoft Office Word` | 27 |
| `unknown` | 4 |
| `Microsoft Word 12.0.0` | 3 |
| `Microsoft Macintosh Word` | 2 |
| `LibreOffice/25.8.4.2$Linux_X86_64 LibreOffice_project/036660…` | 1 |
| `LibreOffice/7.1.4.2$Windows_X86_64 LibreOffice_project/a529a…` | 1 |
| `WPS Office_11.1.0.10700_F1E327BC-269C-435d-A152-05C5408002CA` | 1 |
| `Microsoft word` | 1 |

**Read that table with suspicion, which is the lesson.** `Microsoft Word 12.0.0`
is *pandoc* — it copies the metadata of its reference document. `unknown` is not a lookup failure: Google Docs and Apple Pages ship no
`docProps/app.xml` at all. **The generator string is a claim, not an observation.**

## What the corpus actually exercises

| Feature | Files | Example |
|---|---:|---|
| tables | 25 | `va-ibc-minutes` |
| nestedTables | 3 | `adv-all-features` |
| mergedCells | 11 | `arpah-policy` |
| numberedOrBulletedLists | 19 | `va-ibc-minutes` |
| multiLevelLists | 5 | `va-ibc-minutes` |
| drawingCanvas | 0 | **none — see the report** |
| inlineImages | 8 | `gatech-thesis` |
| floatingImages | 7 | `in-dhs-minutes` |
| images | 11 | `in-dhs-minutes` |
| headers | 17 | `va-ibc-minutes` |
| footers | 21 | `va-ibc-minutes` |
| footnotes | 7 | `arpah-policy` |
| endnotes | 3 | `who-pqs-lab` |
| hyperlinks | 14 | `sc-annual-report` |
| comments | 2 | `adv-all-features` |
| trackedChanges | 3 | `3gpp-working-proc-rm` |
| contentControls | 7 | `usda-perf-report` |
| fields | 14 | `arpah-policy` |
| multiSection | 11 | `usda-perf-report` |
| differingPageSetup | 1 | `adv-page-setups` |
| customStyles | 39 | `va-ibc-minutes` |
| themeFonts | 37 | `va-ibc-minutes` |
| nonLatinText | 5 | `iawg-arabic` |
| rightToLeft | 2 | `iawg-arabic` |
| embeddedObject | 3 | `adv-wps-office` |
| equationOMML | 3 | `gatech-thesis` |
| textBoxOrCanvas | 7 | `or-oha-minutes` |
| strictConformance | 1 | `adv-strict-ooxml` |
| nonWPrefix | 3 | `adv-prefix-ns0` |
| preserveSpace | 31 | `va-ibc-minutes` |
| largeFile | 3 | `iawg-arabic` |

## Tier A — representative (20)

Issuer families, with counts — **stated rather than left to be counted**: ftp.3gpp.org (2) · www.research.va.gov (1) · www.ams.usda.gov (1) · cops.usdoj.gov (1) · arpa-h.gov (1) · www.in.gov (1) · www.oregon.gov (1) · ed.sc.gov (1) · insurance.ky.gov (1) · grad.gatech.edu (1) · www.mtu.edu (1) · graduate.baylor.edu (1) · extranet.who.int (1) · healthcluster.who.int (1) · cdn.who.int (1) · www.acm.org (1) · journals.plos.org (1) · www.ema.europa.eu (1) · cdn.iawg.rygn.io (1).

19 distinct hosts across 20 files. The xlsx corpus took 11 of 25 from a single issuer and said so; this one was built not to repeat that.

| Slug | Source | Paras | Runs | Chars | Tables | Bytes |
|---|---|---:|---:|---:|---:|---:|
| `3gpp-working-proc` | 3GPP — Working Procedures (governing document of the partnership) | 1,156 | 3,155 | 85,139 | 5 | 120,765 |
| `3gpp-working-proc-rm` | 3GPP — Working Procedures, REVISION-MARKED (real-world tracked changes) | 1,156 | 3,166 | 85,139 | 5 | 122,434 |
| `acm-taps-template` | ACM — TAPS primary article submission template | 287 | 2,148 | 33,975 | 2 | 315,194 |
| `gatech-thesis` | Georgia Tech — graduate thesis template | 430 | 793 | 24,673 | 7 | 78,696 |
| `mtu-thesis` | Michigan Tech — thesis template (large, image-heavy) | 232 | 881 | 19,254 | 3 | 918,533 |
| `baylor-dissertation` | Baylor University — dissertation / thesis model | 389 | 525 | 16,912 | 6 | 48,655 |
| `who-pqs-lab` | WHO Prequalification — laboratory report template | 341 | 1,054 | 16,313 | 9 | 56,921 |
| `who-steps-country` | WHO STEPS — NCD surveillance country report template | 292 | 692 | 12,903 | 34 | 41,233 |
| `arpah-policy` | ARPA-H — administrative and national policy template | 220 | 428 | 12,241 | 4 | 57,513 |
| `who-phsa-long` | WHO Health Cluster — public health situation analysis, long form | 656 | 812 | 9,364 | 8 | 152,905 |
| `sc-annual-report` | South Carolina Dept of Education — school annual report template | 352 | 507 | 8,867 | 11 | 51,787 |
| `plos-strobe-mr` | PLOS ONE — STROBE-MR reporting checklist, fillable | 289 | 193 | 7,532 | 1 | 37,136 |
| `ema-orphan-app` | European Medicines Agency — orphan designation application, scientific part | 173 | 479 | 6,053 | 3 | 36,155 |
| `va-ibc-minutes` | US Dept of Veterans Affairs — institutional biosafety committee meeting minutes | 125 | 442 | 5,697 | 2 | 32,080 |
| `doj-mou-fillable` | US DOJ COPS Office — fillable memorandum of understanding | 49 | 315 | 5,257 | 0 | 26,485 |
| `usda-perf-report` | USDA Agricultural Marketing Service — annual performance report template | 180 | 261 | 4,777 | 7 | 35,023 |
| `or-oha-minutes` | Oregon Health Authority — agenda and minutes template | 129 | 97 | 779 | 1 | 54,429 |
| `ky-pbm-policy` | Kentucky Dept of Insurance — pharmacy benefit manager reporting policy | 15 | 15 | 484 | 0 | 17,407 |
| `iawg-arabic` | Inter-Agency Working Group — Arabic-language training template (RTL, 1.7MB) | 17 | 55 | 404 | 0 | 1,772,128 |
| `in-dhs-minutes` | Indiana Dept of Homeland Security — meeting minutes template | 18 | 58 | 396 | 0 | 169,031 |

## Tier B — adversarial (20)

Chosen for **generator diversity** and because each isolates one thing that breaks
naive readers. `origin: derived` entries are deterministic transforms of a locked
source, built by code in `build_docx_corpus.py`, so they are byte-reproducible on a
fresh clone — nothing here depends on a local Word or LibreOffice install.

| Slug | What it isolates | Origin | Prefix | Paras | Chars | Bytes |
|---|---|---|:-:|---:|---:|---:|
| `adv-google-docs` | GOOGLE DOCS export — 9 parts, and NO docProps at all, so `generator` is genuinely absent | downloaded | `w` | 9 | 2,131 | 7,292 |
| `adv-libreoffice-lin` | LIBREOFFICE 25.8 on Linux, and the largest file here at 2.9MB — generator and scale at once | downloaded | `w` | 5 | 26 | 2,959,626 |
| `adv-libreoffice-win` | LIBREOFFICE 7.1 on Windows — 1,322 paragraphs, text boxes, anchored images | downloaded | `w` | 1,322 | 25,470 | 71,491 |
| `adv-apple-pages` | APPLE PAGES export — a producer nobody tests against, also with no docProps | downloaded | `w` | 10 | 188 | 8,740 |
| `adv-wps-office` | WPS OFFICE (Kingsoft) — a non-Microsoft suite, and its document.xml has no text at all | downloaded | `w` | 1 | 0 | 130,189 |
| `adv-word-mac-move` | WORD FOR MAC, carrying a tracked MOVE (paired moveFrom / moveTo, not ins+del) | downloaded | `w` | 9 | 99 | 26,151 |
| `adv-pandoc-tables` | PANDOC output — note it declares itself `Microsoft Word 12.0.0`; the generator string lies | downloaded | `w` | 31 | 253 | 10,870 |
| `adv-strict-ooxml` | STRICT OOXML — the whole document is in purl.oclc.org/ooxml/..., not schemas.openxmlformats.org | downloaded | `w` | 1 | 4 | 11,692 |
| `adv-prefix-ns0` | Every WML element under the prefix `ns0:` instead of `w:` — found in the wild, not synthesised | downloaded | `ns0` | 1 | 3 | 2,289 |
| `adv-alt-doc-path` | The main document part is NOT at word/document.xml — it must be resolved through _rels/.rels | downloaded | `w` | 4 | 97 | 11,582 |
| `adv-all-features` | One file carrying tables, lists, images, headers, footnotes, endnotes, comments, tracked changes, content controls, OMML, a text box, an embedded object and anchored images | downloaded | `w` | 199 | 1,216 | 151,733 |
| `adv-deep-tables` | 5,000 tables nested 4,999 deep — element depth 15,004. A recursive reader dies here | downloaded | `w` | 5,000 | 83,890 | 17,198 |
| `adv-merged-cells` | Horizontal (gridSpan) and vertical (vMerge) cell merges | downloaded | `w` | 16 | 44 | 13,401 |
| `adv-header-footer-only` | ALL of its text lives in header/footer parts — document.xml has zero characters, legitimately | downloaded | `w` | 1 | 0 | 28,423 |
| `adv-many-paragraphs` | 31,190 paragraphs / 800,115 characters / 661 tables — the scale failure mode, and an image relationship that does not resolve | downloaded | `w` | 31,190 | 800,115 | 4,515,424 |
| `adv-hebrew-rtl` | Hebrew — right-to-left text, and a third distinct spelling of the generator (`Microsoft word`) | downloaded | `w` | 17 | 236 | 19,164 |
| `adv-prefix-default` | The WML namespace as the DEFAULT namespace — <p>, <r>, <t>, no prefix on any element | derived | *(default)* | 31 | 253 | 10,894 |
| `adv-prefix-exotic` | Every WML element under the prefix `zzz:` — a prefix no producer would ever pick | derived | `zzz` | 31 | 253 | 10,917 |
| `adv-page-setups` | THREE different page setups in one document, one of them LANDSCAPE — plus a footnote, an endnote and two text boxes | downloaded | `w` | 124 | 3,784 | 92,125 |
| `adv-comments-many` | Eight comments — anchored by commentRangeStart/End marks that are siblings of the text, not parents of it | downloaded | `w` | 7 | 264 | 18,028 |

## Rejected candidates

Recorded so the sourcing is auditable — a corpus is only as honest as what it left out.

| Slug | Leading bytes | Reason |
|---|---|---|
| `poi-password-solrcell` | `b'\xd0\xcf\x11\xe0'` | OLE/CFB compound file, not a zip — this is a password-protected .docx; the OOXML package is encrypted inside it |
| `msoffcrypto-ecma376` | `b'\xd0\xcf\x11\xe0'` | OLE/CFB compound file, not a zip — this is a password-protected .docx; the OOXML package is encrypted inside it |
| `tika-word-truncated` | `b'PK\x03\x04'` | starts with PK but the zip is unreadable (truncated or damaged archive) |

## Coverage targets NOT met

**drawingCanvas** — No <wpc:wpc> ELEMENT in 147 files scanned (40 corpus + 107 staging pool). The trap: the string 'wordprocessingCanvas' appears in ~70 of them because Word declares xmlns:wpc on the document root whether or not a canvas is used, so a feature detector that greps namespace URIs would report a canvas in nearly every Word file ever written. Text boxes (<w:txbxContent>) ARE covered, by 7 files.

**libraryGeneratedApplicationString** — No file declares a LIBRARY as its <Application> (no 'Aspose.Words', 'docx4j', 'Apache POI'). Searched apache/poi test-data (130 docx), apache/tika test-documents (56), aspose-words Examples/Data (237), python-docx tests (4), python-docx-template templates (40), docxtemplater examples (168), docx2python resources (41), mammoth.js + python-mammoth (17 each), jgm/pandoc test/docx (85) and test/docx/golden (38). Those repositories store Word-AUTHORED inputs; library outputs are generated at test time and not committed. The library case is represented instead by the four files with NO docProps at all, which is what a non-Office producer actually looks like on disk.

**localLibreOfficeInstall** — soffice.exe is not on this machine (searched Program Files, Program Files (x86), AppData/Local, scoop, chocolatey). Closed anyway: three genuine LibreOffice exports were found in the wild (25.8/Linux, 7.1/Windows, and 5.1 + 6.0 in the staging pool), which is better evidence than a local render because it is fetchable and hash-lockable.

---

Full traps, per-file numbers, and the notes a reader author needs before writing
one: **`corpus/DOCX_CORPUS_REPORT.md`**.
