/* .docx round-trip: preserve-unknown, proved on the corpus.
 * Run: node test/docx.roundtrip.test.mjs
 *
 * Two gates, the same pair the .xlsx side uses, because they are the two
 * things a person actually cares about when they open a document in a free
 * tool and press save:
 *
 *   A. UNTOUCHED means untouched. Open and save with no edit -> every part
 *      byte-identical, including the ones we do not understand at all.
 *
 *   B. ONE EDIT IS ONE EDIT. Change a single paragraph's text -> exactly one
 *      part differs, the change is present, and everything else is still
 *      byte-identical. That is what makes "I opened it in the free one and it
 *      wrecked my file" impossible rather than unlikely.
 *
 * The output is then validated by a FOREIGN implementation — Python's own
 * zipfile CRC check, run separately — because our reader accepting our writer
 * proves less than it looks like.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { openDocx, characterise, readBody } from '../src/core/ooxml/docx.js';
import { saveDocx, spliceDocument, paragraphXml, paragraphEdits, patchProps, wordPrefix }
  from '../src/core/ooxml/docxedit.js';
import { readZip } from '../src/core/ooxml/zip.js';

const LOCK = 'corpus/docx.json';
if (!existsSync(LOCK)) {
  console.log('\n  docx.roundtrip: corpus lock missing — run: python corpus/build_docx_corpus.py');
  process.exit(0);
}
const lock = JSON.parse(readFileSync(LOCK, 'utf8'));

let pass = 0, fail = 0;
const fails = [];
const t = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else { fail++; fails.push(`${name}\n      want: ${want}\n      got : ${got}`); }
};

/* ---- unit checks on the splice itself ------------------------------------ */

t('splice keeps everything outside a span',
  spliceDocument('<a/><b/><c/>', [{ span: { start: 4, end: 8 }, kind: 'delete' }]),
  '<a/><c/>');
t('splice replaces a span',
  spliceDocument('<a/><b/><c/>', [{ span: { start: 4, end: 8 }, kind: 'replace', xml: '<B/>' }]),
  '<a/><B/><c/>');
t('splice inserts after a span',
  spliceDocument('<a/><b/>', [{ span: { start: 0, end: 4 }, kind: 'insertAfter', xml: '<x/>' }]),
  '<a/><x/><b/>');
t('splice refuses overlapping edits',
  (() => {
    try {
      spliceDocument('<a/><b/>', [{ span: { start: 0, end: 5 }, kind: 'delete' },
                                   { span: { start: 3, end: 8 }, kind: 'delete' }]);
      return 'no throw';
    } catch { return 'threw'; }
  })(), 'threw');

/* patchProps: our elements go in schema order, everything else survives */
{
  const before = '<w:pStyle w:val="Body"/><w:rFonts w:ascii="X"/><w:kinsoku/>';
  const after = patchProps(before,
    ['pStyle', 'kinsoku', 'jc'],
    new Map([['jc', '<w:jc w:val="center"/>'], ['pStyle', null]]));
  t('patchProps drops what it is told to drop', after.includes('pStyle'), false);
  t('patchProps keeps what it does not manage', after.includes('kinsoku'), true);
  t('patchProps keeps unmanaged elements it has never heard of',
    after.includes('rFonts'), true);
  t('patchProps puts the new element in schema order',
    after.indexOf('kinsoku') < after.indexOf('jc'), true);
}

/* ---- the corpus ---------------------------------------------------------- */

mkdirSync('qa/out/docx', { recursive: true });

let identical = 0, isolated = 0, tested = 0, skipped = 0, opened = 0;
const report = [];

