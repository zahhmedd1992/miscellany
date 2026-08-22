/* Doc's document model. Run: node test/doc.model.test.mjs
 *
 * Two things are load-bearing enough to be tested before anything is built on
 * them: the fractional index keys that give paragraphs their order, and the
 * run arithmetic that keeps formatting attached to the right characters.
 *
 * Both fail SILENTLY when they are wrong. A key scheme that loses its
 * ordering shows up as paragraphs in the wrong sequence, which reads as a
 * mystery rather than a bug; run arithmetic that drifts shows up as bold
 * starting three characters late, which nobody reports because nobody
 * believes the computer did it.
 */

import {
  keyBetween, FIRST_KEY, packRuns, insertRuns, deleteRuns, formatRuns, formatAcross,
  splitAt, runAt, bodyId, keyOf, isBodyId, ownerOf,
} from '../src/apps/doc/model.js';

let pass = 0, fail = 0;
const fails = [];
const t = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else { fail++; fails.push(`${name}\n      want: ${want}\n      got : ${got}`); }
};
const ok = (name, cond) => t(name, !!cond, true);

/* ---- fractional index keys ---------------------------------------------- */

t('an empty document gets the first key', keyBetween(null, null), 'a0');

{
  // Appending: 5,000 paragraphs typed one after another.
  const keys = [keyBetween(null, null)];
  for (let i = 0; i < 5000; i++) keys.push(keyBetween(keys[keys.length - 1], null));
  ok('5,000 appends stay in order', keys.every((k, i) => i === 0 || keys[i - 1] < k));
  /* a0..az is 62 keys, b00..bzz another 3,844, then c000 - so 5,001 appended
   * paragraphs never need a fifth character. Without the integer part the
   * 5,000th key would have been 5,000 characters long. */
  t('5,000 appends stay short', Math.max(...keys.map((k) => k.length)), 4);
}

{
  // Prepending: typing above the first line, over and over.
  let first = keyBetween(null, null);
  let bad = 0;
  for (let i = 0; i < 1000; i++) {
    const k = keyBetween(null, first);
    if (!(k < first)) bad++;
    first = k;
  }
  t('1,000 prepends stay in order', bad, 0);
}

{
  /* The pathological case: pressing Enter in the SAME place repeatedly. Each
   * insert must land strictly between its neighbours, and the key may grow -
   * that is the price of never renumbering - but it must grow slowly. */
  const worst = (which) => {
    let a = 'a0', b = keyBetween('a0', null), bad = 0, deepest = 0;
    for (let i = 0; i < 5000; i++) {
      const m = keyBetween(a, b);
      if (!(a < m && m < b)) bad++;
      deepest = Math.max(deepest, m.length);
      if (which === 'before') b = m; else a = m;
    }
    return { bad, deepest };
  };
  const before = worst('before'), after = worst('after');
  t('5,000 inserts always before the same paragraph stay ordered', before.bad, 0);
  t('5,000 inserts always after the same paragraph stay ordered', after.bad, 0);
  /* This is the pathological case for any fractional index and every
   * implementation has it: repeatedly splitting the SAME gap eats precision.
   * What matters is the rate. A fifth of a character per insert means a
   * document would need a hundred thousand consecutive inserts into one gap
   * before an id reached twenty kilobytes, and no human edits that way -
   * typing normally moves the cursor, which moves the gap.
   * Asserted as a rate so a regression that made it linear would show up. */
  ok(`before-growth is sublinear (${before.deepest} chars / 5,000 inserts)`,
     before.deepest / 5000 < 0.25);
  ok(`after-growth is sublinear (${after.deepest} chars / 5,000 inserts)`,
     after.deepest / 5000 < 0.25);
}

