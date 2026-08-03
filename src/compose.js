/* Sheet + Deck over one Grain document.
 *
 * This file is the experiment the plan called for and I kept postponing: if
 * the substrate is real, a second app is cheap. So here is Deck wired next to
 * Sheet, and the honest measure is how little is written here.
 *
 * What is shared, unchanged, between the two panes:
 *   core/document.js   the graph and its recalculation scheduler
 *   core/a1.js         the reference grammar both apps address cells with
 *   core/formula.js    lexer, parser, evaluator
 *   core/value.js      one value model — a slide's title and a cell hold the
 *                      same kind of thing
 *   core/numfmt.js     number formats
 *   apps/sheet/chartview.js  the chart renderer, used by BOTH panes
 *
 * There is no synchronisation code below. None. The slide updates when a cell
 * changes because the slide's objects are nodes in the same graph, and the
 * scheduler already walks dependents — the same walk that updates =SUM().
 */

import { createDocument } from './core/document.js';
import { cellId, SHEET } from './core/a1.js';
import { Grid } from './apps/sheet/sheet.js';
import { DeckView, objId, defineObject, OBJECT, SLIDE_W, SLIDE_H } from './apps/deck/deck.js';
import { toText, isBlank } from './core/value.js';
import { Decimal } from './core/decimal.js';

const $ = (id) => document.getElementById(id);
const doc = createDocument();

/* ---- the document: a small model, and a deck that reads from it ---- */

doc.loadJSON({
  'main!A1': 'Q3 Revenue Model',
  'main!A3': 'Month',   'main!B3': 'Revenue', 'main!C3': 'Cost', 'main!D3': 'Margin',
  'main!A4': 'July',    'main!B4': '128400',  'main!C4': '73100', 'main!D4': '=B4-C4',
  'main!A5': 'August',  'main!B5': '141250',  'main!C5': '78900', 'main!D5': '=B5-C5',
  'main!A6': 'September','main!B6':'155900',  'main!C6': '81400', 'main!D6': '=B6-C6',
  'main!A7': 'Total',   'main!B7': '=SUM(B4:B6)', 'main!C7': '=SUM(C4:C6)', 'main!D7': '=SUM(D4:D6)',
  'main!A9': 'Margin %','main!B9': '=ROUND(D7/B7*100,1)',
});

/* Slide objects are nodes. A text box bound to a formula is a live figure; a
 * chart bound to a range is an ordinary dependent of every cell in it.
 * defineObject() binds every range an object shows, so the graph knows about
 * all of them and painting never has to go looking. */
const { text, chart } = OBJECT;
const def = (slide, name, object, formula) =>
  defineObject(doc, objId(slide, name), object, formula);

def(0, 'title', text(80, 70, 1120, 90, { size: 58, bold: true }), 'Q3 Revenue');
def(0, 'sub', text(80, 178, 1120, 46, { size: 26, color: '#6C6356' }),
    '="Total revenue " & TEXT(B7,"$#,##0") & " across " & COUNT(B4:B6) & " months"');
def(0, 'chart', chart(80, 250, 700, 390, {
      ref: 'main!B4:B6', cats: 'main!A4:A6', chart: 'bar',
      color: '#9A3B1B', title: 'Revenue by month' }));
def(0, 'kpiLabel', text(830, 300, 370, 40, { size: 24, color: '#6C6356' }), 'Margin');
def(0, 'kpi', text(830, 336, 370, 110, { size: 84, bold: true, numFmt: '0.0"%"' }), '=B9');
def(0, 'kpi2Label', text(830, 470, 370, 40, { size: 24, color: '#6C6356' }), 'Best month');
def(0, 'kpi2', text(830, 506, 370, 60, { size: 40, bold: true }),
    '=INDEX(main!A4:A6,MATCH(MAX(main!D4:D6),main!D4:D6,0))');

def(1, 'title', text(80, 70, 1120, 90, { size: 52, bold: true }), 'Margin by month');
def(1, 'chart', chart(80, 200, 1120, 440, {
      ref: 'main!D4:D6', cats: 'main!A4:A6', chart: 'line',
      color: '#2F5D3A', title: 'Margin', yTitle: 'dollars' }));

/* ---- the two views ---- */

const grid = new Grid($('grid'), doc, { onSelect: () => syncBar() });
const deck = new DeckView($('slide'), doc, { slides: 2 });

grid.sheet = SHEET;
grid.colW = new Map([[0, 108]]);
grid.invalidate();

