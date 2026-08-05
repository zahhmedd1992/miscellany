/* A parsed PDF document: xref walked, object streams unpacked, page tree
 * flattened — with the byte span of every top-level object and of every
 * object-stream member RECORDED, because the writer's promise is the same
 * one Sheet makes for .xlsx: what we did not touch comes back exactly.
 *
 * open() is async (Flate runs through DecompressionStream); everything
 * after it is synchronous — all object streams are decoded up front, so a
 * later get() never needs to await.
 */

import { Lexer } from './lex.js';
import { readXref, decodeStream } from './xref.js';

export class PdfDoc {
  /** @param {Uint8Array} buf */
  constructor(buf) {
    this.buf = buf;
    this.cache = new Map();      // objNum -> {value, span?, objStm?}
    this.objStms = new Map();    // stmObjNum -> {data, members: Map<num,{start,end}>}
  }

  static async open(buf) {
    const doc = new PdfDoc(buf);
    const m = /^%PDF-(\d\.\d)/.exec(String.fromCharCode(...buf.subarray(0, 16)));
    doc.version = m ? m[1] : null;

    const { entries, trailer } = await readXref(buf);
    doc.entries = entries;
    doc.trailer = trailer;
    doc.encrypted = trailer.has('Encrypt');
    /* In an encrypted file every stream body is ciphertext — including the
     * object streams the next loop would inflate. Decide encryption FIRST,
     * or the refusal surfaces as a misleading decompression error. */
    if (doc.encrypted) return doc;

    /* Decode every object stream any live entry points into. After this,
     * object access is synchronous. */
    const stms = new Set();
    for (const e of entries.values()) if (e.type === 2) stms.add(e.stm);
    for (const sn of stms) {
      const holder = doc._parseAt(sn);
      if (!holder || !holder.value || !holder.value.stream) throw new Error('ObjStm ' + sn + ' is not a stream');
      const dict = holder.value.stream.dict;
      const data = await decodeStream(buf, holder.value.stream);
      const n = dict.get('N'), first = dict.get('First');
      const lex = new Lexer(data, 0);
      const heads = [];
      for (let i = 0; i < n; i++) heads.push([lex.value(), lex.value()]);
      const members = new Map();
      for (let i = 0; i < n; i++) {
        const [objNum, off] = heads[i];
        const start = first + off;
        const end = i + 1 < n ? first + heads[i + 1][1] : data.length;
        members.set(objNum, { start, end });
      }
      doc.objStms.set(sn, { data, members });
    }

    if (!doc.encrypted) doc._readPages();
    return doc;
  }

  /** Parse the top-level object at entry `num`'s offset. */
  _parseAt(num) {
    const e = this.entries.get(num);
    if (!e || e.type !== 1) return null;
    const lex = new Lexer(this.buf, e.offset);
    const spanStart = e.offset;
    const n1 = lex.value(), n2 = lex.value(), kw = lex.value();
    if (typeof n1 !== 'number' || typeof n2 !== 'number' || !kw || kw.keyword !== 'obj') {
      throw new Error(`object ${num}: offset ${e.offset} does not hold "N G obj"`);
    }
    if (n1 !== num) throw new Error(`object ${num}: offset holds object ${n1} instead`);
    const value = lex.value((ln) => {
      const lv = this.get(ln);
      if (typeof lv !== 'number') throw new Error(`/Length ${ln} is not a number`);
      return lv;
    });
    lex.match('endobj');
    const holder = { value, span: { start: spanStart, end: lex.pos } };
    this.cache.set(num, holder);
    return holder;
  }

  /** The object numbered `num`, parsed. Sync — objstms were pre-decoded. */
  get(num) {
    if (this.cache.has(num)) return this.cache.get(num).value;
    const e = this.entries.get(num);
    if (!e) return null;
    if (e.type === 1) {
      const holder = this._parseAt(num);
      return holder ? holder.value : null;
    }
    const stm = this.objStms.get(e.stm);
    if (!stm) throw new Error(`object ${num}: object stream ${e.stm} missing`);
    const mem = stm.members.get(num);
    if (!mem) throw new Error(`object ${num}: not in object stream ${e.stm}`);
    const lex = new Lexer(stm.data, mem.start);
    const value = lex.value();
    this.cache.set(num, { value, objStm: { stm: e.stm, start: mem.start, end: mem.end } });
    return value;
  }

  /** Follow refs until a direct value. */
  resolve(v) {
    let guard = 0;
    while (v && v.ref) {
      if (++guard > 64) throw new Error('reference loop');
      v = this.get(v.ref[0]);
    }
    return v;
  }

  _readPages() {
    const rootRef = this.trailer.get('Root');
    if (!rootRef || !rootRef.ref) throw new Error('trailer has no /Root');
    this.rootRef = rootRef.ref;
    const catalog = this.resolve(rootRef);
    const cdict = catalog && catalog.dict;
    if (!cdict) throw new Error('/Root is not a dictionary');
    const pagesRef = cdict.get('Pages');
    if (!pagesRef || !pagesRef.ref) throw new Error('catalog has no /Pages');
    this.pagesRootRef = pagesRef.ref;

    const pages = [];
    const visited = new Set();
    const walk = (ref, inherited) => {
      const key = ref.join('/');
      if (visited.has(key)) throw new Error('page tree cycle at ' + key);
      visited.add(key);
      const node = this.resolve({ ref });
      const dict = node && node.dict;
      if (!dict) throw new Error('page tree node ' + key + ' is not a dict');
      const inh = { ...inherited };
      for (const k of ['MediaBox', 'CropBox', 'Rotate', 'Resources']) {
        if (dict.has(k)) inh[k] = dict.get(k);
      }
      const type = dict.get('Type');
      const isLeaf = (type && type.name === 'Page') || !dict.has('Kids');
      if (isLeaf) {
        const mb = this._numArray(inh.MediaBox);
        if (!mb || mb.length !== 4) throw new Error('page ' + key + ' has no MediaBox');
        pages.push({
          ref,
          dict,
          mediaBox: mb,
          cropBox: this._numArray(inh.CropBox) || mb,
          rotate: (this.resolve(inh.Rotate) ?? 0) || 0,
        });
        return;
      }
      const kids = this.resolve(dict.get('Kids'));
      if (!Array.isArray(kids)) throw new Error('/Kids of ' + key + ' is not an array');
      for (const kid of kids) {
        if (!kid || !kid.ref) throw new Error('kid of ' + key + ' is not a reference');
        walk(kid.ref, inh);
      }
    };
    walk(this.pagesRootRef, {});
    this.pages = pages;
  }

  _numArray(v) {
    v = this.resolve(v);
    if (!Array.isArray(v)) return null;
    return v.map((x) => this.resolve(x)).filter((x) => typeof x === 'number');
  }

  /** Metadata worth showing (and stripping): the Info dict, decoded. */
  info() {
    const ref = this.trailer.get('Info');
    if (!ref) return {};
    const d = this.resolve(ref);
    if (!d || !d.dict) return {};
    const out = {};
    for (const [k, v] of d.dict) {
      const r = this.resolve(v);
      if (r && r.str) out[k] = pdfText(r.str);
    }
    return out;
  }
}

/** PDF text strings: UTF-16 with BOM, or PDFDocEncoding (≈latin-1). */
export function pdfText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] * 256 + bytes[i + 1]);
    return s;
  }
  return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
}
