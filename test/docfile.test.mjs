/* The Miscellany document format. Run: node test/docfile.test.mjs
 *
 * The properties that matter are the ones the format was designed for, so
 * those are what is asserted: any app's nodes, inputs only, one node per line,
 * unknown records preserved, and nothing that can execute.
 */

import { serialise, parse, looksLikeGrain, MAGIC, VERSION } from '../src/core/docfile.js';
import { createDocument } from '../src/core/document.js';
import { toText } from '../src/core/value.js';

let pass = 0, fail = 0;
const fails = [];
const t = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else { fail++; fails.push(`${name}\n      want: ${want}\n      got : ${got}`); }
};

/* ---- a document with two apps in it ---- */

const DOC = {
  'main!A1': 'Q3 Revenue Model',
  'main!B4': '128400',
  'main!B5': '141250',
  'main!B7': '=SUM(B4:B5)',
  'deck:s1/title': 'Q3 Revenue',
  'deck:s1/kpi': { r: '=main!B7', m: { object: { kind: 'text', x: 80, y: 70, size: 84 } } },
};

const text = serialise(DOC, { name: 'Q3' });
const back = parse(text);

t('magic and version', text.split('\n')[0], `${MAGIC}/${VERSION}`);
t('header survives', back.header.name, 'Q3');
t('a cell survives', back.nodes['main!B4'], '128400');
t('a formula survives as its INPUT', back.nodes['main!B7'], '=SUM(B4:B5)');
t('a slide object survives', back.nodes['deck:s1/title'], 'Q3 Revenue');
t('geometry survives', back.nodes['deck:s1/kpi'].m.object.size, 84);
/* The format has no per-app schema, and the way to prove that is not to grep
 * for the word "cell" — "miscellany" contains one — but to persist an app
 * that does not exist. If a future app gets storage the day it picks an id
 * prefix, the file genuinely does not know what a spreadsheet is. */
{
  const future = {
    'form:intake/total': '=main!B7*0.08',
    'form:intake/field-3': { r: 'Name', m: { widget: { kind: 'shortText', required: true } } },
  };
  const r = parse(serialise(future, {}));
  t('an app that does not exist yet persists', r.nodes['form:intake/total'], '=main!B7*0.08');
  t('with its own meta shape intact', r.nodes['form:intake/field-3'].m.widget.kind, 'shortText');
}

/* One node per line — a 350,000-node document that serialises to one line
 * cannot be reviewed, merged or blamed. */
t('one line per node',
  text.trimEnd().split('\n').length, 2 + Object.keys(DOC).length);

/* ---- inputs only, never computed values ----
 * A file that caches a result beside the formula that produced it can hold
 * the two in disagreement. Ours cannot, because it does not have the result. */
{
  const doc = createDocument();
  doc.loadJSON(DOC);
  t('the graph computed it', toText(doc.value('main!B7')), '269650');
  const out = serialise(doc.toJSON(), {});
  t('but the file does not contain the answer', out.includes('269650'), false);

  // and reopening recomputes it rather than trusting anything
  const doc2 = createDocument();
  doc2.loadJSON(parse(out).nodes);
  t('reopening recomputes', toText(doc2.value('main!B7')), '269650');
  t('a slide formula is live after a round trip',
    toText(doc2.value('deck:s1/kpi')), '269650');
}

/* ---- escaping is JSON's problem, not ours ---- */
{
  const nasty = {
    'main!A1': 'tab\there',
    'main!A2': 'line\nbreak',
    'main!A3': 'quote " and \\ backslash',
    'main!A4': '"[not a record]"',
    'main!A5': '😀 emoji and — dashes',
  };
  const r = parse(serialise(nasty, {}));
  for (const [k, v] of Object.entries(nasty)) t(`round trip ${JSON.stringify(v)}`, r.nodes[k], v);
  t('a newline inside a value does not become two records',
    Object.keys(r.nodes).length, 5);
}

/* ---- preserve unknown ----
 * A document saved by a newer build, opened and re-saved by an older one,
 * must not quietly lose what the older one could not render. */
{
  const future = [
    `${MAGIC}/9`,
    '{"name":"From the future"}',
    '["main!A1","hello"]',
    '["main!A2","world",{"style":{"bold":true}}]',
    '{"section":"comments","body":"a record shape we do not know"}',
    '@blob:image/png;chart-thumbnail',
    '["deck:s1/title","Later"]',
  ].join('\n');

  const r = parse(future);
  t('reads what it understands', r.nodes['main!A1'], 'hello');
  t('and the later record too', r.nodes['deck:s1/title'], 'Later');
  t('keeps what it does not', r.unknown.length, 2);
  t('warns about the newer version', /newer version/.test(r.warnings[0] || ''), true);

  const rewritten = serialise(r.nodes, r.header, r.unknown);
  t('the unknown section comes back',
    rewritten.includes('{"section":"comments","body":"a record shape we do not know"}'), true);
  t('the unknown blob comes back',
    rewritten.includes('@blob:image/png;chart-thumbnail'), true);
  t('and it still parses', parse(rewritten).nodes['main!A2'].m.style.bold, true);
}

/* ---- nothing in the format can execute ---- */
{
  const hostile = [
    `${MAGIC}/1`,
    '{"name":"x"}',
    '["main!A1","<script>alert(1)</script>"]',
    '["main!A2","=SUM(1,2)"]',
  ].join('\n');
  const r = parse(hostile);
  // it is text, and it stays text — there is no element, handler or include
  // in the grammar for it to become
  t('a script tag is just a string', r.nodes['main!A1'], '<script>alert(1)</script>');
  const doc = createDocument();
  doc.loadJSON(r.nodes);
  t('and the document treats it as text', toText(doc.value('main!A1')), '<script>alert(1)</script>');
  t('while a formula is still a formula', toText(doc.value('main!A2')), '3');
}

/* ---- refusing what is not ours ---- */
{
  let threw = false;
  try { parse('PK this is a zip'); } catch { threw = true; }
  t('an .xlsx is refused, not half-read', threw, true);
  t('sniffing works', looksLikeGrain(text), true);
  t('and does not false-positive', looksLikeGrain('{"cells":{}}'), false);
}

/* ---- determinism: the same document is the same bytes ---- */
{
  const a = serialise(DOC, { name: 'Q3' });
  const shuffled = Object.fromEntries(Object.entries(DOC).reverse());
  const b = serialise(shuffled, { name: 'Q3' });
  t('key order does not change the file', a === b, true);
}

/* ---- an empty node is no node ---- */
t('cleared cells are not written',
  serialise({ 'main!A1': '', 'main!A2': 'x' }, {}).includes('main!A1'), false);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fails.length) { for (const x of fails) console.log('  x ' + x + '\n'); process.exit(1); }
console.log('  all green\n');
