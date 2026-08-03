/* Grain — the value model.
 *
 * A cell, a shape's fill, a form field and a slide's title all hold a Value.
 * There is exactly one value model for the whole platform; nothing is
 * "spreadsheet-flavoured". That is what makes a chart on a slide able to
 * depend on a cell without a translation layer.
 *
 * Kinds: blank | number | text | bool | error
 * Numbers are Decimal (see decimal.js) — never IEEE floats.
 */

import { Decimal } from './decimal.js';

export const ERR = {
  DIV0:  '#DIV/0!',
  VALUE: '#VALUE!',
  REF:   '#REF!',
  NAME:  '#NAME?',
  NUM:   '#NUM!',
  NA:    '#N/A',
  CIRC:  '#CIRC!',   // ours: Excel reports 0 for circular refs, which hides a bug
};
const ERR_SET = new Set(Object.values(ERR));

export const BLANK = { k: 'blank' };

export const V = {
  blank: () => BLANK,
  num:   (d) => ({ k: 'number', d: d instanceof Decimal ? d : Decimal.from(d) }),
  text:  (s) => ({ k: 'text', s: String(s) }),
  bool:  (b) => ({ k: 'bool', b: !!b }),
  err:   (e) => ({ k: 'error', e }),
};

export const isErr   = (v) => v.k === 'error';
export const isBlank = (v) => v.k === 'blank';
export const isNum   = (v) => v.k === 'number';

/* ---------------------------------------------------------------------------
 * Coercion. These rules ARE the model — they decide what =1+"2" means, and
 * every one of them is a deliberate choice, not an inherited default.
 * We follow Excel where Excel is sane, and say so where we don't.
 * ------------------------------------------------------------------------ */

// For arithmetic. Returns a Decimal, or an error Value.
export function toNum(v) {
  switch (v.k) {
    case 'number': return v.d;
    case 'blank':  return Decimal.zero();
    case 'bool':   return new Decimal(v.b ? 1n : 0n, 0);
    case 'text': {
      const s = v.s.trim();
      if (s === '') return V.err(ERR.VALUE);
      const d = Decimal.fromString(s);
      return d === null ? V.err(ERR.VALUE) : d;
    }
    case 'error':  return v;
  }
  return V.err(ERR.VALUE);
}

// For display and CONCAT.
export function toText(v) {
  switch (v.k) {
    case 'text':   return v.s;
    case 'number': return v.d.toString();
    case 'bool':   return v.b ? 'TRUE' : 'FALSE';
    case 'blank':  return '';
    case 'error':  return v.e;
  }
  return '';
}

// For IF() and friends.
export function toBool(v) {
  switch (v.k) {
    case 'bool':   return v.b;
    case 'number': return !v.d.isZero();
    case 'blank':  return false;
    case 'text': {
      const s = v.s.trim().toUpperCase();
      if (s === 'TRUE')  return true;
      if (s === 'FALSE') return false;
      return V.err(ERR.VALUE);
    }
    case 'error':  return v;
  }
  return V.err(ERR.VALUE);
}

/* Ordering across mixed kinds. Excel's rule: number < text < bool.
 * Blank compares as zero against numbers and as "" against text. */
const RANK = { number: 1, text: 2, bool: 3 };

export function compare(a, b) {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  if (isBlank(a) && isBlank(b)) return 0;
  if (isBlank(a)) a = b.k === 'text' ? V.text('') : V.num(Decimal.zero());
  if (isBlank(b)) b = a.k === 'text' ? V.text('') : V.num(Decimal.zero());
  if (a.k !== b.k) return RANK[a.k] < RANK[b.k] ? -1 : 1;
  switch (a.k) {
    case 'number': return a.d.cmp(b.d);
    // Text comparison is case-INSENSITIVE, matching Excel. Deliberate: users
    // typing =A1="yes" do not mean it to fail on "Yes".
    case 'text': {
      const x = a.s.toUpperCase(), y = b.s.toUpperCase();
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case 'bool': return a.b === b.b ? 0 : a.b ? 1 : -1;
  }
  return 0;
}

/* ---------------------------------------------------------------------------
 * Parsing raw user input into a Value. This is the "what did they mean?"
 * layer, and it is where we refuse Excel's most destructive behaviour.
 * ------------------------------------------------------------------------ */

export function parseInput(raw) {
  if (raw === null || raw === undefined || raw === '') return BLANK;
  const s = String(raw);
  const t = s.trim();
  if (t === '') return V.text(s);

  const up = t.toUpperCase();
  if (up === 'TRUE')  return V.bool(true);
  if (up === 'FALSE') return V.bool(false);
  if (ERR_SET.has(t)) return V.err(t);

  // Leading apostrophe forces text — the universal spreadsheet escape hatch.
  if (s[0] === "'") return V.text(s.slice(1));

  // Percent literal: 12.5% -> 0.125
  if (/^[+-]?[\d.,]+%$/.test(t)) {
    const d = Decimal.fromString(t.slice(0, -1).replace(/,/g, ''));
    if (d) return V.num(d.div(new Decimal(100n, 0)));
  }

  // Currency literal: $1,234.50 / -$5 / ($5)
  const cur = /^\(?\s*([+-]?)\s*\$\s*([\d,]+(?:\.\d+)?)\s*\)?$/.exec(t);
  if (cur) {
    const negParen = t.startsWith('(') && t.endsWith(')');
    const d = Decimal.fromString(cur[2].replace(/,/g, ''));
    if (d) return V.num(cur[1] === '-' || negParen ? d.neg() : d);
  }

  // Thousands-separated number: 1,234.5
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) {
    const d = Decimal.fromString(t.replace(/,/g, ''));
    if (d) return V.num(d);
  }

  // Plain number. NOTE: we do NOT auto-convert anything date-shaped here.
  // Excel turning "MAR1" and "SEPT2" into dates has corrupted published
  // genomics data for two decades. Dates require an explicit format or
  // DATE()/DATEVALUE(). Refusing to guess is a feature.
  const d = Decimal.fromString(t);
  if (d !== null) return V.num(d);

  return V.text(s);
}
