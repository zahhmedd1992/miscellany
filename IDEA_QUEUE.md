# IDEA_QUEUE — what ships next on miscellany.io

Established 2026-08-04. Rough list for reaction, not a commitment.

**Status 2026-08-05: the recommended next-5 sequence is FULLY SHIPPED — tally 8.**
✅ Passwords · ✅ QR · ✅ Verify + Encrypt · ✅ PDF toolkit (v1: merge/split/
extract/reorder/rotate/delete/strip-metadata) · ✅ Loan (amortization).
Next up from this queue when Zach green-lights: PDF v2 items (thumbnails,
outlines, page numbers, compress), Redact, Metadata inspect/strip,
Image convert, Diff — or Board as the next Grain app.

---

## The filter — what qualifies as a Miscellany tool

A candidate must pass all five. The rejects below each fail exactly one, which is how the filter stays honest.

1. **People currently upload sensitive data or pay a subscription for it.** The task has a broken status quo.
2. **Entirely computable locally.** No API, no server, no live data feed. The no-network claim is build-enforced; anything needing the network is structurally out.
3. **Narrow enough that flawless is achievable.** The D3 doctrine. Broad-and-mediocre is worthless.
4. **No maintenance decay.** A downloaded single-file tool cannot update itself. Anything resting on yearly tables (tax rates), live data (FX), or shifting external state rots in the user's Downloads folder. Pure algorithms only.
5. **Buildable under "never inherit a MODEL."** Mechanisms (WebCrypto, Canvas, Reed-Solomon, DEFLATE, `window.print()`) are free to use; other people's document models are not.

## The strategy in three sentences

**Small single-file tools grow the tally fast and are the distribution channel** — "free X no upload" searches are how strangers find the site, and each tool page converts one-task visitors into platform users. **The PDF toolkit is the flagship** because it is the highest-traffic free-tool category on the internet and the one place preserve-unknown is an even stronger story than xlsx (people upload contracts and tax returns to iLovePDF). **Grain apps are the deep moat cooking in the background** — slow, but nobody can follow. Bonus: every first-party small exercises the build's guarantee machinery (no-network scan, tally = TOOLS array, closure walk), which is the Stage-4 module registry in embryo.

---

## Track B — single-file tools (the tally growers)

Effort: S = days · M = 1–2 wk · L = multi-week.

### 1. Private file surgery — the moat category
Competitors' business model *requires* the upload (ads, accounts, data). They structurally cannot match "your file never leaves your machine," and we can prove it.

| Tool | Pitch | Effort |
|---|---|---|
| **PDF toolkit** | Merge, split, reorder, rotate, delete pages, page numbers, compress. Built direct on ISO 32000 with preserve-unknown via PDF **incremental updates** — append-only edits, original bytes literally untouched. Every existing client-side tool stands on pdf-lib, which rebuilds the file and drops what it doesn't model. | L — flagship |
| **Redact** | TRUE redaction: content removed from the file, not a black box drawn over it. The overlay failure mode is famous (court filings, DOJ). Rides on the PDF work. | M |
| **Metadata inspect + strip** | "What does this file say about you?" EXIF GPS in photos, author/track-changes in .docx, PDF metadata. Inspect, then strip before sending. | S–M |
| **Image convert / resize / compress** | PNG↔JPEG↔WebP, resize, quality slider, before/after. Canvas + WebCodecs are platform mechanisms. Squoosh proves local viability — but it's a Google PWA, not an auditable file you keep. | M |
| **File encrypt** | Password-protect any file (AES-GCM via WebCrypto) to send over email. The one category where "no network + read the source" IS the product. | S |
| **Hash / verify** | SHA-256 a download, compare against a published hash. Dogfoods Miscellany's own trust story. | S |

### 2. Subscription-scam counterparts
The paid incumbent is a racket; the honest version is small.

| Tool | Pitch | Effort |
|---|---|---|
| **QR generator** | The "dynamic QR" industry charges monthly for a static image that dies when you stop paying. Reed-Solomon is a mechanism; this code is yours forever. URL / WiFi / vCard payloads, SVG+PNG export. | S |
| **Password / passphrase generator** | ~200 lines. The ultimate read-the-source showcase — the tool whose whole value is that you can verify it. | S |
| **Invoice maker** | Clean form → print-ready invoice via the browser's own print-to-PDF (a mechanism — zero PDF code needed). Every free one is an account funnel with a watermark. Enormous small-business traffic. | S–M |
| **Resume builder** | Same chassis as invoices. Competitors literally harvest the resumes. Your career history never leaves the machine. | M |
| **Screen recorder** | getDisplayMedia → a file on your disk. Loom without the account, the watermark, or the 5-minute gate. | M |
| **Audio trim / convert** | Trim a voice memo, convert to WAV/MP3, normalize volume. Every online trimmer uploads. | M |

### 3. Bank-grade calculators — Zach's domain edge
Every ad-farm calculator online gets the conventions subtly wrong. A banker-built one that does day counts correctly is a *provable* quality claim, and this cluster shares one chassis.

