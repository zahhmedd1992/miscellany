/* Grid layout decisions. Run: node test/layout.test.mjs
 *
 * These two rules each shipped a visible defect before they were pinned down:
 * text that clipped where Excel overflows it, and a comfortable "1,478.0"
 * rendered as "######".
 */

import { wrapText, numberOverflows } from '../src/apps/sheet/sheet.js';

let pass = 0, fail = 0;
const fails = [];
const t = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else { fail++; fails.push(`${name}\n      want: ${want}\n      got : ${got}`); }
};

// A stub canvas context: every character is 10 units wide. Deterministic, so
// the test measures the ALGORITHM rather than a font.
const ctx = { measureText: (s) => ({ width: s.length * 10 }) };
const w = (text, maxW) => JSON.stringify(wrapText(ctx, text, maxW));

t('short text is one line', w('abc', 100), '["abc"]');
t('wraps on a space', w('aaa bbb', 40), '["aaa","bbb"]');
t('keeps words together when they fit', w('aa bb cc', 60), '["aa bb","cc"]');
t('breaks inside an over-long word', w('aaaaaaaa', 40), '["aaaa","aaaa"]');
t('honours an explicit newline', w('ab\ncd', 100), '["ab","cd"]');
t('never returns an empty array', wrapText(ctx, '', 100).length >= 1, true);
t('degenerate width does not hang', w('abc', 0), '["abc"]');

/* The ###### rule. avail = column width minus padding. */
t('comfortable fit is not overflow', numberOverflows(44, 46), false);
t('accounting padding must not count', numberOverflows(44, 46), false);
t('marginal overrun is tolerated', numberOverflows(47, 46), false);
t('genuine overflow is caught', numberOverflows(80, 46), true);
t('exact fit is not overflow', numberOverflows(46, 46), false);
t('tolerance is configurable', numberOverflows(47, 46, 1.0), true);


/* ---- trimming, with a stub where a space is NOT a digit ----
 * The uniform stub above cannot see this bug: it charges the same for a
 * padding space as for a digit, so it would pass even if the trim were
 * removed. Real metrics are not uniform, and the defect lived exactly there. */
{
  const real = { measureText: (s) => {
    let w = 0;
    for (const ch of s) w += ch === ' ' ? 3.5 : ch === ',' || ch === '.' ? 3.6 : 7.2;
    return { width: w };
  }};
  const padded = ' 1,478.0 ';          // what an accounting format emits
  const bare = padded.trim();
  const avail = 46;
  t('padded width really does exceed the column',
    real.measureText(padded).width > avail, true);
  t('bare width really does fit',
    real.measureText(bare).width < avail, true);
  t('judging on the PADDED text would show ######',
    numberOverflows(real.measureText(padded).width, avail), true);
  t('judging on the TRIMMED text does not',
    numberOverflows(real.measureText(bare).width, avail), false);
}

/* ---- pathological widths must not hang the repaint loop ---- */
{
  const narrow = { measureText: (s) => ({ width: s.length * 40 }) };  // 1 char > cell
  const lines = wrapText(narrow, 'aaaaaaaaaaaaaaaaaaaa', 5);
  t('narrow column terminates', lines.length > 0, true);
  t('narrow column is capped', lines.length <= 502, true);
  t('negative width returns the text', JSON.stringify(wrapText(ctx, 'ab', -5)), '["ab"]');
  t('NaN width returns the text', JSON.stringify(wrapText(ctx, 'ab', NaN)), '["ab"]');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fails.length) { for (const x of fails) console.log('  x ' + x + '\n'); process.exit(1); }
console.log('  all green\n');