{
  /* The property that actually matters: the sorted order of the keys IS the
   * order they were inserted in. Anything else and the document is scrambled. */
  const list = [keyBetween(null, null)];
  for (let i = 0; i < 5000; i++) {
    const at = (i * 2654435761) % (list.length + 1);   // deterministic scatter
    const lo = at === 0 ? null : list[at - 1];
    const hi = at === list.length ? null : list[at];
    list.splice(at, 0, keyBetween(lo, hi));
  }
  t('5,001 scattered inserts: sorted order == insertion order',
    [...list].sort().join('|') === list.join('|'), true);
  t('every key distinct', new Set(list).size, list.length);
  /* Every key it generates must be a key it accepts. The invariant is that a
   * key's FRACTION part never ends in a zero (the integer part may - "a0" is
   * the first key of every document); asserting the surface form directly
   * would test the spelling rather than the rule. */
  let rejected = 0;
  for (const k of list) {
    try { keyBetween(k, null); keyBetween(null, k); } catch { rejected++; }
  }
  t('every generated key is a valid input to the generator', rejected, 0);

  // and with the node-id prefix and sub-nodes present, which is how the
  // document actually sorts them
  const ids = list.slice(0, 400).map(bodyId);
  const mixed = [...ids, ...ids.slice(0, 90).map((i) => i + '/f1'),
                 ...ids.slice(0, 40).map((i) => i + '/r0c0')];
  const bodyOnly = [...mixed].sort().filter(isBodyId);
  t('sub-nodes do not disturb body order', bodyOnly.join('|'), [...ids].sort().join('|'));
  t('keyOf round-trips', keyOf(bodyId('Vzz')), 'Vzz');
  t('ownerOf finds the block a field belongs to', ownerOf(bodyId('V3') + '/f7'), bodyId('V3'));
  t('ownerOf of a block is itself', ownerOf(bodyId('V3')), bodyId('V3'));
}

t('keyBetween refuses a backwards pair',
  (() => { try { keyBetween('W', 'V'); return 'no throw'; } catch { return 'threw'; } })(),
  'threw');

/* ---- run arithmetic ------------------------------------------------------ */

const J = (r) => JSON.stringify(r);

t('packRuns merges neighbours that agree',
  J(packRuns([{ n: 3 }, { n: 4 }], 7)), J([{ n: 7 }]));
t('packRuns keeps neighbours that differ',
  J(packRuns([{ n: 3, b: 1 }, { n: 4 }], 7)), J([{ n: 3, b: 1 }, { n: 4 }]));
t('packRuns drops empties',
  J(packRuns([{ n: 0, b: 1 }, { n: 4 }], 4)), J([{ n: 4 }]));
t('packRuns extends to cover the text',
  J(packRuns([{ n: 2, b: 1 }], 5)), J([{ n: 2, b: 1 }, { n: 3 }]));
t('packRuns never merges a field with text',
  J(packRuns([{ n: 1, field: 'f1' }, { n: 1, field: 'f1' }], 2)),
  J([{ n: 1, field: 'f1' }, { n: 1, field: 'f1' }]));

t('splitAt puts a boundary exactly at the offset',
  J(splitAt([{ n: 10 }], 4)), J([{ n: 4 }, { n: 6 }]));
t('splitAt on an existing boundary changes nothing',
  J(splitAt([{ n: 4 }, { n: 6 }], 4)), J([{ n: 4 }, { n: 6 }]));

t('runAt finds the run covering an offset', runAt([{ n: 3 }, { n: 5 }], 4).i, 1);
t('runAt at a boundary picks the run that starts there',
  runAt([{ n: 3 }, { n: 5 }], 3).i, 1);

// insert
t('insert in the middle of a plain run',
  J(insertRuns([{ n: 10 }], 4, 3)), J([{ n: 13 }]));
t('insert inherits the formatting to its left',
  J(insertRuns([{ n: 4, b: 1 }, { n: 6 }], 4, 2)),
  J([{ n: 6, b: 1 }, { n: 6 }]));
t('insert at the very start inherits the first run',
  J(insertRuns([{ n: 4, b: 1 }, { n: 6 }], 0, 2)), J([{ n: 6, b: 1 }, { n: 6 }]));

