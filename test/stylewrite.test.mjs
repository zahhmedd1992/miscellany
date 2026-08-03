/* Creating styles. Run: node test/stylewrite.test.mjs
 *
 * A cell holds an INDEX into the style table, not its formatting. These
 * assertions cover the two things that make that safe: an identical request
 * must REUSE an existing entry rather than growing the table on every
 * keystroke, and serialisation must APPEND by splicing so the hundreds of
 * styles already in a real workbook survive byte-for-byte.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setInflate, readZip } from '../src/core/ooxml/zip.js';
import { StyleTable, DEFAULT_STYLES, BUILTIN_IDS } from '../src/core/ooxml/stylewrite.js';

setInflate((b) => new Uint8Array(zlib.inflateRawSync(Buffer.from(b))));
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const fails = [];
const t = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else { fail++; fails.push(`${name}\n      want: ${want}\n      got : ${got}`); }
};

/* ---- from nothing ---- */
{
  const st = new StyleTable(null);
  t('starts with one font', st.fonts.length, 1);
  t('starts with one xf', st.xfs.length, 1);
  const b = st.derive(0, { bold: true });
  t('bold makes a new xf', b, 1);
  t('bold makes a new font', st.fonts.length, 2);
  t('same request reuses', st.derive(0, { bold: true }), b);
  t('describe reports bold', st.describe(b).bold, true);
  t('describe reports not italic', st.describe(b).italic, false);
  const bi = st.derive(b, { italic: true });
  t('bold+italic is a third xf', bi, 2);
  t('bold survives the second change', st.describe(bi).bold, true);
  const off = st.derive(b, { bold: false });
  t('turning bold off returns to the base xf', off, 0);
  t('serialize is not null once dirty', st.serialize() !== null, true);
  t('clean table serializes null', new StyleTable(null).serialize(), null);
}

/* ---- number formats ---- */
{
  const st = new StyleTable(null);
  const a = st.derive(0, { numFmtCode: '"$"#,##0.00' });
  t('a custom code gets an id >= 164', st.describe(a).numFmtId >= 164, true);
  t('the same code reuses its id', st.describe(st.derive(0, { numFmtCode: '"$"#,##0.00' })).numFmtId,
    st.describe(a).numFmtId);
  const b = st.derive(0, { numFmtCode: '0.0%' });
  t('a different code gets a different id', st.describe(b).numFmtId !== st.describe(a).numFmtId, true);
  const p = st.derive(0, { numFmtId: BUILTIN_IDS.percentTwo });
  t('a built-in id needs no declaration', st.describe(p).numFmtId, 10);
  t('format changes do not disturb the font', st.describe(a).bold, false);
}

/* ---- against a real workbook ---- */
{
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'corpus', 'files', 'census-const.xlsx')));
  const zip = await readZip(bytes);
  const xml = await zip.text('xl/styles.xml');
  const st = new StyleTable(xml);
  t('reads the real font table', st.fonts.length > 5, true);
  t('reads the real xf table', st.xfs.length > 50, true);

  const before = st.xfs.length;
  const idx = st.derive(0, { numFmtCode: '"€"#,##0.000' });
  t('appends one xf', st.xfs.length, before + 1);

  const out = st.serialize();
  t('output grew', out.length > xml.length, true);
  t('the whole original survives inside it',
    out.includes(xml.slice(xml.indexOf('<fonts'), xml.indexOf('<fonts') + 200)), true);
  t('cellXfs count was bumped',
    /<cellXfs count="(\d+)"/.exec(out)[1], String(before + 1));

  const round = new StyleTable(out);
  t('reparses with the new xf', round.xfs.length, before + 1);
  t('the new format survives the round trip', round.describe(idx).numFmtId, st.describe(idx).numFmtId);
}


/* ---- fills, borders, colour and size ---- */
{
  const st = new StyleTable(null);
  const y = st.derive(0, { fill: '#FFFF00' });
  t('fill applied', st.describe(y).fill, '#FFFF00');
  t('the same fill reuses its xf', st.derive(0, { fill: '#FFFF00' }), y);
  t('a different fill is a different xf', st.derive(0, { fill: '#FF0000' }) !== y, true);
  t('clearing the fill returns to the base xf', st.derive(y, { fill: null }), 0);

  const b = st.derive(0, { border: 'thin' });
  t('border applied to all four edges',
    ['left', 'right', 'top', 'bottom'].every((k) => st.describe(b).border[k] === 'thin'), true);
  t('border removed', st.describe(st.derive(b, { border: null })).border, null);

  t('font colour', st.describe(st.derive(0, { fontColor: '#C00000' })).color, '#C00000');
  t('font size', st.describe(st.derive(0, { fontSize: 18 })).size, 18);

  // Each change must PRESERVE the others — the common bug is that setting a
  // fill silently drops the bold the user applied a moment earlier.
  const combo = st.derive(st.derive(0, { bold: true }), { fill: '#DDEEFF', border: 'medium', fontSize: 14 });
  const d = st.describe(combo);
  t('a later change keeps bold', d.bold, true);
  t('a later change keeps the fill', d.fill, '#DDEEFF');
  t('a later change keeps the border', d.border.top, 'medium');
  t('a later change keeps the size', d.size, 14);
}
{
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'corpus', 'files', 'census-const.xlsx')));
  const zip = await readZip(bytes);
  const st = new StyleTable(await zip.text('xl/styles.xml'));
  t('reads the real fill table', st.fills.length > 1, true);
  t('reads the real border table', st.borders.length > 1, true);
  const before = st.fills.length;
  st.derive(0, { fill: '#123456' });
  t('appends one fill', st.fills.length, before + 1);
  const out = st.serialize();
  t('the fills count is bumped', /<fills count="(\d+)"/.exec(out)[1], String(before + 1));
  t('reparses with the new fill', new StyleTable(out).fills.length, before + 1);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fails.length) { for (const x of fails) console.log('  x ' + x + '\n'); process.exit(1); }
console.log('  all green\n');
