# PROJECT_SPEC — Miscellany Platform

**Project:** 195_08.02.26_miscellany-platform
**Status:** PLAN AWAITING REVIEW — nothing implemented
**Deliverable under review:** `THE_PLAN.html`

---

## Goal

Make miscellany.io the largest body of free software a non-technical person can actually
use — modular, secure, and composable, without dropping below the quality of the paid
commercial alternatives.

**Success metric (proposed, D6):** not app count — *the most tasks a person can complete
for $0, with no account, without gluing tools together.*

---

## Architecture — "Grain"

Four pieces. The first is load-bearing; the other three fall out of it.

| Piece | Definition |
|---|---|
| **Node graph** | Every cell / shape / paragraph / field is a node: value, optional formula, style, dependents. One recalculation scheduler for the whole platform. |
| **Command registry** | Every action declared once: `id`, typed args, `needs: [capabilities]`, description. |
| **Capability manifest** | Per-module declaration of what it may touch. No ambient authority. |
| **View shell** | UI generated from the command registry, filtered by a JSON profile. |

### The core insight

A spreadsheet's recalc dependency graph and a "live chart on a slide" are the *same
machinery*. Build the graph once → app composition is free, app N costs ~20% of app 1,
security becomes enforceable, and the HTTP/MCP API generates itself.

```
sheet:q3-model/B4:B16   → 13 value nodes
deck:board/s3/chart-1   → node { source: ref("sheet:q3-model/B4:B16") }

edit B7 → scheduler walks dependents (same walk that updates =SUM)
        → chart-1 is an ordinary dependent → slide repaints
```

No link, no paste-special, no sync job, no integration code. References are **stable node
ids**, not file paths — which is why this doesn't break the way PowerPoint linked charts do.

### One command → six surfaces

```js
command("data.sort", {
  args:  { range: "Range", by: "Column", dir: "asc|desc" },
  needs: ["doc.write"],
  describe: "Sort a range by a column."
})
// ⇒ keyboard · menu · Ctrl+K palette · script · POST /v1/cmd/data.sort · MCP tool
```

### The ribbon answer

`profiles/sheet.simple.json` lists 10 commands, `"hide": ["*"]`. The other ~390 are
**not deleted** — they're `Ctrl+K` searchable. Minimalism without a ceiling, and no fork.

---

## Naming (D7, cosmetic)

- Platform: **Miscellany**
- Substrate: **Grain**
- Apps: **Sheet · Deck · Doc · Note · Form · Board** (plain nouns, no prefixes)

---

## Dependency policy — HARD RULE, CI-enforced

**Allowed:** MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0, CC0/Unlicense
**Forbidden:** GPL, AGPL, LGPL-static, **and anything dual-licensed with a commercial
escape hatch** (the trap — looks free until you read the terms).

CI scans the dependency tree every commit and fails the build on violation. One
contaminating dependency invalidates the entire free promise.

### Verified stack (checked 2026-08-02, primary sources)

### The rule (v3 — replaces "build vs. stand on")

