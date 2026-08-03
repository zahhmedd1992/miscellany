/* Grain — formula lexer, parser and evaluator.
 *
 * Written against the OOXML formula grammar rather than adapted from an
 * existing engine. The reason is not purity: every engine encodes hundreds
 * of small semantic decisions (what does SUM do with text? does "" equal
 * blank? when does a comparison coerce?) and adopting one means inheriting
 * all of them without ever making them. Those decisions ARE the product.
 *
 * Where we deliberately depart from Excel, the code says so.
 */

import { Decimal } from './decimal.js';
import { V, ERR, BLANK, isErr, toNum, toText, toBool, compare } from './value.js';

/* =========================================================================
 * LEXER
 * ====================================================================== */

const T = { NUM:1, STR:2, REF:3, NAME:4, OP:5, LP:6, RP:7, COMMA:8, EOF:9, ERR:10, BOOL:11 };

/* The '!' is REQUIRED when a sheet name is present. With it optional, the
 * sheet group happily matches part of the column: `AA255` backtracks to
 * sheet="A", cell A255 — so every two-letter column reference without a sheet
 * qualifier silently reads from a sheet that does not exist. That single
 * character was worth ~28,000 wrong cells in one corpus workbook. */
const REF_RE = /^(?:(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_.]*))!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})(?![A-Za-z0-9_(])/;
const ERR_RE = /^#(?:DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|CIRC!)/;
/* A deleted range leaves `Sheet1!#REF!` or `'My Sheet'!#REF!` behind. That is
 * an error VALUE, not a malformed reference — reporting #NAME? for it would
 * blame the formula for the file's history. */
const SHEET_ERR_RE = /^(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!#(?:REF!|NAME\?|VALUE!|DIV\/0!|NUM!|N\/A)/;

export function lex(src) {
  const out = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    // string literal — "" is an escaped quote
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { s += '"'; j += 2; continue; }
          break;
        }
        s += src[j++];
      }
      if (j >= n) throw new Error('unterminated string');
      out.push({ t: T.STR, v: s });
      i = j + 1;
      continue;
    }

    // error literal
    const em = ERR_RE.exec(src.slice(i));
    if (em) { out.push({ t: T.ERR, v: em[0] }); i += em[0].length; continue; }

    // number
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      out.push({ t: T.NUM, v: Decimal.fromString(m[0]) });
      i += m[0].length;
      continue;
    }

    // reference (must be tried before NAME — B4 is a ref, BIN is a name)
    if (/[A-Za-z_'$]/.test(c)) {
      const rest = src.slice(i);
      const sm = SHEET_ERR_RE.exec(rest);
      if (sm) {
        out.push({ t: T.ERR, v: sm[0].slice(sm[0].indexOf('!') + 1) });
        i += sm[0].length;
        continue;
      }
      const rm = REF_RE.exec(rest);
      if (rm) {
        out.push({
          t: T.REF,
          v: { sheet: rm[1] || rm[2] || null, col: colToIndex(rm[3]), row: parseInt(rm[4], 10) - 1, text: rm[0] },
        });
        i += rm[0].length;
        continue;
      }
      const nm = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
      if (nm) {
        let up = nm[0].toUpperCase();
        // Excel writes functions newer than the file's format version with an
        // `_xlfn.` prefix, so a modern workbook stores CONCAT as _xlfn.CONCAT.
        // Treating that as an unknown name makes every one of them #NAME? —
        // 3,420 cells in one corpus workbook. The prefix is a compatibility
        // marker, not part of the function's identity.
        if (up.startsWith('_XLFN.')) up = up.slice(6);
        if (up.startsWith('_XLWS.')) up = up.slice(6);
        if (up === 'TRUE' || up === 'FALSE') out.push({ t: T.BOOL, v: up === 'TRUE' });
        else out.push({ t: T.NAME, v: up });
        i += nm[0].length;
        continue;
      }
    }

    // operators
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') { out.push({ t: T.OP, v: two }); i += 2; continue; }
    if ('+-*/^&=<>:%'.includes(c)) { out.push({ t: T.OP, v: c }); i++; continue; }
    if (c === '(') { out.push({ t: T.LP }); i++; continue; }
    if (c === ')') { out.push({ t: T.RP }); i++; continue; }
    if (c === ',' || c === ';') { out.push({ t: T.COMMA }); i++; continue; }

    throw new Error(`unexpected character '${c}' at ${i}`);
  }

  out.push({ t: T.EOF });
  return out;
}

