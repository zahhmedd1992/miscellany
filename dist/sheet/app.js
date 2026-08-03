/* Sheet — application wiring.
 *
 * Every button on screen is generated from the registry below. There is no
 * hand-written toolbar HTML and no hand-written keyboard switch. If a
 * command exists, it is automatically in the palette, in the keymap, in the
 * HTTP route table and in the MCP tool list.
 *
 * Every command here DOES something. A button that looks real and isn't is
 * worse than no button — it is the exact failure mode we are trying to
 * beat, in miniature.
 */

import { makeGraph, Grid, cellId, expand, SHEET, COLS, ROWS } from './apps/sheet/sheet.js';
import { Registry, eventKey } from './core/commands.js';
import { indexToCol } from './core/formula.js';
import { V, toText, isBlank, isErr } from './core/value.js';
import { Decimal } from './core/decimal.js';
import { openXlsx, readSheet, readSheetCharts } from './core/ooxml/xlsx.js';
import { writeZip } from './core/ooxml/zipwrite.js';
import { setCellRaw, setCellStyle, cellInner } from './core/ooxml/edit.js';
import { StyleTable, BUILTIN_IDS } from './core/ooxml/stylewrite.js';
import { applyStructural, setColumnWidths, setRowHeights } from './core/ooxml/structural.js';
import { translateFormula, adjustReferences, moveCell } from './core/ooxml/refs.js';
import { splitRef } from './core/ooxml/chart.js';
import { buildPayload, decodePaste, MIME } from './apps/sheet/clipboard.js';

const $ = (id) => document.getElementById(id);

const graph = makeGraph();
const reg = new Registry();

/* ---- undo: snapshot the raw-input map before each mutating batch.
 * Values are never snapshotted — they are always recomputed. */
const undoStack = [];
const redoStack = [];
let suspendSnapshot = false;

/* Undo is a JOURNAL OF DELTAS, not a stack of document snapshots.
 *
 * Snapshots are the obvious implementation and they fail on exactly the files
 * that matter: one snapshot of a 741,000-cell workbook is ~30MB, so any
 * sensible memory budget caps undo depth at one. A delta is a handful of
 * [cell, previous input] pairs, so depth is free and size is proportional to
 * what you actually changed. */

function snapshot() {
  if (suspendSnapshot) return;
  graph.beginJournal();
}

/** Close the current journal and push it as one undoable step. */
function commit() {
  if (suspendSnapshot) return;
  const j = graph.endJournal();
  if (!j.length) return;
  undoStack.push(j);
  if (undoStack.length > 500) undoStack.shift();
  redoStack.length = 0;
}

/** Apply a journal backwards, returning the inverse for the opposite stack. */
function applyJournal(j) {
  suspendSnapshot = true;
  const inverse = [];
  for (let i = j.length - 1; i >= 0; i--) {
    const [id, oldRaw] = j[i];
    inverse.push([id, graph.raw(id)]);
    graph.set(id, oldRaw);
  }
  suspendSnapshot = false;
  grid.draw();
  syncBar();
  markDirty();
  return inverse.reverse();
}

/* =======================================================================
 * COMMANDS — the single source of truth for every surface
 * ==================================================================== */

