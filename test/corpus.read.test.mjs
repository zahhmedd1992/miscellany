/* Read every file in the locked corpus. Run: node test/corpus.read.test.mjs
 *
 * The assertion that matters is NOT "it didn't throw". It is a cross-check
 * against corpus.json, whose cell counts were produced by a completely
 * separate implementation (Python, different XML strategy). Two independent
 * readers agreeing is evidence; one reader asserting is a press release.
 *
 * Specifically it catches the failure mode that motivated the whole corpus:
 * a reader that opens a file as BLANK and reports success.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setInflate } from '../src/core/ooxml/zip.js';
import { openXlsx, readSheet, isDateFormat, serialToISO } from '../src/core/ooxml/xlsx.js';
import { translateFormula } from '../src/core/ooxml/refs.js';

setInflate((b) => new Uint8Array(zlib.inflateRawSync(Buffer.from(b))));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'corpus', 'corpus.json'), 'utf8'));

let pass = 0, fail = 0;
const fails = [];
const t = (name, ok, detail = '') => {
  if (ok) pass++; else { fail++; fails.push(`${name}${detail ? '\n      ' + detail : ''}`); }
};

/* ---- reference translation -------------------------------------------
 * Used by shared-formula expansion, fill-down and paste. A corrupted formula
 * still computes, so a wrong answer here is invisible until someone trusts
 * the number. These are the cases a naive regex gets wrong. */

const tf = (s, dc, dr) => translateFormula(s, dc, dr);

t('shift row', tf('A1+B2', 0, 1) === 'A2+B3', tf('A1+B2', 0, 1));
t('shift col', tf('A1+B2', 1, 0) === 'B1+C2', tf('A1+B2', 1, 0));
t('absolute both held', tf('$F$14', 3, 5) === '$F$14', tf('$F$14', 3, 5));
t('absolute col only', tf('$F14', 3, 5) === '$F19', tf('$F14', 3, 5));
t('absolute row only', tf('F$14', 3, 5) === 'I$14', tf('F$14', 3, 5));
t('range both ends', tf('SUM(A1:A9)', 0, 2) === 'SUM(A3:A11)', tf('SUM(A1:A9)', 0, 2));
t('LOG10 is not a reference', tf('LOG10(A1)', 0, 1) === 'LOG10(A2)', tf('LOG10(A1)', 0, 1));
t('LOG10 col shift too', tf('LOG10(A1)', 1, 0) === 'LOG10(B1)', tf('LOG10(A1)', 1, 0));
t('string literal untouched', tf('IF(A1="A1","A1",B1)', 0, 1) === 'IF(A2="A1","A1",B2)', tf('IF(A1="A1","A1",B1)', 0, 1));
t('escaped quote in literal', tf('"say ""A1"""&A1', 0, 1) === '"say ""A1"""&A2', tf('"say ""A1"""&A1', 0, 1));
t('off-sheet becomes #REF!', tf('A1', 0, -5) === '#REF!', tf('A1', 0, -5));
t('col AA wraps correctly', tf('Z1', 1, 0) === 'AA1', tf('Z1', 1, 0));
t('real NREL shared formula', tf('1/((1+$F$14)*(1+$F$26))^H24', 0, 3) === '1/((1+$F$14)*(1+$F$26))^H27',
  tf('1/((1+$F$14)*(1+$F$26))^H24', 0, 3));
t('zero shift is identity', tf('SUM(A1:B2)', 0, 0) === 'SUM(A1:B2)');

/* ---- unit checks on the tricky bits ----------------------------------- */

t('date fmt: dd/mm/yyyy', isDateFormat('dd/mm/yyyy') === true);
t('date fmt: [$-409]d-mmm-yy', isDateFormat('[$-409]d-mmm-yy') === true);
t('date fmt: h:mm:ss', isDateFormat('h:mm:ss') === true);
t('NOT a date: #,##0.00', isDateFormat('#,##0.00') === false);
t('NOT a date: 0.0%', isDateFormat('0.0%') === false);
t('NOT a date: "May"#,##0', isDateFormat('"May"#,##0') === false,
  'quoted literal text must not make a format a date');
t('NOT a date: $#,##0;[Red]($#,##0)', isDateFormat('$#,##0;[Red]($#,##0)') === false,
  '[Red] is a colour modifier, not a date token');

