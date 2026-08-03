/* Number format engine. Run: node test/numfmt.test.mjs
 *
 * Expected values are what EXCEL renders, not what my implementation happens
 * to produce. Where we deliberately diverge, the case says so.
 */

import { Decimal } from '../src/core/decimal.js';
import { V } from '../src/core/value.js';
import { formatValue, BUILTIN } from '../src/core/numfmt.js';

let pass = 0, fail = 0;
const fails = [];
const t = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else { fail++; fails.push(`${name}\n      want: ${want}\n      got : ${got}`); }
};
const f = (n, code) => formatValue(V.num(Decimal.fromString(String(n))), code).text;
const col = (n, code) => formatValue(V.num(Decimal.fromString(String(n))), code).color;

/* ---- plain numbers ---- */
t('integer, no decimals', f(1234, '#,##0'), '1,234');
t('two decimals', f(1234.5, '#,##0.00'), '1,234.50');
t('rounds to 2dp', f(1234.567, '#,##0.00'), '1,234.57');
t('leading zeros forced', f(7, '000'), '007');
t('optional decimals trimmed', f(1.5, '0.##'), '1.5');
t('optional decimals absent', f(1, '0.##'), '1');
t('required decimals kept', f(1, '0.00'), '1.00');
t('no thousands', f(1234567, '0'), '1234567');
t('thousands', f(1234567, '#,##0'), '1,234,567');
t('zero', f(0, '#,##0.00'), '0.00');
t('hash only drops leading zero', f(0.5, '#.##'), '.5');

/* ---- percent ---- */
t('percent', f(0.125, '0%'), '13%');
t('percent 2dp', f(0.125, '0.00%'), '12.50%');
t('percent thousands', f(12.3456, '#,##0.0%'), '1,234.6%');

/* ---- currency and literals ---- */
t('dollar', f(1234.5, '$#,##0.00'), '$1,234.50');
t('suffix literal', f(5, '0" units"'), '5 units');
t('escaped literal', f(5, '0\\ x'), '5 x');

/* ---- negatives and sections ---- */
t('minus from single section', f(-1234.5, '#,##0.00'), '-1,234.50');
t('parenthesised negative', f(-1234.5, '#,##0.00;(#,##0.00)'), '(1,234.50)');
t('positive uses first section', f(1234.5, '#,##0.00;(#,##0.00)'), '1,234.50');
t('zero section', f(0, '0.00;(0.00);"-"'), '-');
t('red negative colour', col(-5, '#,##0;[Red]-#,##0'), '#FF0000');
t('no colour on positive', col(5, '#,##0;[Red]-#,##0'), null);
t('accounting underscore is a space', f(1234, '#,##0_);(#,##0)'), '1,234 ');

/* ---- scaling ---- */
t('thousands scale', f(1234567, '#,##0,'), '1,235');
t('millions scale', f(1234567890, '#,##0,,'), '1,235');

/* ---- text section ---- */
t('text passes through by default',
  formatValue(V.text('hello'), '#,##0.00').text, 'hello');
t('text section applies',
  formatValue(V.text('hi'), '#,##0;;;"["@"]"').text, '[hi]');

t('bracket inside a quoted literal is a LITERAL, not a modifier',
  f(5, '"["0"]"'), '[5]');
t('currency in brackets', f(5, '[$USD-409]#,##0'), 'USD5');

/* ---- dates ---- */
t('mm-dd-yy', f(45000, 'mm-dd-yy'), '03-15-23');
t('d-mmm-yy', f(45000, 'd-mmm-yy'), '15-Mar-23');
t('yyyy-mm-dd', f(45000, 'yyyy-mm-dd'), '2023-03-15');
t('long month', f(45000, 'mmmm d, yyyy'), 'March 15, 2023');
t('day name', f(45000, 'dddd'), 'Wednesday');
t('m is MONTH next to d', f(45000, 'm/d/yyyy'), '3/15/2023');
t('m is MINUTE after h', f(45000.5, 'h:mm'), '12:00');
t('seconds', f(45000.5, 'h:mm:ss'), '12:00:00');
t('12-hour with AM/PM', f(45000.75, 'h:mm AM/PM'), '6:00 PM');
t('date+time', f(45000.5, 'm/d/yy h:mm'), '3/15/23 12:00');