reg
.define('file.new', {
  title: 'New', group: 'File', glyph: '✧', needs: ['doc.write'],
  describe: 'Discard the current sheet and start an empty one.',
  run: () => { undoStack.length = 0; redoStack.length = 0; book = null; graph.loadJSON({});
    grid.colW = new Map(); grid.rowH = new Map(); grid.setMerges([]); grid.invalidate(); renderTabs(); $('docname').value = 'Untitled'; commit(); grid.draw(); syncBar(); markDirty(); },
})
.define('file.save', {
  title: 'Save', group: 'File', glyph: '⤓', key: 'Mod+S', needs: ['doc.read'],
  describe: 'Save. With a workbook open this writes the .xlsx; otherwise it saves to local browser storage. Nothing leaves your machine either way.',
  run: () => (book ? saveXlsx() : save(true)),
})
.define('file.open', {
  title: 'Open .xlsx', group: 'File', glyph: '⌂', key: 'Mod+O', needs: ['doc.write'],
  describe: 'Open an Excel workbook. The file is read in this browser tab and never uploaded anywhere.',
  run: () => $('fileinput').click(),
})
.define('file.save.xlsx', {
  title: 'Save .xlsx', group: 'File', glyph: '⤒', needs: ['doc.read'],
  describe: 'Write the workbook back out. Every part we did not change comes back byte-for-byte — including charts, pivot tables and macros.',
  run: () => saveXlsx(),
})
.define('file.export.csv', {
  title: 'Export CSV', group: 'File', glyph: '⇥', needs: ['doc.read'],
  describe: 'Download the used range as a CSV file.',
  run: () => exportCsv(),
})
.define('edit.undo', {
  title: 'Undo', group: 'Edit', glyph: '↶', key: 'Mod+Z', needs: ['doc.write'],
  describe: 'Undo the last change.',
  run: () => {
    if (!undoStack.length) return;
    redoStack.push(applyJournal(undoStack.pop()));
  },
})
.define('edit.redo', {
  title: 'Redo', group: 'Edit', glyph: '↷', key: 'Mod+Shift+Z', needs: ['doc.write'],
  describe: 'Redo the change that was just undone.',
  run: () => {
    if (!redoStack.length) return;
    undoStack.push(applyJournal(redoStack.pop()));
  },
})
.define('edit.copy', {
  title: 'Copy', group: 'Edit', glyph: '⧉', key: 'Mod+C', needs: ['doc.read'],
  describe: 'Copy the selection. Formulas survive a paste back into Sheet; plain text goes to every other app.',
  run: () => doCopy(false),
})
.define('edit.cut', {
  title: 'Cut', group: 'Edit', glyph: '✂', key: 'Mod+X', needs: ['doc.write'],
  describe: 'Cut the selection.',
  run: () => doCopy(true),
})
.define('edit.paste', {
  title: 'Paste', group: 'Edit', glyph: '⎘', key: 'Mod+V', needs: ['doc.write'],
  describe: 'Paste at the selection, shifting relative references by how far the paste moved.',
  run: () => { setStatus('press Ctrl+V — the browser only releases the clipboard to a real paste'); },
})
.define('edit.clear', {
  title: 'Clear', group: 'Edit', glyph: '×', needs: ['doc.write'],
  describe: 'Clear the contents of the selected cells.',
  run: () => {
    snapshot();
    const r = grid.selRect();
    for (let row = r.r0; row <= r.r1; row++)
      for (let col = r.c0; col <= r.c1; col++) graph.set(cellId(col, row, grid.sheet), '');
    commit(); grid.draw(); syncBar(); markDirty();
  },
})
.define('fmt.bold', {
  title: 'Bold', group: 'Format', glyph: 'B', key: 'Mod+B', needs: ['doc.write'],
  describe: 'Bold the selected cells.',
  run: () => applyFormat((cur) => ({ bold: !cur.bold })),
})
.define('fmt.italic', {
  title: 'Italic', group: 'Format', glyph: 'I', key: 'Mod+I', needs: ['doc.write'],
  describe: 'Italicise the selected cells.',
  run: () => applyFormat((cur) => ({ italic: !cur.italic })),
})
.define('fmt.currency', {
  title: 'Currency', group: 'Format', glyph: '$', needs: ['doc.write'],
  describe: 'Format as currency with two decimals.',
  run: () => applyFormat(() => ({ numFmtCode: '"$"#,##0.00' })),
})
.define('fmt.percent', {
  title: 'Percent', group: 'Format', glyph: '%', needs: ['doc.write'],
  describe: 'Format as a percentage.',
  run: () => applyFormat(() => ({ numFmtId: BUILTIN_IDS.percentTwo })),
})
.define('fmt.comma', {
  title: 'Thousands', group: 'Format', glyph: ',', needs: ['doc.write'],
  describe: 'Group thousands with a comma.',
  run: () => applyFormat(() => ({ numFmtId: BUILTIN_IDS.commaTwo })),
})
.define('fmt.plain', {
  title: 'Plain number', group: 'Format', glyph: '0', needs: ['doc.write'],
  describe: 'Remove the number format.',
  run: () => applyFormat(() => ({ numFmtId: 0 })),
})
.define('fmt.fill', {
  title: 'Fill colour', group: 'Format', glyph: '▧', needs: ['doc.write'],
  describe: 'Set the background colour of the selected cells.',
  run: () => pickColour('Fill', (c) => applyFormat(() => ({ fill: c }))),
})
.define('fmt.textcolor', {
  title: 'Text colour', group: 'Format', glyph: 'A', needs: ['doc.write'],
  describe: 'Set the text colour of the selected cells.',
  run: () => pickColour('Text', (c) => applyFormat(() => ({ fontColor: c }))),
})
.define('fmt.border.all', {
  title: 'Borders', group: 'Format', glyph: '⊞', needs: ['doc.write'],
  describe: 'Put a thin border on every side of the selected cells.',
  run: () => applyFormat(() => ({ border: 'thin' })),
})
.define('fmt.border.none', {
  title: 'No borders', group: 'Format', glyph: '⊡', needs: ['doc.write'],
  describe: 'Remove borders from the selected cells.',
  run: () => applyFormat(() => ({ border: null })),
})
.define('fmt.size.up', {
  title: 'Bigger text', group: 'Format', glyph: 'A+', needs: ['doc.write'],
  describe: 'Increase the font size of the selected cells.',
  run: () => applyFormat((cur) => ({ fontSize: Math.min(72, (cur.size || 11) + 1) })),
})
.define('fmt.size.down', {
  title: 'Smaller text', group: 'Format', glyph: 'A-', needs: ['doc.write'],
  describe: 'Decrease the font size of the selected cells.',
  run: () => applyFormat((cur) => ({ fontSize: Math.max(6, (cur.size || 11) - 1) })),
})
.define('fmt.align.left', {
  title: 'Align left', group: 'Format', glyph: '⯇', needs: ['doc.write'],
  describe: 'Align the selected cells to the left.',
  run: () => applyFormat(() => ({ horizontal: 'left' })),
})
.define('fmt.align.center', {
  title: 'Align centre', group: 'Format', glyph: '≡', needs: ['doc.write'],
  describe: 'Centre the selected cells.',
  run: () => applyFormat(() => ({ horizontal: 'center' })),
})
.define('fmt.align.right', {
  title: 'Align right', group: 'Format', glyph: '⯈', needs: ['doc.write'],
  describe: 'Align the selected cells to the right.',
  run: () => applyFormat(() => ({ horizontal: 'right' })),
})
.define('data.sum', {
  title: 'Sum', group: 'Data', glyph: 'Σ', needs: ['doc.write'],
  describe: 'Insert a SUM formula totalling the selected cells, just below them.',
  run: () => {
    snapshot();
    const r = grid.selRect();
    const target = { col: r.c0, row: r.r1 + 1 };
    const ref = `${indexToCol(r.c0)}${r.r0 + 1}:${indexToCol(r.c1)}${r.r1 + 1}`;
    graph.set(cellId(target.col, target.row, grid.sheet), `=SUM(${ref})`);
    commit();
    grid.select(target.col, target.row);
    syncBar(); markDirty();
  },
})
.define('data.fill.down', {
  title: 'Fill down', group: 'Data', glyph: '↓', key: 'Mod+D', needs: ['doc.write'],
  describe: 'Copy the top row of the selection into the rows below it, shifting relative references.',
  run: () => {
    snapshot();
    const r = grid.selRect();
    for (let col = r.c0; col <= r.c1; col++) {
      const src = graph.raw(cellId(col, r.r0, grid.sheet));
      for (let row = r.r0 + 1; row <= r.r1; row++) {
        graph.set(cellId(col, row, grid.sheet), shiftRefs(src, row - r.r0));
      }
    }
    commit(); grid.draw(); syncBar(); markDirty();
  },
})
.define('data.sort', {
  title: 'Sort', group: 'Data', glyph: '⇅', needs: ['doc.write'],
  describe: 'Sort the selected rows ascending by their first column.',
  run: () => {
    snapshot();
    const r = grid.selRect();
    const rows = [];
    for (let row = r.r0; row <= r.r1; row++) {
      const cells = [];
      for (let col = r.c0; col <= r.c1; col++) cells.push(graph.raw(cellId(col, row, grid.sheet)));
      rows.push({ key: graph.value(cellId(r.c0, row, grid.sheet)), cells });
    }
    rows.sort((a, b) => {
      const av = a.key, bv = b.key;
      if (av.k === 'number' && bv.k === 'number') return av.d.cmp(bv.d);
      return toText(av).localeCompare(toText(bv));
    });
    rows.forEach((rw, i) => {
      rw.cells.forEach((raw, j) => graph.set(cellId(r.c0 + j, r.r0 + i, grid.sheet), raw));
    });
    commit(); grid.draw(); syncBar(); markDirty();
  },
})
.define('sheet.insert.row', {
  title: 'Insert rows', group: 'Sheet', glyph: '⤒', needs: ['doc.write'],
  describe: 'Insert rows above the selection. Formulas across the whole workbook follow.',
  run: () => structural('row', false),
})
.define('sheet.delete.row', {
  title: 'Delete rows', group: 'Sheet', glyph: '⌦', needs: ['doc.write'],
  describe: 'Delete the selected rows. References into them become #REF!, as they must.',
  run: () => structural('row', true),
})
.define('sheet.insert.col', {
  title: 'Insert columns', group: 'Sheet', glyph: '⇥', needs: ['doc.write'],
  describe: 'Insert columns to the left of the selection.',
  run: () => structural('col', false),
})
.define('sheet.delete.col', {
  title: 'Delete columns', group: 'Sheet', glyph: '⇤', needs: ['doc.write'],
  describe: 'Delete the selected columns.',
  run: () => structural('col', true),
})
.define('nav.goto', {
  title: 'Go to cell', group: 'View', glyph: '→', args: { cell: 'Text' },
  describe: 'Jump to a cell by its address, for example C42.',
  run: (a) => {
    const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec((a.cell || prompt('Go to cell (e.g. C42)') || '').trim());
    if (!m) return;
    let col = 0; for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    grid.select(col - 1, parseInt(m[2], 10) - 1);
  },
})
.define('view.api', {
  title: 'Show API', group: 'View', glyph: '⚯',
  describe: 'Show the HTTP routes and AI tool definitions generated from this command list.',
  run: () => showApi(),
})
.define('help.functions', {
  title: 'Function list', group: 'Help', glyph: '?',
  describe: 'List every formula function this sheet understands.',
  run: async () => {
    const { FUNCTION_NAMES } = await import('./core/functions.js');
    alert(`${FUNCTION_NAMES.length} functions:\n\n` + FUNCTION_NAMES.join('  '));
  },
});

