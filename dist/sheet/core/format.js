/* Grain — number display.
 *
 * DISPLAY ONLY. The stored value is always the exact Decimal; nothing here
 * ever changes it. That separation is the whole point: Excel's "General"
 * format shows 0.02 for a value that is really 0.020000000000000018, and
 * both facts must remain available — the clean one on screen, the exact one
 * in the formula bar and in every calculation.
 *
 * Why this is needed and not cosmetic: real workbooks are full of float
 * noise, because they were produced by software that computed in binary
 * floating point. Rendering that noise at full precision makes a correct
 * reader look broken — a column of "-0.024000000000000021" where Excel shows
 * "-0.024". We are not obliged to inherit their arithmetic, but we are
 * obliged to display their numbers the way they meant them.
 */

import { Decimal } from './decimal.js';

/** Significant digits Excel's General format keeps. */
const GENERAL_SIG = 11;

/** Digits in |units|, i.e. the length of the mantissa. */
function mantissaLen(d) {
  const u = d.u < 0n ? -d.u : d.u;
  return u === 0n ? 1 : u.toString().length;
}

/**
 * Excel's General format, faithfully: round to 11 significant digits, drop
 * trailing zeros, and fall back to scientific notation when the number is
 * too large or too small to show plainly.
 */
export function formatGeneral(d) {
  if (!(d instanceof Decimal)) return String(d);
  if (d.isZero()) return '0';

  const L = mantissaLen(d);
  const intDigits = L - d.s;              // digits before the point (may be <= 0)

  // Scientific for very large or very small, matching Excel's switchover.
  if (intDigits > GENERAL_SIG || intDigits < -8) {
    return toScientific(d);
  }

  const places = GENERAL_SIG - intDigits;
  const r = places >= 0 ? d.round(places) : d.round(0);
  return r.toString();
}

/* Excel's General switches to scientific based on COLUMN WIDTH, so the same
 * number renders differently in two columns of the same sheet. That is a
 * model decision we decline to inherit: width should change what fits, not
 * what a number is. We switch on magnitude alone, and keep the same 11
 * significant digits either way. */
function toScientific(d) {
  const neg = d.sign < 0;
  const a = d.abs();
  const exp = mantissaLen(a) - a.s - 1;
  const digits = a.u.toString();
  let m = digits[0];
  const rest = digits.slice(1).replace(/0+$/, '').slice(0, GENERAL_SIG - 1);
  if (rest) m += '.' + rest;
  return `${neg ? '-' : ''}${m}E${exp >= 0 ? '+' : '-'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

/** Thousands separators, for the status bar and currency-ish display. */
export function withThousands(str) {
  const neg = str.startsWith('-');
  const s = neg ? str.slice(1) : str;
  const [i, f] = s.split('.');
  return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
}