| Tool | Pitch | Effort |
|---|---|---|
| **Amortization / loan analyzer** | Real day-count conventions (30/360, actual/360, actual/365), extra-payment scenarios, printable schedule. Later: exports into Sheet — the first cross-tool composition demo. | M |
| **TVM calculator** | HP-12C-grade time value of money: N/I/PV/PMT/FV, NPV, IRR — exact, not float-sloppy (the BigInt decimal core already exists). | S–M |
| **Refinance / rent-vs-buy** | Same chassis as amortization, one scenario layer up. | S each |

### 4. Text & data — everyday, zero-decay
| Tool | Pitch | Effort |
|---|---|---|
| **Diff** | Two texts side-by-side, word-level highlights. Pasting a confidential contract into an online differ is a leak people don't think about. | S–M |
| **Text cleaner** | Smart quotes, invisible Unicode, whitespace, case, dedupe/sort lines — including the AI-era "clean this pasted text" problem. | S |
| **Chart maker** | Paste data → clean chart → export SVG/PNG. Datawrapper without the account; reuses the chart renderer already built for Sheet. | M |
| **CSV / JSON tools** | View, validate, pretty-print, convert. Dev-leaning but broad. | S–M |
| **Word count + readability** | Counts, reading time, grade-level. | S |
| **Unit converter** | Comprehensive, offline. Passes every filter; just unglamorous. Filler tier. | S |

### 5. Printables — pure algorithm, zero decay, word-of-mouth
Teachers and small offices evangelize tools. All of these are `window.print()` + good typography.

| Tool | Pitch | Effort |
|---|---|---|
| **Calendar generator** | Any month/year, wall-calendar quality, print-ready. Charming and permanent. | S |
| **Practice sheets** | Math worksheet generator by grade/skill, with answer keys. The incumbent is subscription junk (TPT). | S–M |
| **Paper** | Graph / lined / dot-grid / handwriting paper. | S |
| **Labels / envelopes** | Avery-layout printing without Avery's site. | S |
| **Picker / wheel / groups** | Random name picker, team splitter. The wheel-of-names category is huge with teachers and every site is ad-soaked. | S |

### Needs a design answer before queueing
- **Vault (password manager)** — a single-file encrypted vault (the file IS the database; re-save = persist) passes every filter and there's a parked project for it (`project_diy_password_manager`). Gated on one hard problem: lost file = lost everything, and crypto UX for non-technical users is sharp. Worth a design session, not a build yet.

---

## Track A — Grain apps (the platform track)

In order:

1. **Board** (kanban) — cheapest next Grain app: cards are nodes, columns are ranges, WIP counts are formulas. Trello's free tier shrinks yearly. Third app shape = the real validation of the Grain extraction.
2. **Note** — local-first linked notes on the .grain format. The Obsidian-adjacent audience IS the local-first crowd.
3. **Form** — inverted by no-server: *generates a self-contained form file*; responses come back as files. Genuinely novel, needs design thought first.
4. ~~**Doc** — stays deferred per spec~~ — **SHIPPED 2026-08-22.** The deferral judged Doc
   as a word processor competing with word processors. On the node graph it is not that: a
   sentence can hold a formula, and a table or chart in the report is a dependent of a range.
   Rich text layout really was enormous — a layout engine, a font-metrics table, a caret and
   selection from nothing, and a PDF writer — but everything else was already built.
   See PROJECT_SPEC.md for the full reversal.

**Deepen-the-existing (doesn't grow the tally, grows the claim):** .pptx open/save for Deck · editable charts in Sheet · CSV import · functions 76 → ~120 · resize/formatting gaps.

---

## The anti-queue — explicit rejects

| Candidate | Killed by filter # | Why |
|---|---|---|
| Currency converter | 2 | Needs live FX. No-network makes it structurally impossible. |
| Tax / paycheck calculators | 4 | Yearly-table decay — the downloaded copy silently goes wrong every January. |
| Diagramming | 1 | Excalidraw and draw.io are already free, local-capable, excellent. No broken status quo to fix. (May fall out of Grain shapes later for free.) |
| Video editor | 3 | Codecs, patents, gigabyte files — single-file can't hold it flawlessly. |
| Email / chat / anything comms | 2 | The network is the product. |

---

## Recommended sequence (next 5)

1. **Password generator** (S) — tally 3 in days; pure trust showcase.
2. **QR generator** (S) — tally 4; the subscription-scam story writes itself.
3. **Hash/verify + File encrypt** (S) — tally 5–6; completes the trust trio.
4. **PDF toolkit** (L) — start now in parallel; the traffic magnet and preserve-unknown at its strongest.
5. **Amortization analyzer** (M) — first bank-grade calculator; the domain-credibility wedge.

Then **Board** as the next Grain app once the smalls have the tally moving.

Open naming question (cosmetic, D7-style): smalls could take plain verbs — Seal (encrypt), Wipe (metadata), Trim (audio), Pick (wheel) — or stay descriptive. Decide once, before tool #3.
