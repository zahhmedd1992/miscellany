/* Sheet + Deck + Doc over one Grain document.
 *
 * There is no synchronisation code in this file. None. The slide updates when
 * a cell changes because the slide's objects are nodes in the same graph, and
 * the scheduler already walks dependents — the same walk that updates =SUM().
 *
 * The three panes are the SAME apps that run on their own at index.html,
 * deck.html and doc.html. Nothing is special-cased for this page:
 * `shell.mount(root, [...])` is the whole of the composition, and the "All"
 * tab in any of them does the same thing.
 *
 * The report is the clearest statement of the idea in the whole project. The
 * sentence "Revenue was X" holds a formula, not a number; so does the slide's
 * headline; so does the cell it reads. Change one figure in the spreadsheet
 * and the slide, the sentence and the table all move, because they were never
 * three documents.
 */

import { createDocument } from './core/document.js';
import { Shell } from './core/shell.js';
import { SheetApp } from './apps/sheet/app.js';
import { DeckApp } from './apps/deck/app.js';
import { DocApp } from './apps/doc/app.js';
import { defineObject, objId, OBJECT } from './apps/deck/deck.js';
import { setPara, insertBlock, bodyId, FIRST_KEY, keyBetween, catsId } from './apps/doc/model.js';

const doc = createDocument();
const shell = new Shell(doc, {
  name: 'Miscellany',
  // One key for the whole document. Sheet and Deck had separate keys,
  // which made "one document, two views" true of the screen and false
  // of everything underneath it.
  storageKey: 'miscellany.doc.v1',
  grant: ['fs'],
});

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

/* ---- the report that reads from the same cells ---- */
writeReport(doc);

/* ---- the three views ---- */
shell.app(SheetApp).app(DeckApp).app(DocApp);
shell.mount(document.getElementById('root'), ['sheet', 'deck']);

shell.docName = 'Q3 Revenue Model';
shell.nameInput.value = shell.docName;
shell.surfaces.get('sheet').grid.select(1, 3);
shell.refresh();
shell.surface.focus();

window.miscellany = {
  doc, shell,
  get grid() { return shell.surfaces.get('sheet').grid; },
  get deck() { return shell.surfaces.get('deck').view; },
  get writer() { const s = shell.surfaces.get('doc'); return s && s.view; },
};

/* A memo whose figures are formulas. Every number below is a node reading the
 * same cells the chart on slide 1 reads. */
function writeReport(d) {
  let key = FIRST_KEY;
  const put = (text, p, runs) => {
    const id = bodyId(key);
    setPara(d, id, text, runs || [{ n: text.length }], p || {});
    key = keyBetween(key, null);
    return id;
  };
  const field = (paraId, n, formula, fmt) => {
    const fid = `${paraId}/f${n}`;
    d.set(fid, formula);
    d.setMeta(fid, { field: { fmt: fmt || null } });
    return fid;
  };

  put('Q3 Revenue', { style: 'title' });
  put('Prepared from the model in the next pane. Nothing here was typed twice.',
      { style: 'caption' });

  // "Revenue across the quarter totalled $X, against costs of $Y."
  {
    const id = bodyId(key);
    const a = field(id, 1, '=SUM(main!B4:B6)', '$#,##0');
    const b = field(id, 2, '=SUM(main!C4:C6)', '$#,##0');
    const head = 'Revenue across the quarter totalled ';
    const mid = ', against costs of ';
    const tail = '. Both figures are formulas: edit a cell in the sheet and this ' +
                 'sentence changes with it.';
    setPara(d, id, head + '￼' + mid + '￼' + tail,
      [{ n: head.length }, { n: 1, field: a }, { n: mid.length },
       { n: 1, field: b }, { n: tail.length }],
      { style: 'body', align: 'justify' });
    key = keyBetween(key, null);
  }

  put('The months', { style: 'h2' });

  // a table bound to the range, not a copy of it
  {
    const id = bodyId(key);
    d.set(id, '=main!A3:D6');
    d.setMeta(id, { block: { kind: 'table', ref: 'main!A3:D6', header: true } });
    key = keyBetween(key, null);
  }

  put('The same numbers, drawn', { style: 'h2' });
  {
    const id = bodyId(key);
    d.set(id, '=main!B4:B6');
    d.setMeta(id, { block: { kind: 'chart', chart: 'bar', w: 430, h: 230,
                             ref: 'main!B4:B6', cats: 'main!A4:A6',
                             color: '#9A3B1B', align: 'center' } });
    d.set(catsId(id), '=main!A4:A6');
    key = keyBetween(key, null);
  }
  put('Revenue by month. The chart is a dependent of the range, exactly as the ' +
      'chart on slide 1 is.', { style: 'caption', align: 'center' });
}