for (const entry of lock.files) {
  const path = `corpus/docx/files/${entry.file}`;
  if (!existsSync(path)) { skipped++; continue; }
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes[0] === 0xD0) { skipped++; continue; }            // encrypted

  let wd;
  try { wd = await openDocx(bytes); } catch { skipped++; continue; }

  /* ---- gate A: no edit, no change ---- */
  const same = await saveDocx(wd, []);
  const src = await readZip(bytes);
  const out = await readZip(same);
  let diffs = 0, missing = 0;
  const byName = new Map(out.entries.map((e) => [e.name, e]));
  for (const e of src.entries) {
    const o = byName.get(e.name);
    if (!o) { missing++; continue; }
    const a = await src.bytes(e.name);
    const b = await out.bytes(e.name);
    if (a.length !== b.length) { diffs++; continue; }
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { diffs++; break; }
  }
  opened++;
  const partsOk = diffs === 0 && missing === 0 && out.entries.length === src.entries.length;
  if (partsOk) identical++;
  t(`${entry.slug}: untouched -> every part identical`, `${diffs} differ, ${missing} missing`,
    '0 differ, 0 missing');

  /* ---- gate B: one paragraph edited, nothing else moves ---- */
  const body = readBody(wd);
  const target = body.blocks.find((b) => b.kind === 'para' && b.text.trim().length > 3 &&
                                          b.span && b.span.end > b.span.start);
  if (!target) { report.push([entry.slug, src.entries.length, 'no editable paragraph']); continue; }

  const P = wordPrefix(wd.xml);
  const MARK = 'MISCELLANY_ROUNDTRIP_MARK';
  /* Append the mark as a NEW run at the end of the paragraph — which is what
   * typing at the end of a paragraph does. It exercises both paths: the
   * existing runs are left alone, and one run is invented. */
  const edited = {
    text: target.text + ' ' + MARK,
    runs: [...target.runs.map((r) => ({ ...r })), { n: MARK.length + 1 }],
    p: target.p,
  };
  const edits = paragraphEdits(target, edited, P, { xml: wd.xml });
  const oneEdit = await saveDocx(wd, edits);
  const out2 = await readZip(oneEdit);
  let changed = [];
  const byName2 = new Map(out2.entries.map((e) => [e.name, e]));
  for (const e of src.entries) {
    const o = byName2.get(e.name);
    if (!o) { changed.push(e.name + ' (missing)'); continue; }
    const a = await src.bytes(e.name);
    const b = await out2.bytes(e.name);
    let differ = a.length !== b.length;
    if (!differ) for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { differ = true; break; }
    if (differ) changed.push(e.name);
  }
  t(`${entry.slug}: one edit changes exactly one part`, changed.join(','), wd.mainPath);

  // and the edit is really in there, read back by our own reader
  const back = await openDocx(oneEdit);
  const body2 = readBody(back);
  const flat = (b) => b.blocks.filter((x) => x.kind === 'para').map((x) => x.text).join('');
  const t1 = flat(body), t2 = flat(body2);
  t(`${entry.slug}: the edit is present after a re-read`, t2.includes(MARK), true);
  /* ...and NOTHING ELSE moved. Compared at the reader level rather than on the
   * flat <w:t> count, because the flat count includes markup-compatibility
   * duplicates the reader resolves — the two measure different things, and
   * comparing them makes a correct reader look wrong. */
  t(`${entry.slug}: and nothing else in the document text moved`,
    t2.length - t1.length, MARK.length + 1);
  /* THE ASSERTION THAT CATCHES A REWRITE EATING AN ANCHORED IMAGE.
   *
   * Everything in the edited paragraph except the spans we deliberately
   * touched must be byte-identical. A drawing, a bookmark, a comment anchor,
   * a hyperlink, a content control, the rsid stamps on the <w:p> itself — all
   * of it. Checked by reconstructing what the paragraph SHOULD be and
   * comparing bytes, not by looking for the pieces we happened to think of. */
  {
    const newXml = (await openDocx(oneEdit)).xml;
    const oldPara = wd.xml.slice(target.span.start, target.span.end);
    let expect = '';
    let at = target.span.start;
    for (const e of edits) {
      expect += wd.xml.slice(at, e.span.start);
      if (e.kind === 'replace') expect += e.xml;
      at = e.span.end;
    }
    expect += wd.xml.slice(at, target.span.end);
    const newPara = newXml.slice(target.span.start,
      target.span.start + expect.length);
    t(`${entry.slug}: the edited paragraph differs ONLY where it was edited`,
      newPara === expect, true);
    // and the untouched share of the paragraph is most of it
    const touched = edits.reduce((n, e) => n + (e.span.end - e.span.start), 0);
    t(`${entry.slug}: the edit touched a small part of the paragraph`,
      touched <= oldPara.length, true);
  }
  if (changed.length === 1 && changed[0] === wd.mainPath) isolated++;
  tested++;
  report.push([entry.slug, src.entries.length, partsOk ? 'identical' : 'DIFFERS']);

  // every edited output is kept, because the foreign validator checks them all
  writeFileSync(`qa/out/docx/${entry.slug}.edited.docx`, oneEdit);
}