/* Fill-down uses the SAME reference translator as shared-formula expansion
 * and paste. Its own regex was a second implementation that would have
 * drifted — and got LOG10(A1) wrong. */
function shiftRefs(src, dr) {
  if (!src.startsWith('=')) return src;
  return '=' + translateFormula(src.slice(1), 0, dr);
}

/* =======================================================================
 * PROFILES — the 400-button answer. A toolbar is a filter, not a codebase.
 * ==================================================================== */

const PROFILES = {
  simple: {
    name: 'Simple mode',
    toolbar: ['file.open', 'file.save.xlsx', 'edit.undo', 'edit.redo', 'edit.copy', 'edit.paste', 'fmt.bold', 'fmt.currency', 'fmt.percent', 'data.sum', 'data.sort', 'data.fill.down', 'edit.clear'],
    hide: ['*'],
  },
  full: {
    name: 'Everything',
    toolbar: ['file.new', 'file.open', 'file.save.xlsx', 'file.save', 'file.export.csv',
              'edit.undo', 'edit.redo', 'edit.copy', 'edit.cut', 'edit.paste', 'edit.clear',
              'fmt.bold', 'fmt.italic', 'fmt.currency', 'fmt.percent', 'fmt.comma', 'fmt.plain',
              'fmt.fill', 'fmt.textcolor', 'fmt.border.all', 'fmt.border.none',
              'fmt.size.up', 'fmt.size.down',
              'fmt.align.left', 'fmt.align.center', 'fmt.align.right',
              'sheet.insert.row', 'sheet.delete.row', 'sheet.insert.col', 'sheet.delete.col',
              'data.sum', 'data.sort', 'data.fill.down', 'nav.goto', 'view.api', 'help.functions'],
  },
};
let profile = 'simple';

function renderToolbar() {
  const p = PROFILES[profile];
  const bar = $('toolbar');
  bar.innerHTML = '';
  let lastGroup = null;
  for (const c of reg.toolbar(p)) {
    if (lastGroup && c.group !== lastGroup) {
      const s = document.createElement('div'); s.className = 'tsep'; bar.appendChild(s);
    }
    lastGroup = c.group;
    const b = document.createElement('button');
    b.className = 'tool';
    b.title = c.describe + (c.key ? `  (${c.key})` : '');
    b.innerHTML = `<span class="g">${c.glyph || '•'}</span>${c.title}`;
    b.onclick = () => { reg.run(c.id); $('finput').blur(); };
    bar.appendChild(b);
  }
  const hidden = reg.all().length - reg.toolbar(p).length;
  const more = document.createElement('div');
  more.className = 'more';
  more.innerHTML = `${hidden} more <kbd>Ctrl</kbd><kbd>K</kbd>`;
  bar.appendChild(more);
  $('btn-profile').textContent = p.name;
}

$('btn-profile').onclick = () => {
  profile = profile === 'simple' ? 'full' : 'simple';
  renderToolbar();
};
$('btn-mcp').onclick = () => reg.run('view.api');

/* =======================================================================
 * GRID + EDITING
 * ==================================================================== */

const geomDirty = new Set();          // sheets whose widths/heights changed
const resizedCols = new Map();        // sheet -> Map<col, px>, ONLY user resizes
const resizedRows = new Map();        // sheet -> Map<row, px>

const grid = new Grid($('grid'), graph, {
  onResize: (axis, index, px) => {
    geomDirty.add(grid.sheet);
    const bag = axis === 'col' ? resizedCols : resizedRows;
    if (!bag.has(grid.sheet)) bag.set(grid.sheet, new Map());
    bag.get(grid.sheet).set(index, px);
    syncGeom(); markDirty();
  },
  onSelect: () => syncBar(),
  onEdit: (sel, keepContent, seed) => beginEdit(sel, keepContent, seed),
});

const editor = $('editor');
let editing = null;

function beginEdit(sel, keepContent, seed) {
  const id = cellId(sel.col, sel.row, grid.sheet);
  editing = { ...sel, id };
  const x = grid.colX(sel.col), y = grid.rowY(sel.row), w = grid.width(sel.col);
  editor.style.display = 'block';
  editor.style.left = x + 'px';
  editor.style.top = y + 'px';
  editor.style.width = w + 'px';
  editor.style.height = '26px';
  editor.value = seed !== undefined ? seed : (keepContent ? graph.raw(id) : '');
  editor.focus();
  if (seed === undefined) editor.setSelectionRange(editor.value.length, editor.value.length);
}

function commitEdit(move) {
  if (!editing) return;
  const { id, col, row } = editing;
  const val = editor.value;
  if (graph.raw(id) !== val) { snapshot(); graph.set(id, val); commit(); markDirty(); }
  editor.style.display = 'none';
  editing = null;
  if (move === 'down') grid.select(col, row + 1);
  else if (move === 'right') grid.select(col + 1, row);
  else grid.draw();
  syncBar();
  $('grid').focus();
}

function cancelEdit() {
  editor.style.display = 'none';
  editing = null;
  $('grid').focus();
  grid.draw();
}

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitEdit('down'); }
  else if (e.key === 'Tab') { e.preventDefault(); commitEdit('right'); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  e.stopPropagation();
});

/* ---- formula bar ---- */
const finput = $('finput');
finput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const id = cellId(grid.sel.col, grid.sel.row, grid.sheet);
    if (graph.raw(id) !== finput.value) { snapshot(); graph.set(id, finput.value); commit(); markDirty(); }
    grid.select(grid.sel.col, grid.sel.row + 1);
    syncBar();
    $('grid').focus();
  } else if (e.key === 'Escape') { syncBar(); $('grid').focus(); }
  e.stopPropagation();
});

