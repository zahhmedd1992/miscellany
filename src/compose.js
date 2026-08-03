/* Sheet + Deck over one Grain document.
 *
 * There is no synchronisation code in this file. None. The slide updates when
 * a cell changes because the slide's objects are nodes in the same graph, and
 * the scheduler already walks dependents — the same walk that updates =SUM().
 *
 * The two panes are the SAME apps that run on their own at index.html and
 * deck.html. Nothing is special-cased for this page: `shell.mount(root,
 * ['sheet', 'deck'])` is the whole of the composition, and the "Both" tab in
 * either app does the same thing.
 */

import { createDocument } from './core/document.js';
import { Shell } from './core/shell.js';
import { SheetApp } from './apps/sheet/app.js';
import { DeckApp } from './apps/deck/app.js';
import { defineObject, objId, OBJECT } from './apps/deck/deck.js';

const doc = createDocument();
const shell = new Shell(doc, { name: 'Miscellany', grant: ['fs'] });

/* ---- the model ---- */
doc.loadJSON({
  'main!A1': 'Q3 Revenue Model',
  'main!A3': 'Month',    'main!B3': 'Revenue', 'main!C3': 'Cost', 'main!D3': 'Margin',
  'main!A4': 'July',     'main!B4': '128400',  'main!C4': '73100', 'main!D4': '=B4-C4',
  'main!A5': 'August',   'main!B5': '141250',  'main!C5': '78900', 'main!D5': '=B5-C5',
  'main!A6': 'September','main!B6': '155900',  'main!C6': '81400', 'main!D6': '=B6-C6',
  'main!A7': 'Total',    'main!B7': '=SUM(B4:B6)', 'main!C7': '=SUM(C4:C6)', 'main!D7': '=SUM(D4:D6)',
  'main!A9': 'Margin %', 'main!B9': '=ROUND(D7/B7*100,1)',
});

/* ---- the deck that reads from it ----
 * A text box bound to a formula is a live figure; a chart bound to a range is
 * an ordinary dependent of every cell in it. */
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
shell.app(SheetApp).app(DeckApp);
shell.mount(document.getElementById('root'), ['sheet', 'deck']);

shell.surfaces.get('sheet').grid.select(1, 3);
shell.refresh();
shell.surface.focus();

window.miscellany = {
  doc, shell,
  get grid() { return shell.surfaces.get('sheet').grid; },
  get deck() { return shell.surfaces.get('deck').view; },
};