export function colToIndex(s) {
  let n = 0;
  const u = s.toUpperCase();
  for (let i = 0; i < u.length; i++) n = n * 26 + (u.charCodeAt(i) - 64);
  return n - 1;
}

export function indexToCol(n) {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/* =========================================================================
 * PARSER  (precedence climbing)
 * ====================================================================== */

const BIN_PREC = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2,
  '+': 3, '-': 3,
  '*': 4, '/': 4,
  '^': 5,
  ':': 8,
};
const RIGHT_ASSOC = new Set(['^']);

export function parse(src, ctx = {}) {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t) => { const k = next(); if (k.t !== t) throw new Error('unexpected token'); return k; };

  function parseExpr(minPrec = 0) {
    let left = parseUnary();
    for (;;) {
      const tk = peek();
      if (tk.t !== T.OP) break;
      const prec = BIN_PREC[tk.v];
      if (prec === undefined || prec < minPrec) break;
      next();
      const nextMin = RIGHT_ASSOC.has(tk.v) ? prec : prec + 1;
      const right = parseExpr(nextMin);
      left = tk.v === ':'
        ? { t: 'range', a: left, b: right }
        : { t: 'bin', op: tk.v, l: left, r: right };
    }
    return left;
  }

  function parseUnary() {
    const tk = peek();
    if (tk.t === T.OP && (tk.v === '-' || tk.v === '+')) {
      next();
      // Unary binds tighter than * but looser than ^, matching Excel:
      // -2^2 is 4 in Excel (unary first). We follow, and note it.
      return { t: 'un', op: tk.v, x: parseUnary() };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let x = parsePrimary();
    for (;;) {
      const tk = peek();
      if (tk.t === T.OP && tk.v === '%') { next(); x = { t: 'pct', x }; continue; }
      break;
    }
    return x;
  }

  function parsePrimary() {
    const tk = next();
    switch (tk.t) {
      case T.NUM:  return { t: 'num', v: tk.v };
      case T.STR:  return { t: 'str', v: tk.v };
      case T.BOOL: return { t: 'bool', v: tk.v };
      case T.ERR:  return { t: 'err', v: tk.v };
      case T.REF:  return { t: 'ref', sheet: tk.v.sheet, col: tk.v.col, row: tk.v.row };
      case T.LP: { const e = parseExpr(0); expect(T.RP); return e; }
      case T.NAME: {
        if (peek().t === T.LP) {
          next();
          const args = [];
          if (peek().t !== T.RP) {
            for (;;) {
              args.push(parseExpr(0));
              if (peek().t === T.COMMA) { next(); continue; }
              break;
            }
          }
          expect(T.RP);
          return { t: 'call', name: tk.v, args };
        }
        return { t: 'name', v: tk.v };
      }
    }
    throw new Error('unexpected token in primary');
  }

  const ast = parseExpr(0);
  if (peek().t !== T.EOF) throw new Error('trailing input');
  return ast;
}

/* =========================================================================
 * EVALUATOR
 * ====================================================================== */

import { FUNCTIONS } from './functions.js';

/**
 * @param ast   parsed formula
 * @param api   { value(id), expand(ref, ctx) }
 * @param ctx   { sheet } — the sheet a bare reference belongs to
 */
export function evaluate(ast, api, ctx = {}) {
  return ev(ast, api, ctx);
}

