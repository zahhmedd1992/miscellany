/* Grain — exact decimal arithmetic.
 *
 * WHY THIS EXISTS AND ISN'T A LIBRARY:
 * A spreadsheet's number type is a MODEL, not a mechanism. It decides what
 * "0.1 + 0.2" means, when to round, and how money behaves. Every existing
 * spreadsheet answers with IEEE-754 binary floats, which is why Excel shows
 * 0.30000000000000004 if you subtract 0.3 and format wide enough.
 *
 * Representation: value = units * 10^-scale, units is a BigInt.
 *   1.25  ->  units=125n  scale=2
 *   -0.5  ->  units=-5n   scale=1
 *
 * +, -, * are EXACT. / is exact when it terminates, else rounded to
 * DIV_SCALE digits (half-even, the standard for money).
 */

const DIV_SCALE = 28;
const P = []; // 10^n cache
function pow10(n) {
  if (P[n] !== undefined) return P[n];
  let v = 1n;
  for (let i = 0; i < n; i++) v *= 10n;
  return (P[n] = v);
}

export class Decimal {
  constructor(units, scale) {
    this.u = units;   // BigInt
    this.s = scale;   // non-negative int
  }

  /* ---- construction ---- */

  static fromString(str) {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(str.trim());
    if (!m || (!m[2] && !m[3])) return null;
    const [, sign, int = '', frac = '', exp] = m;
    let units = BigInt((int || '0') + frac);
    let scale = frac.length;
    if (exp) {
      const e = parseInt(exp, 10);
      if (e >= 0) {
        // shrink scale first, then multiply
        const take = Math.min(e, scale);
        scale -= take;
        const rest = e - take;
        if (rest > 0) units *= pow10(rest);
      } else {
        scale += -e;
      }
    }
    if (sign === '-') units = -units;
    return new Decimal(units, scale);
  }

  static fromNumber(n) {
    if (!Number.isFinite(n)) return null;
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return new Decimal(BigInt(n), 0);
    // Number.prototype.toString gives the shortest round-tripping decimal,
    // which is the honest reading of what the float was meant to be.
    return Decimal.fromString(n.toString());
  }

  static from(v) {
    if (v instanceof Decimal) return v;
    if (typeof v === 'number') return Decimal.fromNumber(v);
    if (typeof v === 'string') return Decimal.fromString(v);
    if (typeof v === 'bigint') return new Decimal(v, 0);
    return null;
  }

  static zero() { return new Decimal(0n, 0); }

  /* ---- internals ---- */

  // Re-express both operands at a common scale without losing information.
  static #align(a, b) {
    if (a.s === b.s) return [a.u, b.u, a.s];
    if (a.s > b.s) return [a.u, b.u * pow10(a.s - b.s), a.s];
    return [a.u * pow10(b.s - a.s), b.u, b.s];
  }

  // Drop trailing zeros so 1.50 and 1.5 compare and print identically.
  #norm() {
    if (this.u === 0n) return new Decimal(0n, 0);
    let { u, s } = this;
    while (s > 0 && u % 10n === 0n) { u /= 10n; s--; }
    return new Decimal(u, s);
  }

  /* ---- arithmetic ---- */

  add(o) { const [x, y, s] = Decimal.#align(this, o); return new Decimal(x + y, s).#norm(); }
  sub(o) { const [x, y, s] = Decimal.#align(this, o); return new Decimal(x - y, s).#norm(); }
  mul(o) { return new Decimal(this.u * o.u, this.s + o.s).#norm(); }
  neg()  { return new Decimal(-this.u, this.s); }
  abs()  { return this.u < 0n ? this.neg() : this; }

  div(o) {
    if (o.u === 0n) return null; // caller raises #DIV/0!
    // (this.u / 10^this.s) / (o.u / 10^o.s) = this.u * 10^o.s / (o.u * 10^this.s)
    const targetScale = DIV_SCALE;
    // numerator scaled up so the quotient carries targetScale digits
    const num = this.u * pow10(o.s + targetScale);
    const den = o.u * pow10(this.s);
    const q = Decimal.#divRoundHalfEven(num, den);
    return new Decimal(q, targetScale).#norm();
  }

  static #divRoundHalfEven(num, den) {
    if (den < 0n) { num = -num; den = -den; }
    const neg = num < 0n;
    const a = neg ? -num : num;
    const q = a / den;
    const r = a % den;
    if (r === 0n) return neg ? -q : q;
    const twice = r * 2n;
    let up = false;
    if (twice > den) up = true;
    else if (twice === den) up = (q % 2n === 1n); // ties -> even
    const res = up ? q + 1n : q;
    return neg ? -res : res;
  }

  pow(nInt) {
    // integer exponent only; fractional falls back to float in eval.js
    if (nInt === 0) return new Decimal(1n, 0);
    let base = this, e = Math.abs(nInt), acc = new Decimal(1n, 0);
    while (e > 0) {
      if (e & 1) acc = acc.mul(base);
      base = base.mul(base);
      e >>= 1;
    }
    if (nInt < 0) return new Decimal(1n, 0).div(acc);
    return acc;
  }

  /* ---- comparison ---- */

  cmp(o) {
    const [x, y] = Decimal.#align(this, o);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  eq(o) { return this.cmp(o) === 0; }
  isZero() { return this.u === 0n; }
  get sign() { return this.u < 0n ? -1 : this.u > 0n ? 1 : 0; }

  /* ---- rounding ---- */

  // Round to `places` decimal places, half-away-from-zero (what users expect
  // from ROUND(), and what Excel does — this is a deliberate model choice).
  round(places = 0) {
    if (this.s <= places) return this;
    const drop = this.s - places;
    const den = pow10(drop);
    const neg = this.u < 0n;
    const a = neg ? -this.u : this.u;
    const q = a / den, r = a % den;
    const up = r * 2n >= den;
    const res = up ? q + 1n : q;
    return new Decimal(neg ? -res : res, places).#norm();
  }

  trunc(places = 0) {
    if (this.s <= places) return this;
    const den = pow10(this.s - places);
    const neg = this.u < 0n;
    const a = neg ? -this.u : this.u;
    const q = a / den;
    return new Decimal(neg ? -q : q, places).#norm();
  }

  /* ---- output ---- */

  toString() {
    const n = this.#norm();
    const neg = n.u < 0n;
    let d = (neg ? -n.u : n.u).toString();
    if (n.s === 0) return (neg ? '-' : '') + d;
    if (d.length <= n.s) d = '0'.repeat(n.s - d.length + 1) + d;
    const cut = d.length - n.s;
    return (neg ? '-' : '') + d.slice(0, cut) + '.' + d.slice(cut);
  }

  // Lossy on purpose — only for interop with things that demand a float
  // (charting, Math.* fallbacks). Never used for storage or comparison.
  toNumber() { return Number(this.toString()); }
}