function syncBar() {
  const s = grid.sel;
  const id = cellId(s.col, s.row, grid.sheet);
  const addr = `${indexToCol(s.col)}${s.row + 1}`;
  $('addr').textContent = addr;
  if (document.activeElement !== finput) finput.value = graph.raw(id);
  $('st-sel').innerHTML = `<b>${addr}</b>`;

  // selection statistics — the number people actually want from a spreadsheet
  const r = grid.selRect();
  const nums = [];
  let filled = 0;
  for (let row = r.r0; row <= r.r1; row++) {
    for (let col = r.c0; col <= r.c1; col++) {
      const v = graph.value(cellId(col, row, grid.sheet));
      if (!isBlank(v)) filled++;
      if (v.k === 'number') nums.push(v.d);
    }
  }
  const cells = (r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1);
  if (nums.length) {
    const sum = nums.reduce((a, b) => a.add(b), Decimal.zero());
    const avg = sum.div(new Decimal(BigInt(nums.length), 0));
    $('st-stats').innerHTML =
      `Sum <b>${fmt(sum)}</b> &nbsp; Average <b>${fmt(avg.round(6))}</b> &nbsp; Count <b>${nums.length}</b>`;
  } else {
    $('st-stats').textContent = '';
  }
  $('st-cnt').textContent = cells > 1 ? `${cells} cells, ${filled} filled` : '';
}

function fmt(d) {
  const s = d.toString();
  const [i, f] = s.split('.');
  const neg = i.startsWith('-');
  const digits = neg ? i.slice(1) : i;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + (f ? '.' + f : '');
}

/* =======================================================================
 * COMMAND PALETTE — Ctrl+K. This is what makes a 7-button toolbar safe.
 * ==================================================================== */

const palette = $('palette'), pinput = $('pinput'), plist = $('plist');
let pIndex = 0, pItems = [];

function openPalette() {
  palette.classList.add('on');
  pinput.value = '';
  renderPalette();
  pinput.focus();
}
function closePalette() { palette.classList.remove('on'); $('grid').focus(); }

function renderPalette() {
  pItems = reg.search(pinput.value);
  pIndex = 0;
  plist.innerHTML = '';
  if (!pItems.length) {
    plist.innerHTML = '<li class="pempty">No command matches that.</li>';
    return;
  }
  pItems.forEach((c, i) => {
    const li = document.createElement('li');
    if (i === 0) li.className = 'sel';
    li.innerHTML =
      `<span class="pg">${c.group}</span>` +
      `<span class="pt">${c.title}</span>` +
      `<span class="pd">${c.describe}</span>` +
      `<span class="pk">${c.key || ''}</span>`;
    li.onclick = () => { closePalette(); reg.run(c.id); };
    plist.appendChild(li);
  });
}

pinput.addEventListener('input', renderPalette);
pinput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePalette(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = plist.children.length;
    if (!pItems.length) return;
    plist.children[pIndex]?.classList.remove('sel');
    pIndex = (pIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    plist.children[pIndex]?.classList.add('sel');
    plist.children[pIndex]?.scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const c = pItems[pIndex];
    if (c) { closePalette(); reg.run(c.id); }
  }
  e.stopPropagation();
});
palette.addEventListener('mousedown', (e) => { if (e.target === palette) closePalette(); });

/* =======================================================================
 * GLOBAL KEYS — generated from the registry, not a hand-written switch
 * ==================================================================== */

const keymap = reg.keymap();

window.addEventListener('keydown', (e) => {
  if (editing || document.activeElement === pinput || document.activeElement === finput
      || document.activeElement === $('docname')) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault(); openPalette(); return;
  }

  const k = eventKey(e);
  // Let the browser's native clipboard events fire; preventing the default
  // here would stop the copy/cut/paste event ever reaching our handlers.
  if (k === 'c+mod' || k === 'mod+x' || k === 'mod+v' || k === 'mod+c' || k === 'x+mod' || k === 'v+mod') {
    if (k.includes('c')) doCopy(false);
    else if (k.includes('x')) doCopy(true);
    return;
  }
  if (keymap.has(k)) { e.preventDefault(); reg.run(keymap.get(k)); return; }

  if (grid.handleKey(e)) { syncBar(); }
});

/* =======================================================================
 * PERSISTENCE — localStorage, no account, nothing leaves the machine
 * ==================================================================== */

const KEY = 'miscellany.sheet.v1';
let dirtyTimer = null;

function markDirty() {
  $('st-save').textContent = 'unsaved';
  $('st-save').classList.remove('saved');
  clearTimeout(dirtyTimer);
  // With an .xlsx open, THAT file is the document — autosaving a copy into
  // localStorage is both wrong and impossible (it caps around 5MB and throws
  // QuotaExceededError from inside this timeout, where nothing is listening).
  if (book) return;
  dirtyTimer = setTimeout(() => save(false), 900);
}

function save(explicit) {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      name: $('docname').value,
      cells: graph.toJSON(),
      saved: new Date().toISOString(),
    }));
    $('st-save').textContent = explicit ? 'saved' : 'saved automatically';
    $('st-save').classList.add('saved');
  } catch (ex) {
    // Quota exceeded. Say so instead of leaving the indicator lying.
    $('st-save').textContent = 'too large for browser storage';
    $('st-save').classList.remove('saved');
  }
}

function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return false;
  try {
    const d = JSON.parse(raw);
    $('docname').value = d.name || 'Untitled';
    graph.loadJSON(d.cells || {});
    return true;
  } catch { return false; }
}

$('docname').addEventListener('input', markDirty);

