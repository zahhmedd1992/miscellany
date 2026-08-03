/* Grain — the Miscellany document format.
 *
 * WHY THIS EXISTS, since the codebase already writes a perfectly good .xlsx:
 *
 * Because .xlsx is not our document. It is Excel's answer to "what is a
 * file?", and its answer is "a workbook of worksheets". A deck cannot live in
 * it. Neither can a form, or whatever the fourth app turns out to be. Saving
 * a Sheet+Deck document as .xlsx would mean deciding, today, which parts of
 * the platform are allowed to be persisted — which is the same as deciding
 * which parts are allowed to exist.
 *
 * So the format is derived from what the platform IS, not from what one app
 * happened to need:
 *
 *   1. A document is a GRAPH OF NODES. Not cells. The graph has never known
 *      what a spreadsheet is, and neither does this file — `main!B4` and
 *      `deck:s1/kpi` are both just ids, and an app invented next year gets
 *      persistence for free the day it picks an id prefix.
 *
 *   2. INPUTS ONLY. Never computed values. A file that caches a result next
 *      to the formula that produced it can hold the two in disagreement, and
 *      that is the most corrosive bug a spreadsheet can carry. Opening a
 *      document recalculates it. The cost is a recalc on load; the benefit is
 *      that a Miscellany file cannot lie about its own arithmetic.
 *      (.xlsx does cache them, which is exactly why we can use real workbooks
 *      as a graded exam — see test/agreement.mjs. Useful in a corpus, wrong
 *      in our own format.)
 *
 *   3. ONE NODE PER LINE, so a document diffs. Real work lives in version
 *      control, and a format that serialises a 350,000-node document to a
 *      single line is a format that cannot be reviewed, merged, or blamed.
 *      It also means a reader can stream it instead of holding two copies.
 *
 *   4. PRESERVE UNKNOWN. Any line this version does not understand is kept
 *      verbatim and written back in place. The same discipline as the zip
 *      work: a document saved by a newer build, opened and re-saved by an
 *      older one, must not quietly lose what the older one could not render.
 *
 *   5. NOTHING EXECUTES. There is no script section, no macro, no external
 *      reference, no include. Opening a document cannot do anything — it can
 *      only describe values. "Secure" has to mean something at the format
 *      level or it means nothing at the app level.
 *
 * On JSON: each record is a JSON array, so string escaping is JSON's rules
 * rather than a quoting scheme invented here. That is a MECHANISM with a
 * provably correct answer and no opinion about what a document is. Every
 * opinion in this file — nodes not cells, inputs not values, line per node,
 * preserve unknown, nothing executes — is ours.
 */

export const MAGIC = 'miscellany';
export const VERSION = 1;
export const EXT = '.grain';
export const MIME = 'application/x-miscellany-grain';

/**
 * Write a document.
 *
 * @param nodes    from Graph.toJSON(): { id: raw } or { id: {r, m} }
 * @param header   document metadata (name, and anything an app adds)
 * @param unknown  lines from a previous read that this build did not
 *                 understand; re-emitted verbatim, in place. See parse().
 */
export function serialise(nodes, header = {}, unknown = []) {
  const out = [`${MAGIC}/${VERSION}`, JSON.stringify(header)];

  // Sorted, so the same document always produces the same bytes and a diff
  // shows what changed rather than what moved.
  for (const id of Object.keys(nodes).sort()) {
    const v = nodes[id];
    const raw = typeof v === 'string' ? v : (v && v.r) || '';
    const meta = typeof v === 'string' ? null : (v && v.m) || null;
    if (raw === '' && !meta) continue;          // an empty node is no node
    out.push(JSON.stringify(meta ? [id, raw, meta] : [id, raw]));
  }

  for (const line of unknown) out.push(line);
  return out.join('\n') + '\n';
}

/**
 * Read a document.
 *
 * @returns { header, nodes, unknown, version, warnings }
 *          `nodes` is Graph.loadJSON's shape. `unknown` is every line this
 *          build could not interpret, to hand back to serialise().
 */
export function parse(text) {
  const warnings = [];
  const lines = String(text).split(/\r?\n/);

  const m = /^([a-z]+)\/(\d+)$/.exec((lines[0] || '').trim());
  if (!m || m[1] !== MAGIC) {
    throw new Error('not a Miscellany document');
  }
  const version = parseInt(m[2], 10);
  if (version > VERSION) {
    // Readable anyway: records we understand are read, records we do not are
    // preserved. Say so rather than refusing a file the user can see is fine.
    warnings.push(`written by a newer version (${version}); unknown records preserved`);
  }

  let header = {};
  let start = 1;
  if (lines[1] && lines[1].startsWith('{')) {
    try { header = JSON.parse(lines[1]); start = 2; }
    catch { warnings.push('header is not readable; ignored'); start = 2; }
  }

  const nodes = {};
  const unknown = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    let rec = null;
    if (line[0] === '[') { try { rec = JSON.parse(line); } catch { rec = null; } }
    // A record is [id, raw] or [id, raw, meta]. Anything else is from a build
    // that knows something we do not, and is kept exactly as it arrived.
    if (!Array.isArray(rec) || typeof rec[0] !== 'string' || typeof rec[1] !== 'string') {
      unknown.push(line);
      continue;
    }
    nodes[rec[0]] = rec.length > 2 && rec[2] ? { r: rec[1], m: rec[2] } : rec[1];
  }

  return { header, nodes, unknown, version, warnings };
}

/** Does this look like one of ours? Cheap enough to run on a dropped file. */
export function looksLikeGrain(text) {
  return new RegExp(`^${MAGIC}/\\d+\\s*$`, 'm').test(String(text).slice(0, 64).split('\n')[0] || '');
}
