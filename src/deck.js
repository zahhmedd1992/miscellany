/* Deck, standing on its own.
 *
 * This file is the entire bootstrap for a second application. It is short
 * because the shell is real: undo, the command palette, the keyboard map, the
 * toolbar, autosave and the status bar are already there and are not Deck's
 * to build.
 *
 * A deck opened here is the same kind of document a workbook is, so a slide
 * saved from Sheet + Deck opens in this window with its formulas still live.
 */

import { createDocument } from './core/document.js';
import { Shell } from './core/shell.js';
import { DeckApp } from './apps/deck/app.js';
import { defineObject, objId, OBJECT } from './apps/deck/deck.js';

const doc = createDocument();
const shell = new Shell(doc, { name: 'Miscellany · Deck', storageKey: 'miscellany.deck.v1' });

shell.app(DeckApp).mount(document.getElementById('root'), ['deck']);

// Restore the last deck, or start one worth looking at rather than a blank
// rectangle and a shrug.
if (!shell.load()) {
  defineObject(doc, objId(0, 'title'),
    OBJECT.text(80, 240, 1120, 110, { size: 64, bold: true }), 'Untitled deck');
  defineObject(doc, objId(0, 'sub'),
    OBJECT.text(80, 360, 1120, 60, { size: 26, color: '#6C6356' }),
    'Double-click to edit. A text box may hold a formula.');
}
shell.refresh();
shell.surface.focus();

window.miscellany = { doc, shell };
