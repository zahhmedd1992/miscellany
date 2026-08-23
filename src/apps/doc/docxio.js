/* Doc <-> .docx.
 *
 * Opening turns a Word document into ordinary Grain nodes, and keeps a side
 * table saying where each paragraph CAME FROM. Saving uses that table to
 * splice the original XML rather than to regenerate it.
 *
 * The side table lives here and not in the document on purpose. Source spans
 * are facts about one file on disk, not about the document — a .grain saved
 * from this session must not carry byte offsets into a .docx that the person
 * receiving it has never seen.
 */

import {
  openDocx, readBody, surveyParts, isEncryptedPackage,
} from '../../core/ooxml/docx.js';
import {
  saveDocx, paragraphEdits, paragraphXml, wordPrefix,
} from '../../core/ooxml/docxedit.js';
import { elements, firstElement } from '../../core/ooxml/xml.js';
import {
  bodyId, keyBetween, keyOf, blockIds, paraOf, setPara, setPageSetup, packRuns,
  isLive, FIRST_KEY,
} from './model.js';

/** Everything about the .docx currently open, or null. */
export class DocxBinding {
  constructor(wd, body, survey) {
    this.wd = wd;
    this.body = body;
    this.survey = survey;
    this.prefix = wordPrefix(wd.xml);
    this.origin = new Map();       // node id -> the block it was read from
    this.order = [];               // node ids, in document order
    this.numIds = readNumIds(wd);
  }
}

/** Existing list definitions we can point a new list at. */
function readNumIds(wd) {
  const out = { bullet: null, number: null };
  const n = wd.numbering;
  if (!n || !n.present) return out;
  for (const [numId, abs] of n.numIdToAbstract) {
    const levels = n.abstract.get(abs);
    const fmt = levels ? levels.get('0') : null;
    if (fmt === 'bullet' && !out.bullet) out.bullet = numId;
    else if (fmt && fmt !== 'bullet' && !out.number) out.number = numId;
  }
  return out;
}

/**
 * Read a .docx into the document.
 * @returns {Promise<DocxBinding>}
 */
export async function loadDocx(doc, bytes) {
  if (isEncryptedPackage(bytes)) {
    throw new Error('This document is password-protected. Miscellany cannot open encrypted files.');
  }
  const wd = await openDocx(bytes);
  const body = readBody(wd);
  const survey = await surveyParts(wd);
  const b = new DocxBinding(wd, body, survey);

  const nodes = {};
  let key = FIRST_KEY;
  const walk = (blocks) => {
    for (const blk of blocks) {
      const id = bodyId(key);
      key = keyBetween(key, null);
      if (blk.kind === 'table') {
        /* A table is stored as its cells' paragraphs plus a block record, so
         * the cells are ordinary nodes and may hold formulas like any other
         * paragraph. Writing a table's STRUCTURE back is not supported yet;
         * editing the text inside one is. */
        nodes[id] = { r: '', m: { block: { kind: 'table', rows: blk.rows.length,
                                           colsN: (blk.rows[0] || []).length,
                                           cols: blk.cols, header: false } } };
        blk.rows.forEach((row, ri) => {
          row.forEach((cell, ci) => {
            const cid = `${id}/r${ri}c${ci}`;
            const first = (cell.blocks || [])[0];
            const text = (cell.blocks || []).map((x) => x.text || '').join('\n');
            nodes[cid] = { r: text, m: { para: {
              runs: first && (cell.blocks || []).length === 1
                ? stripRuns(first.runs) : [{ n: text.length }],
              p: { after: 0, before: 0, ...(first ? first.p : {}) },
            } } };
            if (first && (cell.blocks || []).length === 1) b.origin.set(cid, first);
          });
        });
        continue;
      }
      nodes[id] = { r: blk.text, m: { para: { runs: stripRuns(blk.runs), p: blk.p } } };
      b.origin.set(id, blk);
      b.order.push(id);
    }
  };
  walk(body.blocks);

  doc.loadJSON(nodes);
  if (body.section && (body.section.size || body.section.margin)) {
    setPageSetup(doc, {
      size: body.section.size || 'letter',
      landscape: !!body.section.landscape,
      ...(body.section.margin ? { margin: { top: 72, right: 72, bottom: 72, left: 72,
                                            ...body.section.margin } } : {}),
    });
  }
  return b;
}

/* The private fields a run carries from the file are kept OUT of the document:
 * they are offsets into a file, and a .grain is not that file. The binding
 * holds them instead, keyed by the paragraph. */
function stripRuns(runs) {
  return (runs || []).map((r) => {
    const { _rpr, _src, ...rest } = r;
    return rest;
  });
}

/** Has this paragraph changed since it was read? */
function changed(before, text, runs, props) {
  if (!before) return true;
  if (before.text !== text) return true;
  const a = before.runs || [], c = runs || [];
  if (a.length !== c.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = c[i];
    if (x.n !== y.n) return true;
    for (const k of ['b', 'i', 'u', 's', 'sz', 'f', 'c', 'hl', 'sup', 'sub']) {
      if ((x[k] ?? null) !== (y[k] ?? null)) return true;
    }
  }
  return propsChanged(before.p, props);
}

