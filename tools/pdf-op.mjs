/* CLI over the PDF core, for the fidelity exam and for scripting.
 *
 *   node tools/pdf-op.mjs noop        in.pdf out.pdf
 *   node tools/pdf-op.mjs delete=2,5  in.pdf out.pdf        (1-based)
 *   node tools/pdf-op.mjs extract=2-4 in.pdf out.pdf
 *   node tools/pdf-op.mjs reverse     in.pdf out.pdf
 *   node tools/pdf-op.mjs rotate=1:90,3:180 in.pdf out.pdf
 *   node tools/pdf-op.mjs stripmeta   in.pdf out.pdf
 *   node tools/pdf-op.mjs merge       a.pdf b.pdf [c.pdf…] out.pdf
 */
import fs from 'node:fs';
import { PdfDoc } from '../src/core/pdf/doc.js';
import { buildPdf } from '../src/core/pdf/writer.js';

const [op, ...files] = process.argv.slice(2);
if (!op || files.length < 2) {
  console.error('usage: pdf-op.mjs <op> in.pdf [in2.pdf…] out.pdf');
  process.exit(2);
}
const outPath = files.pop();
const docs = [];
for (const f of files) docs.push(await PdfDoc.open(new Uint8Array(fs.readFileSync(f))));
for (const d of docs) {
  if (d.encrypted) { console.error('encrypted input — refusing'); process.exit(3); }
}

const all = (d) => d.pages.map((_, i) => ({ doc: d, page: i }));
let pageList;
let opts = {};

if (op === 'noop') pageList = all(docs[0]);
else if (op === 'stripmeta') { pageList = all(docs[0]); opts.stripMeta = true; }
else if (op === 'reverse') pageList = all(docs[0]).reverse();
else if (op === 'merge') pageList = docs.flatMap(all);
else if (op.startsWith('delete=')) {
  const kill = new Set(op.slice(7).split(',').map((x) => parseInt(x, 10) - 1));
  pageList = all(docs[0]).filter((_, i) => !kill.has(i));
} else if (op.startsWith('extract=')) {
  const [a, b] = op.slice(8).split('-').map((x) => parseInt(x, 10));
  pageList = all(docs[0]).slice(a - 1, (b || a));
} else if (op.startsWith('rotate=')) {
  const rot = new Map(op.slice(7).split(',').map((pair) => {
    const [p, deg] = pair.split(':').map((x) => parseInt(x, 10));
    return [p - 1, deg];
  }));
  pageList = all(docs[0]).map((e, i) => ({ ...e, addRotate: rot.get(i) || 0 }));
} else {
  console.error('unknown op ' + op);
  process.exit(2);
}

const out = buildPdf(pageList, opts);
fs.writeFileSync(outPath, out);
console.log(`${outPath}: ${out.length} bytes, ${pageList.length} pages`);
