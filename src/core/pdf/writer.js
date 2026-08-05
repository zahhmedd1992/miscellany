/* The writer. One operation model expresses every tool: a new page list,
 * each entry naming (source document, page index, extra rotation). Merge is
 * pages from two sources; split, extract, delete, reorder are subsets and
 * permutations of one; rotate is a delta.
 *
 * The preservation contract, precisely stated:
 *   - single source: every untouched object keeps its NUMBER and its exact
 *     ORIGINAL BYTES (top-level objects as verbatim slices, object-stream
 *     members as their verbatim member bytes). Only page dicts (new /Parent,
 *     materialised inheritance, rotation) and the new catalog + page tree
 *     are written fresh.
 *   - merge: the FIRST document keeps the single-source guarantee wholesale.
 *     Later documents are renumbered, which forces their dicts to be
 *     re-serialised (references live in dicts) — but stream DATA, which is
 *     where fonts, images and content actually live, is still copied
 *     byte-for-byte.
 *
 * What is deliberately dropped, and why, is part of the contract too:
 *   - the old page tree and catalog (replaced),
 *   - /Outlines, /Names, structure trees (they reference pages that may be
 *     gone; a dangling outline is worse than none — v2 material),
 *   - /AcroForm on MULTI-source merges (field-name collisions make merged
 *     forms lie; single-source operations keep the form, pruned to fields
 *     whose widgets still sit on a surviving page).
 */

const enc = new TextEncoder();

/* PDF forbids exponent notation; JS produces it eagerly. */
export function fmtNum(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  let s = n.toFixed(8);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function escapeName(name) {
  let out = '/';
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c <= 0x20 || c > 0x7E || '()<>[]{}/%#'.includes(ch)) {
      out += '#' + c.toString(16).padStart(2, '0');
    } else out += ch;
  }
  return out;
}

const hex = (bytes) => {
  let s = '<';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s + '>';
};

/**
 * Serialise a parsed value. `renum(ref) -> [num, gen]` maps references;
 * `sliceRaw(stream) -> Uint8Array` hands back original stream data.
 */
export function serialize(v, renum, sliceRaw, out) {
  if (v === null) { out.push('null'); return; }
  if (v === true || v === false) { out.push(String(v)); return; }
  if (typeof v === 'number') { out.push(fmtNum(v)); return; }
  if (Array.isArray(v)) {
    out.push('[');
    v.forEach((x, i) => { if (i) out.push(' '); serialize(x, renum, sliceRaw, out); });
    out.push(']');
    return;
  }
  if (v.name !== undefined) { out.push(escapeName(v.name)); return; }
  if (v.str !== undefined) { out.push(hex(v.str)); return; }
  if (v.ref !== undefined) { const [n, g] = renum(v.ref); out.push(`${n} ${g} R`); return; }
  if (v.dict !== undefined) {
    out.push('<<');
    for (const [k, val] of v.dict) {
      out.push(' ' + escapeName(k) + ' ');
      serialize(val, renum, sliceRaw, out);
    }
    out.push(' >>');
    return;
  }
  if (v.stream !== undefined) {
    const data = sliceRaw(v.stream);
    const d = new Map(v.stream.dict);
    d.set('Length', data.length);              // was possibly an indirect ref
    serialize({ dict: d }, renum, sliceRaw, out);
    out.push('\nstream\n');
    out.push(data);
    out.push('\nendstream');
    return;
  }
  throw new Error('cannot serialise ' + JSON.stringify(v).slice(0, 60));
}

/* Keys never walked out of a kept page dict: /Parent drags the whole OLD
 * page tree in (and with it every deleted page); /B drags article threads. */
const PAGE_SKIP = new Set(['Parent', 'B']);

/**
 * @param {Array<{doc: PdfDoc, page: number, addRotate?: number}>} pageList
 * @param {{stripMeta?: boolean}} opts
 * @returns {Uint8Array}
 */
