/* Grain — the function library.
 *
 * Each function's semantics are a decision, not an inheritance. The subtle
 * ones are commented with WHY, because those are exactly the places a
 * borrowed engine would have silently decided for us.
 *
 * Coverage: the ~95% surface. Stage 1 target is ~120; this is the spine.
 */

import { Decimal } from './decimal.js';
import { V, ERR, BLANK, isErr, isBlank, toNum, toText, toBool, compare } from './value.js';

const ZERO = () => Decimal.zero();
const ONE  = () => new Decimal(1n, 0);
const D    = (n) => new Decimal(BigInt(n), 0);

/* ---- argument helpers --------------------------------------------------
 *
 * Excel's rule, which we adopt deliberately: text and booleans inside a
 * RANGE are ignored by SUM/AVERAGE, but a text argument passed DIRECTLY is
 * coerced. =SUM(A1:A3) skips "hello"; =SUM("1",2) is 3. This looks
 * inconsistent until you see why: a range is data you pointed at, a literal
 * is something you typed on purpose.
 */

function numbersIn(args) {
  const out = [];
  for (const a of args) {
    if (a.isRange) {
      for (const v of a.values) {
        if (isErr(v)) return { error: v };
        if (v.k === 'number') out.push(v.d);
        // text, bool, blank in a range: skipped
      }
    } else {
      const v = a.scalar;
      if (isErr(v)) return { error: v };
      if (isBlank(v)) continue;
      const d = toNum(v);
      if (d.k === 'error') return { error: d };
      out.push(d);
    }
  }
  return { nums: out };
}

function allValues(args) {
  const out = [];
  for (const a of args) {
    if (a.isRange) out.push(...a.values);
    else out.push(a.scalar);
  }
  return out;
}

function firstNum(args, i = 0) {
  const a = args[i];
  if (!a) return { error: V.err(ERR.VALUE) };
  const v = a.scalar;
  if (isErr(v)) return { error: v };
  const d = toNum(v);
  if (d.k === 'error') return { error: d };
  return { d };
}

const num = (d) => V.num(d);
const fnNum = (f) => ({ call: ({ args }) => { const r = firstNum(args); return r.error || f(r.d); } });

/* Float bridge for the transcendentals, which have no exact decimal answer.
 * Isolated here so it is obvious exactly which functions are inexact. */
const viaFloat = (f) => fnNum((d) => {
  const r = f(d.toNumber());
  if (!Number.isFinite(r)) return V.err(ERR.NUM);
  return num(Decimal.fromNumber(r));
});

/* ---- criteria matching (for SUMIF / COUNTIF) ---------------------------
 * Supports ">10", "<=3", "<>x", "apple", and * / ? wildcards. */
function makeMatcher(critVal) {
  const raw = toText(critVal);
  const m = /^(>=|<=|<>|>|<|=)?(.*)$/.exec(raw);
  const op = m[1] || '=';
  const rhsRaw = m[2];
  const rhsNum = Decimal.fromString(rhsRaw);
  const rhs = rhsNum !== null ? V.num(rhsNum) : V.text(rhsRaw);

  const hasWild = /[*?]/.test(rhsRaw);
  let re = null;
  if (hasWild && (op === '=' || op === '<>')) {
    const esc = rhsRaw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    re = new RegExp('^' + esc + '$', 'i');
  }

  return (v) => {
    if (re) { const hit = re.test(toText(v)); return op === '<>' ? !hit : hit; }
    if (isBlank(v) && rhsRaw === '') return op === '=' || op === '>=' || op === '<=';
    const c = compare(v, rhs);
    if (c && c.k === 'error') return false;
    switch (op) {
      case '=':  return c === 0;
      case '<>': return c !== 0;
      case '>':  return c > 0;
      case '<':  return c < 0;
      case '>=': return c >= 0;
      case '<=': return c <= 0;
    }
    return false;
  };
}

/* ======================================================================= */