t('serial 1 -> 1900-01-01', serialToISO(1, false) === '1900-01-01', serialToISO(1, false));
t('serial 59 -> 1900-02-28', serialToISO(59, false) === '1900-02-28', serialToISO(59, false));
t('serial 60 is the phantom leap day', String(serialToISO(60, false)).includes('invalid'), String(serialToISO(60, false)));
t('serial 61 -> 1900-03-01', serialToISO(61, false) === '1900-03-01', serialToISO(61, false));
t('serial 45000 -> 2023-03-15', serialToISO(45000, false) === '2023-03-15', serialToISO(45000, false));
t('1904 epoch: 0 -> 1904-01-01', serialToISO(0, true) === '1904-01-01', serialToISO(0, true));

/* ---- the corpus ------------------------------------------------------- */

const rows = [];
let blanked = 0, threw = 0, totalCells = 0;
const started = Date.now();

for (const e of lock.files) {
  const p = path.join(ROOT, 'corpus', 'files', e.file);
  let readCells = 0, sheets = 0, formulas = 0, dates = 0, err = null, warns = 0;
  try {
    const bytes = new Uint8Array(fs.readFileSync(p));
    const wb = await openXlsx(bytes);
    sheets = wb.sheets.length;
    for (const sh of wb.sheets) {
      if (!sh.path || sh.kind !== 'worksheet') continue;
      const r = await readSheet(wb, sh);
      readCells += r.cells.length;
      for (const c of r.cells) { if (c.formula) formulas++; if (c.isDate) dates++; }
    }
    warns = wb.warnings.length;
  } catch (ex) {
    err = ex.message;
    threw++;
  }
  totalCells += readCells;

  const expected = e.features.cellsWithValue;
  const expectedF = e.features.cellsWithFormula;

  t(`read ${e.slug}`, !err, err || '');
  if (!err) {
    // EXACT equality against an independent implementation. The earlier
    // version of this test asserted only "reader != 0" and "reader <=
    // expected*1.05" — and passed a reader that silently dropped 116,491
    // shared formulas. A gate loose enough to pass a broken build is not a
    // gate.
    t(`cells with a value: ${e.slug}`, readCells === expected,
      `reader ${readCells} vs characteriser ${expected}`);
    t(`cells with a formula: ${e.slug}`, formulas === expectedF,
      `reader ${formulas} vs characteriser ${expectedF}` +
      (e.features.sharedFormulaRefs ? ` (${e.features.sharedFormulaRefs} are shared refs)` : ''));
  }
  if (!err && expected > 0 && readCells === 0) blanked++;

  rows.push({ slug: e.slug, tier: e.tier, sheets, expected, readCells, formulas, expectedF, dates, warns, err,
              pfx: e.features.prefixedXml ? 'pfx' : '' });
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);

/* ---- report ----------------------------------------------------------- */

const w = (s) => process.stdout.write(s + '\n');
w('');
w('  slug                  tier sh    values  =expect   formulas  =expect  dates');
w('  ' + '-'.repeat(76));
for (const r of rows) {
  const okC = r.readCells === r.expected, okF = r.formulas === r.expectedF;
  const flag = r.err ? ' THREW: ' + r.err.slice(0, 26)
    : (!okC || !okF) ? '  <-- MISMATCH'
    : r.warns ? `  (${r.warns} warn)` : '';
  w('  ' + r.slug.padEnd(21) + ' ' + r.tier.padEnd(4) +
    String(r.sheets).padStart(3) +
    String(r.readCells).padStart(10) + (okC ? ' ok' : ' NO').padEnd(9) +
    String(r.formulas).padStart(9) + (okF ? ' ok' : ' NO').padEnd(9) +
    String(r.dates).padStart(6) + ' ' + r.pfx.padEnd(4) + flag);
}
w('');
w(`  ${lock.files.length} files · ${totalCells.toLocaleString()} cells read in ${elapsed}s`);
w(`  threw: ${threw} · silently blank: ${blanked}`);
w('');
w(`  ${pass} passed, ${fail} failed`);
w('');
if (fails.length) {
  for (const f of fails.slice(0, 25)) w('  x ' + f);
  if (fails.length > 25) w(`  ... and ${fails.length - 25} more`);
  w('');
  process.exit(1);
}
w('  all green');
w('');
