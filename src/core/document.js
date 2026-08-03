/* Grain — a document.
 *
 * The graph plus the three answers every app has to give it: how to parse a
 * formula, how to evaluate one, and what node ids a reference names. Sheet
 * and Deck give the SAME three answers, because they are the same document —
 * which is the entire architectural claim, in one function.
 *
 * This lived inside apps/sheet until there was a second app. That is the
 * honest moment to extract it: an abstraction that survives two real
 * consumers is real, one designed in advance is a guess.
 */

import { Graph } from './graph.js';
import { parse, evaluate } from './formula.js';
import { expand, sheetOfId, SHEET } from './a1.js';

/**
 * A document every Miscellany app shares.
 *
 * There is no `kind` parameter and no app name here on purpose. A workbook
 * with a slide deck in it is one document, not two that talk to each other.
 */
export function createDocument() {
  return new Graph({
    parse: (src, ctx) => parse(src, ctx),
    // The context comes from the CELL BEING EVALUATED, not a constant —
    // pinning it to one sheet makes every bare reference on every other sheet
    // resolve to that sheet.
    evaluate: (ast, api) => evaluate(ast, api, api.ctx || { sheet: SHEET }),
    expand,
    contextOf: (id) => ({ sheet: sheetOfId(id) }),
  });
}
