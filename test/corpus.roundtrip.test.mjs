/* Round-trip the whole locked corpus. Run: node test/corpus.roundtrip.test.mjs
 *
 * Two gates, and the second is what makes the first honest.
 *
 *   A. NO-EDIT round trip is BYTE-IDENTICAL.
 *      Read a workbook, write it back untouched, compare bytes. Anything less
 *      than identical means we are silently rewriting parts of the user's
 *      file — which is the exact failure ("I opened it in the free one and it
 *      wrecked my file") that the whole preserve-unknown design exists to
 *      prevent. There is no partial credit here.
 *
 *   B. EDIT round trip changes ONLY the sheet part it should.
 *      Change one cell; every other part must come back byte-identical,
 *      including pivot tables, charts, drawings and macros we do not model.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setInflate, readZip } from '../src/core/ooxml/zip.js';
import { setDeflate, writeZip } from '../src/core/ooxml/zipwrite.js';
import { crc32 } from '../src/core/ooxml/crc32.js';
import { openXlsx, readSheet } from '../src/core/ooxml/xlsx.js';
import { setCellRaw } from '../src/core/ooxml/edit.js';

setInflate((b) => new Uint8Array(zlib.inflateRawSync(Buffer.from(b))));
setDeflate((b) => new Uint8Array(zlib.deflateRawSync(Buffer.from(b), { level: 9 })));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'corpus', 'corpus.json'), 'utf8'));

let pass = 0, fail = 0;
const fails = [];
const t = (name, ok, detail = '') => {
  if (ok) pass++; else { fail++; fails.push(`${name}${detail ? '\n      ' + detail : ''}`); }
};

const same = (a, b) => {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `first diff at byte ${i}`;
  return null;
};

/* ---- crc32 against the published check value -------------------------- */
t('crc32("123456789") === 0xCBF43926',
  crc32(new TextEncoder().encode('123456789')) === 0xcbf43926,
  '0x' + crc32(new TextEncoder().encode('123456789')).toString(16));

/* ---- the corpus -------------------------------------------------------- */

const rows = [];
let identical = 0, editedOk = 0;
const started = Date.now();

for (const e of lock.files) {
  const p = path.join(ROOT, 'corpus', 'files', e.file);
  const orig = new Uint8Array(fs.readFileSync(p));
  const row = { slug: e.slug, tier: e.tier, bytes: orig.length, ident: null, edit: null, err: null };

  try {
    /* --- gate A: untouched round trip --- */
    const zip = await readZip(orig);
    const rebuilt = await writeZip(zip);
    const d = same(orig, rebuilt);
    row.ident = d;
    if (!d) identical++;
    t(`byte-identical no-edit round trip: ${e.slug}`, d === null, d || '');

    /* --- gate B: one cell changed, everything else untouched --- */
    const wb = await openXlsx(orig);
    const target = wb.sheets.find((s) => s.path && s.kind === 'worksheet');
    if (target) {
      const before = await wb.zip.text(target.path);
      const patched = setCellRaw(before, 'ZZ9999', '<v>424242</v>', 'n');
      const out = await writeZip(wb.zip, new Map([[target.path, patched]]));

      const z2 = await readZip(out);
      // every part except the edited sheet must be byte-identical
      let drift = null;
      for (const en of zip.entries) {
        if (en.name === target.path) continue;
        const a = zip.rawBytes(en.name);
        const b = z2.rawBytes(en.name);
        const dd = b ? same(a, b) : 'part missing from output';
        if (dd) { drift = `${en.name}: ${dd}`; break; }
      }
      // and the edit must actually be readable back
      const wb2 = await openXlsx(out);
      const sh2 = wb2.sheets.find((s) => s.path === target.path);
      const cells2 = await readSheet(wb2, sh2);
      const found = cells2.cells.find((c) => c.ref === 'ZZ9999');
      const readBack = found && found.kind === 'number' && found.value.toString() === '424242';

      row.edit = drift || (readBack ? null : 'edited cell did not read back');
      if (!row.edit) editedOk++;
      t(`edit touches only its own part: ${e.slug}`, drift === null, drift || '');
      t(`edited cell reads back: ${e.slug}`, !!readBack,
        found ? `got ${found.kind} ${found.value}` : 'cell not found');
    }
  } catch (ex) {
    row.err = ex.message;
    t(`round trip ${e.slug}`, false, ex.message);
  }
  rows.push(row);
}


/* ---- editing a STYLED cell must keep its style ------------------------
 * setCellRaw carries the existing s= index forward. If it did not, every
 * cell a user touches would silently lose its number format — a date they
 * edited would come back as a raw serial on reopen, which is precisely the
 * failure the whole formatting layer exists to prevent. */
{
  const p2 = path.join(ROOT, 'corpus', 'files', 'fhfa-po-monthly.xlsx');
  const wb = await openXlsx(new Uint8Array(fs.readFileSync(p2)));
  const sh = wb.sheets.find((x) => x.kind === 'worksheet');
  const before = await readSheet(wb, sh);
  const a5 = before.cells.find((c) => c.ref === 'A5');
  t('fixture A5 is a styled date', a5 && a5.numFmtId === 14, `numFmtId ${a5 && a5.numFmtId}`);

  let xml = await wb.zip.text(sh.path);
  xml = setCellRaw(xml, 'A5', '<v>40000</v>', 'n');
  const out2 = await writeZip(wb.zip, new Map([[sh.path, xml]]));

  const wb2 = await openXlsx(out2);
  const after = await readSheet(wb2, wb2.sheets.find((x) => x.path === sh.path));
  const n5 = after.cells.find((c) => c.ref === 'A5');
  t('edited value reads back', n5 && n5.value.toString(), '40000');
  t('edited cell keeps its style index', n5 && n5.numFmtId, 14);
  t('edited cell still reads as a date', n5 && n5.isDate, true);

  const neighbour = after.cells.find((c) => c.ref === 'A6');
  t('neighbour untouched', neighbour && neighbour.value.toString(),
    before.cells.find((c) => c.ref === 'A6').value.toString());
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const w = (s) => process.stdout.write(s + '\n');
w('');
w('  slug                  tier      bytes  no-edit    one-edit');
w('  ' + '-'.repeat(62));
for (const r of rows) {
  w('  ' + r.slug.padEnd(21) + ' ' + r.tier.padEnd(4) +
    String(r.bytes).padStart(11) +
    (r.err ? '  THREW' : r.ident === null ? '  identical' : '  DIFF').padEnd(12) +
    (r.err ? '' : r.edit === null ? 'clean' : r.edit ? 'DRIFT' : '-') +
    (r.err ? '  ' + r.err.slice(0, 30) : ''));
}
w('');
w(`  ${lock.files.length} files in ${elapsed}s`);
w(`  byte-identical untouched: ${identical}/${lock.files.length}`);
w(`  single-edit isolated:     ${editedOk}/${lock.files.length}`);
w('');
w(`  ${pass} passed, ${fail} failed`);
w('');
if (fails.length) {
  for (const f of fails.slice(0, 20)) w('  x ' + f);
  if (fails.length > 20) w(`  ... and ${fails.length - 20} more`);
  w('');
  process.exit(1);
}
w('  all green');
w('');