function ev(a, api, ctx) {
  switch (a.t) {
    case 'num':  return V.num(a.v);
    case 'str':  return V.text(a.v);
    case 'bool': return V.bool(a.v);
    case 'err':  return V.err(a.v);

    case 'ref': {
      const ids = api.expand(a, ctx);
      if (!ids.length) return V.err(ERR.REF);
      return api.value(ids[0]);
    }

    case 'range':
      // A bare range in a scalar position is an error. Functions that accept
      // ranges receive them unevaluated (see evalArg).
      return V.err(ERR.VALUE);

    case 'name':
      return V.err(ERR.NAME);

    case 'pct': {
      const x = ev(a.x, api, ctx);
      if (isErr(x)) return x;
      const d = toNum(x);
      if (d.k === 'error') return d;
      return V.num(d.div(new Decimal(100n, 0)));
    }

    case 'un': {
      const x = ev(a.x, api, ctx);
      if (isErr(x)) return x;
      const d = toNum(x);
      if (d.k === 'error') return d;
      return V.num(a.op === '-' ? d.neg() : d);
    }

    case 'bin': return evalBin(a, api, ctx);

    case 'call': {
      const fn = FUNCTIONS[a.name];
      if (!fn) return V.err(ERR.NAME);
      if (fn.lazy) return fn.call({ args: a.args, ev: (n) => ev(n, api, ctx), api, ctx });
      const args = [];
      for (const argAst of a.args) {
        const r = evalArg(argAst, api, ctx);
        if (r.error) return r.error;
        args.push(r);
      }
      return fn.call({ args, api, ctx });
    }
  }
  return V.err(ERR.VALUE);
}

/* An argument is either a scalar Value or a materialised list of Values.
 * Range-taking functions (SUM, COUNT…) want the list; scalar functions
 * take .scalar. Keeping both on one object avoids a second traversal. */
function evalArg(a, api, ctx) {
  if (a.t === 'range') {
    // expand() returns ids in row-major order and attaches .shape ({rows,cols}).
    // Shape matters for VLOOKUP/INDEX, which address a range in 2-D.
    const ids = api.expand(a, ctx);
    if (!ids.length) return { error: V.err(ERR.REF) };
    const vals = ids.map((id) => api.value(id));
    return { isRange: true, values: vals, ids, shape: ids.shape, scalar: vals[0] ?? BLANK };
  }
  const v = ev(a, api, ctx);
  if (isErr(v)) return { error: v };
  return { isRange: false, values: [v], scalar: v };
}

function evalBin(a, api, ctx) {
  const op = a.op;
  const L = ev(a.l, api, ctx);
  if (isErr(L)) return L;
  const R = ev(a.r, api, ctx);
  if (isErr(R)) return R;

  if (op === '&') return V.text(toText(L) + toText(R));

  if ('=<>'.includes(op[0]) && BIN_PREC[op] === 1) {
    const c = compare(L, R);
    if (c && c.k === 'error') return c;
    switch (op) {
      case '=':  return V.bool(c === 0);
      case '<>': return V.bool(c !== 0);
      case '<':  return V.bool(c < 0);
      case '>':  return V.bool(c > 0);
      case '<=': return V.bool(c <= 0);
      case '>=': return V.bool(c >= 0);
    }
  }

  const x = toNum(L); if (x.k === 'error') return x;
  const y = toNum(R); if (y.k === 'error') return y;

  switch (op) {
    case '+': return V.num(x.add(y));
    case '-': return V.num(x.sub(y));
    case '*': return V.num(x.mul(y));
    case '/': {
      const q = x.div(y);
      return q === null ? V.err(ERR.DIV0) : V.num(q);
    }
    case '^': {
      const e = y.toNumber();
      if (Number.isInteger(e) && Math.abs(e) <= 1000) {
        if (x.isZero() && e < 0) return V.err(ERR.DIV0);
        return V.num(x.pow(e));
      }
      // Fractional exponents have no exact decimal answer. Fall back to
      // float and be honest that this one operation is inexact.
      const r = Math.pow(x.toNumber(), e);
      if (!Number.isFinite(r)) return V.err(ERR.NUM);
      return V.num(Decimal.fromNumber(r));
    }
  }
  return V.err(ERR.VALUE);
}