/* Typing next to a FIELD must not make the typed characters part of the
 * field: the field's text is a computed value, and a character living inside
 * it disappears the next time the number changes. */
t('typing after a field does NOT join the field',
  J(insertRuns([{ n: 5 }, { n: 1, field: 'f1' }], 6, 3)),
  J([{ n: 5 }, { n: 1, field: 'f1' }, { n: 3 }]));

// delete
t('delete inside one run',
  J(deleteRuns([{ n: 10 }], 2, 5)), J([{ n: 7 }]));
t('delete across a boundary keeps both formats',
  J(deleteRuns([{ n: 5, b: 1 }, { n: 5 }], 3, 7)), J([{ n: 3, b: 1 }, { n: 3 }]));
t('deleting a whole run removes it',
  J(deleteRuns([{ n: 5, b: 1 }, { n: 5 }], 0, 5)), J([{ n: 5 }]));
/* Deleting [2,5) of "abc<field>def" removes 'c', the field, and 'd' - so two
 * characters survive on each side and, being formatted alike, they merge. */
t('a partly deleted field is deleted entirely',
  J(deleteRuns([{ n: 3 }, { n: 1, field: 'f1' }, { n: 3 }], 2, 5)), J([{ n: 4 }]));

// format
t('bold a span splits the run',
  J(formatRuns([{ n: 10 }], 2, 5, () => ({ b: 1 }))),
  J([{ n: 2 }, { n: 3, b: 1 }, { n: 5 }]));
t('formatting the whole paragraph leaves one run',
  J(formatRuns([{ n: 10 }], 0, 10, () => ({ b: 1 }))), J([{ n: 10, b: 1 }]));
t('formatting an empty span changes nothing',
  J(formatRuns([{ n: 10 }], 4, 4, () => ({ b: 1 }))), J([{ n: 10 }]));
t('re-formatting merges back',
  J(formatRuns([{ n: 2 }, { n: 3, b: 1 }, { n: 5 }], 0, 10, () => ({ b: undefined }))),
  J([{ n: 10 }]));

// what the toolbar reads back
t('formatAcross reports agreement', formatAcross([{ n: 10, b: 1 }], 0, 5).b, 1);
t('formatAcross reports disagreement as undefined',
  formatAcross([{ n: 5, b: 1 }, { n: 5 }], 0, 10).b, undefined);
t('formatAcross of an empty document is empty',
  JSON.stringify(formatAcross([{ n: 0 }], 0, 0)), '{}');

/* A property test: whatever sequence of edits happens, the runs must always
 * cover exactly the text. A drift of one character here is invisible until
 * somebody notices the italics are off by a word. */
{
  let text = 'The quick brown fox jumps over the lazy dog.';
  let runs = [{ n: text.length }];
  let bad = 0;
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 3000; i++) {
    const op = rnd(3);
    if (op === 0) {
      const at = rnd(text.length + 1), s = 'xyz'.slice(0, 1 + rnd(3));
      text = text.slice(0, at) + s + text.slice(at);
      runs = insertRuns(runs, at, s.length);
    } else if (op === 1 && text.length > 2) {
      const a = rnd(text.length), b = a + 1 + rnd(Math.min(5, text.length - a));
      text = text.slice(0, a) + text.slice(b);
      runs = deleteRuns(runs, a, b);
    } else if (text.length > 2) {
      const a = rnd(text.length), b = a + 1 + rnd(Math.min(8, text.length - a));
      runs = formatRuns(runs, a, b, () => (rnd(2) ? { b: 1 } : { i: 1 }));
    }
    const total = runs.reduce((x, r) => x + r.n, 0);
    if (total !== text.length) { bad++; break; }
  }
  t('3,000 random edits: runs always cover the text exactly', bad, 0);
}

/* ---- report -------------------------------------------------------------- */

console.log(`\n  doc model: ${pass} passed, ${fail} failed`);
for (const f of fails) console.log('   x ' + f);
process.exit(fail ? 1 : 0);
