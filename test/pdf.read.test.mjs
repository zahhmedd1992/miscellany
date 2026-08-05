/* The PDF reader against the locked corpus. The exam is the same shape the
 * xlsx one settled on after it was fooled once: EXACT equality against
 * numbers recorded by two independent implementations (pikepdf and pdfium,
 * which agreed with each other before anything of ours existed), never
 * "non-zero and plausible".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PdfDoc } from '../src/core/pdf/doc.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(ROOT, 'corpus', 'pdf');
const lock = JSON.parse(fs.readFileSync(path.join(CORPUS, 'pdf_corpus.json'), 'utf8'));

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n       want: ${JSON.stringify(want)}\n       got : ${JSON.stringify(got)}`);
  }
};

for (const [name, info] of Object.entries(lock).sort()) {
  const file = path.join(CORPUS, 'files', name);
  if (!fs.existsSync(file)) { console.log(`  skip ${name} (not fetched here)`); continue; }
  const buf = new Uint8Array(fs.readFileSync(file));
  let doc;
  try {
    doc = await PdfDoc.open(buf);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}: open threw: ${e.message}`);
    continue;
  }
  t(`${name}: header version`, doc.version, info.version);
  t(`${name}: not encrypted`, doc.encrypted, false);
  t(`${name}: page count (two prior oracles agreed on this)`, doc.pages.length, info.pages);
  for (let i = 0; i < info.firstPageSizes.length; i++) {
    const mb = doc.pages[i].mediaBox;
    const w = Math.round((mb[2] - mb[0]) * 100) / 100;
    const h = Math.round((mb[3] - mb[1]) * 100) / 100;
    // pdfium reports the CROP box size when present; MediaBox when not.
    const cb = doc.pages[i].cropBox;
    const cw = Math.round((cb[2] - cb[0]) * 100) / 100;
    const ch = Math.round((cb[3] - cb[1]) * 100) / 100;
    const want = info.firstPageSizes[i];
    const ok = (w === want[0] && h === want[1]) || (cw === want[0] && ch === want[1]);
    t(`${name}: page ${i + 1} size ${want}`, ok, true);
  }
  for (const p of doc.pages) {
    if (p.mediaBox.length !== 4) { fail++; console.log(`  FAIL ${name}: a page without a 4-number MediaBox`); break; }
  }
  const inf = doc.info();
  t(`${name}: info() does not throw and is an object`, typeof inf, 'object');

  /* The page walk touches a fraction of the file. The lexer's real exam is
   * EVERY live object: all of them must parse, or the reader only appears
   * to read the file. */
  let objects = 0, streams = 0, broken = [];
  for (const n of doc.entries.keys()) {
    try {
      const v = doc.get(n);
      objects++;
      if (v && v.stream) streams++;
    } catch (e) {
      broken.push(`${n}: ${e.message}`);
    }
  }
  t(`${name}: every live object parses (${objects} objects, ${streams} streams)`, broken.slice(0, 3), []);
}

console.log(`\n  pdf.read: ${pass} passed, ${fail} failed  (${Object.keys(lock).length} corpus files)`);
process.exit(fail ? 1 : 0);
