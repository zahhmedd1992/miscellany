/* Cross-reference machinery, ISO 32000-1 §7.5. This is where a PDF's whole
 * shape is decided, and where the three generations of the format meet:
 *
 *   - classic tables ("xref" + 20-byte lines + a trailer dict), 1993–
 *   - cross-reference STREAMS (/Type /XRef, binary rows described by /W,
 *     usually Flate with a PNG predictor), 1.5+
 *   - HYBRID files that carry both, pointing at each other with /XRefStm,
 *     so that pre-1.5 readers see one document and modern readers another.
 *
 * Incremental updates chain through /Prev, newest first. The rule that keeps
 * all of this correct is single: walking newest → oldest, the FIRST in-use
 * entry seen for an object number wins, and a FREE entry is recorded as
 * freedom rather than as a claim — a hybrid file's classic table routinely
 * marks free the very objects its /XRefStm defines.
 */

import { Lexer } from './lex.js';

/** zlib-wrapped deflate, the platform's own. PDF names it FlateDecode. */
export async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/** PNG predictors (§7.4.4.4): each row starts with a filter byte. */
export function unpredict(data, predictor, columns) {
  if (!predictor || predictor < 10) return data;
  const row = columns, stride = row + 1;
  const rows = Math.floor(data.length / stride);
  const out = new Uint8Array(rows * row);
  let prev = new Uint8Array(row);
  for (let r = 0; r < rows; r++) {
    const f = data[r * stride];
    const src = data.subarray(r * stride + 1, r * stride + 1 + row);
    const dst = out.subarray(r * row, r * row + row);
    for (let i = 0; i < row; i++) {
      const a = i > 0 ? dst[i - 1] : 0, b = prev[i], c = i > 0 ? prev[i - 1] : 0;
      let x = src[i];
      if (f === 1) x = (x + a) & 0xFF;
      else if (f === 2) x = (x + b) & 0xFF;
      else if (f === 3) x = (x + ((a + b) >> 1)) & 0xFF;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        x = (x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xFF;
      }
      dst[i] = x;
    }
    prev = dst;
  }
  return out;
}

/** Decode one stream object's bytes: Flate (+predictor) or raw. */
export async function decodeStream(buf, stream) {
  const dict = stream.dict;
  let data = buf.subarray(stream.rawStart, stream.rawEnd);
  let filters = dict.get('Filter');
  if (!filters) return data;
  filters = Array.isArray(filters) ? filters : [filters];
  let parms = dict.get('DecodeParms') || dict.get('DP') || null;
  parms = Array.isArray(parms) ? parms : [parms];
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i], p = parms[i] && parms[i].dict ? parms[i].dict : null;
    if (f && f.name === 'FlateDecode') {
      data = await inflate(data);
      if (p) data = unpredict(data, num(p.get('Predictor')), num(p.get('Columns')) || 1);
    } else if (f && f.name === 'ASCIIHexDecode') {
      const out = [];
      let hi = -1;
      for (const c of data) {
        let v = -1;
        if (c >= 0x30 && c <= 0x39) v = c - 0x30;
        else if (c >= 0x41 && c <= 0x46) v = c - 55;
        else if (c >= 0x61 && c <= 0x66) v = c - 87;
        else if (c === 0x3E) break;
        else continue;
        if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
      }
      if (hi >= 0) out.push(hi * 16);
      data = Uint8Array.from(out);
    } else {
      throw new Error('unsupported filter ' + (f && f.name));
    }
  }
  return data;
}

const num = (v) => (typeof v === 'number' ? v : undefined);

/** Find the LAST startxref in the file tail. */
export function findStartXref(buf) {
  const tail = buf.subarray(Math.max(0, buf.length - 2048));
  const text = Array.from(tail, (b) => String.fromCharCode(b)).join('');
  const at = text.lastIndexOf('startxref');
  if (at < 0) throw new Error('no startxref');
  const m = text.slice(at + 9).match(/\s*(\d+)/);
  if (!m) throw new Error('startxref without offset');
  return parseInt(m[1], 10);
}