export const FUNCTIONS = {

  /* ---- math ---- */

  SUM: { call: ({ args }) => {
    const r = numbersIn(args);
    if (r.error) return r.error;
    return num(r.nums.reduce((a, b) => a.add(b), ZERO()));
  }},

  PRODUCT: { call: ({ args }) => {
    const r = numbersIn(args);
    if (r.error) return r.error;
    if (!r.nums.length) return num(ZERO());
    return num(r.nums.reduce((a, b) => a.mul(b), ONE()));
  }},

  ABS:  fnNum((d) => num(d.abs())),
  SIGN: fnNum((d) => num(D(d.sign))),
  INT:  fnNum((d) => {
    // INT floors toward negative infinity — NOT truncation. INT(-2.5) is -3.
    const t = d.trunc(0);
    return num(d.sign < 0 && !t.eq(d) ? t.sub(ONE()) : t);
  }),
  TRUNC: { call: ({ args }) => {
    const a = firstNum(args); if (a.error) return a.error;
    let places = 0;
    if (args[1]) { const b = firstNum(args, 1); if (b.error) return b.error; places = b.d.toNumber(); }
    return num(a.d.trunc(places));
  }},
  ROUND: { call: ({ args }) => {
    const a = firstNum(args); if (a.error) return a.error;
    let places = 0;
    if (args[1]) { const b = firstNum(args, 1); if (b.error) return b.error; places = b.d.toNumber(); }
    if (places >= 0) return num(a.d.round(places));
    const f = new Decimal(1n, 0).div(Decimal.from(10 ** -places));
    return num(a.d.mul(f).round(0).div(f));
  }},
  ROUNDDOWN: { call: ({ args }) => {
    const a = firstNum(args); if (a.error) return a.error;
    const b = args[1] ? firstNum(args, 1) : { d: ZERO() };
    if (b.error) return b.error;
    return num(a.d.trunc(b.d.toNumber()));
  }},
  ROUNDUP: { call: ({ args }) => {
    const a = firstNum(args); if (a.error) return a.error;
    const b = args[1] ? firstNum(args, 1) : { d: ZERO() };
    if (b.error) return b.error;
    const p = b.d.toNumber();
    const t = a.d.trunc(p);
    if (t.eq(a.d)) return num(t);
    const step = new Decimal(1n, Math.max(0, p));
    return num(a.d.sign < 0 ? t.sub(step) : t.add(step));
  }},
  MOD: { call: ({ args }) => {
    const a = firstNum(args); if (a.error) return a.error;
    const b = firstNum(args, 1); if (b.error) return b.error;
    if (b.d.isZero()) return V.err(ERR.DIV0);
    // Result takes the sign of the DIVISOR (Excel/Python), not the dividend.
    const q = a.d.div(b.d);
    const fl = q.trunc(0);
    const floor = q.sign < 0 && !fl.eq(q) ? fl.sub(ONE()) : fl;
    return num(a.d.sub(b.d.mul(floor)));
  }},
  POWER: { call: ({ args }) => {
    const a = firstNum(args); if (a.error) return a.error;
    const b = firstNum(args, 1); if (b.error) return b.error;
    const e = b.d.toNumber();
    if (Number.isInteger(e) && Math.abs(e) <= 1000) {
      if (a.d.isZero() && e < 0) return V.err(ERR.DIV0);
      return num(a.d.pow(e));
    }
    const r = Math.pow(a.d.toNumber(), e);
    return Number.isFinite(r) ? num(Decimal.fromNumber(r)) : V.err(ERR.NUM);
  }},
  SQRT: fnNum((d) => {
    if (d.sign < 0) return V.err(ERR.NUM);
    const r = Math.sqrt(d.toNumber());
    return num(Decimal.fromNumber(r));
  }),
  EXP:   viaFloat(Math.exp),
  LN:    viaFloat((x) => (x <= 0 ? NaN : Math.log(x))),
  LOG10: viaFloat((x) => (x <= 0 ? NaN : Math.log10(x))),
  LOG: { call: ({ args }) => {
    const a = firstNum(args); if (a.error) return a.error;
    let base = 10;
    if (args[1]) { const b = firstNum(args, 1); if (b.error) return b.error; base = b.d.toNumber(); }
    const x = a.d.toNumber();
    if (x <= 0 || base <= 0 || base === 1) return V.err(ERR.NUM);
    return num(Decimal.fromNumber(Math.log(x) / Math.log(base)));
  }},
  PI: { call: () => num(Decimal.fromString('3.14159265358979323846')) },
  SIN: viaFloat(Math.sin), COS: viaFloat(Math.cos), TAN: viaFloat(Math.tan),

  /* ---- statistics ---- */

  AVERAGE: { call: ({ args }) => {
    const r = numbersIn(args);
    if (r.error) return r.error;
    if (!r.nums.length) return V.err(ERR.DIV0);
    const s = r.nums.reduce((a, b) => a.add(b), ZERO());
    return num(s.div(D(r.nums.length)));
  }},
  COUNT: { call: ({ args }) => {
    const r = numbersIn(args);
    if (r.error) return r.error;
    return num(D(r.nums.length));
  }},
  COUNTA: { call: ({ args }) => num(D(allValues(args).filter((v) => !isBlank(v)).length)) },
  COUNTBLANK: { call: ({ args }) => num(D(allValues(args).filter(isBlank).length)) },
  MIN: { call: ({ args }) => {
    const r = numbersIn(args); if (r.error) return r.error;
    if (!r.nums.length) return num(ZERO());
    return num(r.nums.reduce((a, b) => (a.cmp(b) <= 0 ? a : b)));
  }},
  MAX: { call: ({ args }) => {
    const r = numbersIn(args); if (r.error) return r.error;
    if (!r.nums.length) return num(ZERO());
    return num(r.nums.reduce((a, b) => (a.cmp(b) >= 0 ? a : b)));
  }},
  MEDIAN: { call: ({ args }) => {
    const r = numbersIn(args); if (r.error) return r.error;
    if (!r.nums.length) return V.err(ERR.NUM);
    const s = [...r.nums].sort((a, b) => a.cmp(b));
    const m = s.length >> 1;
    return num(s.length % 2 ? s[m] : s[m - 1].add(s[m]).div(D(2)));
  }},
  STDEV: { call: ({ args }) => stdev(args, true) },
  'STDEV.S': { call: ({ args }) => stdev(args, true) },
  'STDEV.P': { call: ({ args }) => stdev(args, false) },
  VAR: { call: ({ args }) => variance(args, true) },

  SUMIF: { call: ({ args }) => {
    const range = args[0]; const crit = args[1];
    if (!range || !crit) return V.err(ERR.VALUE);
    const match = makeMatcher(crit.scalar);
    const src = range.isRange ? range.values : [range.scalar];
    const sumSrc = args[2] ? (args[2].isRange ? args[2].values : [args[2].scalar]) : src;
    let acc = ZERO();
    for (let i = 0; i < src.length; i++) {
      if (isErr(src[i])) return src[i];
      if (!match(src[i])) continue;
      const v = sumSrc[i];
      if (v && v.k === 'number') acc = acc.add(v.d);
    }
    return num(acc);
  }},
  COUNTIF: { call: ({ args }) => {
    const range = args[0]; const crit = args[1];
    if (!range || !crit) return V.err(ERR.VALUE);
    const match = makeMatcher(crit.scalar);
    const src = range.isRange ? range.values : [range.scalar];
    return num(D(src.filter(match).length));
  }},
  AVERAGEIF: { call: ({ args, api, ctx }) => {
    const s = FUNCTIONS.SUMIF.call({ args, api, ctx });
    if (isErr(s)) return s;
    const c = FUNCTIONS.COUNTIF.call({ args: args.slice(0, 2), api, ctx });
    if (isErr(c)) return c;
    if (c.d.isZero()) return V.err(ERR.DIV0);
    return num(s.d.div(c.d));
  }},

  /* ---- logical (lazy: the untaken branch must not be evaluated, or
   *      =IF(A1=0,"n/a",1/A1) would raise #DIV/0! for no reason) ---- */

  IF: { lazy: true, call: ({ args, ev }) => {
    if (args.length < 2) return V.err(ERR.VALUE);
    const c = ev(args[0]);
    if (isErr(c)) return c;
    const b = toBool(c);
    if (b && b.k === 'error') return b;
    if (b) return ev(args[1]);
    return args[2] ? ev(args[2]) : V.bool(false);
  }},
  IFERROR: { lazy: true, call: ({ args, ev }) => {
    if (args.length < 2) return V.err(ERR.VALUE);
    const v = ev(args[0]);
    return isErr(v) ? ev(args[1]) : v;
  }},
  IFS: { lazy: true, call: ({ args, ev }) => {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const c = ev(args[i]);
      if (isErr(c)) return c;
      const b = toBool(c);
      if (b && b.k === 'error') return b;
      if (b) return ev(args[i + 1]);
    }
    return V.err(ERR.NA);
  }},
  AND: { lazy: true, call: ({ args, ev }) => {
    for (const a of args) {
      const v = ev(a); if (isErr(v)) return v;
      const b = toBool(v); if (b && b.k === 'error') return b;
      if (!b) return V.bool(false);           // short-circuit
    }
    return V.bool(true);
  }},
  OR: { lazy: true, call: ({ args, ev }) => {
    for (const a of args) {
      const v = ev(a); if (isErr(v)) return v;
      const b = toBool(v); if (b && b.k === 'error') return b;
      if (b) return V.bool(true);
    }
    return V.bool(false);
  }},
  NOT: { call: ({ args }) => {
    const v = args[0] ? args[0].scalar : BLANK;
    if (isErr(v)) return v;
    const b = toBool(v);
    return b && b.k === 'error' ? b : V.bool(!b);
  }},
  TRUE:  { call: () => V.bool(true) },
  FALSE: { call: () => V.bool(false) },

  /* ---- text ---- */

  CONCAT:      { call: ({ args }) => V.text(allValues(args).map(toText).join('')) },
  CONCATENATE: { call: ({ args }) => V.text(allValues(args).map(toText).join('')) },
  TEXTJOIN: { call: ({ args }) => {
    const sep = toText(args[0].scalar);
    const skip = args[1] ? !!toBool(args[1].scalar) : true;
    const vals = allValues(args.slice(2));
    return V.text(vals.filter((v) => !(skip && isBlank(v))).map(toText).join(sep));
  }},
  LEN:   { call: ({ args }) => num(D(toText(args[0] ? args[0].scalar : BLANK).length)) },
  UPPER: { call: ({ args }) => V.text(toText(args[0].scalar).toUpperCase()) },
  LOWER: { call: ({ args }) => V.text(toText(args[0].scalar).toLowerCase()) },
  TRIM:  { call: ({ args }) => V.text(toText(args[0].scalar).replace(/\s+/g, ' ').trim()) },
  LEFT:  { call: ({ args }) => sub(args, 'left') },
  RIGHT: { call: ({ args }) => sub(args, 'right') },
  MID: { call: ({ args }) => {
    const s = toText(args[0].scalar);
    const a = firstNum(args, 1); if (a.error) return a.error;
    const b = firstNum(args, 2); if (b.error) return b.error;
    const start = a.d.toNumber(), len = b.d.toNumber();
    if (start < 1 || len < 0) return V.err(ERR.VALUE);
    return V.text(s.substr(start - 1, len));
  }},
  FIND: { call: ({ args }) => {
    // FIND is case-SENSITIVE; SEARCH is not. Preserving the distinction
    // because formulas in the wild rely on exactly this difference.
    const needle = toText(args[0].scalar), hay = toText(args[1].scalar);
    const from = args[2] ? firstNum(args, 2).d.toNumber() - 1 : 0;
    const i = hay.indexOf(needle, from);
    return i < 0 ? V.err(ERR.VALUE) : num(D(i + 1));
  }},
  SEARCH: { call: ({ args }) => {
    const needle = toText(args[0].scalar).toLowerCase();
    const hay = toText(args[1].scalar).toLowerCase();
    const from = args[2] ? firstNum(args, 2).d.toNumber() - 1 : 0;
    const i = hay.indexOf(needle, from);
    return i < 0 ? V.err(ERR.VALUE) : num(D(i + 1));
  }},
  SUBSTITUTE: { call: ({ args }) => {
    const s = toText(args[0].scalar), from = toText(args[1].scalar), to = toText(args[2].scalar);
    if (from === '') return V.text(s);
    if (args[3]) {
      const n = firstNum(args, 3); if (n.error) return n.error;
      let idx = -1, count = 0, target = n.d.toNumber();
      for (let i = 0; (i = s.indexOf(from, i)) !== -1; i += from.length) {
        if (++count === target) { idx = i; break; }
      }
      return V.text(idx < 0 ? s : s.slice(0, idx) + to + s.slice(idx + from.length));
    }
    return V.text(s.split(from).join(to));
  }},
  VALUE: { call: ({ args }) => {
    const d = Decimal.fromString(toText(args[0].scalar));
    return d === null ? V.err(ERR.VALUE) : num(d);
  }},

  /* ---- lookup ---- */

  VLOOKUP: { call: ({ args, api }) => {
    const key = args[0].scalar;
    const tbl = args[1];
    if (!tbl || !tbl.isRange || !tbl.shape) return V.err(ERR.REF);
    const colArg = firstNum(args, 2); if (colArg.error) return colArg.error;
    const col = colArg.d.toNumber();
    const { rows, cols } = tbl.shape;
    if (col < 1 || col > cols) return V.err(ERR.VALUE);
    const exact = args[3] ? !toBool(args[3].scalar) : false;
    for (let r = 0; r < rows; r++) {
      const probe = tbl.values[r * cols];
      const c = compare(probe, key);
      if (c && c.k === 'error') continue;
      if (c === 0) return tbl.values[r * cols + (col - 1)] ?? BLANK;
      if (!exact && c > 0 && r > 0) return tbl.values[(r - 1) * cols + (col - 1)] ?? BLANK;
    }
    if (!exact && rows > 0) return tbl.values[(rows - 1) * cols + (col - 1)] ?? BLANK;
    return V.err(ERR.NA);
  }},
  INDEX: { call: ({ args }) => {
    const src = args[0];
    if (!src || !src.isRange) return V.err(ERR.REF);
    const shape = src.shape || { rows: src.values.length, cols: 1 };
    const rArg = firstNum(args, 1); if (rArg.error) return rArg.error;
    const r = rArg.d.toNumber();
    const c = args[2] ? firstNum(args, 2).d.toNumber() : 1;
    if (r < 1 || r > shape.rows || c < 1 || c > shape.cols) return V.err(ERR.REF);
    return src.values[(r - 1) * shape.cols + (c - 1)] ?? BLANK;
  }},
  MATCH: { call: ({ args }) => {
    const key = args[0].scalar;
    const src = args[1];
    if (!src || !src.isRange) return V.err(ERR.REF);
    const type = args[2] ? firstNum(args, 2).d.toNumber() : 1;
    const vals = src.values;
    if (type === 0) {
      for (let i = 0; i < vals.length; i++) { const c = compare(vals[i], key); if (c === 0) return num(D(i + 1)); }
      return V.err(ERR.NA);
    }
    let best = -1;
    for (let i = 0; i < vals.length; i++) {
      const c = compare(vals[i], key);
      if (c && c.k === 'error') continue;
      if (type === 1 ? c <= 0 : c >= 0) best = i; else break;
    }
    return best < 0 ? V.err(ERR.NA) : num(D(best + 1));
  }},

  /* ---- information ---- */

  ISBLANK:  { call: ({ args }) => V.bool(isBlank(args[0] ? args[0].scalar : BLANK)) },
  ISERROR:  { call: ({ args }) => V.bool(isErr(args[0] ? args[0].scalar : BLANK)) },
  ISNUMBER: { call: ({ args }) => V.bool((args[0] ? args[0].scalar : BLANK).k === 'number') },
  ISTEXT:   { call: ({ args }) => V.bool((args[0] ? args[0].scalar : BLANK).k === 'text') },
  NA:       { call: () => V.err(ERR.NA) },

  /* ---- finance (the reason a spreadsheet exists) ---- */

  PMT: { call: ({ args }) => {
    const r = firstNum(args, 0); if (r.error) return r.error;
    const n = firstNum(args, 1); if (n.error) return n.error;
    const pv = firstNum(args, 2); if (pv.error) return pv.error;
    const fv = args[3] ? firstNum(args, 3).d.toNumber() : 0;
    const type = args[4] ? firstNum(args, 4).d.toNumber() : 0;
    const rate = r.d.toNumber(), nper = n.d.toNumber(), PV = pv.d.toNumber();
    if (nper === 0) return V.err(ERR.NUM);
    let pmt;
    if (rate === 0) pmt = -(PV + fv) / nper;
    else {
      const f = Math.pow(1 + rate, nper);
      pmt = -(PV * f + fv) / (((1 + rate * type) * (f - 1)) / rate);
    }
    return num(Decimal.fromNumber(pmt));
  }},
  NPV: { call: ({ args }) => {
    const r = firstNum(args, 0); if (r.error) return r.error;
    const rate = r.d;
    const flows = numbersIn(args.slice(1));
    if (flows.error) return flows.error;
    let acc = ZERO();
    const onePlus = ONE().add(rate);
    for (let i = 0; i < flows.nums.length; i++) {
      const disc = onePlus.pow(i + 1);
      const q = flows.nums[i].div(disc);
      if (q === null) return V.err(ERR.DIV0);
      acc = acc.add(q);
    }
    return num(acc);
  }},


  /* ---- array maths ---- */

  /* SUMPRODUCT is the workhorse of real financial models — 4,725 uses in one
   * corpus workbook alone. Multiply corresponding elements across every
   * argument, then sum. Non-numeric entries count as ZERO rather than
   * erroring, which is what makes it usable over messy ranges. */
  SUMPRODUCT: { call: ({ args }) => {
    if (!args.length) return V.err(ERR.VALUE);
    const cols = args.map((a) => (a.isRange ? a.values : [a.scalar]));
    const n = cols[0].length;
    for (const c of cols) {
      if (c.length !== n) return V.err(ERR.VALUE);   // mismatched shapes
      for (const v of c) if (isErr(v)) return v;
    }
    let acc = ZERO();
    for (let i = 0; i < n; i++) {
      let prod = ONE();
      let allNum = true;
      for (const c of cols) {
        const v = c[i];
        if (v && v.k === 'number') prod = prod.mul(v.d);
        else { allNum = false; break; }
      }
      if (allNum) acc = acc.add(prod);
    }
    return num(acc);
  }},

  /* ---- position ---- */

  ROW: { lazy: true, call: ({ args, api }) => {
    if (!args.length) return num(D(selfRow(api) + 1));
    const a = args[0];
    if (a.t === 'ref') return num(D(a.row + 1));
    if (a.t === 'range' && a.a) return num(D(a.a.row + 1));
    return V.err(ERR.VALUE);
  }},
  COLUMN: { lazy: true, call: ({ args, api }) => {
    if (!args.length) return num(D(selfCol(api) + 1));
    const a = args[0];
    if (a.t === 'ref') return num(D(a.col + 1));
    if (a.t === 'range' && a.a) return num(D(a.a.col + 1));
    return V.err(ERR.VALUE);
  }},
  ADDRESS: { call: ({ args }) => {
    const r = firstNum(args, 0); if (r.error) return r.error;
    const c = firstNum(args, 1); if (c.error) return c.error;
    const absNum = args[2] ? firstNum(args, 2).d.toNumber() : 1;
    const row = r.d.toNumber(), col = c.d.toNumber();
    if (row < 1 || col < 1) return V.err(ERR.VALUE);
    const cs = absNum === 1 || absNum === 3 ? '$' : '';
    const rs = absNum === 1 || absNum === 2 ? '$' : '';
    return V.text(cs + colName(col - 1) + rs + row);
  }},

  /* ---- characters ---- */

  UNICHAR: { call: ({ args }) => {
    const r = firstNum(args); if (r.error) return r.error;
    const n = r.d.toNumber();
    if (!Number.isInteger(n) || n < 1 || n > 0x10ffff) return V.err(ERR.VALUE);
    try { return V.text(String.fromCodePoint(n)); } catch (e) { return V.err(ERR.VALUE); }
  }},
  UNICODE: { call: ({ args }) => {
    const s = toText(args[0] ? args[0].scalar : BLANK);
    return s ? num(D(s.codePointAt(0))) : V.err(ERR.VALUE);
  }},
  CHAR: { call: ({ args }) => {
    const r = firstNum(args); if (r.error) return r.error;
    const n = r.d.toNumber();
    if (n < 1 || n > 255) return V.err(ERR.VALUE);
    return V.text(String.fromCharCode(n));
  }},
  CODE: { call: ({ args }) => {
    const s = toText(args[0] ? args[0].scalar : BLANK);
    return s ? num(D(s.charCodeAt(0))) : V.err(ERR.VALUE);
  }},
  /* HYPERLINK renders as its friendly name. The destination is not clickable
   * here yet, so returning the label is the honest result, not the URL. */
  HYPERLINK: { call: ({ args }) => {
    const label = args[1] ? args[1].scalar : (args[0] ? args[0].scalar : BLANK);
    return V.text(toText(label));
  }},
};