> **Never inherit a MODEL. Freely use a MECHANISM.**
> A *model* is an opinion about what the thing is (ExcelJS's `Workbook`, HyperFormula's
> cell semantics, Yjs's `Y.Map`). Adopting one puts our architecture permanently and
> invisibly downstream of someone else's analysis. **BUILD.**
> A *mechanism* has a provably correct answer and no opinion (DEFLATE, SHA-256, OpenType
> shaping). There is no "our take on inflate." **USE.**

| Layer | Kind | Call |
|---|---|---|
| Node graph + recalc scheduler | model | BUILD — this is the product |
| Command registry + view shell | model | BUILD |
| Capability broker (Rust) | model | BUILD |
| Design system | model | BUILD |
| **.xlsx / .pptx read + write** | model | **BUILD** — direct OOXML vs ECMA-376, preserve-unknown *(was ExcelJS)* |
| **Formula function library** | model — every function's edge cases are semantics | **BUILD** ~120 from spec *(was Formualizer)* |
| Collaboration / history | split | **algorithm only, never Yjs's document model**; deferred past Stage 2 |
| zip / DEFLATE | mechanism (RFC 1951) | USE — container logic still ours |
| Text shaping | mechanism (Unicode + OpenType) | USE |
| Desktop host (Tauri 2) | host, not a model | USE — keep surface thin |
| Win code signing (SignPath) | mechanism | USE |

**Rejected — HyperFormula:** GPLv3 or paid. Would force the whole platform to GPLv3.

**Rejected — ExcelJS / PptxGenJS (MIT, both fine licences):** their workbook models
silently drop what they don't understand. v2 chose ExcelJS four sections away from a Stage
1 gate demanding zero-loss round-trip — **it structurally cannot pass that gate.** Zach
found the contradiction from the premise alone.

**Rejected — Formualizer (MIT/Apache-2.0):** a function library is a model. Separately it
was thin: v0.7.1 · 1,266 downloads · single maintainer. Building removes the risk entirely
rather than hedging it.

**The payoff — `preserve-unknown`:** parse what we model, keep the rest as opaque XML,
write it back byte-for-byte. Open a workbook with an unsupported pivot table → cells
modelled, pivot XML returned intact. No wrapper can offer this, because every wrapper's
job is to discard what it doesn't model. *"I opened it in the free one and it wrecked my
file"* is the #1 reason people don't leave Excel.

**Cost, stated plainly:** Stage 1 ~10–14 wk → **~18–24 wk**.

---

## Security — enforcement by stage (do NOT let "secure" float)

| Stage | Mechanism | Honest strength |
|---|---|---|
| 1–2 | Manifests declared; CI fails build if code touches undeclared capability | **Advisory.** Discipline + audit trail, NOT a sandbox. Safe only because all first-party. |
| 3 | Separate context (Web Worker / isolated process). No DOM, fs, or net handles. Privileged calls cross IPC to a Rust broker that checks the granted set. | **Enforced.** Module holds no function that can read an ungranted file. |
| 4 | + WASM Component Model, signed modules, published review bar | **Enforced + attested.** |

User-facing: plain-English permission sheet. "This add-on wants to: read files you open ·
send data to the internet." Most modules should need **nothing**.

**Macro differentiator:** Excel macros = arbitrary code with full user rights (major malware
vector, unremovable due to back-compat). Ours = registry commands under the document's
capability set. A macro wanting network access must ask and can be refused while the rest
still works.

---

## Stages and binary gates

Gates are pass/fail tests, never judgement calls. The gate IS the defence against dying
of ambition. **Pace assumption: ~4 focused sessions/week.**

| Stage | Scope | Est. | Gate |
|---|---|---|---|
| **NOW** | Working grid in browser: type, format, formulas recalc, save/reload. Deliberately unpolished. | ~2 wk | Open link, build a budget, close tab, reopen → work is there. |
| **1** | Sheet at real quality; **Grain extracted from working Sheet code**, not designed up front. | ~10–14 wk | (a) 25 real .xlsx (SEC, gov budgets) → open/save/reopen in Excel → **zero** value or visual diffs. (b) 10 non-technical people finish a real task unaided. **Corpus fixed and published BEFORE Stage 1 coding starts, never changed** — otherwise the person being graded picks the exam at grading time. |
| **2** | Deck on extracted Grain. **This stage is the experiment** — 6 wk validates the architecture; 12 wk means the abstraction was wrong (cheapest possible moment to learn). | ~6–8 wk | Edit cell → slide chart moves. .pptx round-trips into PowerPoint. |
| **3** | HTTP API + MCP generated from registry. Rust capability broker (upgrades security advisory→enforced). | ~3–5 wk | Off-the-shelf AI assistant, MCP endpoint only, no glue → CSV to finished deck. Malicious test module fails to read ungranted file. |
| **4** | Front door, signed installers, module registry, quality bar. Doc/Note/Form/Board follow. | ongoing | Someone who isn't me ships a passing module unaided. |

~6 months to two apps beating every free alternative; ~7 months to the agent layer.

---

## Where Codex / second models earn their keep

1. **Differential formula testing** — Codex generates adversarial workbooks; run through our
   engine + headless LibreOffice as independent oracle; diff. Catches "looks right, quietly
   wrong in case 400." Automatable, runs forever.
2. **Red-team the capability broker** — hand it the spec + broker source, instruction: escape
   it. Findings become permanent tests.
3. **Design critique before every ship** — screenshots against a written rubric. Catches what
   I'm blind to from staring.
4. **Round-trip fuzzing** — .xlsx generate → import → export → re-import → diff. Drift =
   silent data loss = worst possible reputational failure for a free spreadsheet.

---

## Explicitly out of scope (year one)

- **Word replacement** — rich text layout is deceptively enormous, and Doc is the least
  differentiated (everyone tolerates a free writing tool already).
- **Cloud / accounts / server** — not for cost; accounts create lock-in, liability, and a
  business model we don't want. Collab is peer-to-peer.
- **Native mobile** — web version works on a phone.
- **Feature parity claims** — we compete on the 95% + what a clean start makes possible.

---

## Checked and NOT a risk

- **File format legality** — OOXML is ECMA-376 / ISO-IEC 29500, openly specified. LibreOffice
  has implemented it for 15 years.
- **Running cost** — static downloads on Cloudflare, p2p sync, no accounts → no DB → no breach
  liability. ~$0/mo.
- **Windows install friction** — SignPath Foundation signs qualifying OSS free (clears
  SmartScreen). Azure Artifact Signing $9.99/mo fallback.

---

## The positioning wedge (verified, not marketing)

**Univer** (14k stars, Apache-2.0 core) — the closest existing thing to this vision — gates
**file import/export and printing** behind Univer Pro. Its free tier cannot open an .xlsx or
print.

→ **"Nothing here is ever gated"** is a claim we can prove and they cannot match without
changing their business model.

**The quality thesis:** free software loses on *taste*, not features. LibreOffice has the
features and hasn't won — it feels like 2009. Blender is the counterexample: version 2.8's
ground-up interface redesign flipped it from "the free one professionals avoid" to the tool
studios choose over thousand-dollar seats. The license didn't change. **Design was the unlock.**
→ One design system, one interaction language, from commit one — not applied at the end.
