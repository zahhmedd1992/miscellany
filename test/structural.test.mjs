/* Structural edits. Run: node test/structural.test.mjs
 *
 * Two layers: the REFERENCE rule (which is what every formula in the workbook
 * gets), and the XML transform (which is what the file gets). The reference
 * rule is applied per reference, and that handles ranges for free — inserting
 * inside A1:A10 grows it, deleting inside shrinks it, with no special case.
 */

import { adjustReferences, moveCell } from '../src/core/ooxml/refs.js';
import { applyStructural, shiftIndex, setColumnWidths, setRowHeights,
         pxToChars, charsToPx } from '../src/core/ooxml/structural.js';

let pass = 0, fail = 0;
const fails = [];
const t = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else { fail++; fails.push(`${name}\n      want: ${want}\n      got : ${got}`); }
};

const insRow = (at, n = 1) => ({ sheet: 'S', homeSheet: 'S', axis: 'row', at, count: n, remove: false });
const delRow = (at, n = 1) => ({ sheet: 'S', homeSheet: 'S', axis: 'row', at, count: n, remove: true });
const insCol = (at, n = 1) => ({ sheet: 'S', homeSheet: 'S', axis: 'col', at, count: n, remove: false });
const delCol = (at, n = 1) => ({ sheet: 'S', homeSheet: 'S', axis: 'col', at, count: n, remove: true });

/* ---- the reference rule ---- */
t('a row below the cut shifts', adjustReferences('A10', insRow(4)), 'A11');
t('a row above the cut stays', adjustReferences('A1', insRow(4)), 'A1');
t('a row exactly at the cut shifts', adjustReferences('A5', insRow(4)), 'A6');
t('a range GROWS around an insert', adjustReferences('A1:A10', insRow(4)), 'A1:A11');
t('an absolute row shifts too', adjustReferences('A$10', insRow(4)), 'A$11');
t('multi-row insert', adjustReferences('A10', insRow(4, 3)), 'A13');

t('after a delete, rows shift back', adjustReferences('A10', delRow(4)), 'A9');
t('inside a delete is #REF!', adjustReferences('A5', delRow(4)), '#REF!');
t('a range SHRINKS around a delete', adjustReferences('A1:A10', delRow(4)), 'A1:A9');
t('a wholly deleted range collapses', adjustReferences('A5:A5', delRow(4)), '#REF!');

t('columns insert', adjustReferences('B1', insCol(1)), 'C1');
t('column ranges grow', adjustReferences('A1:B1', insCol(1)), 'A1:C1');
t('columns delete', adjustReferences('C1', delCol(1)), 'B1');

/* The one that is easy to get wrong: a formula on ANOTHER sheet must only
 * move if it points AT the sheet being edited. */
t('a bare ref on another sheet is untouched',
  adjustReferences('A10', { ...insRow(4), homeSheet: 'Other' }), 'A10');
t('a qualified ref to the edited sheet moves',
  adjustReferences('S!A10', { ...insRow(4), homeSheet: 'Other' }), 'S!A11');
t('a qualified ref to a third sheet does not',
  adjustReferences('Third!A10', insRow(4)), 'Third!A10');
t('a quoted sheet name is matched',
  adjustReferences("'S'!A10", { ...insRow(4), homeSheet: 'Other' }), "'S'!A11");

/* traps that a naive regex gets wrong */
t('LOG10 is not a reference', adjustReferences('LOG10(A10)', insRow(4)), 'LOG10(A11)');
t('a string literal is left alone', adjustReferences('IF(A10="A10",1,0)', insRow(4)), 'IF(A11="A10",1,0)');

/* ---- cell movement ---- */
t('a cell below an insert moves down', JSON.stringify(moveCell(0, 9, insRow(4))), '{"col":0,"row":10}');
t('a deleted cell is gone', String(moveCell(0, 4, delRow(4))), 'null');
t('shiftIndex agrees', shiftIndex(9, insRow(4)), 10);

/* ---- the XML transform ---- */
const XML =
  '<worksheet><sheetData>' +
  '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>' +
  '<row r="2" ht="30" customHeight="1"><c r="A2" s="5"><v>3</v></c></row>' +
  '<row r="3"><c r="A3"><f>SUM(A1:A2)</f><v>4</v></c></row>' +
  '</sheetData>' +
  '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>' +
  '<cols><col min="1" max="2" width="12" customWidth="1"/></cols>' +
  '</worksheet>';

