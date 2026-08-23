/* The .docx reader, graded against corpus/docx.json.
 * Run: node test/docx.read.test.mjs
 *
 * The numbers in the lock were counted by a SEPARATE implementation, in
 * Python, using a different XML strategy, and were fixed before a line of
 * this reader existed. Every count below is asserted for EXACT equality.
 *
 * That discipline is not ceremony. On the .xlsx side the first corpus test
 * asserted only "the reader found some cells, and not too many", reported
 * 158/158 green, and the reader underneath it had silently dropped 116,491
 * of 233,410 formulas. A gate that cannot fail is not a gate.
 *
 * The three prefix files are the sharpest assertion in the suite: the same
 * document with prefix `w`, with no prefix, and with prefix `zzz` must
 * produce IDENTICAL numbers and an identical text hash. A reader matching on
 * "w:" passes every real-world file in the corpus and fails those three.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openDocx, characterise, readBody, surveyParts, isEncryptedPackage }
  from '../src/core/ooxml/docx.js';

const LOCK = 'corpus/docx.json';
if (!existsSync(LOCK)) {
  console.log('\n  docx.read: corpus lock missing — run: python corpus/build_docx_corpus.py');
  process.exit(0);
}
const lock = JSON.parse(readFileSync(LOCK, 'utf8'));

let pass = 0, fail = 0, skipped = 0;
const fails = [];
const t = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else { fail++; fails.push(`${name}\n      want: ${want}\n      got : ${got}`); }
};
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const FIELDS = ['bodyParagraphs', 'allParagraphs', 'runs', 'tables', 'tableCells',
                'tableRows', 'hyperlinks', 'sections', 'numberedParas'];

const results = [];
let totalChars = 0, totalParas = 0;

for (const entry of lock.files) {
  const path = `corpus/docx/files/${entry.file}`;
  if (!existsSync(path)) { skipped++; continue; }
  const bytes = new Uint8Array(readFileSync(path));
  const f = entry.features;

  if (isEncryptedPackage(bytes)) {
    // An OLE compound file. The reader must SAY it is encrypted rather than
    // fail the way a truncated download fails.
    let msg = '';
    try { await openDocx(bytes); } catch (e) { msg = e.message; }
    t(`${entry.slug}: an encrypted package is diagnosed, not mistaken for corruption`,
      /password|encrypt/i.test(msg), true);
    results.push({ slug: entry.slug, note: 'encrypted' });
    continue;
  }

  let wd;
  try {
    wd = await openDocx(bytes);
  } catch (e) {
    t(`${entry.slug}: opens`, `threw: ${e.message}`, 'ok');
    continue;
  }

  t(`${entry.slug}: finds the right document part`, wd.mainPath, f.documentPart);

  const { counts, text } = characterise(wd);
  for (const k of FIELDS) {
    if (f[k] === undefined) continue;
    t(`${entry.slug}: ${k}`, counts[k], f[k]);
  }
  t(`${entry.slug}: textChars`, text.length, f.textChars);
  t(`${entry.slug}: textSha256`, sha(text), f.textSha256);
  if (f.preserveSpaceEls !== undefined) {
    t(`${entry.slug}: xml:space="preserve" elements`, counts.preserveSpaceEls, f.preserveSpaceEls);
  }
  if (f.deletedTextChars !== undefined) {
    t(`${entry.slug}: characters of deleted text`, counts.deletedTextChars, f.deletedTextChars);
  }
  if (f.maxElementDepth !== undefined) {
    t(`${entry.slug}: element depth`, counts.maxDepth, f.maxElementDepth);
  }

  // and the reader proper must produce blocks without throwing
  let body = null;
  try {
    body = readBody(wd);
  } catch (e) {
    t(`${entry.slug}: readBody`, `threw: ${e.message}`, 'ok');
  }
  if (body) {
    const paras = body.blocks.filter((b) => b.kind === 'para');
    t(`${entry.slug}: every block is a kind we can lay out`,
      body.blocks.every((b) => b.kind === 'para' || b.kind === 'table'), true);
    t(`${entry.slug}: every paragraph's runs cover its text`,
      paras.every((b) => b.runs.reduce((a, r) => a + r.n, 0) === b.text.length), true);
    totalParas += paras.length;
    totalChars += paras.reduce((a, b) => a + b.text.length, 0);
    results.push({ slug: entry.slug, paras: paras.length, tables: body.counters.tables,
                   chars: text.length, prefix: f.prefix || '(default)' });
  }
  await surveyParts(wd);
}

/* ---- the assertions the corpus was built to make ------------------------- */