/* ---- built-ins are NOT in styles.xml and must be known ---- */
t('builtin 4 exists', BUILTIN[4], '#,##0.00');
t('builtin 14 exists', BUILTIN[14], 'mm-dd-yy');
t('builtin 9 percent', f(0.5, BUILTIN[9]), '50%');
t('builtin 38 red negative', col(-5, BUILTIN[38]), '#FF0000');

/* ---- display never mutates the stored value ---- */
t('stored value untouched', (() => {
  const d = Decimal.fromString('1234.5678');
  formatValue(V.num(d), '#,##0.00');
  return d.toString();
})(), '1234.5678');

/* ---- errors and booleans ---- */
t('error ignores format', formatValue(V.err('#DIV/0!'), '#,##0.00').text, '#DIV/0!');
t('bool ignores format', formatValue(V.bool(true), '#,##0.00').text, 'TRUE');
t('blank stays blank', formatValue(V.blank(), '#,##0.00').text, '');


/* ---- literals in the TEXT section (accounting formats) ----
 * Emitting the raw pattern turns "_(" padding into a visible "_(" — which is
 * how a faithful reader ends up looking like it prints garbage. */
const ACC = '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)';
t('text through an accounting format', formatValue(V.text('X'), ACC).text, ' X ');
t('no pattern chars leak into text', /[_*#0?]/.test(formatValue(V.text('X'), ACC).text), false);
t('zero section renders its literal', f(0, ACC).trim(), '-');
t('accounting positive', f(1234, ACC).trim(), '1,234');
t('accounting negative', f(-1234, ACC).trim(), '(1,234)');

/* ---- a literal is never a token ----
 *
 * The pass that EMITS a section was always quote-aware. The passes that
 * DECIDE — how much to scale by, where the decimal point is, how many digits
 * are required — read the raw pattern, so any structural character sitting
 * inside a quoted literal changed the number itself.
 *
 * Found by the second app: a slide KPI formatted `0.0"%"` showed 45.2 as
 * 4520.0%. The percent was decoration; the engine spent it. */
t('quoted % does not scale',      f(45.2, '0.0"%"'), '45.2%');
t('escaped % does not scale',     f(45.2, '0.0\\%'), '45.2%');
t('bare % still scales',          f(0.452, '0.0%'), '45.2%');
t('quoted digits are not places', f(1234, '0" (2000)"'), '1234 (2000)');
t('quoted dot is not a point',    f(1234.5, '0"."0'), '1235.');
t('quoted comma does not scale',  f(1500, '0", thousand"'), '1500, thousand');
t('real scaling comma still does',f(1234567, '#,##0,"k"'), '1,235k');
t('quoted % after a real one',    f(0.452, '0.0%" of plan"'), '45.2% of plan');
// A quoted bracket is a literal, not a [Red]-style modifier. Text only takes
// the 4th section, so this is the shape the case actually occurs in.
t('bracket literal survives',     formatValue(V.text('X'), '0;-0;0;"["@"]"').text, '[X]');

/* ---- TEXT(value, format): the same engine, reachable from a formula ----
 * numfmt existed from week one and no formula could call it, because
 * formatting was something the grid VIEW did to a cell. A slide has no
 * cells. */
const { evaluate, parse } = await import('../src/core/formula.js');
const ev = (src) => {
  const api = { value: () => V.blank(), expand: () => [], range: () => [] };
  return evaluate(parse(src), api, { sheet: 'main' });
};
t('TEXT formats',            ev('TEXT(1234.5,"$#,##0.00")').s, '$1,234.50');
t('TEXT percent',            ev('TEXT(0.125,"0.0%")').s, '12.5%');
t('TEXT date',               ev('TEXT(45000,"yyyy-mm-dd")').s, '2023-03-15');
t('TEXT of text passes',     ev('TEXT("abc","0.00")').s, 'abc');
t('TEXT needs two args',     ev('TEXT(1)').e, '#VALUE!');
t('TEXT propagates errors',  ev('TEXT(1/0,"0.00")').e, '#DIV/0!');
t('TEXT concatenates',       ev('"Total " & TEXT(425550,"$#,##0")').s, 'Total $425,550');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fails.length) { for (const x of fails) console.log('  x ' + x + '\n'); process.exit(1); }
console.log('  all green\n');
