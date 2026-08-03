/* Grain core tests. Run: node test/core.test.mjs
 *
 * These are correctness tests for the parts where being quietly wrong is
 * worse than crashing: decimal arithmetic, coercion, recalculation order,
 * and cycle detection.
 */

import { Decimal } from '../src/core/decimal.js';
import { V, ERR, toText, isErr, parseInput } from '../src/core/value.js';
import { parse, evaluate, indexToCol, colToIndex } from '../src/core/formula.js';
import { makeGraph, cellId } from '../src/apps/sheet/sheet.js';

let pass = 0, fail = 0;
const failures = [];

function t(name, actual, expected) {
  const a = String(actual), e = String(expected);
  if (a === e) { pass++; }
  else { fail++; failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`); }
}

/* ---- decimal ---------------------------------------------------------- */

const d = (s) => Decimal.fromString(s);

t('0.1 + 0.2 is exact', d('0.1').add(d('0.2')).toString(), '0.3');
t('float would not be', (0.1 + 0.2).toString(), '0.30000000000000004');
t('1.1 * 3', d('1.1').mul(d('3')).toString(), '3.3');
t('money subtract', d('19.99').sub(d('19.98')).toString(), '0.01');
t('penny loop', (() => { let a = Decimal.zero(); for (let i = 0; i < 100; i++) a = a.add(d('0.01')); return a.toString(); })(), '1');
t('big int', d('123456789012345678901234567890').add(d('1')).toString(), '123456789012345678901234567891');
t('div exact', d('1').div(d('4')).toString(), '0.25');
t('div repeating rounds', d('1').div(d('3')).toString().slice(0, 12), '0.3333333333');
t('div by zero is null', String(d('1').div(d('0'))), 'null');
t('negative scale norm', d('1.50').toString(), '1.5');
t('round half up', d('2.5').round(0).toString(), '3');
t('round negative half', d('-2.5').round(0).toString(), '-3');
t('round to 2dp', d('3.14159').round(2).toString(), '3.14');
t('trunc toward zero', d('-2.9').trunc(0).toString(), '-2');
t('pow', d('1.05').pow(3).toString(), '1.157625');
t('pow negative', d('2').pow(-2).toString(), '0.25');
t('cmp', d('0.30').cmp(d('0.3')), '0');
t('exponent notation', d('1.5e3').toString(), '1500');
t('exponent negative', d('1.5e-3').toString(), '0.0015');

/* ---- input parsing ---------------------------------------------------- */

t('parse int', toText(parseInput('42')), '42');
t('parse decimal', toText(parseInput('3.14')), '3.14');
t('parse percent', toText(parseInput('12.5%')), '0.125');
t('parse currency', toText(parseInput('$1,234.50')), '1234.5');
t('parse paren negative', toText(parseInput('($500)')), '-500');
t('parse thousands', toText(parseInput('1,234')), '1234');
t('parse bool', toText(parseInput('true')), 'TRUE');
t('apostrophe forces text', toText(parseInput("'42")), '42');
t('apostrophe kind is text', parseInput("'42").k, 'text');
// The gene-name test: Excel destroys these. We must not.
t('MAR1 stays text', parseInput('MAR1').k, 'text');
t('SEPT2 stays text', parseInput('SEPT2').k, 'text');
t('DEC1 stays text', toText(parseInput('DEC1')), 'DEC1');
t('leading zeros preserved as text', toText(parseInput('00123')), '123');

/* ---- addresses -------------------------------------------------------- */

t('col A', colToIndex('A'), 0);
t('col Z', colToIndex('Z'), 25);
t('col AA', colToIndex('AA'), 26);
t('col AMJ', colToIndex('AMJ'), 1023);
t('index 0', indexToCol(0), 'A');
t('index 26', indexToCol(26), 'AA');
t('roundtrip', indexToCol(colToIndex('BZ')), 'BZ');

/* ---- formulas --------------------------------------------------------- */

const g = makeGraph();
const set = (a, v) => g.set(`main!${a}`, v);
const val = (a) => toText(g.value(`main!${a}`));

set('A1', '10'); set('A2', '20'); set('A3', '30');
set('B1', 'x');  set('B2', '');   set('B3', '5');

t('sum range', (set('C1', '=SUM(A1:A3)'), val('C1')), '60');
t('average', (set('C2', '=AVERAGE(A1:A3)'), val('C2')), '20');
t('sum skips text in range', (set('C3', '=SUM(B1:B3)'), val('C3')), '5');
t('count numbers only', (set('C4', '=COUNT(B1:B3)'), val('C4')), '1');
t('counta skips blank', (set('C5', '=COUNTA(B1:B3)'), val('C5')), '2');
t('arithmetic', (set('C6', '=A1+A2*2'), val('C6')), '50');
t('precedence with parens', (set('C7', '=(A1+A2)*2'), val('C7')), '60');
t('exact decimal in formula', (set('C8', '=0.1+0.2'), val('C8')), '0.3');
t('div by zero', (set('C9', '=A1/0'), val('C9')), '#DIV/0!');
t('error propagates', (set('C10', '=C9+1'), val('C10')), '#DIV/0!');
t('IFERROR catches', (set('C11', '=IFERROR(A1/0,"safe")'), val('C11')), 'safe');
t('IF lazy - no div0', (set('C12', '=IF(A1=0,"n/a",100/A1)'), val('C12')), '10');
t('IF false branch', (set('C13', '=IF(A1>100,"big","small")'), val('C13')), 'small');
t('concat', (set('C14', '="a"&"b"&A1'), val('C14')), 'ab10');
t('comparison', (set('C15', '=A1<A2'), val('C15')), 'TRUE');
t('text compare is case-insensitive', (set('C16', '="Yes"="yes"'), val('C16')), 'TRUE');
t('MAX', (set('C17', '=MAX(A1:A3)'), val('C17')), '30');
t('MIN', (set('C18', '=MIN(A1:A3)'), val('C18')), '10');
t('MEDIAN', (set('C19', '=MEDIAN(A1:A3)'), val('C19')), '20');
t('ROUND', (set('C20', '=ROUND(3.14159,2)'), val('C20')), '3.14');
t('percent literal', (set('C21', '=50%'), val('C21')), '0.5');
t('unary minus', (set('C22', '=-A1'), val('C22')), '-10');
t('power', (set('C23', '=2^10'), val('C23')), '1024');
t('MOD sign follows divisor', (set('C24', '=MOD(-7,3)'), val('C24')), '2');
t('INT floors negative', (set('C25', '=INT(-2.5)'), val('C25')), '-3');
t('TRUNC does not', (set('C26', '=TRUNC(-2.5)'), val('C26')), '-2');
t('LEN', (set('C27', '=LEN("hello")'), val('C27')), '5');
t('LEFT', (set('C28', '=LEFT("hello",2)'), val('C28')), 'he');
t('MID', (set('C29', '=MID("hello",2,3)'), val('C29')), 'ell');
t('UPPER', (set('C30', '=UPPER("abc")'), val('C30')), 'ABC');
t('SUBSTITUTE', (set('C31', '=SUBSTITUTE("a-b-c","-","+")'), val('C31')), 'a+b+c');
t('FIND case sensitive fails', (set('C32', '=FIND("H","hello")'), val('C32')), '#VALUE!');
t('SEARCH case insensitive', (set('C33', '=SEARCH("H","hello")'), val('C33')), '1');
t('AND short circuit', (set('C34', '=AND(A1>5,A2>5)'), val('C34')), 'TRUE');
t('OR', (set('C35', '=OR(A1>100,A2>5)'), val('C35')), 'TRUE');
t('NOT', (set('C36', '=NOT(TRUE)'), val('C36')), 'FALSE');
t('nested', (set('C37', '=SUM(A1:A3)+AVERAGE(A1:A3)'), val('C37')), '80');
t('unknown function', (set('C38', '=FOOBAR(1)'), val('C38')), '#NAME?');
t('blank is zero in arithmetic', (set('C39', '=B2+5'), val('C39')), '5');
t('SUMIF gt', (set('C40', '=SUMIF(A1:A3,">15")'), val('C40')), '50');
t('COUNTIF', (set('C41', '=COUNTIF(A1:A3,">=20")'), val('C41')), '2');
t('STDEV.P', (set('C42', '=ROUND(STDEV.P(A1:A3),4)'), val('C42')), '8.165');

/* 2-D lookup */
set('E1', 'a'); set('F1', '1');
set('E2', 'b'); set('F2', '2');
set('E3', 'c'); set('F3', '3');
t('VLOOKUP exact', (set('G1', '=VLOOKUP("b",E1:F3,2,FALSE)'), val('G1')), '2');
t('VLOOKUP miss', (set('G2', '=VLOOKUP("z",E1:F3,2,FALSE)'), val('G2')), '#N/A');
t('INDEX/MATCH', (set('G3', '=INDEX(E1:E3,MATCH("c",E1:E3,0))'), val('G3')), 'c');
t('INDEX 2d', (set('G4', '=INDEX(E1:F3,2,2)'), val('G4')), '2');

/* ---- graph behaviour -------------------------------------------------- */

t('dependent updates', (set('A1', '100'), val('C1')), '150');   // 100+20+30
t('transitive updates', val('C37'), (100 + 20 + 30) + (150 / 3) + '');
t('chain', (set('H1', '=A1*2'), set('H2', '=H1+1'), set('H3', '=H2*10'), val('H3')), '2010');
t('chain recalcs from root', (set('A1', '1'), val('H3')), '30');

/* cycle detection */
set('I1', '=I2'); set('I2', '=I1');
t('self cycle detected', val('I1'), '#CIRC!');
t('cycle partner detected', val('I2'), '#CIRC!');
set('J1', '=J1');
t('direct self reference', val('J1'), '#CIRC!');

/* the cross-app claim: a non-cell node depending on a cell range */
g.set('deck:board/s3/chart-1', '=SUM(main!A1:A3)');
t('foreign node reads a sheet range', toText(g.value('deck:board/s3/chart-1')), '51');
set('A1', '10');
t('foreign node recalcs when a cell changes', toText(g.value('deck:board/s3/chart-1')), '60');

/* persistence round-trip */
const dump = JSON.stringify(g.toJSON());
const g2 = makeGraph();
g2.loadJSON(JSON.parse(dump));
t('reload preserves formula results', toText(g2.value('main!C1')), '60');
t('reload preserves cross-app node', toText(g2.value('deck:board/s3/chart-1')), '60');
t('reload recomputes, not restores', (() => {
  // values are never stored; if they were, this would silently pass anyway
  return JSON.parse(dump)['main!C1'];
})(), '=SUM(A1:A3)');

/* ---- report ----------------------------------------------------------- */

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log('  all green\n');

/* ---- General number display (see format.js) ---------------------------- */
{
  const { formatGeneral } = await import('../src/core/format.js');
  const g = (s) => formatGeneral(Decimal.fromString(s));
  t('float noise cleaned', g('0.020000000000000018'), '0.02');
  t('float noise below', g('0.0199999999999999995'), '0.02');
  t('negative noise', g('-0.024000000000000021'), '-0.024');
  t('exact stays exact', g('0.3'), '0.3');
  t('integers untouched', g('1399'), '1399');
  t('zero', g('0'), '0');
  t('11 sig digits kept', g('3.14159265358979'), '3.1415926536');
  t('big -> scientific', g('1234567890123'), '1.2345678901E+12');
  t('tiny -> scientific', g('0.000000000123'), '1.23E-10');
  t('display does not mutate', (() => {
    const d = Decimal.fromString('0.020000000000000018');
    formatGeneral(d);
    return d.toString();               // the stored value must be untouched
  })(), '0.020000000000000018');
}

/* ---- a change listener may not change the document ---------------------
 *
 * Recalculation notifies listeners. A listener that writes re-enters
 * recalculation, which notifies again. Deck's first chart renderer resolved a
 * range by writing a scratch node WHILE PAINTING, and one keystroke became
 * 496 nested repaints and a stack overflow — with an empty console, because
 * an exhausted stack has no room to run an error handler. It looked like
 * nothing was wrong right up until the screen went blank.
 *
 * The rule that prevents it is worth more than the fix: if something must
 * update when a value changes, it is a NODE. */
{
  const gg = makeGraph();

  /* A literal's value is assigned before recalc runs, so recalc compared the
   * new value against itself and reported "nothing changed". Typing into a
   * cell nothing depends on notified NO listener. Sheet never noticed because
   * it repaints itself; a second view of the same document would simply not
   * have updated — and that is the product. */
  let heard = [];
  const offL = gg.onChange((ids) => heard.push(...ids));
  gg.set('main!Z9', '42');                    // isolated literal, no dependents
  t('an isolated literal notifies', heard, ['main!Z9']);
  heard = [];
  gg.set('main!Z9', '42');                    // same input
  t('an unchanged write is silent', heard.length, 0);
  heard = [];
  gg.set('main!Z9', '');
  t('clearing notifies', heard, ['main!Z9']);
  offL();

  gg.set('main!A1', '1');
  let caught = null;
  const off = gg.onChange(() => {
    try { gg.set('main!B1', '2'); } catch (e) { caught = e.message; }
  });
  gg.set('main!A1', '5');
  off();
  t('writing from a listener is refused', /read-only/.test(caught || ''), true);
  t('the refusal names the fix', /node/i.test(caught || ''), true);
  t('nothing was written', gg.raw('main!B1'), '');

  // and the document is not left wedged by the refusal
  gg.set('main!B1', '7');
  t('document still writable afterwards', toText(gg.value('main!B1')), '7');

  // a listener that throws for its own reasons must not wedge it either
  const off2 = gg.onChange(() => { throw new Error('listener blew up'); });
  let threw = false;
  try { gg.set('main!A1', '9'); } catch { threw = true; }
  off2();
  t('a throwing listener propagates', threw, true);
  gg.set('main!C1', '3');
  t('and does not leave the document locked', toText(gg.value('main!C1')), '3');
}

console.log(`  (with formatting: ${pass} passed, ${fail} failed)`);
if (fail) process.exit(1);