function exportCsv() {
  let maxC = 0, maxR = 0;
  for (const id of graph.nodes.keys()) {
    const m = /!([A-Z]+)(\d+)$/.exec(id);
    if (!m) continue;
    let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    maxC = Math.max(maxC, c); maxR = Math.max(maxR, parseInt(m[2], 10));
  }
  const lines = [];
  for (let r = 0; r < maxR; r++) {
    const row = [];
    for (let c = 0; c < maxC; c++) {
      const t = toText(graph.value(cellId(c, r, grid.sheet)));
      row.push(/[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
    }
    lines.push(row.join(','));
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = ($('docname').value || 'sheet') + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* =======================================================================
 * .XLSX — open and save, with preserve-unknown
 *
 * `book` holds the ORIGINAL archive for as long as the file is open. On save
 * we splice the cells that actually changed into the original sheet XML and
 * re-emit every other part from its original compressed bytes. That is why a
 * pivot table we cannot even display survives a save untouched.
 * ==================================================================== */

let book = null;   // { wb, name, baseline, sheetPaths }

$('fileinput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  await openWorkbook(f);
  e.target.value = '';
});

async function openWorkbook(file) {
  setStatus('reading…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const wb = await openXlsx(bytes);
    const worksheets = wb.sheets.filter((s) => s.path && s.kind === 'worksheet');
    if (!worksheets.length) { setStatus('no worksheets in that file'); return; }

    const data = {};
    let cells = 0;
    const geom = new Map();
    for (const sh of worksheets) {
      const r = await readSheet(wb, sh);
      geom.set(sh.name, {
        colWidths: r.colWidths || new Map(),
        rowHeights: r.rowHeights || new Map(),
        merges: (r.merges || []).map(parseRangeRef).filter(Boolean),
        charts: await readSheetCharts(wb, sh),
      });
      for (const c of r.cells) {
        const id = `${sh.name}!${c.ref}`;
        let raw;
        // A DATE is a number wearing a date format. Keep it as a number and
        // let the format render it — converting to an ISO string here would
        // make it text, and text does not do arithmetic.
        if (c.formula) raw = '=' + c.formula;
        else if (c.kind === 'text') raw = "'" + c.value;
        else if (c.kind === 'number') raw = c.value.toString();
        else if (c.kind === 'bool') raw = c.value ? 'TRUE' : 'FALSE';
        else if (c.kind === 'error') raw = c.value;
        else if (c.kind === 'date') raw = "'" + c.value;
        else raw = '';
        data[id] = (c.style || c.numFmt || c.numFmtId || c.styleIndex !== undefined)
          ? { r: raw, m: { style: c.style || null, numFmt: c.numFmt || null,
                           numFmtId: c.numFmtId || 0, date1904: wb.date1904,
                           styleIndex: c.styleIndex === undefined ? 0 : +c.styleIndex } }
          : raw;
        cells++;
      }
    }

    suspendSnapshot = true;
    graph.loadJSON(data);
    suspendSnapshot = false;
    undoStack.length = 0; redoStack.length = 0;

    book = {
      wb, name: file.name,
      sheets: worksheets,
      baseline: JSON.stringify(graph.toJSON()),
      stylesXml: await wb.zip.text(wb.stylesPath),
    };
    styleTable = null;                 // rebuilt from THIS workbook's styles
    styleDirty = false;
    book.geom = geom;
    $('docname').value = file.name.replace(/\.xlsx$/i, '');
    applySheetGeometry(worksheets[0].name);
    grid.select(0, 0);
    renderTabs();
    renderToolbar();
    grid.draw();
    syncBar();

    const unmodelled = wb.unmodelledParts().length;
    let chartCount = 0;
    for (const g of geom.values()) chartCount += (g.charts || []).length;
    setStatus(`${cells.toLocaleString()} cells · ${worksheets.length} sheet${worksheets.length > 1 ? 's' : ''} · ` +
      `${unmodelled} parts kept untouched` +
      (chartCount ? ` · ${chartCount} chart${chartCount > 1 ? 's' : ''}` : '') +
      (wb.warnings.length ? ` · ${wb.warnings.length} warnings` : ''));
  } catch (ex) {
    console.error(ex);
    setStatus('could not open: ' + ex.message);
  }
}

async function saveXlsx() {
  if (!book) { setStatus('open an .xlsx first — a new sheet has no original to preserve'); return; }
  setStatus('writing…');
  try {
    // Only cells whose RAW INPUT differs from what we read are written back.
    // Computed values are never written: a cached value that disagrees with
    // its formula is the most corrosive bug a spreadsheet can carry.
    // A structural edit is applied to the sheet's SKELETON, once, before any
    // cell diffing. Otherwise inserting one row into a 3,000-cell sheet
    // becomes 3,000 individual splices — quadratic, and it never finishes.
    const structuralXml = new Map();
    if (structuralOps.length) {
      for (const op of structuralOps) {
        const sh = book.sheets.find((x) => x.name === op.sheet);
        if (!sh) continue;
        const cur = structuralXml.get(sh.path) || await book.wb.zip.text(sh.path);
        structuralXml.set(sh.path, applyStructural(cur, op));
      }
      // The baseline moves with the file: after the skeleton is rewritten,
      // the cells are where the graph says they are, so nothing else differs.
      book.baseline = JSON.stringify(graph.toJSON());
    }

    const base = JSON.parse(book.baseline);
    const now = graph.toJSON();
    const changedBySheet = new Map();
    const keys = new Set([...Object.keys(base), ...Object.keys(now)]);
    let changes = 0;
    for (const k of keys) {
      const a = typeof base[k] === 'string' ? base[k] : (base[k] ? base[k].r : '');
      const b = typeof now[k] === 'string' ? now[k] : (now[k] ? now[k].r : '');
      if (a === b) continue;
      const i = k.indexOf('!');
      const sheetName = k.slice(0, i), ref = k.slice(i + 1);
      if (!changedBySheet.has(sheetName)) changedBySheet.set(sheetName, []);
      changedBySheet.get(sheetName).push({ ref, raw: b });
      changes++;
    }

    const parts = new Map();

    // Cells whose STYLE changed need their s= attribute rewritten, and any
    // new xfs need to reach styles.xml.
    const styledBySheet = new Map();
    if (styleDirty) {
      for (const [id, node] of graph.nodes) {
        if (!node.meta || node.meta.styleIndex === undefined || !node.meta._styleChanged) continue;
        const i = id.indexOf('!');
        const sn = id.slice(0, i);
        if (!styledBySheet.has(sn)) styledBySheet.set(sn, []);
        styledBySheet.get(sn).push({ ref: id.slice(i + 1), idx: node.meta.styleIndex });
      }
      const newStyles = styles().serialize();
      if (newStyles) parts.set(book.wb.stylesPath, newStyles);
    }

    for (const [sheetName, edits] of changedBySheet) {
      const sh = book.sheets.find((s) => s.name === sheetName);
      if (!sh) continue;
      let xml = structuralXml.get(sh.path) || await book.wb.zip.text(sh.path);
      structuralXml.delete(sh.path);
      for (const ed of edits) {
        const { inner, type } = cellInner(ed.raw.startsWith("'") ? ed.raw.slice(1) : ed.raw);
        xml = setCellRaw(xml, ed.ref, inner, type);
      }
      for (const sd of (styledBySheet.get(sheetName) || [])) xml = setCellStyle(xml, sd.ref, sd.idx);
      styledBySheet.delete(sheetName);
      parts.set(sh.path, xml);
    }

    // sheets with style changes but no value changes
    for (const [sheetName, list] of styledBySheet) {
      const sh = book.sheets.find((x) => x.name === sheetName);
      if (!sh) continue;
      let xml = structuralXml.get(sh.path) || await book.wb.zip.text(sh.path);
      structuralXml.delete(sh.path);
      for (const sd of list) xml = setCellStyle(xml, sd.ref, sd.idx);
      parts.set(sh.path, xml);
    }

    // sheets changed ONLY structurally
    for (const [path, xml] of structuralXml) parts.set(path, xml);

    // Column widths and row heights. A resize that is not written back is a
    // change the user made and the file forgot.
    for (const sheetName of geomDirty) {
      const sh = book.sheets.find((x) => x.name === sheetName);
      if (!sh) continue;
      const g = book.geom.get(sheetName);
      if (!g) continue;
      let xml = parts.get(sh.path) || await book.wb.zip.text(sh.path);
      // Only the columns and rows the user actually dragged. Writing all of
      // them would re-round every untouched one.
      xml = setColumnWidths(xml, resizedCols.get(sheetName) || new Map());
      xml = setRowHeights(xml, resizedRows.get(sheetName) || new Map());
      parts.set(sh.path, xml);
    }

    const out = await writeZip(book.wb.zip, parts);
    const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ($('docname').value || 'workbook') + '.xlsx';
    a.click();
    URL.revokeObjectURL(a.href);

    const untouched = book.wb.zip.entries.length - parts.size;
    // Report style changes too. "0 cells changed" after formatting 35 cells
    // reads as a failed save.
    let styled = 0;
    for (const node of graph.nodes.values()) if (node.meta && node.meta._styleChanged) styled++;
    const what = [
      changes ? `${changes} value${changes === 1 ? '' : 's'}` : null,
      styled ? `${styled} format${styled === 1 ? '' : 's'}` : null,
      structuralOps.length ? `${structuralOps.length} row/column edit${structuralOps.length === 1 ? '' : 's'}` : null,
      geomDirty.size ? 'resized' : null,
    ].filter(Boolean).join(' · ') || 'no changes';
    structuralOps.length = 0;
    geomDirty.clear(); resizedCols.clear(); resizedRows.clear();
    setStatus(`saved · ${what} · ${untouched} parts re-emitted byte-for-byte`);
  } catch (ex) {
    console.error(ex);
    setStatus('could not save: ' + ex.message);
  }
}

function setStatus(msg) { $('st-file').textContent = msg; }

/** Keep the per-sheet geometry in step with the grid after a resize. */
function syncGeom() {
  const g = book && book.geom && book.geom.get(grid.sheet);
  if (!g) return;
  g.colWidths = new Map(grid.colW);
  g.rowHeights = new Map(grid.rowH);
}

/* =======================================================================
 * STRUCTURAL EDITS — insert and delete rows and columns
 *
 * Two things move, and forgetting either one silently corrupts the file:
 *   1. the CELLS on the edited sheet shift, and
 *   2. every FORMULA in the WHOLE WORKBOOK that points at that sheet has to
 *      follow — including formulas on other sheets, which is the part that
 *      is easy to miss because the edited sheet looks right afterwards.
 * ==================================================================== */

function structural(axis, remove) {
  const r = grid.selRect();
  const at = axis === 'row' ? r.r0 : r.c0;
  const count = axis === 'row' ? (r.r1 - r.r0 + 1) : (r.c1 - r.c0 + 1);
  const op = { sheet: grid.sheet, axis, at, count, remove };

  snapshot();
  const before = graph.toJSON();
  const after = {};

  for (const [id, entry] of Object.entries(before)) {
    const i = id.indexOf('!');
    const sheetName = id.slice(0, i);
    const ref = id.slice(i + 1);
    const raw = typeof entry === 'string' ? entry : entry.r;
    const meta = typeof entry === 'string' ? null : entry.m;

    // 2. adjust the formula wherever it lives
    let nextRaw = raw;
    if (typeof raw === 'string' && raw.startsWith('=')) {
      nextRaw = '=' + adjustReferences(raw.slice(1), { ...op, homeSheet: sheetName });
    }

    // 1. move the cell, but only on the sheet being edited
    let nextId = id;
    if (sheetName === op.sheet) {
      const m = /^([A-Za-z]{1,3})(\d+)$/.exec(ref);
      if (m) {
        let col = 0;
        for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
        const moved = moveCell(col - 1, parseInt(m[2], 10) - 1, op);
        if (!moved) continue;                       // this cell was deleted
        nextId = cellId(moved.col, moved.row, sheetName);
      }
    }
    after[nextId] = meta ? { r: nextRaw, m: meta } : nextRaw;
  }

  suspendSnapshot = true;
  graph.loadJSON(after);
  suspendSnapshot = false;
  undoStack.length = 0; redoStack.length = 0;   // a journal cannot express this

  adjustGeometry(op);
  structuralOps.push(op);
  grid.draw(); syncBar(); markDirty();
  setStatus(`${remove ? 'deleted' : 'inserted'} ${count} ${axis}${count === 1 ? '' : 's'}`);
}

const structuralOps = [];

/** Merges, widths and heights shift with the cells they describe. */
function adjustGeometry(op) {
  const g = book && book.geom && book.geom.get(op.sheet);
  const shift = (i) => {
    if (op.remove) {
      if (i >= op.at && i < op.at + op.count) return null;
      return i >= op.at + op.count ? i - op.count : i;
    }
    return i >= op.at ? i + op.count : i;
  };

  const map = op.axis === 'col' ? grid.colW : grid.rowH;
  const next = new Map();
  for (const [i, v] of map) {
    if (i < 0) { next.set(i, v); continue; }        // the sheet default
    const n = shift(i);
    if (n !== null) next.set(n, v);
  }
  if (op.axis === 'col') grid.colW = next; else grid.rowH = next;

  const merges = [];
  for (const m of grid.merges) {
    const a = op.axis === 'row' ? shift(m.r0) : shift(m.c0);
    const b = op.axis === 'row' ? shift(m.r1) : shift(m.c1);
    if (a === null || b === null) continue;         // the merge was deleted
    merges.push(op.axis === 'row' ? { ...m, r0: a, r1: b } : { ...m, c0: a, c1: b });
  }
  grid.setMerges(merges);
  if (g) { g.merges = merges; g.colWidths = grid.colW; g.rowHeights = grid.rowH; }
  grid.invalidate();
}

/* =======================================================================
 * FORMATTING
 *
 * A cell holds an INDEX into the workbook's style table, not its formatting.
 * So "bold this" is "find or create an xf like this one but bold, and point
 * the cell at it" — and the new xf is APPENDED to styles.xml by splicing, so
 * the hundreds of styles already in the file survive byte-for-byte.
 * ==================================================================== */

let styleTable = null;

function styles() {
  if (!styleTable) styleTable = new StyleTable(book ? book.stylesXml : null);
  return styleTable;
}

/**
 * @param fn (current) => changes   — receives the cell's resolved properties
 *                                    so a command can TOGGLE rather than set
 */
function applyFormat(fn) {
  const st = styles();
  const r = grid.selRect();
  let n = 0;
  for (let row = r.r0; row <= r.r1; row++) {
    for (let col = r.c0; col <= r.c1; col++) {
      const id = cellId(col, row, grid.sheet);
      const node = graph.node(id, true);
      const meta = node.meta || (node.meta = {});
      const base = meta.styleIndex === undefined ? 0 : meta.styleIndex;
      const cur = st.describe(base) || { bold: false, italic: false, numFmtId: 0, horizontal: null };
      const idx = st.derive(base, fn(cur));
      if (idx === base) continue;
      meta.styleIndex = idx;
      meta._styleChanged = true;
      applyResolvedStyle(meta, st.describe(idx));
      n++;
    }
  }
  if (!n) { setStatus('no change'); return; }
  styleDirty = true;
  grid.draw(); syncBar(); markDirty();
  setStatus(`formatted ${n} cell${n === 1 ? '' : 's'}`);
}

/** Mirror an xf's properties into the meta the renderer reads. */
function applyResolvedStyle(meta, d) {
  if (!d) return;
  const prev = meta.style || {};
  const thin = (st) => (st ? { style: st, color: '#000000' } : null);
  meta.style = {
    ...prev,
    font: {
      ...(prev.font || {}),
      bold: d.bold, italic: d.italic,
      size: d.size || 11,
      color: d.color || null,
    },
    fill: d.fill ? { type: 'solid', color: d.fill } : null,
    border: d.border
      ? { left: thin(d.border.left), right: thin(d.border.right),
          top: thin(d.border.top), bottom: thin(d.border.bottom) }
      : null,
    align: { ...(prev.align || {}), h: d.horizontal },
  };
  meta.numFmtId = d.numFmtId;
  meta.numFmt = null;                    // resolved from the table below
  const code = styles().customFmts;
  for (const [c, i] of code) if (i === d.numFmtId) meta.numFmt = c;
}

let styleDirty = false;

/* A small preset palette. A full colour wheel is a bigger UI than the value
 * it adds here: almost every real formatting choice is one of these, and the
 * ones that are not can be reached later through the style machinery. */
const PALETTE = [
  '#000000', '#404040', '#808080', '#BFBFBF', '#FFFFFF',
  '#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050',
  '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0',
  '#FCE4D6', '#FFF2CC', '#E2EFDA', '#DDEBF7', '#EDEDED',
];

function pickColour(label, apply) {
  const old = document.getElementById('swatches');
  if (old) old.remove();

  const box = document.createElement('div');
  box.id = 'swatches';
  box.innerHTML = `<div class="sw-title">${label} colour</div><div class="sw-grid"></div>` +
                  `<button class="sw-none">No colour</button>`;
  const grid = box.querySelector('.sw-grid');
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = 'sw';
    b.style.background = c;
    b.title = c;
    b.onclick = () => { box.remove(); apply(c); };
    grid.appendChild(b);
  }
  box.querySelector('.sw-none').onclick = () => { box.remove(); apply(null); };
  document.body.appendChild(box);

  const anchor = document.getElementById('toolbar').getBoundingClientRect();
  box.style.top = anchor.bottom + 4 + 'px';
  box.style.left = '12px';

  const away = (e) => {
    if (!box.contains(e.target)) { box.remove(); document.removeEventListener('mousedown', away); }
  };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
}

// exposed so a test can choose a colour without clicking a floating panel
window.__pickColour = (label, hex) => {
  if (label === 'fill') applyFormat(() => ({ fill: hex }));
  else if (label === 'text') applyFormat(() => ({ fontColor: hex }));
};

/* =======================================================================
 * CLIPBOARD
 *
 * Bound to the browser's own copy/cut/paste EVENTS. navigator.clipboard
 * needs a permission prompt and a user gesture; the events need neither and
 * fire from the keystrokes the user already knows.
 * ==================================================================== */

let cutPending = null;      // rect to clear once a cut is actually pasted

function selectionPayload() {
  const r = grid.selRect();
  return buildPayload(
    r,
    (c, row) => graph.raw(cellId(c, row, grid.sheet)),
    (c, row) => {
      const v = graph.value(cellId(c, row, grid.sheet));
      return v.k === 'number' ? v.d.toString() : toText(v);
    },
  );
}

function doCopy(isCut) {
  const p = selectionPayload();
  lastPayload = p;
  cutPending = isCut ? { ...grid.selRect(), sheet: grid.sheet } : null;
  // document.execCommand('copy') routes through our own copy handler below,
  // so the two payloads are written exactly once, in one place.
  try { document.execCommand(isCut ? 'cut' : 'copy'); } catch (e) { /* ignore */ }
  const n = (p.grain.match(/,/g) || []).length;
  setStatus((isCut ? 'cut ' : 'copied ') + describeRect(grid.selRect()));
  void n;
}

let lastPayload = null;

function describeRect(r) {
  const cells = (r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1);
  return cells === 1 ? '1 cell' : `${cells} cells`;
}

document.addEventListener('copy', (e) => {
  if (editing || isTextInput(document.activeElement)) return;
  const p = lastPayload || selectionPayload();
  e.clipboardData.setData('text/plain', p.tsv);
  e.clipboardData.setData(MIME, p.grain);
  e.preventDefault();
});

document.addEventListener('cut', (e) => {
  if (editing || isTextInput(document.activeElement)) return;
  const p = lastPayload || selectionPayload();
  e.clipboardData.setData('text/plain', p.tsv);
  e.clipboardData.setData(MIME, p.grain);
  e.preventDefault();
});

document.addEventListener('paste', (e) => {
  if (editing || isTextInput(document.activeElement)) return;
  e.preventDefault();
  const grain = e.clipboardData.getData(MIME);
  const tsv = e.clipboardData.getData('text/plain');
  applyPaste({ grain, tsv });
});

function isTextInput(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

/** Paste a decoded grid at the current selection. */
function applyPaste(clip) {
  const target = { col: grid.sel.col, row: grid.sel.row };
  const grid2 = decodePaste(clip, target);
  if (!grid2 || !grid2.length) { setStatus('nothing to paste'); return; }

  snapshot();
  // A cut only takes effect when it is pasted — matching every spreadsheet,
  // and meaning an abandoned cut never destroys anything.
  if (cutPending) {
    for (let r = cutPending.r0; r <= cutPending.r1; r++)
      for (let c = cutPending.c0; c <= cutPending.c1; c++)
        graph.set(cellId(c, r, cutPending.sheet), '');
    cutPending = null;
  }
  let n = 0;
  for (let r = 0; r < grid2.length; r++) {
    for (let c = 0; c < grid2[r].length; c++) {
      const raw = grid2[r][c];
      graph.set(cellId(target.col + c, target.row + r, grid.sheet), raw === undefined ? '' : raw);
      n++;
    }
  }
  commit();
  grid.anchor = { col: target.col, row: target.row };
  grid.sel = { col: target.col + grid2[0].length - 1, row: target.row + grid2.length - 1 };
  grid.draw(); syncBar(); markDirty();
  setStatus(`pasted ${n} cell${n === 1 ? '' : 's'}`);
}

// exposed so a test can drive paste without the OS clipboard
window.__applyPaste = applyPaste;

/** Point the grid at a sheet and load that sheet's column widths, row
 *  heights and merges. Geometry is per-sheet, not per-workbook. */
function applySheetGeometry(name) {
  grid.sheet = name;
  const g = book && book.geom && book.geom.get(name);
  grid.colW = g ? new Map(g.colWidths) : new Map();
  grid.rowH = g ? new Map(g.rowHeights) : new Map();
  grid.setMerges(g ? g.merges : []);
  grid.setCharts(g ? g.charts : []);
  grid.theme = book && book.wb && book.wb.styles ? book.wb.styles.theme : null;
  grid.invalidate();
}

/* Resolve a chart's series reference — "'LCOE Range'!$D$6:$D$18" — against
 * the LIVE graph. Returning the graph's values rather than the file's cached
 * ones is what makes a chart move when you edit a cell; every other reader
 * shows you what the workbook said the last time it was saved. */
function resolveChartRef(f) {
  const parts = splitRef(f);
  if (!parts) return null;
  const sheetName = parts.sheet || grid.sheet;
  const rect = parseRangeRef(parts.ref) || parseRangeRef(parts.ref + ':' + parts.ref);
  if (!rect) return null;
  const span = (rect.c1 - rect.c0 + 1) * (rect.r1 - rect.r0 + 1);
  if (span > 20000) return null;          // a runaway ref is not data
  const out = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      const v = graph.value(cellId(c, r, sheetName));
      out.push(v.k === 'number' ? v.d.toNumber() : v.k === 'text' ? v.s : null);
    }
  }
  return out;
}

/** "B4:D9" -> {c0,r0,c1,r1}, 0-based. */
function parseRangeRef(ref) {
  let m = /^([A-Za-z]{1,3})(\d+):([A-Za-z]{1,3})(\d+)$/.exec(ref || '');
  if (!m) {
    // A single cell is a 1x1 range; chart series legitimately use them.
    const one = /^([A-Za-z]{1,3})(\d+)$/.exec(ref || '');
    if (one) m = [null, one[1], one[2], one[1], one[2]];
  }
  if (!m) return null;
  const ci = (t) => { let n = 0; for (const ch of t.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const c0 = ci(m[1]), r0 = parseInt(m[2], 10) - 1, c1 = ci(m[3]), r1 = parseInt(m[4], 10) - 1;
  return { c0: Math.min(c0, c1), r0: Math.min(r0, r1), c1: Math.max(c0, c1), r1: Math.max(r0, r1) };
}

/* ---- sheet tabs ---- */

function renderTabs() {
  const bar = $('tabs');
  if (!book) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  for (const sh of book.sheets) {
    const b = document.createElement('button');
    b.className = 'tab' + (sh.name === grid.sheet ? ' on' : '');
    b.textContent = sh.name;
    b.onclick = () => {
      applySheetGeometry(sh.name);
      grid.scrollX = grid.scrollY = 0;
      grid.select(0, 0);
      renderTabs();
      grid.draw();
      syncBar();
    };
    bar.appendChild(b);
  }
}

/* ---- the API viewer: proof the projection is real, not a diagram ---- */
function showApi() {
  const routes = reg.httpRoutes();
  const mcp = reg.toMCP();
  const w = window.open('', '_blank', 'width=860,height=760');
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Generated API</title>
  <style>
    body{font:13px/1.6 "Inter",system-ui,sans-serif;margin:0;padding:2rem;background:#FBF8F2;color:#211C16}
    h1{font-size:1.15rem;margin:0 0 .3rem}
    p.s{color:#6C6356;margin:0 0 1.5rem;max-width:44rem;font-size:.85rem}
    h2{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:#9A3B1B;margin:1.8rem 0 .5rem}
    pre{background:#231E17;color:#EDE6D8;padding:1rem;border-radius:4px;overflow-x:auto;font-size:11.5px;line-height:1.55}
    table{border-collapse:collapse;width:100%;font-size:12px;background:#fff;border:1px solid #E3E0DA;border-radius:4px}
    th{text-align:left;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:#6C6356;padding:.5rem .7rem;border-bottom:1px solid #CFCAC1;background:#F7F5F1}
    td{padding:.45rem .7rem;border-bottom:1px solid #E3E0DA;font-family:"JetBrains Mono",monospace;font-size:11px}
    td.d{font-family:inherit;font-size:12px;color:#4A4338}
  </style>
  <h1>Generated from the command registry</h1>
  <p class="s">Nothing below was written by hand. Every route and every AI tool definition is a
  projection of the same ${reg.all().length} command declarations that produce the toolbar, the
  keyboard shortcuts and the Ctrl+K palette. Add a command and all five surfaces gain it at once —
  which is why they cannot drift apart.</p>
  <h2>HTTP routes</h2>
  <table><tr><th>Method</th><th>Path</th><th>What it does</th></tr>
  ${routes.map((r) => `<tr><td>${r.method}</td><td>${r.path}</td><td class="d">${r.describe}</td></tr>`).join('')}
  </table>
  <h2>MCP tool definitions — what an AI assistant sees</h2>
  <pre>${JSON.stringify(mcp, null, 2).replace(/</g, '&lt;')}</pre>`);
  w.document.close();
}

/* =======================================================================
 * BOOT
 * ==================================================================== */

renderToolbar();

if (!load()) {
  // A first-run sheet that demonstrates the engine rather than describing it.
  suspendSnapshot = true;
  const demo = {
    'main!A1': 'Q3 Model',
    'main!A3': 'Month',   'main!B3': 'Revenue', 'main!C3': 'Cost',  'main!D3': 'Margin',
    'main!A4': 'July',    'main!B4': '128400',  'main!C4': '73100', 'main!D4': '=B4-C4',
    'main!A5': 'August',  'main!B5': '141250',  'main!C5': '78900', 'main!D5': '=B5-C5',
    'main!A6': 'September','main!B6':'155900',  'main!C6': '81400', 'main!D6': '=B6-C6',
    'main!A7': 'Total',   'main!B7': '=SUM(B4:B6)', 'main!C7': '=SUM(C4:C6)', 'main!D7': '=SUM(D4:D6)',
    'main!A9': 'Margin %','main!B9': '=ROUND(D7/B7*100,1)',
    'main!A10':'Best month', 'main!B10': '=INDEX(A4:A6,MATCH(MAX(D4:D6),D4:D6,0))',
    'main!A12':'0.1 + 0.2', 'main!B12': '=0.1+0.2',
    'main!A13':'Excel says', 'main!B13': "'0.3000000000000000444",
    'main!C13':'(binary floats)',
  };
  graph.loadJSON(demo);
  suspendSnapshot = false;
}

grid.resolveRef = resolveChartRef;
grid.draw();
syncBar();
$('grid').setAttribute('tabindex', '0');
$('grid').focus();

// Expose for console poking and for the eventual HTTP/MCP bridge.
window.miscellany = { graph, reg, grid, cellId, expand, _undo: undoStack, _redo: redoStack,
  get book() { return book; }, resolveChartRef };