export function buildPdf(pageList, opts = {}) {
  const docs = [...new Set(pageList.map((p) => p.doc))];

  /* ---- object number spaces ---- */
  const sizes = docs.map((d) => {
    let max = 0;
    for (const n of d.entries.keys()) max = Math.max(max, n);
    return max + 1;
  });
  const bases = [0];
  for (let i = 1; i < docs.length; i++) bases.push(bases[i - 1] + sizes[i - 1]);
  let nextNew = bases[docs.length - 1] + sizes[docs.length - 1];

  const renumFor = (di) => (ref) => [bases[di] + ref[0], di === 0 ? ref[1] : 0];

  /* ---- reachability closure per document ---- */
  const keepPages = docs.map(() => new Set());
  for (const p of pageList) keepPages[docs.indexOf(p.doc)].add(p.page);

  const needed = docs.map(() => new Set());   // object numbers per doc
  const walkValue = (di, v, skipKeys = null) => {
    const stack = [[v, skipKeys]];
    while (stack.length) {
      const [cur, skip] = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (cur.ref) {
        const n = cur.ref[0];
        if (!needed[di].has(n)) {
          needed[di].add(n);
          stack.push([docs[di].get(n), null]);
        }
        continue;
      }
      if (Array.isArray(cur)) { for (const x of cur) stack.push([x, null]); continue; }
      if (cur.dict) {
        for (const [k, val] of cur.dict) if (!skip || !skip.has(k)) stack.push([val, null]);
        continue;
      }
      if (cur.stream) { stack.push([{ dict: cur.stream.dict }, skip]); continue; }
    }
  };

  for (const p of pageList) {
    const di = docs.indexOf(p.doc);
    walkValue(di, { dict: p.doc.pages[p.page].dict }, PAGE_SKIP);
  }

  /* ---- catalog extras ---- */
  const catalogExtra = new Map();
  const d0 = docs[0], cat0 = d0.resolve({ ref: d0.rootRef });
  if (cat0 && cat0.dict) {
    if (cat0.dict.has('OCProperties')) {
      catalogExtra.set('OCProperties', cat0.dict.get('OCProperties'));
      walkValue(0, cat0.dict.get('OCProperties'));
    }
    if (!opts.stripMeta && cat0.dict.has('Metadata')) {
      catalogExtra.set('Metadata', cat0.dict.get('Metadata'));
      walkValue(0, cat0.dict.get('Metadata'));
    }
    if (docs.length === 1 && cat0.dict.has('AcroForm')) {
      const af = d0.resolve(cat0.dict.get('AcroForm'));
      if (af && af.dict) {
        const keptPageNums = new Set([...keepPages[0]].map((i) => d0.pages[i].ref[0]));
        const fieldOnKeptPage = (fRef, depth = 0) => {
          if (depth > 32) return false;
          const f = d0.resolve(fRef);
          if (!f || !f.dict) return false;
          const P = f.dict.get('P');
          if (P && P.ref && keptPageNums.has(P.ref[0])) return true;
          const kids = d0.resolve(f.dict.get('Kids'));
          if (Array.isArray(kids)) return kids.some((k) => k && k.ref && fieldOnKeptPage(k, depth + 1));
          return false;
        };
        const fields = d0.resolve(af.dict.get('Fields'));
        const keptFields = Array.isArray(fields) ? fields.filter((f) => f && f.ref && fieldOnKeptPage(f)) : [];
        if (keptFields.length) {
          const afDict = new Map(af.dict);
          afDict.set('Fields', keptFields);
          catalogExtra.set('AcroForm', { dict: afDict });
          walkValue(0, { dict: afDict });
        }
      }
    }
  }

  let infoRefOut = null;
  if (!opts.stripMeta) {
    const info = d0.trailer.get('Info');
    if (info && info.ref) { walkValue(0, info); infoRefOut = renumFor(0)(info.ref); }
  }
  if (opts.stripMeta) catalogExtra.delete('Metadata');

  /* ---- assemble ---- */
  const chunks = [];
  let where = 0;
  const push = (x) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    chunks.push(b); where += b.length;
  };
  const offsets = new Map();   // outNum -> {offset, gen}

  const maxVer = docs.map((d) => d.version || '1.4').sort().at(-1);
  push(`%PDF-${maxVer}\n`);
  // the conventional high-bit comment that tells transfer tools this is binary
  push(Uint8Array.from([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

  const catalogNum = nextNew++;
  const pagesNum = nextNew++;
  const pageOutNums = pageList.map(() => nextNew++);

  const emitRebuilt = (outNum, gen, value, di, extra = null) => {
    offsets.set(outNum, { offset: where, gen });
    push(`${outNum} ${gen} obj\n`);
    const out = [];
    serialize(value, renumFor(di), (s) => docs[di].buf.subarray(s.rawStart, s.rawEnd), out);
    for (const piece of out) push(piece);
    push('\nendobj\n');
    void extra;
  };

  /* preserved objects */
  for (let di = 0; di < docs.length; di++) {
    const doc = docs[di];
    for (const n of [...needed[di]].sort((a, b) => a - b)) {
      const e = doc.entries.get(n);
      if (!e) continue;                            // ref to a free object: legal, stays dangling
      const outNum = bases[di] + n;
      const holder = doc.cache.get(n) || (doc.get(n), doc.cache.get(n));
      if (!holder) continue;
      if (di === 0 && holder.span) {
        offsets.set(outNum, { offset: where, gen: e.gen || 0 });
        push(doc.buf.subarray(holder.span.start, holder.span.end));
        push('\n');
      } else if (di === 0 && holder.objStm) {
        offsets.set(outNum, { offset: where, gen: 0 });
        push(`${outNum} 0 obj\n`);
        push(doc.objStms.get(holder.objStm.stm).data.subarray(holder.objStm.start, holder.objStm.end));
        push('\nendobj\n');
      } else {
        emitRebuilt(outNum, 0, holder.value, di);
      }
    }
  }

  /* pages, rebuilt */
  pageList.forEach((p, i) => {
    const di = docs.indexOf(p.doc);
    const page = p.doc.pages[p.page];
    const d = new Map();
    for (const [k, v] of page.dict) if (!PAGE_SKIP.has(k)) d.set(k, v);
    d.set('Type', { name: 'Page' });
    d.set('Parent', { ref: [pagesNum, 0] });
    if (!d.has('MediaBox')) d.set('MediaBox', page.mediaBox);
    if (!d.has('Resources')) {
      const res = page.dict.get('Resources') ?? null;
      if (!res) {
        // inherited: find it again the way the page walk did
        const inh = pInherited(p.doc, page);
        if (inh.Resources) { d.set('Resources', inh.Resources); walkValue(di, inh.Resources); }
      }
    }
    const baseRot = page.rotate || 0;
    const rot = ((baseRot + (p.addRotate || 0)) % 360 + 360) % 360;
    if (rot) d.set('Rotate', rot); else d.delete('Rotate');
    // the serialize pass below needs any newly-materialised refs in the file:
    // MediaBox is numbers; Resources handled above.
    emitRebuilt(pageOutNums[i], 0, { dict: d }, di);
  });

  /* NOTE: materialised Resources may have added to needed[] AFTER the
   * preserved-object pass. Emit any stragglers now, same rules. */
  for (let di = 0; di < docs.length; di++) {
    const doc = docs[di];
    for (const n of [...needed[di]].sort((a, b) => a - b)) {
      const outNum = bases[di] + n;
      if (offsets.has(outNum)) continue;
      const e = doc.entries.get(n);
      if (!e) continue;
      const holder = doc.cache.get(n) || (doc.get(n), doc.cache.get(n));
      if (!holder) continue;
      if (di === 0 && holder.span) {
        offsets.set(outNum, { offset: where, gen: e.gen || 0 });
        push(doc.buf.subarray(holder.span.start, holder.span.end));
        push('\n');
      } else if (di === 0 && holder.objStm) {
        offsets.set(outNum, { offset: where, gen: 0 });
        push(`${outNum} 0 obj\n`);
        push(doc.objStms.get(holder.objStm.stm).data.subarray(holder.objStm.start, holder.objStm.end));
        push('\nendobj\n');
      } else {
        emitRebuilt(outNum, 0, holder.value, di);
      }
    }
  }

  /* pages root + catalog */
  {
    const kids = pageOutNums.map((n) => ({ ref: [n, 0] }));
    const d = new Map([
      ['Type', { name: 'Pages' }],
      ['Kids', kids],
      ['Count', pageList.length],
    ]);
    emitRebuilt(pagesNum, 0, { dict: d }, 0);
    const c = new Map([['Type', { name: 'Catalog' }], ['Pages', { ref: [pagesNum, 0] }]]);
    for (const [k, v] of catalogExtra) c.set(k, v);
    emitRebuilt(catalogNum, 0, { dict: c }, 0);
  }

  /* classic xref, subsectioned over the numbers actually present */
  const xrefAt = where;
  const nums = [...offsets.keys()].sort((a, b) => a - b);
  const sections = [];
  let run = null;
  for (const n of nums) {
    if (run && n === run.start + run.rows.length) run.rows.push(n);
    else { run = { start: n, rows: [n] }; sections.push(run); }
  }
  let xref = 'xref\n0 1\n0000000000 65535 f \n';
  for (const s of sections) {
    xref += `${s.start} ${s.rows.length}\n`;
    for (const n of s.rows) {
      const { offset, gen } = offsets.get(n);
      xref += `${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} n \n`;
    }
  }
  push(xref);
  const trailer = [`trailer\n<< /Size ${nums.at(-1) + 1} /Root ${catalogNum} 0 R`];
  if (infoRefOut) trailer.push(` /Info ${infoRefOut[0]} ${infoRefOut[1]} R`);
  trailer.push(` >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  push(trailer.join(''));

  const total = new Uint8Array(where);
  let at = 0;
  for (const c of chunks) { total.set(c, at); at += c.length; }
  return total;
}

/** Re-derive a page's inherited attribute by walking up from the root. */
function pInherited(doc, page) {
  // pages[] was built with inheritance applied for MediaBox/CropBox/Rotate;
  // Resources was carried in the same walk but not stored — rewalk cheaply.
  const out = {};
  const walk = (ref, inh) => {
    const node = doc.resolve({ ref });
    const dict = node && node.dict;
    if (!dict) return false;
    const next = { ...inh };
    if (dict.has('Resources')) next.Resources = dict.get('Resources');
    if (ref[0] === page.ref[0] && ref[1] === page.ref[1]) { Object.assign(out, next); return true; }
    const kids = doc.resolve(dict.get('Kids'));
    if (Array.isArray(kids)) for (const k of kids) if (k && k.ref && walk(k.ref, next)) return true;
    return false;
  };
  walk(doc.pagesRootRef, {});
  return out;
}