/**
 * Walk the whole chain. Returns:
 *   entries: Map<objNum, {type:1, offset, gen} | {type:2, stm, idx}>
 *   trailer: Map — merged newest-first (first-seen key wins)
 */
export async function readXref(buf) {
  const entries = new Map();
  const trailer = new Map();
  const seenOffsets = new Set();
  const claim = (n, e) => { if (!entries.has(n)) entries.set(n, e); };
  const mergeTrailer = (d) => { for (const [k, v] of d) if (!trailer.has(k)) trailer.set(k, v); };

  let offset = findStartXref(buf);
  const queue = [offset];
  while (queue.length) {
    offset = queue.shift();
    if (offset == null || seenOffsets.has(offset) || offset < 0 || offset >= buf.length) continue;
    seenOffsets.add(offset);

    const lex = new Lexer(buf, offset);
    if (lex.match('xref')) {
      /* ---- classic table ---- */
      for (;;) {
        lex.skipWs();
        if (lex.match('trailer')) break;
        const start = lex.value(); const count = lex.value();
        if (typeof start !== 'number' || typeof count !== 'number') throw new Error('bad xref subsection');
        lex.skipWs();
        for (let i = 0; i < count; i++) {
          const at = lex.pos;
          const line = Array.from(buf.subarray(at, at + 20), (b) => String.fromCharCode(b)).join('');
          const m = line.match(/^(\d{10}) (\d{5}) ([nf])/);
          if (!m) throw new Error('bad xref entry at ' + at);
          if (m[3] === 'n') claim(start + i, { type: 1, offset: parseInt(m[1], 10), gen: parseInt(m[2], 10) });
          lex.pos = at + (line[18] === '\r' || line[18] === '\n' || line[19] === '\r' || line[19] === '\n' ? 20 : 19);
          lex.skipWs();
        }
      }
      const t = lex.value();
      if (!t || !t.dict) throw new Error('classic xref without trailer dict');
      mergeTrailer(t.dict);
      const xs = t.dict.get('XRefStm');
      if (typeof xs === 'number') queue.push(xs);          // hybrid: consult next
      const prev = t.dict.get('Prev');
      if (typeof prev === 'number') queue.push(prev);
    } else {
      /* ---- xref STREAM: "N G obj << ... >> stream" ---- */
      const lex2 = new Lexer(buf, offset);
      const n1 = lex2.value(), n2 = lex2.value(), kw = lex2.value();
      if (typeof n1 !== 'number' || typeof n2 !== 'number' || !kw || kw.keyword !== 'obj') {
        throw new Error('startxref points at neither table nor stream (offset ' + offset + ')');
      }
      const obj = lex2.value();
      if (!obj || !obj.stream) throw new Error('xref stream object has no stream');
      const dict = obj.stream.dict;
      const data = await decodeStream(buf, obj.stream);
      const W = (dict.get('W') || []).map((x) => x);
      const size = dict.get('Size');
      let index = dict.get('Index');
      if (!index) index = [0, size];
      const w = W.length, rowLen = W.reduce((a, b) => a + b, 0);
      let p = 0;
      for (let s = 0; s < index.length; s += 2) {
        const start = index[s], count = index[s + 1];
        for (let i = 0; i < count; i++) {
          if (p + rowLen > data.length) throw new Error('xref stream truncated');
          const fields = [];
          for (let f = 0; f < w; f++) {
            let v = 0;
            for (let k = 0; k < W[f]; k++) v = v * 256 + data[p++];
            fields.push(v);
          }
          const type = W[0] === 0 ? 1 : fields[0];
          if (type === 1) claim(start + i, { type: 1, offset: fields[1], gen: fields[2] || 0 });
          else if (type === 2) claim(start + i, { type: 2, stm: fields[1], idx: fields[2] });
          /* type 0 = free: freedom, not a claim */
        }
      }
      mergeTrailer(dict);
      const prev = dict.get('Prev');
      if (typeof prev === 'number') queue.push(prev);
    }
  }
  return { entries, trailer };
}
