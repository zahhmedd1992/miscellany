/* Doc, standing on its own.
 *
 * The third application, and the third time this bootstrap has been about
 * thirty lines. The shell is real: the title bar, the toolbar, the command
 * palette, the keyboard map, undo, autosave and the status bar are already
 * there and are not Doc's to build.
 *
 * A document written here is the same kind of document a workbook is, so a
 * report saved from Sheet + Doc opens in this window with its live figures
 * still live.
 */

import { createDocument } from './core/document.js';
import { Shell } from './core/shell.js';
import { DocApp } from './apps/doc/app.js';
/* Sheet comes along because a live figure needs somewhere to read from. A
 * word processor whose headline feature points at cells, on a page with no
 * cells, is a demonstration of nothing. */
import { SheetApp } from './apps/sheet/app.js';
import { setPara, bodyId, FIRST_KEY, keyBetween, FIELD_CHAR } from './apps/doc/model.js';

const doc = createDocument();
const shell = new Shell(doc, {
  name: 'Miscellany · Doc',
  // compose.html already owns 'miscellany.doc.v1' for the whole-platform
  // document; a second page writing the same key would silently overwrite it.
  storageKey: 'miscellany.doc.standalone.v1',
  grant: ['fs'],
});

shell.app(DocApp).app(SheetApp).mount(document.getElementById('root'), ['doc']);

if (!shell.load()) firstRun(doc);

shell.refresh();
shell.surface.focus();

window.miscellany = { doc, shell, get view() { return shell.surfaces.get('doc').view; } };

/* A first document that demonstrates the thing that makes this one different,
 * rather than describing it: the number in the sentence is a formula.
 *
 * Two rules this function obeys, both learned the hard way:
 *
 *   Run lengths are DERIVED from the strings, never typed. A hand-counted
 *   "Two thirds is " as 15 instead of 14 puts every run one character out,
 *   so the field lands on the space after it and the sentence reads
 *   "is  66.7%of the whole". Nothing throws; it just looks like a typo.
 *
 *   Every character here is one the built-in PDF fonts can print. A demo that
 *   uses a glyph outside WinAnsiEncoding is a demo of the one limitation the
 *   product has.
 */
function firstRun(d) {
  let key = FIRST_KEY;
  const put = (text, p, runs) => {
    const id = bodyId(key);
    setPara(d, id, text, runs || [{ n: text.length }], p || {});
    key = keyBetween(key, null);
    return id;
  };

  /** A sentence built from pieces, where a piece may be a live field. */
  const sentence = (parts, p) => {
    const id = bodyId(key);
    let text = '';
    const runs = [];
    let n = 0;
    for (const part of parts) {
      if (typeof part === 'string') {
        text += part;
        runs.push({ n: part.length });
      } else {
        const fid = `${id}/f${++n}`;
        d.set(fid, part.formula);
        d.setMeta(fid, { field: { fmt: part.fmt || null } });
        text += FIELD_CHAR;
        runs.push({ n: 1, field: fid });
      }
    }
    setPara(d, id, text, runs, p || {});
    key = keyBetween(key, null);
    return id;
  };

  put('An untitled document', { style: 'title' });
  put('Everything here is a paragraph in a node graph, which is why the ' +
      'number in the next line can be a formula instead of a number.',
      { style: 'body', align: 'justify' });

  sentence([
    'Two thirds is ',
    { formula: '=ROUND(2/3*100,1)', fmt: '0.0"%"' },
    ' of the whole — and that figure is computed, not typed. Put a ' +
    'spreadsheet beside this document and it will read from that instead.',
  ], { style: 'body' });

  put('Try this', { style: 'h2' });
  put('Type. Press Ctrl+B. Press Ctrl+K and search for any command.',
      { style: 'body', list: 'bullet' });
  put('Insert a Live figure to put a formula inside a sentence.',
      { style: 'body', list: 'bullet' });
  put('Press PDF to write a real PDF — it breaks its lines exactly where ' +
      'this screen breaks them, because both used the same measurements.',
      { style: 'body', list: 'bullet' });
}
