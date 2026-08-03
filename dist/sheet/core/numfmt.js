/* Grain — Excel number format codes.
 *
 * A format code is a small language, not a setting. `#,##0.00_);[Red](#,##0.00)`
 * means: thousands-separated with two decimals, then a space the width of a
 * closing paren; negatives in red and parenthesised. Getting this wrong is
 * the difference between a financial model that reads like itself and a wall
 * of raw digits — which is what "we support .xlsx" usually turns out to mean.
 *
 * This is unambiguously a MODEL: every rule below is a decision about what a
 * number means to the person who typed it. So we build it, from ECMA-376
 * §18.8.31 and the observed behaviour of the corpus.
 *
 * Formatting is DISPLAY ONLY. The stored Decimal is never touched.
 */

import { Decimal } from './decimal.js';
import { serialToISO } from './dates.js';

/* Built-in formats, ECMA-376 §18.8.30. Ids 0-49 are reserved and are NOT
 * written into styles.xml, so a reader that only looks at <numFmt> elements
 * silently renders every built-in as General. */
export const BUILTIN = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
  18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0',
  48: '##0.0E+0', 49: '@',
};

const COLORS = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000',
  blue: '#0000FF', yellow: '#FFFF00', magenta: '#FF00FF', cyan: '#00FFFF',
};

const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/* ---- splitting a code into its sections ------------------------------- */

/** Split on `;` while respecting quotes, [brackets] and \escapes. */
function sections(code) {
  const out = [];
  let cur = '', q = false, br = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\\') { cur += c + (code[++i] || ''); continue; }
    if (c === '"') { q = !q; cur += c; continue; }
    if (q) { cur += c; continue; }
    if (c === '[') { br++; cur += c; continue; }
    if (c === ']') { br--; cur += c; continue; }
    if (c === ';' && br === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Pull [Red] / [$-409] / [h] style modifiers out of one section.
 *
 * Must be QUOTE-AWARE. A regex over the whole section treats the bracket in
 * `"["@"]"` as a modifier and deletes the literal — so a format that prints
 * a value in square brackets silently prints nothing. Anything inside quotes
 * or after a backslash is literal text, never a modifier. */
function stripModifiers(sec) {
  let color = null, elapsed = false, currency = '';
  let body = '';
  for (let i = 0; i < sec.length; i++) {
    const c = sec[i];
    if (c === '\\') { body += c + (sec[++i] || ''); continue; }
    if (c === '"') {
      const j = sec.indexOf('"', i + 1);
      const end = j < 0 ? sec.length : j;
      body += sec.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c !== '[') { body += c; continue; }

    const j = sec.indexOf(']', i);
    if (j < 0) { body += c; continue; }
    const inner = sec.slice(i + 1, j);
    i = j;
    const low = inner.toLowerCase();
    if (COLORS[low]) { color = COLORS[low]; continue; }
    if (/^color\d+$/.test(low)) continue;
    if (/^[hms]+$/.test(low)) { elapsed = true; body += '[' + inner + ']'; continue; }
    if (inner.startsWith('$')) {
      // [$USD-409] or [$-409]: the part before the dash is a literal symbol
      const sym = inner.slice(1).split('-')[0];
      currency = sym;
      if (sym) body += '"' + sym + '"';
      continue;
    }
    // conditions like [>100] — unsupported, dropped
  }
  return { body, color, elapsed, currency };
}

const isDateCode = (body) => {
  let out = '', q = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { i++; continue; }
    if (c === '"') { q = !q; continue; }
    if (q) continue;
    out += c;
  }
  return /(?:y{2,}|m{1,5}|d{1,4}|h{1,2}|s{1,2}|AM\/PM)/i.test(out) &&
         /[ymdhs]/i.test(out);
};

/** Walk a section emitting only its literal text.
 *  `\x` escapes, "quoted runs", `_x` = a space the width of x, `*x` = a fill
 *  character (not replicated), `@` = the text value. */
function renderLiterals(body, textValue) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { out += body[++i] || ''; continue; }
    if (c === '"') {
      const j = body.indexOf('"', i + 1);
      out += body.slice(i + 1, j < 0 ? body.length : j);
      i = j < 0 ? body.length : j;
      continue;
    }
    if (c === '_') { out += ' '; i++; continue; }
    if (c === '*') { i++; continue; }
    if (c === '@') { out += textValue === undefined ? '' : textValue; continue; }
    if ('#0?'.includes(c)) continue;      // digit placeholders have no number here
    out += c;
  }
  return out;
}

