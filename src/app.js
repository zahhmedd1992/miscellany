/* Sheet — the entry point.
 *
 * This file was 1,339 lines. Everything that has left it is either in
 * apps/sheet/app.js, because it genuinely knows what a spreadsheet is, or in
 * core/shell.js, because it never did.
 *
 * `fs` is granted here rather than assumed: opening and saving a file on your
 * disk is a real capability, and the manifest is only worth anything if
 * somebody has to hand it over on purpose.
 */

import { createDocument } from './core/document.js';
import { Shell } from './core/shell.js';
import { SheetApp } from './apps/sheet/app.js';
import { DeckApp } from './apps/deck/app.js';

const doc = createDocument();
const shell = new Shell(doc, {
  name: 'Miscellany',
  storageKey: 'miscellany.sheet.v1',
  grant: ['fs'],
});

shell.app(SheetApp).app(DeckApp);
shell.mount(document.getElementById('root'), ['sheet']);

if (!shell.load()) {
  // A first-run sheet that demonstrates the engine rather than describing it.
  doc.loadJSON({
    'main!A1': 'Q3 Model',
    'main!A3': 'Month',    'main!B3': 'Revenue', 'main!C3': 'Cost',  'main!D3': 'Margin',
    'main!A4': 'July',     'main!B4': '128400',  'main!C4': '73100', 'main!D4': '=B4-C4',
    'main!A5': 'August',   'main!B5': '141250',  'main!C5': '78900', 'main!D5': '=B5-C5',
    'main!A6': 'September','main!B6': '155900',  'main!C6': '81400', 'main!D6': '=B6-C6',
    'main!A7': 'Total',    'main!B7': '=SUM(B4:B6)', 'main!C7': '=SUM(C4:C6)', 'main!D7': '=SUM(D4:D6)',
    'main!A9': 'Margin %', 'main!B9': '=ROUND(D7/B7*100,1)',
    'main!A10': 'Best month', 'main!B10': '=INDEX(A4:A6,MATCH(MAX(D4:D6),D4:D6,0))',
    'main!A12': '0.1 + 0.2',  'main!B12': '=0.1+0.2',
    'main!A13': 'Excel says', 'main!B13': "'0.3000000000000000444",
    'main!C13': '(binary floats)',
  });
}

shell.refresh();
shell.surface.focus();

// Exposed for console poking and for the eventual HTTP/MCP bridge.
window.miscellany = { doc, shell, get grid() { return shell.surfaces.get('sheet').grid; } };