{
  const out = applyStructural(XML, { axis: 'row', at: 1, count: 1, remove: false, sheet: 'S' });
  t('insert renumbers rows', (out.match(/<row r="(\d+)"/g) || []).join(' '), '<row r="1" <row r="3" <row r="4"');
  t('insert renumbers cell refs', (out.match(/r="A\d"/g) || []).join(' '), 'r="A1" r="A3" r="A4"');
  t('insert grows the formula', /<f>([^<]*)<\/f>/.exec(out)[1], 'SUM(A1:A3)');
  t('custom height survives', out.includes('ht="30"'), true);
  t('cell style survives', out.includes('s="5"'), true);
  t('unmodelled elements survive', out.includes('<cols>'), true);
}
{
  const out = applyStructural(XML, { axis: 'row', at: 1, count: 1, remove: true, sheet: 'S' });
  t('delete drops the row', (out.match(/<row r="(\d+)"/g) || []).join(' '), '<row r="1" <row r="2"');
  t('delete shrinks the formula', /<f>([^<]*)<\/f>/.exec(out)[1], 'SUM(A1:#REF!)');
}
{
  const out = applyStructural(XML, { axis: 'col', at: 0, count: 1, remove: true, sheet: 'S' });
  t('deleting column A leaves only the shifted B', (out.match(/r="[A-Z]\d"/g) || []).join(' '), 'r="A1"');
  // A1:B1 loses column A, so it would collapse to a single cell. Excel drops
  // such a merge rather than keeping a 1x1 one, and so do we.
  t('a merge that collapses to one cell is dropped',
    /mergeCell ref="([^"]*)"/.test(out) ? RegExp.$1 : 'dropped', 'dropped');
}
{
  const out = applyStructural(XML, { axis: 'col', at: 0, count: 1, remove: false, sheet: 'S' });
  t('inserting a column shifts cells right', (out.match(/r="[A-Z]\d"/g) || []).join(' '),
    'r="B1" r="C1" r="B2" r="B3"');
  t('col span shifts', /min="(\d+)"[^>]*max="(\d+)"/.exec(out).slice(1, 3).join('-'), '2-3');
}


/* ---- column widths and row heights ----
 * Widths live in CHARACTERS of the default font and as SPANS, so both facts
 * have to be undone on the way in and redone on the way out. */
{
  let bad = 0;
  for (let px = 20; px <= 600; px++) if (Math.abs(charsToPx(pxToChars(px)) - px) > 1) bad++;
  t('px -> chars -> px round-trips within 1px across 20..600', bad, 0);

  const X = '<worksheet><cols>'
    + '<col min="1" max="3" width="32.5" customWidth="1"/><col min="5" max="5" width="9"/>'
    + '</cols><sheetData><row r="1"><c r="A1"/></row><row r="3"/></sheetData></worksheet>';

  const out = setColumnWidths(X, new Map([[1, 130]]));
  // Regenerating every span would re-round the columns the user never touched,
  // so a workbook would lose a pixel per column on every save.
  t('an untouched span keeps its exact text', out.includes('width="9"'), true);
  t('the containing span is split in three', (out.match(/<col /g) || []).length, 4);
  t('column A keeps its original width', /min="1" max="1" width="32.5"/.test(out), true);
  t('column C keeps its original width', /min="3" max="3" width="32.5"/.test(out), true);
  t('the resized column is rewritten', /min="2" max="2" width="[\d.]+" customWidth/.test(out), true);
  t('no overrides means no change', setColumnWidths(X, new Map()), X);
  t('cols is created before sheetData when absent', (() => {
    const o = setColumnWidths('<worksheet><sheetData/></worksheet>', new Map([[0, 100]]));
    return o.includes('<cols>') && o.indexOf('<cols>') < o.indexOf('<sheetData');
  })(), true);

  const h = setRowHeights(X, new Map([[0, 40]]));
  t('row height is written in POINTS', /ht="30"/.test(h), true);
  t('customHeight is set alongside it', /customHeight="1"/.test(h), true);
  t('rows with no override keep their tag', h.includes('<row r="3"/>'), true);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fails.length) { for (const x of fails) console.log('  x ' + x + '\n'); process.exit(1); }
console.log('  all green\n');
