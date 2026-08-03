/* Grade our formula engine against Excel's own answers.
 *
 * Excel caches the result it computed next to every formula. That makes any
 * real workbook a graded exam we did not write — the single most honest
 * measure of the engine available, and one that costs nothing to run.
 *
 * Usage: node test/agreement.mjs [slug ...]
 *
 * Reports overall agreement, then ROOT disagreements: cells that differ from
 * Excel while every dependency of theirs AGREES. A root is a real defect; the
 * thousands of cells downstream of it are just propagation, and chasing them
 * is how you spend a day fixing nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setInflate } from '../src/core/ooxml/zip.js';
import { openXlsx, readSheet } from '../src/core/ooxml/xlsx.js';
import { makeGraph } from '../src/apps/sheet/sheet.js';

setInflate((b) => new Uint8Array(zlib.inflateRawSync(Buffer.from(b))));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const slugs = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'corpus', 'corpus.json'), 'utf8'));
const targets = slugs.length
  ? lock.files.filter((f) => slugs.includes(f.slug))
  : lock.files.filter((f) => f.features.cellsWithFormula > 0);

const close = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);

/** Normalise a formula to its SHAPE so identical defects group together. */
function shape(f) {
  return String(f)
    .replace(/'[^']*'!/g, 'S!')
    .replace(/\$?\b[A-Z]{1,3}\$?\d+/g, 'R')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/"[^"]*"/g, '"T"')
    .slice(0, 64);
}

/* Cells we knowingly cannot reproduce yet, with the reason. This is a
 * PUBLISHED BASELINE, not an allowlist that grows to make the gate pass: the
 * test fails the moment the count rises, and each entry names a real missing
 * feature rather than a fudge. */
const KNOWN_GAPS = {
  'adv-formulas-eval': {
    count: 5,
    why: 'defined names (A10_R1C1), whole-row references (SUM(8:9)), and array '
       + 'functions (TRANSPOSE) are not implemented',
  },
};

let totalGraded = 0, totalOk = 0, totalErrOk = 0, totalErr = 0, failures = 0;
const unexpected = [];

for (const entry of targets) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'corpus', 'files', entry.file)));
  const wb = await openXlsx(bytes);

  const data = {};
  const cachedNum = new Map();     // id -> Excel's number
  const cachedErr = new Map();     // id -> Excel's error
  const formulaOf = new Map();

  for (const sh of wb.sheets.filter((s) => s.kind === 'worksheet')) {
    const { cells } = await readSheet(wb, sh);
    for (const c of cells) {
      const id = `${sh.name}!${c.ref}`;
      data[id] = c.formula ? '=' + c.formula
        : c.kind === 'text' ? "'" + c.value
        : c.kind === 'number' ? c.value.toString()
        : c.kind === 'bool' ? (c.value ? 'TRUE' : 'FALSE')
        : c.kind === 'error' ? c.value : '';
      if (!c.formula) continue;
      formulaOf.set(id, c.formula);
      if (c.kind === 'number') cachedNum.set(id, c.value.toNumber());
      else if (c.kind === 'error') cachedErr.set(id, c.value);
    }
  }

  const g = makeGraph();
  g.loadJSON(data);

  /* ---- verdict per graded cell ---- */
  const verdict = new Map();       // id -> 'ok' | 'bad' | 'err'
  let ok = 0, bad = 0, err = 0;
  for (const [id, want] of cachedNum) {
    const v = g.value(id);
    if (v.k === 'error') { verdict.set(id, 'err'); err++; }
    else if (v.k === 'number' && close(v.d.toNumber(), want)) { verdict.set(id, 'ok'); ok++; }
    else { verdict.set(id, 'bad'); bad++; }
  }
  // cells where Excel itself errored: agreeing means we error the same way
  let errOk = 0, errBad = 0;
  for (const [id, want] of cachedErr) {
    const v = g.value(id);
    if (v.k === 'error' && v.e === want) errOk++; else errBad++;
  }

  const graded = cachedNum.size;
  const pct = graded ? ((ok / graded) * 100).toFixed(1) : '—';

  console.log(`\n=== ${entry.slug} ===`);
  console.log(`  graded formula cells : ${graded.toLocaleString()}`);
  console.log(`  agree                : ${ok.toLocaleString()}  (${pct}%)`);
  console.log(`  we error, Excel did not : ${err.toLocaleString()}`);
  console.log(`  wrong number         : ${bad.toLocaleString()}`);
  if (cachedErr.size) {
    console.log(`  Excel errored here   : ${cachedErr.size.toLocaleString()} (we match ${errOk.toLocaleString()})`);
  }
  totalGraded += graded; totalOk += ok; totalErrOk += errOk; totalErr += cachedErr.size;
  const missed = (graded - ok) + errBad;
  const allowed = KNOWN_GAPS[entry.slug] ? KNOWN_GAPS[entry.slug].count : 0;
  if (missed > allowed) { failures++; unexpected.push(`${entry.slug}: ${missed} disagree, baseline ${allowed}`); }
  else if (missed) console.log(`  known gap            : ${missed} cells — ${KNOWN_GAPS[entry.slug].why}`);
  if (!missed) continue;

  /* ---- roots: a failure whose inputs are all correct ---- */
  const isCleanDep = (d) => {
    const vd = verdict.get(d);
    if (vd === undefined) return true;      // literal, or ungraded — assume fine
    return vd === 'ok';
  };

  const roots = new Map();
  for (const [id, vd] of verdict) {
    if (vd === 'ok') continue;
    const n = g.nodes.get(id);
    if (!n) continue;
    let clean = true;
    for (const d of n.deps) if (!isCleanDep(d)) { clean = false; break; }
    if (!clean) continue;
    const key = (vd === 'err' ? g.value(id).e : 'WRONG') + '  ' + shape(formulaOf.get(id));
    if (!roots.has(key)) {
      const got = g.value(id);
      roots.set(key, {
        n: 0, id,
        f: formulaOf.get(id),
        got: got.k === 'number' ? got.d.toNumber() : got.e,
        want: cachedNum.get(id),
      });
    }
    roots.get(key).n++;
  }

  const top = [...roots.values()].sort((a, b) => b.n - a.n).slice(0, 10);
  console.log(`  ROOT patterns        : ${roots.size}  (top ${top.length})`);
  for (const r of top) {
    console.log(`    ${String(r.n).padStart(6)}  ${r.id}`);
    console.log(`            =${String(r.f).slice(0, 84)}`);
    console.log(`            ours=${r.got}   excel=${r.want}`);
  }
}

/* ---- verdict ---------------------------------------------------------- */

const pctAll = totalGraded ? ((totalOk / totalGraded) * 100).toFixed(2) : '100.00';
console.log('');
console.log(`  ${targets.length} workbooks · ${totalGraded.toLocaleString()} graded formula cells`);
console.log(`  agreement with Excel : ${totalOk.toLocaleString()} / ${totalGraded.toLocaleString()}  (${pctAll}%)`);
console.log(`  Excel's own errors reproduced : ${totalErrOk.toLocaleString()} / ${totalErr.toLocaleString()}`);
console.log('');
const baseline = Object.values(KNOWN_GAPS).reduce((a, k) => a + k.count, 0);
console.log(`  known gaps (published baseline) : ${baseline}`);
console.log('');
if (failures) { for (const u of unexpected) console.log('  x ' + u); process.exit(1); }
console.log('  all green');
