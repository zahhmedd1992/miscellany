/* Grain — ZIP container reader.
 *
 * DEFLATE is a MECHANISM: RFC 1951 has exactly one correct answer, so we use
 * the platform's implementation rather than writing our own. Both runtimes
 * ship one, so this costs zero dependencies:
 *   browser  DecompressionStream('deflate-raw')
 *   node     zlib.inflateRawSync
 *
 * The container LAYOUT is ours, because the thing we need from it is not
 * "give me the files" — it is "give me the files AND everything required to
 * put them back byte-identically." A general-purpose zip library discards
 * exactly the metadata that preserve-unknown depends on: entry order,
 * per-entry compression method, external attributes, extra fields, and the
 * original compressed bytes. We keep all of it.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

/* ---- platform inflate ------------------------------------------------- */

let _inflateRaw = null;

export function setInflate(fn) { _inflateRaw = fn; }

async function inflateRaw(bytes) {
  if (_inflateRaw) return _inflateRaw(bytes);
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Node without an injected inflate: load zlib lazily so the browser bundle
  // never sees this import.
  const zlib = await import('node:zlib');
  _inflateRaw = (b) => new Uint8Array(zlib.inflateRawSync(Buffer.from(b)));
  return _inflateRaw(bytes);
}

/* ---- reading ----------------------------------------------------------- */