/* ---- the number path -------------------------------------------------- */

function formatNumberSection(d, body) {
  // percent: each % multiplies by 100
  const pct = (body.match(/%/g) || []).length;
  let v = d;
  for (let i = 0; i < pct; i++) v = v.mul(new Decimal(100n, 0));

  // trailing commas before the decimal point scale by 1000 each
  const scaleMatch = /([#0?](,+))(?=[^#0?]*$)/.exec(body.split('.')[0]);
  if (scaleMatch) {
    const n = scaleMatch[2].length;
    for (let i = 0; i < n; i++) v = v.div(new Decimal(1000n, 0));
    body = body.replace(scaleMatch[1], scaleMatch[1][0]);
  }

  // does the integer part carry a thousands separator?
  const intPat = body.split('.')[0];
  const useThousands = /[#0?],[#0?]/.test(intPat) || /,#{3}/.test(intPat);

  // decimal places = count of placeholders after the '.'
  const dotIdx = body.indexOf('.');
  const decPat = dotIdx < 0 ? '' : body.slice(dotIdx + 1);
  const decPlaces = (decPat.match(/[0#?]/g) || []).length;
  const minDec = (decPat.match(/0/g) || []).length;
  const minInt = (intPat.match(/0/g) || []).length;

  const rounded = v.abs().round(decPlaces);
  let s = rounded.toString();
  let [ip, fp = ''] = s.split('.');

  if (fp.length < decPlaces) fp = fp.padEnd(decPlaces, '0');
  // trim optional (#) trailing decimals back to the minimum required
  while (fp.length > minDec && fp.endsWith('0')) fp = fp.slice(0, -1);

  if (ip === '0' && minInt === 0 && (fp || decPlaces === 0)) ip = '';
  if (ip.length < minInt) ip = ip.padStart(minInt, '0');
  if (useThousands) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const num = ip + (fp ? '.' + fp : '');

  // Walk the pattern, replacing the placeholder run with the built number and
  // emitting every literal exactly where it sits.
  let out = '', placed = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { out += body[++i] || ''; continue; }
    if (c === '"') { const j = body.indexOf('"', i + 1); out += body.slice(i + 1, j < 0 ? body.length : j); i = j < 0 ? body.length : j; continue; }
    if (c === '_') { out += ' '; i++; continue; }          // width of next char
    if (c === '*') { i++; continue; }                       // fill — not replicated
    if (c === '%') { out += '%'; continue; }
    if ('#0?.,'.includes(c)) {
      if (!placed) { out += num; placed = true; }
      continue;
    }
    out += c;
  }
  if (!placed) out += num;
  return out;
}

/* ---- the date path ---------------------------------------------------- */

function formatDateSection(d, body, date1904, elapsed) {
  const serial = d.toNumber();
  const iso = serialToISO(serial, date1904);
  if (!iso || iso.includes('invalid')) return String(serial);

  const days = Math.floor(serial);
  const frac = serial - days;
  const [datePart, timePart = '00:00:00'] = iso.split(' ');
  const [Y, M, D] = datePart.split('-').map(Number);
  const [hh, mi, ss] = timePart.split(':').map(Number);
  const dow = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();

  const has12 = /AM\/PM|A\/P/i.test(body);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const p = (n, w) => String(n).padStart(w, '0');

  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { out += body[++i] || ''; continue; }
    if (c === '"') { const j = body.indexOf('"', i + 1); out += body.slice(i + 1, j < 0 ? body.length : j); i = j < 0 ? body.length : j; continue; }
    if (c === '_') { out += ' '; i++; continue; }
    if (c === '*') { i++; continue; }
    if (c === '[') { const j = body.indexOf(']', i); const tok = body.slice(i + 1, j).toLowerCase(); i = j;
      if (tok[0] === 'h') out += String(Math.floor(serial * 24));
      else if (tok[0] === 'm') out += String(Math.floor(serial * 1440));
      else if (tok[0] === 's') out += String(Math.floor(serial * 86400));
      continue; }

    const run = /^(y+|m+|d+|h+|s+|AM\/PM|A\/P)/i.exec(body.slice(i));
    if (!run) { out += c; continue; }
    const tok = run[0];
    const low = tok.toLowerCase();
    i += tok.length - 1;

    if (low[0] === 'y') out += tok.length <= 2 ? p(Y % 100, 2) : p(Y, 4);
    else if (low[0] === 'd') {
      out += tok.length === 1 ? String(D)
        : tok.length === 2 ? p(D, 2)
        : tok.length === 3 ? DAYS[dow].slice(0, 3) : DAYS[dow];
    } else if (low[0] === 'h') out += tok.length === 1 ? String(has12 ? h12 : hh) : p(has12 ? h12 : hh, 2);
    else if (low[0] === 's') out += tok.length === 1 ? String(ss) : p(ss, 2);
    else if (low === 'am/pm' || low === 'a/p') out += hh < 12 ? (low === 'a/p' ? 'A' : 'AM') : (low === 'a/p' ? 'P' : 'PM');
    else if (low[0] === 'm') {
      // 'm' is minutes when it neighbours an hour or second token, months otherwise.
      const before = body.slice(0, i - tok.length + 1);
      const after = body.slice(i + 1);
      const isMinute = /[hH]\W*$/.test(before) || /^\W*[sS]/.test(after);
      if (isMinute) out += tok.length === 1 ? String(mi) : p(mi, 2);
      else out += tok.length === 1 ? String(M)
        : tok.length === 2 ? p(M, 2)
        : tok.length === 3 ? MONTHS[M - 1].slice(0, 3)
        : tok.length === 4 ? MONTHS[M - 1] : MONTHS[M - 1][0];
    }
  }
  void frac; void elapsed;
  return out;
}

/* ---- public API -------------------------------------------------------- */

/**
 * Format a value for display.
 * @returns {{text:string, color:string|null, align:'left'|'right'|null}}
 */
export function formatValue(value, code, opts = {}) {
  const { date1904 = false, general } = opts;

  if (value.k === 'error') return { text: value.e, color: '#9A3B1B', align: 'right' };
  if (value.k === 'bool') return { text: value.b ? 'TRUE' : 'FALSE', color: null, align: 'center' };
  if (value.k === 'blank') return { text: '', color: null, align: null };

  if (!code || code === 'General' || code === '@') {
    if (value.k === 'text') return { text: value.s, color: null, align: 'left' };
    return { text: general ? general(value.d) : value.d.toString(), color: null, align: 'right' };
  }

  const secs = sections(code);

  if (value.k === 'text') {
    // The 4th section formats text; without one, text ignores the format.
    const t = secs[3];
    if (!t) return { text: value.s, color: null, align: 'left' };
    const { body, color } = stripModifiers(t);
    // Literals must be processed here too. Emitting the raw pattern turns an
    // accounting format's `_(` padding into visible "_(" — which is exactly
    // how a faithful reader ends up looking like it is printing garbage.
    return { text: renderLiterals(body, value.s), color, align: 'left' };
  }

  const d = value.d;
  const sign = d.sign;
  let sec = secs[0];
  if (sign < 0 && secs.length > 1) sec = secs[1];
  else if (sign === 0 && secs.length > 2) sec = secs[2];

  const { body, color, elapsed } = stripModifiers(sec);
  if (!body.trim()) return { text: '', color, align: 'right' };

  if (isDateCode(body)) {
    return { text: formatDateSection(d, body, date1904, elapsed), color, align: 'right' };
  }

  // A negative shown by the FIRST section keeps its minus sign; a dedicated
  // negative section supplies its own sign or parentheses, so we drop it.
  const usedNegSection = sign < 0 && secs.length > 1;
  const text = formatNumberSection(d.abs(), body);
  return {
    text: (sign < 0 && !usedNegSection ? '-' : '') + text,
    color,
    align: 'right',
  };
}
