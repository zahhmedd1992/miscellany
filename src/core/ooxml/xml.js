/* Grain — XML scanner for OOXML.
 *
 * Not a DOM parser and not a general XML library. It does two things a DOM
 * cannot, both of which preserve-unknown depends on:
 *
 *   1. Every event carries its SOURCE OFFSETS, so a change can be spliced
 *      into the original text instead of the document being regenerated.
 *      Regeneration is where byte fidelity dies — attribute order, self-
 *      closing style, whitespace and entity choice are all unrecoverable.
 *
 *   2. It is NAMESPACE-PREFIX-AGNOSTIC by construction. OOXML permits any
 *      prefix: Excel writes <worksheet><c>, ClosedXML and LibreOffice write
 *      <x:worksheet><x:c>. 12 of the 49 corpus files use a prefix. A reader
 *      that matches "<c " opens a quarter of the corpus as a blank sheet and
 *      reports success. That bug was found in the corpus tooling first —
 *      cheapest possible place — and this module exists so it cannot recur.
 */

/** Strip any namespace prefix: "x:worksheet" -> "worksheet". */
export const local = (q) => {
  const i = q.indexOf(':');
  return i < 0 ? q : q.slice(i + 1);
};

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode XML character/entity references. */
export function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, r) => {
    if (r[0] === '#') {
      const cp = r[1] === 'x' || r[1] === 'X'
        ? parseInt(r.slice(2), 16)
        : parseInt(r.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENT[r] !== undefined ? ENT[r] : m;
  });
}

export function encode(s) {
  return String(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
export function encodeAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

/** Parse the attribute section of a start tag. Values may contain '>'. */
export function parseAttrs(src, from, to) {
  const out = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(src)) && m.index < to) {
    out[local(m[1])] = decode(m[3] !== undefined ? m[3] : m[4]);
  }
  return out;
}

/**
 * Walk the document, emitting events in order.
 *
 *   open  { type:'open',  name, qname, attrs(), selfClosing, start, end }
 *   close { type:'close', name, qname, start, end }
 *   text  { type:'text',  value(), start, end }
 *
 * `attrs()` and `value()` are lazy — a 700,000-cell sheet must not allocate
 * an object per cell just to be skipped.
 */
export function* scan(src) {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      if (i < n) yield { type: 'text', start: i, end: n, value: () => decode(src.slice(i, n)) };
      return;
    }
    if (lt > i) {
      const s = i, e = lt;
      yield { type: 'text', start: s, end: e, value: () => decode(src.slice(s, e)) };
    }

    // comment / CDATA / PI / doctype pass through as raw
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt); i = e < 0 ? n : e + 3;
      yield { type: 'raw', start: lt, end: i };
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      const end = e < 0 ? n : e + 3;
      const s = lt + 9, te = e < 0 ? n : e;
      yield { type: 'text', start: lt, end, value: () => src.slice(s, te) };
      i = end;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt); i = e < 0 ? n : e + 2;
      yield { type: 'raw', start: lt, end: i };
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE and friends — scan to the matching '>' at depth 0
      let d = 0, j = lt;
      for (; j < n; j++) {
        const c = src[j];
        if (c === '[') d++;
        else if (c === ']') d--;
        else if (c === '>' && d <= 0) { j++; break; }
      }
      i = j;
      yield { type: 'raw', start: lt, end: i };
      continue;
    }

    // a real tag — find its '>' while respecting quoted attribute values
    let j = lt + 1, quote = 0;
    for (; j < n; j++) {
      const c = src.charCodeAt(j);
      if (quote) { if (c === quote) quote = 0; continue; }
      if (c === 34 || c === 39) { quote = c; continue; }
      if (c === 62) break; // '>'
    }
    if (j >= n) { i = n; break; }
    const tagEnd = j + 1;

    if (src.charCodeAt(lt + 1) === 47) { // '</'
      const qname = src.slice(lt + 2, j).trim();
      yield { type: 'close', qname, name: local(qname), start: lt, end: tagEnd };
      i = tagEnd;
      continue;
    }

    const selfClosing = src.charCodeAt(j - 1) === 47; // '/>'
    let k = lt + 1;
    while (k < j && !/[\s/>]/.test(src[k])) k++;
    const qname = src.slice(lt + 1, k);
    const attrFrom = k, attrTo = selfClosing ? j - 1 : j;
    yield {
      type: 'open', qname, name: local(qname), selfClosing,
      start: lt, end: tagEnd,
      contentStart: tagEnd,
      attrs: () => parseAttrs(src, attrFrom, attrTo),
      attr: (a) => {
        const re = new RegExp(`(?:^|[\\s])(?:[A-Za-z_][\\w.-]*:)?${a}\\s*=\\s*("([^"]*)"|'([^']*)')`);
        const m = re.exec(src.slice(attrFrom, attrTo));
        return m ? decode(m[2] !== undefined ? m[2] : m[3]) : undefined;
      },
    };
    i = tagEnd;
  }
}

/**
 * Yield every element with the given local name, with its full source span
 * and inner text span. Handles nesting of same-named elements.
 */
export function* elements(src, wanted) {
  let depth = 0, open = null, innerStart = 0;
  for (const ev of scan(src)) {
    if (ev.type === 'open' && ev.name === wanted) {
      if (ev.selfClosing) {
        if (depth === 0) {
          yield { attrs: ev.attrs, attr: ev.attr, start: ev.start, end: ev.end, innerStart: -1, innerEnd: -1, inner: () => '' };
        }
        continue;
      }
      if (depth === 0) { open = ev; innerStart = ev.end; }
      depth++;
    } else if (ev.type === 'close' && ev.name === wanted) {
      depth--;
      if (depth === 0 && open) {
        const s = innerStart, e = ev.start;
        yield {
          attrs: open.attrs, attr: open.attr,
          start: open.start, end: ev.end,
          innerStart: s, innerEnd: e,
          inner: () => src.slice(s, e),
        };
        open = null;
      }
      if (depth < 0) depth = 0;
    }
  }
}

/** First element with the given local name, or null. */
export function firstElement(src, wanted) {
  for (const e of elements(src, wanted)) return e;
  return null;
}

/** Concatenated text of an element's descendants, skipping markup. */
export function textOf(src) {
  let out = '';
  for (const ev of scan(src)) if (ev.type === 'text') out += ev.value();
  return out;
}