class Reader {
  constructor(buf) { this.b = buf; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  u16(o) { return this.dv.getUint16(o, true); }
  u32(o) { return this.dv.getUint32(o, true); }
  u64(o) {
    // Zip64 sizes. Values above 2^53 cannot occur in a spreadsheet, and
    // silently truncating would be worse than refusing.
    const lo = this.dv.getUint32(o, true), hi = this.dv.getUint32(o + 4, true);
    if (hi > 0x1fffff) throw new Error('zip64 value exceeds safe integer range');
    return hi * 0x100000000 + lo;
  }
  str(o, n) { return new TextDecoder('utf-8').decode(this.b.subarray(o, o + n)); }
}

function findEOCD(r) {
  const n = r.b.length;
  const min = Math.max(0, n - 0xffff - 22);
  for (let i = n - 22; i >= min; i--) {
    if (r.u32(i) === SIG_EOCD) return i;
  }
  throw new Error('not a zip file: no end-of-central-directory record');
}

/**
 * Parse a zip. Returns entries in CENTRAL DIRECTORY ORDER, which is the order
 * a writer must reproduce — reordering parts is a diff even when every byte
 * of content matches.
 */
export async function readZip(buf) {
  const r = new Reader(buf);
  const eocd = findEOCD(r);

  let count = r.u16(eocd + 10);
  let cdOffset = r.u32(eocd + 16);
  let cdSize = r.u32(eocd + 12);

  // Zip64: the 32-bit fields are saturated and the real values live in the
  // zip64 EOCD. Government workbooks are big enough that this happens.
  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    const locOff = eocd - 20;
    if (locOff >= 0 && r.u32(locOff) === SIG_EOCD64_LOC) {
      const z64 = r.u64(locOff + 8);
      if (r.u32(z64) !== SIG_EOCD64) throw new Error('bad zip64 EOCD signature');
      count = r.u64(z64 + 32);
      cdSize = r.u64(z64 + 40);
      cdOffset = r.u64(z64 + 48);
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (r.u32(p) !== SIG_CEN) throw new Error(`bad central directory entry at ${p}`);
    const flags = r.u16(p + 8);
    const method = r.u16(p + 10);
    const modTime = r.u16(p + 12);
    const modDate = r.u16(p + 14);
    const crc32 = r.u32(p + 16);
    let compSize = r.u32(p + 20);
    let uncompSize = r.u32(p + 24);
    const nameLen = r.u16(p + 28);
    const extraLen = r.u16(p + 30);
    const commentLen = r.u16(p + 32);
    const internalAttr = r.u16(p + 36);
    const externalAttr = r.u32(p + 38);
    let localOffset = r.u32(p + 42);
    const name = r.str(p + 46, nameLen);
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

    // zip64 extended information extra field (0x0001)
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      let q = 0;
      while (q + 4 <= extra.length) {
        const hid = extra[q] | (extra[q + 1] << 8);
        const hsz = extra[q + 2] | (extra[q + 3] << 8);
        if (hid === 0x0001) {
          const er = new Reader(extra.subarray(q + 4, q + 4 + hsz));
          let k = 0;
          if (uncompSize === 0xffffffff) { uncompSize = er.u64(k); k += 8; }
          if (compSize === 0xffffffff) { compSize = er.u64(k); k += 8; }
          if (localOffset === 0xffffffff) { localOffset = er.u64(k); k += 8; }
          break;
        }
        q += 4 + hsz;
      }
    }

    entries.push({
      name, method, flags, crc32, compSize, uncompSize,
      modTime, modDate, internalAttr, externalAttr, localOffset,
      versionMadeBy: r.u16(p + 4),
      versionNeeded: r.u16(p + 6),
      diskStart: r.u16(p + 34),
      extra: extra.slice(),
      comment: commentLen ? r.str(p + 46 + nameLen + extraLen, commentLen) : '',
      _buf: buf,
      _data: null,
      _localHeader: null,   // filled on first read; re-emitted verbatim
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  // The archive comment must survive too, or the tail differs by a byte.
  const commentLen = r.u16(eocd + 20);
  const archiveComment = commentLen ? buf.subarray(eocd + 22, eocd + 22 + commentLen).slice() : new Uint8Array(0);

  const byName = new Map(entries.map((e) => [e.name, e]));

  /** Locate an entry's local header and payload without decompressing. */
  function locate(e) {
    if (e._localHeader) return;
    const lo = e.localOffset;
    if (r.u32(lo) !== SIG_LOC) throw new Error(`bad local header for ${e.name}`);
    const nameLen = r.u16(lo + 26);
    const extraLen = r.u16(lo + 28);
    const dataStart = lo + 30 + nameLen + extraLen;
    // The LOCAL header's extra field often differs from the central one
    // (alignment padding, Zip64 placement). Keeping the whole block verbatim
    // is the only way an untouched entry comes back byte-identical.
    e._localHeader = buf.subarray(lo, dataStart).slice();
    e._raw = buf.subarray(dataStart, dataStart + e.compSize);

    // Streaming writers set flag 0x08 and append a data descriptor AFTER the
    // payload, because they didn't know the CRC or sizes when they wrote the
    // header. Those bytes belong to the entry. Copying header+payload and
    // stopping there produces an archive that is both a byte-diff and, for
    // strict readers, malformed.
    e._descriptor = null;
    if (e.flags & 0x08) {
      const after = dataStart + e.compSize;
      const hasSig = r.u32(after) === 0x08074b50;
      const len = (hasSig ? 4 : 0) + 12;   // crc + compSize + uncompSize
      e._descriptor = buf.subarray(after, after + len).slice();
    }
  }

  return {
    entries,                 // central-directory order — a writer must preserve it
    byName,
    archiveComment,
    has: (n) => byName.has(n),
    names: () => entries.map((e) => e.name),
    locate,

    /** Decompressed bytes for one entry. Cached. */
    async bytes(name) {
      const e = byName.get(name);
      if (!e) return null;
      if (e._data) return e._data;
      locate(e);
      if (e.method === 0) e._data = e._raw.slice();
      else if (e.method === 8) e._data = await inflateRaw(e._raw);
      else throw new Error(`unsupported compression method ${e.method} for ${name}`);
      return e._data;
    },

    /** Original compressed bytes — how an unmodified part is re-emitted
     *  without ever being re-compressed (recompression is not bit-stable:
     *  a different zlib build, level or window size produces different bytes
     *  for identical input, so "just recompress it" cannot round-trip). */
    rawBytes(name) {
      const e = byName.get(name);
      if (!e) return null;
      locate(e);
      return e._raw;
    },

    async text(name) {
      const b = await this.bytes(name);
      if (!b) return null;
      // Strip a UTF-8 BOM if present. It is part of the bytes and must be
      // restored on write, so record that it was there.
      return new TextDecoder('utf-8').decode(b);
    },
  };
}