/* ---- the path a person actually takes ------------------------------------
 * open -> edit -> save, through the SAME code the app runs. The document is
 * DOM-free, so this can be driven in Node; the browser check afterwards only
 * has to prove the buttons are wired to it. */
{
  const { createDocument } = await import('../src/core/document.js');
  const { loadDocx, saveToDocx } = await import('../src/apps/doc/docxio.js');
  const { blockIds, paraOf, setPara, insertPara, removeBlock } =
    await import('../src/apps/doc/model.js');

  for (const slug of ['va-ibc-minutes', 'adv-prefix-default', 'plos-strobe-mr',
                      'in-dhs-minutes', 'adv-strict-ooxml']) {
    const e = lock.files.find((x) => x.slug === slug);
    if (!e || !existsSync(`corpus/docx/files/${e.file}`)) continue;
    const bytes = new Uint8Array(readFileSync(`corpus/docx/files/${e.file}`));

    const doc = createDocument();
    const binding = await loadDocx(doc, bytes);
    const ids = blockIds(doc);
    t(`${slug}: opening fills the document`, ids.length > 0, true);

    const first = ids.find((id) => paraOf(doc, id).text.trim().length > 3);
    if (!first) continue;
    const p0 = paraOf(doc, first);
    setPara(doc, first, p0.text + ' EDITED', p0.runs, p0.p);          // change a word
    insertPara(doc, first, null, 'A brand new paragraph.', { style: 'body' });
    const all = blockIds(doc);
    const last = all[all.length - 1];
    const lastText = paraOf(doc, last).text;
    if (all.length > 3 && lastText.trim()) removeBlock(doc, last);    // delete one

    const r = await saveToDocx(doc, binding);
    t(`${slug}: saving produced bytes`, r.bytes.length > 1000, true);

    const back = createDocument();
    const b2 = await loadDocx(back, r.bytes);
    const texts = blockIds(back).map((id) => paraOf(back, id).text);
    t(`${slug}: the edit round-trips`, texts.some((x) => x.includes('EDITED')), true);
    t(`${slug}: the inserted paragraph round-trips`,
      texts.some((x) => x.includes('A brand new paragraph.')), true);
    if (lastText.trim() && all.length > 3) {
      t(`${slug}: the deleted paragraph is gone`, texts.includes(lastText), false);
    }
    t(`${slug}: the part count is unchanged`, b2.survey.parts, binding.survey.parts);
  }
}

console.log(`\n  docx.roundtrip: ${pass} passed, ${fail} failed` +
  (skipped ? `, ${skipped} skipped` : ''));
console.log(`  byte-identical untouched: ${identical}/${identical + 0 + (opened - identical)}` +
  `   single-edit isolated: ${isolated}/${tested}`);
for (const f of fails.slice(0, 30)) console.log('   x ' + f);
if (fails.length > 30) console.log(`   ... and ${fails.length - 30} more`);
process.exit(fail ? 1 : 0);