function propsChanged(a = {}, b = {}) {
  const keys = ['style', 'align', 'indentLeft', 'indentRight', 'indentFirst',
                'before', 'after', 'line', 'list', 'level', 'breakBefore', 'keepNext'];
  for (const k of keys) if ((a[k] ?? null) !== (b[k] ?? null)) return true;
  return false;
}

/**
 * Write the document back to .docx bytes.
 *
 * @returns {Promise<{bytes:Uint8Array, edits:number, notes:string[]}>}
 */
export async function saveToDocx(doc, binding) {
  const { wd, prefix: P } = binding;
  const edits = [];
  const notes = [];
  const ids = blockIds(doc);
  const seen = new Set();
  let anchor = null;               // the last origin paragraph we passed
  let pending = '';                // new paragraphs waiting for an anchor

  for (const id of ids) {
    const node = doc.node(id, true);
    if (node.meta && node.meta.block) {
      // a table or an inserted object: its structure is not written back yet
      if (!binding.origin.has(id)) notes.push('inserted tables and charts are not written into .docx yet');
      continue;
    }
    const p = paraOf(doc, id);
    const before = binding.origin.get(id);
    if (before) {
      seen.add(id);
      if (pending) {
        edits.push({ span: { start: before.span.start, end: before.span.start },
                     kind: 'replace', xml: pending });
        pending = '';
      }
      if (changed(before, p.text, p.runs, p.p)) {
        /* Normalise BEFORE writing. A run list that does not cover the text is
         * a bug wherever it came from, but the consequence here is silent and
         * expensive: the characters past the end of the last run are simply
         * not written, so a saved document loses the end of a sentence and
         * still opens perfectly. */
        const restored = restoreRuns(packRuns(p.runs, p.text.length), before.runs);
        edits.push(...paragraphEdits(before, { text: p.text, runs: restored, p: p.p }, P, {
          xml: wd.xml,
          propsChanged: propsChanged(before.p, p.p),
          numId: numIdFor(binding, p.p, notes),
        }));
      }
      anchor = before;
      continue;
    }
    // a paragraph that did not come from the file
    const xml = paragraphXml({ text: p.text, runs: p.runs, p: p.p }, P, null,
                             numIdFor(binding, p.p, notes));
    if (anchor) {
      edits.push({ span: { start: anchor.span.end, end: anchor.span.end },
                   kind: 'replace', xml });
    } else {
      pending += xml;
    }
  }

  /* Paragraphs that were deleted.
   *
   * `doc.nodes.has(id)` is the wrong question: Graph.set never removes a node
   * from the map, it only empties it. A deleted paragraph is one that is no
   * longer LIVE — the same test blockIds and the file format use — and asking
   * the other question meant a deletion was never written back to the .docx
   * at all. */
  for (const [id, blk] of binding.origin) {
    if (seen.has(id) || !blk.span) continue;
    if (isLive(doc.nodes.get(id))) continue;
    edits.push({ span: blk.span, kind: 'delete' });
  }

  if (pending) {
    notes.push('a paragraph added before the first one could not be placed');
  }

  const bytes = await saveDocx(wd, dedupe(edits));
  return { bytes, edits: edits.length, notes: [...new Set(notes)] };
}

/* Two edits at the same insertion point are legal and must keep their order;
 * two edits over the same span are a bug, and the splice refuses them. */
function dedupe(edits) {
  return edits.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
}

/** Put back the source spans the document does not carry. */
function restoreRuns(current, original) {
  const src = (original || []).map((r) => r._src).filter(Boolean);
  let i = 0;
  return (current || []).map((r) => {
    if (r._src) return r;
    // a run that still lines up with an original one keeps its origin
    const s = src[i];
    if (s) { i++; return { ...r, _src: s }; }
    return r;
  });
}

function numIdFor(binding, p, notes) {
  if (!p || !p.list) return null;
  const id = p.list === 'bullet' ? binding.numIds.bullet : binding.numIds.number;
  if (!id) {
    notes.push('this document has no list definitions, so new bullets are saved as plain paragraphs');
    return null;
  }
  return id;
}

/** A plain-English summary of what the file holds that Doc does not show. */
export function surveyNote(s) {
  const bits = [];
  if (s.headers) bits.push(`${s.headers} header${s.headers > 1 ? 's' : ''}`);
  if (s.footers) bits.push(`${s.footers} footer${s.footers > 1 ? 's' : ''}`);
  if (s.footnoteRefs) bits.push(`${s.footnoteRefs} footnote${s.footnoteRefs > 1 ? 's' : ''}`);
  if (s.comments) bits.push('comments');
  if (s.images) bits.push(`${s.images} image${s.images > 1 ? 's' : ''}`);
  if (s.charts) bits.push(`${s.charts} chart${s.charts > 1 ? 's' : ''}`);
  if (s.embedded) bits.push('embedded objects');
  return bits.length
    ? `kept but not shown: ${bits.join(' · ')}`
    : '';
}
