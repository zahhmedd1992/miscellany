/* PDF object syntax, from ISO 32000-1 §7.2–7.3. Byte-oriented on purpose:
 * PDF is not text. A string object can hold arbitrary bytes, a "line" can
 * end three different ways, and names smuggle bytes in as #xx — decode any
 * of it as UTF-8 first and you corrupt what you later write back.
 *
 * Values come out as: number | boolean | null | {name} | {str: Uint8Array}
 * | Array | {dict: Map} | {ref: [num, gen]} | {stream: {dict, rawStart,
 * rawEnd}}. Streams carry OFFSETS, not bytes — the writer's whole promise
 * is to hand back original bytes, so the reader records where they live.
 */

const WS = new Uint8Array(256);
for (const b of [0, 9, 10, 12, 13, 32]) WS[b] = 1;
const DELIM = new Uint8Array(256);
for (const b of [0x28, 0x29, 0x3C, 0x3E, 0x5B, 0x5D, 0x7B, 0x7D, 0x2F, 0x25]) DELIM[b] = 1;

export class Lexer {
  /** @param {Uint8Array} buf @param {number} pos */
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }

  skipWs() {
    const b = this.buf;
    while (this.pos < b.length) {
      if (WS[b[this.pos]]) { this.pos++; continue; }
      if (b[this.pos] === 0x25) {               // % comment to end of line
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
        continue;
      }
      break;
    }
  }

  /** Bare keyword / number token text (never called at a delimiter). */
  regular() {
    const start = this.pos, b = this.buf;
    while (this.pos < b.length && !WS[b[this.pos]] && !DELIM[b[this.pos]]) this.pos++;
    let s = '';
    for (let i = start; i < this.pos; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  name() {                                       // caller consumed '/'
    const b = this.buf;
    let s = '';
    while (this.pos < b.length && !WS[b[this.pos]] && !DELIM[b[this.pos]]) {
      let c = b[this.pos++];
      if (c === 0x23 && this.pos + 1 < b.length) {   // #xx
        const hex = String.fromCharCode(b[this.pos], b[this.pos + 1]);
        const v = parseInt(hex, 16);
        if (!Number.isNaN(v)) { c = v; this.pos += 2; }
      }
      s += String.fromCharCode(c);
    }
    return { name: s };
  }

  literalString() {                              // caller consumed '('
    const b = this.buf, out = [];
    let depth = 1;
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x5C) {                          // backslash
        const e = b[this.pos++];
        if (e === 0x6E) out.push(10);
        else if (e === 0x72) out.push(13);
        else if (e === 0x74) out.push(9);
        else if (e === 0x62) out.push(8);
        else if (e === 0x66) out.push(12);
        else if (e === 0x28 || e === 0x29 || e === 0x5C) out.push(e);
        else if (e >= 0x30 && e <= 0x37) {       // \ooo, up to 3 digits
          let v = e - 0x30;
          for (let k = 0; k < 2; k++) {
            const d = b[this.pos];
            if (d >= 0x30 && d <= 0x37) { v = v * 8 + (d - 0x30); this.pos++; } else break;
          }
          out.push(v & 0xFF);
        } else if (e === 13) { if (b[this.pos] === 10) this.pos++; } // line continuation
        else if (e === 10) { /* line continuation */ }
        else out.push(e);                        // unknown escape: byte stands
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29) { if (--depth === 0) break; }
      out.push(c);
    }
    return { str: Uint8Array.from(out) };
  }

  hexString() {                                  // caller consumed '<'
    const b = this.buf, out = [];
    let hi = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3E) break;
      let v = -1;
      if (c >= 0x30 && c <= 0x39) v = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) v = c - 55;
      else if (c >= 0x61 && c <= 0x66) v = c - 87;
      else continue;                             // whitespace inside is legal
      if (hi < 0) hi = v;
      else { out.push(hi * 16 + v); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);              // odd digit: low nibble 0
    return { str: Uint8Array.from(out) };
  }

  /** One object. `resolveLen` maps a /Length ref to a number (streams). */
  value(resolveLen = null) {
    this.skipWs();
    const b = this.buf, c = b[this.pos];

    if (c === 0x2F) { this.pos++; return this.name(); }
    if (c === 0x28) { this.pos++; return this.literalString(); }
    if (c === 0x5B) {                            // array
      this.pos++;
      const arr = [];
      for (;;) {
        this.skipWs();
        if (b[this.pos] === 0x5D) { this.pos++; return arr; }
        if (this.pos >= b.length) throw new Error('unterminated array');
        arr.push(this.value(resolveLen));
      }
    }
    if (c === 0x3C) {
      if (b[this.pos + 1] === 0x3C) {            // dict
        this.pos += 2;
        const dict = new Map();
        for (;;) {
          this.skipWs();
          if (b[this.pos] === 0x3E && b[this.pos + 1] === 0x3E) { this.pos += 2; break; }
          if (b[this.pos] !== 0x2F) throw new Error('dict key is not a name at ' + this.pos);
          this.pos++;
          const key = this.name().name;
          dict.set(key, this.value(resolveLen));
        }
        // stream?
        const save = this.pos;
        this.skipWs();
        if (String.fromCharCode(b[this.pos], b[this.pos + 1], b[this.pos + 2], b[this.pos + 3], b[this.pos + 4], b[this.pos + 5]) === 'stream') {
          this.pos += 6;
          if (b[this.pos] === 13) this.pos++;    // CR of CRLF
          if (b[this.pos] === 10) this.pos++;    // LF (required)
          let len = dict.get('Length');
          if (len && len.ref) {
            if (!resolveLen) throw new Error('indirect /Length with no resolver');
            len = resolveLen(len.ref[0], len.ref[1]);
          }
          if (typeof len !== 'number') throw new Error('stream without numeric /Length');
          const rawStart = this.pos, rawEnd = rawStart + len;
          this.pos = rawEnd;
          this.skipWs();
          if (this.match('endstream')) { /* good */ }
          // A wrong /Length is a damaged file; v1 reads well-formed files and
          // says so when it cannot. (No silent resync that might "work".)
          return { stream: { dict, rawStart, rawEnd } };
        }
        this.pos = save;
        return { dict };
      }
      this.pos++;
      return this.hexString();
    }

    const tok = this.regular();
    if (tok === '') throw new Error('lex: nothing at ' + this.pos);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      // possible "N G R" reference
      const save = this.pos;
      if (/^\d+$/.test(tok)) {
        this.skipWs();
        const t2start = this.pos;
        const tok2 = this.regular();
        if (/^\d+$/.test(tok2)) {
          this.skipWs();
          const tok3 = this.regular();
          if (tok3 === 'R') return { ref: [parseInt(tok, 10), parseInt(tok2, 10)] };
        }
        this.pos = save;
        void t2start;
      }
      return parseFloat(tok);
    }
    return { keyword: tok };                     // obj / endobj / xref / …
  }

  match(word) {
    this.skipWs();
    for (let i = 0; i < word.length; i++) {
      if (this.buf[this.pos + i] !== word.charCodeAt(i)) return false;
    }
    this.pos += word.length;
    return true;
  }
}

export const isName = (v, n) => v && typeof v === 'object' && v.name === n;
export const asDict = (v) => v && v.dict ? v.dict : v && v.stream ? v.stream.dict : null;
