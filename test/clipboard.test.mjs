/* Clipboard payloads. Run: node test/clipboard.test.mjs
 *
 * Two payloads ride on the clipboard at once: TSV of displayed values so
 * every other app can read it, and the raw inputs plus a source anchor so a
 * paste back into Sheet keeps formulas and shifts their references.
 */

import { parseTSV, toTSV, buildPayload, decodePaste } from '../src/apps/sheet/clipboard.js';

let pass = 0, fail = 0;
const fails = [];
const t = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++; else { fail++; fails.push(`${name}\n      want: ${b}\n      got : ${a}`); }
};

/* ---- TSV in ---- */
t('simple grid', parseTSV('a\tb\nc\td'), [['a', 'b'], ['c', 'd']]);
t('trailing newline is not a row', parseTSV('a\tb\n'), [['a', 'b']]);
t('empty cells survive', parseTSV('a\t\tc'), [['a', '', 'c']]);
t('quoted cell containing a tab', parseTSV('"x\ty"\tb'), [['x\ty', 'b']]);
t('quoted cell containing a newline', parseTSV('"line1\nline2"\tb'), [['line1\nline2', 'b']]);
t('escaped quotes', parseTSV('"he said ""hi"""\tb'), [['he said "hi"', 'b']]);
t('CRLF is tolerated', parseTSV('a\tb\r\nc\td'), [['a', 'b'], ['c', 'd']]);
t('single cell', parseTSV('42'), [['42']]);

/* ---- TSV out ---- */
t('plain values need no quoting', toTSV([['a', 'b']]), 'a\tb');
t('a tab forces quoting', toTSV([['a\tb', 'c']]), '"a\tb"\tc');
t('a quote is doubled', toTSV([['say "hi"']]), '"say ""hi"""');
t('round trip', parseTSV(toTSV([['a\tb', 'c"d'], ['e', '']])), [['a\tb', 'c"d'], ['e', '']]);

/* ---- payload ---- */
const raw = { '0,0': '=A1+1', '0,1': '5', '1,0': 'text', '1,1': '' };
const shown = { '0,0': '2', '0,1': '5', '1,0': 'text', '1,1': '' };
const p = buildPayload({ c0: 0, r0: 0, c1: 1, r1: 1 },
  (c, r) => raw[`${c},${r}`] || '', (c, r) => shown[`${c},${r}`] || '');

t('TSV carries DISPLAYED values', p.tsv, '2\ttext\n5\t');
t('payload carries RAW inputs', JSON.parse(p.grain).cells, [['=A1+1', 'text'], ['5', '']]);

/* ---- paste ---- */
t('paste in place is unchanged', decodePaste(p, { col: 0, row: 0 }),
  [['=A1+1', 'text'], ['5', '']]);
t('paste right and down shifts refs', decodePaste(p, { col: 2, row: 3 }),
  [['=C4+1', 'text'], ['5', '']]);
t('paste up-left shifts back', decodePaste(
  buildPayload({ c0: 2, r0: 2, c1: 2, r1: 2 }, () => '=C3*2', () => '6'),
  { col: 0, row: 0 }), [['=A1*2']]);
t('off-sheet after a shift becomes #REF!', decodePaste(
  buildPayload({ c0: 0, r0: 0, c1: 0, r1: 0 }, () => '=A1', () => '1'),
  { col: 0, row: 5 }).length, 1);

/* Text from another app has no anchor, so it is taken LITERALLY. Guessing an
 * anchor would silently rewrite formulas the user pasted in from elsewhere. */
t('plain TSV is never translated', decodePaste({ tsv: '=A1\t7' }, { col: 5, row: 5 }),
  [['=A1', '7']]);
t('a Grain payload wins over TSV when both are present',
  decodePaste({ grain: p.grain, tsv: 'ignored' }, { col: 0, row: 0 })[0][0], '=A1+1');
t('corrupt Grain falls back to TSV',
  decodePaste({ grain: '{not json', tsv: 'a\tb' }, { col: 0, row: 0 }), [['a', 'b']]);
t('nothing at all', decodePaste({}, { col: 0, row: 0 }), null);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fails.length) { for (const x of fails) console.log('  x ' + x + '\n'); process.exit(1); }
console.log('  all green\n');
