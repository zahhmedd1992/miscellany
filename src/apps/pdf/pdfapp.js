/* The PDF workbench: files come in, a page list is edited, one file goes
 * out. All the machinery is core/pdf; this module is only state and DOM.
 * The page list IS the operation model — merge, split, extract, delete,
 * reorder and rotate are all just edits to this array, and Save hands it
 * to the writer as-is.
 */
import { PdfDoc } from '../../core/pdf/doc.js';
import { buildPdf } from '../../core/pdf/writer.js';

const $ = (id) => document.getElementById(id);

const files = [];   // {name, doc}
let list = [];      // {fi, page, addRotate}

/* ---- loading ---- */

async function addFiles(fileList) {
  const status = $('status');
  for (const f of fileList) {
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const doc = await PdfDoc.open(buf);
      if (doc.encrypted) {
        setStatus('err', `${f.name} is password-protected — refused rather than half-handled.`);
        continue;
      }
      const fi = files.length;
      files.push({ name: f.name, doc });
      for (let p = 0; p < doc.pages.length; p++) list.push({ fi, page: p, addRotate: 0 });
      setStatus('', '');
    } catch (e) {
      setStatus('err', `${f.name}: could not read it — ${e.message}`);
    }
  }
  render();
  void status;
}

function setStatus(cls, text) {
  const el = $('status');
  el.className = 'status ' + cls;
  el.textContent = text;
}

/* ---- rendering ---- */

function render() {
  $('bench').hidden = list.length === 0 && files.length === 0;
  const box = $('pages');
  const frag = document.createDocumentFragment();
  list.forEach((entry, i) => {
    const { name, doc } = files[entry.fi];
    const pg = doc.pages[entry.page];
    const [x0, y0, x1, y1] = pg.mediaBox;
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    const rot = ((pg.rotate + entry.addRotate) % 360 + 360) % 360;
    const swap = rot % 180 !== 0;
    const mw = swap ? h : w, mh = swap ? w : h;
    const scale = 30 / Math.max(mw, mh);

    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.i = i;
    div.innerHTML =
      `<span class="idx">${i + 1}</span>` +
      `<span class="mini" style="width:${Math.max(8, Math.round(mw * scale))}px;height:${Math.max(8, Math.round(mh * scale))}px"></span>` +
      `<span class="what"><b></b><span></span></span>` +
      `<span class="acts">` +
      `<button data-act="rot" title="Rotate 90°">&#10227;</button>` +
      `<button data-act="up" title="Move up">&#8593;</button>` +
      `<button data-act="down" title="Move down">&#8595;</button>` +
      `<button data-act="del" title="Remove page">&#10005;</button>` +
      `</span>`;
    div.querySelector('.what b').textContent = `${name} — page ${entry.page + 1} of ${doc.pages.length}`;
    div.querySelector('.what span').textContent =
      `${Math.round(mw)} × ${Math.round(mh)} pt · ${mw >= mh ? 'landscape' : 'portrait'}` +
      (rot ? ` · rotated ${rot}°` : '');
    frag.append(div);
  });
  box.replaceChildren(frag);
  $('count').textContent = list.length === 0 ? 'No pages — add a PDF above.'
    : `${list.length} page${list.length === 1 ? '' : 's'} from ${files.length} file${files.length === 1 ? '' : 's'}`;
  $('save').disabled = list.length === 0;
}

/* ---- actions ---- */

$('pages').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const i = Number(btn.closest('.page').dataset.i);
  const act = btn.dataset.act;
  if (act === 'del') list.splice(i, 1);
  else if (act === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
  else if (act === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
  else if (act === 'rot') list[i].addRotate = (list[i].addRotate + 90) % 360;
  render();
});

$('reverse').addEventListener('click', () => { list.reverse(); render(); });

$('applyrange').addEventListener('click', () => {
  const spec = $('range').value.trim();
  if (!spec) return;
  const keep = new Set();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
    if (!m || (!m[1] && !m[3])) { setStatus('err', `Could not read "${part.trim()}" — use forms like 2, 4-7, 9-`); return; }
    const a = m[1] ? parseInt(m[1], 10) : 1;
    const b = m[2] ? (m[3] ? parseInt(m[3], 10) : list.length) : a;
    for (let k = a; k <= Math.min(b, list.length); k++) keep.add(k - 1);
  }
  if (!keep.size) { setStatus('err', 'That range keeps nothing.'); return; }
  list = list.filter((_, i) => keep.has(i));
  $('range').value = '';
  setStatus('', '');
  render();
});

$('save').addEventListener('click', () => {
  if (!list.length) return;
  try {
    const t0 = performance.now();
    const out = buildPdf(
      list.map((e) => ({ doc: files[e.fi].doc, page: e.page, addRotate: e.addRotate })),
      { stripMeta: $('stripmeta').checked },
    );
    const name = files.length === 1
      ? files[0].name.replace(/\.pdf$/i, '') + ' (edited).pdf'
      : 'combined.pdf';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setStatus('ok', `Saved ${name} — ${list.length} pages, ${(out.length / 1e6).toFixed(2).replace(/\.?0+$/, '')} MB, in ${((performance.now() - t0) / 1000).toFixed(1)}s.`);
  } catch (e) {
    setStatus('err', 'Save failed: ' + e.message);
  }
});

/* ---- pickers ---- */

$('pick').addEventListener('change', () => { addFiles($('pick').files); $('pick').value = ''; });
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  addFiles(e.dataTransfer.files);
});

render();

// Exposed deliberately, for the console and the test harness.
window.misc = { PdfDoc, buildPdf, files, get list() { return list; }, addFiles };