/* ---- the ONLY wiring between them: a visual cue that something changed ----
 * The slide does not need telling. It repaints because DeckView subscribed to
 * the same document, and the document told it. This is only so a human can
 * see it happen. */
doc.onChange((ids) => {
  for (const id of ids) {
    if (id.startsWith('deck:')) { pulse(); return; }
  }
});

let pulseTimer = null;
function pulse() {
  const el = $('pulse');
  el.classList.add('on');
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => el.classList.remove('on'), 900);
}

/* ---- Sheet's editing surface (the same code paths as the standalone app) ---- */

const editor = $('editor');
let editing = null;

grid.onEdit = (sel, keepContent, seed) => {
  const id = cellId(sel.col, sel.row, grid.sheet);
  editing = { ...sel, id };
  const x = grid.colX(sel.col), y = grid.rowY(sel.row), w = grid.width(sel.col);
  editor.style.display = 'block';
  editor.style.left = x + 'px';
  editor.style.top = y + 'px';
  editor.style.width = w + 'px';
  editor.style.height = '26px';
  editor.value = seed !== undefined ? seed : (keepContent ? doc.raw(id) : '');
  editor.focus();
  if (seed === undefined) editor.setSelectionRange(editor.value.length, editor.value.length);
};

function commit(move) {
  if (!editing) return;
  const { id, col, row } = editing;
  if (doc.raw(id) !== editor.value) doc.set(id, editor.value);
  editor.style.display = 'none';
  editing = null;
  if (move === 'down') grid.select(col, row + 1);
  else if (move === 'right') grid.select(col + 1, row);
  else grid.draw();
  syncBar();
  $('grid').focus();
}

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commit('down'); }
  else if (e.key === 'Tab') { e.preventDefault(); commit('right'); }
  else if (e.key === 'Escape') { e.preventDefault(); editor.style.display = 'none'; editing = null; $('grid').focus(); }
  e.stopPropagation();
});

const finput = $('finput');
finput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const id = cellId(grid.sel.col, grid.sel.row, grid.sheet);
    if (doc.raw(id) !== finput.value) doc.set(id, finput.value);
    grid.select(grid.sel.col, grid.sel.row + 1);
    syncBar();
    $('grid').focus();
  }
  e.stopPropagation();
});

window.addEventListener('keydown', (e) => {
  if (editing || document.activeElement === finput) return;
  if (grid.handleKey(e)) syncBar();
});

function syncBar() {
  const s = grid.sel;
  const id = cellId(s.col, s.row, grid.sheet);
  const addr = id.slice(id.indexOf('!') + 1);
  $('addr').textContent = addr;
  if (document.activeElement !== finput) finput.value = doc.raw(id);
  $('st-sel').innerHTML = `<b>${addr}</b>`;

  const r = grid.selRect();
  const nums = [];
  for (let row = r.r0; row <= r.r1; row++) {
    for (let col = r.c0; col <= r.c1; col++) {
      const v = doc.value(cellId(col, row, grid.sheet));
      if (v.k === 'number') nums.push(v.d);
    }
  }
  $('st-stats').textContent = nums.length
    ? `Sum ${nums.reduce((a, b) => a.add(b), Decimal.zero()).toString()}` : '';

  // how many slide objects depend on the selected cell, computed from the
  // graph rather than from a list someone has to remember to update
  const node = doc.nodes.get(id);
  const deps = node ? [...node.dependents].filter((d) => d.startsWith('deck:')).length : 0;
  $('st-link').textContent = deps
    ? `${deps} slide object${deps === 1 ? ' depends' : 's depend'} on ${addr}` : '';
  void isBlank; void toText;
}

/* ---- slide navigation ---- */

function renderSlides() {
  const bar = $('slides');
  bar.innerHTML = '';
  for (let i = 0; i < deck.slides; i++) {
    const b = document.createElement('button');
    b.className = 'slidebtn' + (i === deck.slide ? ' on' : '');
    b.textContent = `Slide ${i + 1}`;
    b.onclick = () => { deck.go(i); renderSlides(); };
    bar.appendChild(b);
  }
}

$('sheet-note').textContent = 'edit any number';
$('deck-note').textContent = `${SLIDE_W}×${SLIDE_H}, live from the sheet`;
renderSlides();
grid.select(1, 3);
syncBar();
$('grid').setAttribute('tabindex', '0');
$('grid').focus();

window.miscellany = { doc, grid, deck, cellId };