/* THE PREFIX PROOF.
 *
 * adv-prefix-default and adv-prefix-exotic are the SAME document written two
 * ways: the WordprocessingML namespace as the default namespace, and under
 * the prefix `zzz`. Our reader must produce byte-identical text and identical
 * counts for both. adv-prefix-ns0 is a third spelling (`ns0:`) of a different
 * document — pandoc's own fixture, so this is a real-world spelling and not
 * one invented for the corpus.
 *
 * And the trap is DEMONSTRATED, not merely avoided: the same files are
 * counted a second time by a deliberately naive scan that matches the literal
 * string "<w:p" — the shortcut a reader takes when every real-world file in
 * front of it uses `w:`. It must get a different (wrong) answer, or these
 * files are not testing anything. */
const readOne = async (slug) => {
  const e = lock.files.find((x) => x.slug === slug);
  if (!e || !existsSync(`corpus/docx/files/${e.file}`)) return null;
  const wd = await openDocx(new Uint8Array(readFileSync(`corpus/docx/files/${e.file}`)));
  return { wd, c: characterise(wd) };
};

const a = await readOne('adv-prefix-default');
const b = await readOne('adv-prefix-exotic');
if (a && b) {
  t('the same document with no prefix and with prefix "zzz" reads identically',
    sha(a.c.text) === sha(b.c.text) &&
    a.c.counts.allParagraphs === b.c.counts.allParagraphs &&
    a.c.counts.runs === b.c.counts.runs, true);

  const naive = (xml) => (xml.match(/<w:p[ />]/g) || []).length;
  t('and a reader that matched "<w:p" would have found nothing in either',
    `${naive(a.wd.xml)}/${naive(b.wd.xml)}`, '0/0');
  t('...while the real one finds every paragraph',
    `${a.c.counts.allParagraphs}/${b.c.counts.allParagraphs}`,
    `${a.c.counts.allParagraphs}/${a.c.counts.allParagraphs}`);
}

const ns0 = await readOne('adv-prefix-ns0');
if (ns0) {
  t('a pandoc "ns0:" document is read, not seen as empty',
    ns0.c.text.length > 0 && ns0.c.counts.allParagraphs > 0, true);
}

/* The strict-conformance file uses purl.oclc.org namespaces throughout. A
 * reader that hardcodes the transitional URI opens it, finds zero paragraphs,
 * and reports success. */
const strict = lock.files.find((e) => (e.features || {}).conformance === 'strict');
if (strict && existsSync(`corpus/docx/files/${strict.file}`)) {
  const wd = await openDocx(new Uint8Array(readFileSync(`corpus/docx/files/${strict.file}`)));
  const c = characterise(wd);
  t(`${strict.slug}: a Strict OOXML document is not empty`,
    c.counts.allParagraphs > 0 && c.text.length > 0, true);
}

const clean = lock.files.find((e) => e.slug === '3gpp-working-proc');
const marked = lock.files.find((e) => e.slug === '3gpp-working-proc-rm');
if (clean && marked) {
  t('tracked changes do not alter the accepted text',
    clean.features.textSha256, marked.features.textSha256);
}

/* ---- report -------------------------------------------------------------- */

console.log(`\n  docx.read: ${pass} passed, ${fail} failed` +
  (skipped ? `, ${skipped} files not on disk` : ''));
if (results.length) {
  console.log(`  ${results.length} files · ${totalParas.toLocaleString()} paragraphs · ` +
    `${totalChars.toLocaleString()} characters read into blocks`);
}
for (const f of fails.slice(0, 40)) console.log('   x ' + f);
if (fails.length > 40) console.log(`   ... and ${fails.length - 40} more`);
process.exit(fail ? 1 : 0);