/* ---- helpers for the position functions ----
 * ROW()/COLUMN() with no argument mean "this cell", so they read the node id
 * the graph passes in as api.self. */

function selfRow(api) {
  const m = /!(?:\$?[A-Za-z]{1,3})(\d{1,7})$/.exec((api && api.self) || '');
  return m ? parseInt(m[1], 10) - 1 : 0;
}
function selfCol(api) {
  const m = /!\$?([A-Za-z]{1,3})\d{1,7}$/.exec((api && api.self) || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function colName(n) {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}


/* ---- shared implementations ---- */

function sub(args, side) {
  const s = toText(args[0].scalar);
  let n = 1;
  if (args[1]) { const r = firstNum(args, 1); if (r.error) return r.error; n = r.d.toNumber(); }
  if (n < 0) return V.err(ERR.VALUE);
  return V.text(side === 'left' ? s.slice(0, n) : (n === 0 ? '' : s.slice(-n)));
}

function variance(args, sample) {
  const r = numbersIn(args);
  if (r.error) return r.error;
  const xs = r.nums;
  const n = xs.length;
  if (n < (sample ? 2 : 1)) return V.err(ERR.DIV0);
  const mean = xs.reduce((a, b) => a.add(b), ZERO()).div(D(n));
  let acc = ZERO();
  for (const x of xs) { const d = x.sub(mean); acc = acc.add(d.mul(d)); }
  return V.num(acc.div(D(sample ? n - 1 : n)));
}

function stdev(args, sample) {
  const v = variance(args, sample);
  if (isErr(v)) return v;
  return V.num(Decimal.fromNumber(Math.sqrt(v.d.toNumber())));
}

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
