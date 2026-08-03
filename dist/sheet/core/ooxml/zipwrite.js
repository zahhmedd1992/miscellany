/* Grain — ZIP writer.
 *
 * The whole point: an entry we did not change is re-emitted from its ORIGINAL
 * COMPRESSED BYTES, with its original local header, in its original position
 * in the central directory. Not "recompressed identically" — recompression is
 * not bit-stable across zlib builds, levels and window sizes, so a writer that
 * decompresses and recompresses everything can never produce the same file
 * twice, let alone the same file it read.
 *
 * That is what makes preserve-unknown real rather than aspirational: a pivot
 * table we do not model is not re-serialised from a model we don't have. It
 * is copied.
 */

import { crc32 } from './crc32.js';

const SIG_LOC = 0x04034b50;
const SIG_CEN = 0x02014b50;
const SIG_EOCD = 0x06054b50;

let _deflateRaw = null;
export function setDeflate(fn) { _deflateRaw = fn; }

async function deflateRaw(bytes) {
  if (_deflateRaw) return _deflateRaw(bytes);
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const zlib = await import('node:zlib');
  _deflateRaw = (b) => new Uint8Array(zlib.deflateRawSync(Buffer.from(b), { level: 9 }));
  return _deflateRaw(bytes);
}

class Out {
  constructor() { this.parts = []; this.len = 0; }
  push(u8) { this.parts.push(u8); this.len += u8.length; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
  bytes() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

const enc = new TextEncoder();

/**
 * Rebuild a zip from a source archive plus a set of replacements.
 *
 * @param {object} zip        the object returned by readZip()
 * @param {Map<string,Uint8Array|string>} changes  part name -> new content
 * @param {object} [opts]
 * @param {Set<string>} [opts.remove]  parts to drop
 * @returns {Promise<Uint8Array>}
 */
export async function writeZip(zip, changes = new Map(), opts = {}) {
  const remove = opts.remove || new Set();
  const out = new Out();
  const central = new Map();

  // A zip has TWO independent orderings and conflating them is a byte diff.
  // The central directory lists entries in one order; the local headers sit
  // in the file in whatever order the writer laid them down. Real files
  // disagree — one corpus workbook's first central-directory entry lives at
  // byte 361,093. So: emit payloads in PHYSICAL order, emit the directory in
  // CENTRAL order, and map between them by the offsets we actually wrote.
  const physical = [...zip.entries].sort((a, b) => a.localOffset - b.localOffset);

  for (const e of physical) {
    if (remove.has(e.name)) continue;

    const localOffset = out.len;
    if (localOffset > 0xfffffffe) throw new Error('output exceeds 4GB; zip64 writing not implemented');

    const changed = changes.has(e.name);

    if (!changed) {
      // ---- verbatim path: original local header + original payload ----
      zip.locate(e);
      out.push(e._localHeader);
      out.push(e._raw);
      if (e._descriptor) out.push(e._descriptor);   // streaming-writer trailer
      central.set(e.name, { e, localOffset, crc: e.crc32, comp: e.compSize, uncomp: e.uncompSize,
                            method: e.method, flags: e.flags });
      continue;
    }

    // ---- rewritten path ----
    let content = changes.get(e.name);
    if (typeof content === 'string') content = enc.encode(content);
    const crc = crc32(content);
    const deflated = await deflateRaw(content);
    // Storing is legal and smaller when deflate would inflate.
    const useDeflate = deflated.length < content.length;
    const payload = useDeflate ? deflated : content;
    const method = useDeflate ? 8 : 0;
    // Clear the data-descriptor bit: sizes are known up front here, so
    // leaving it set would make readers look for a trailer we never write.
    const flags = e.flags & ~0x08;

    const lh = new Out();
    lh.u32(SIG_LOC);
    lh.u16(e.versionNeeded ?? 20);
    lh.u16(flags);
    lh.u16(method);
    lh.u16(e.modTime);
    lh.u16(e.modDate);
    lh.u32(crc);
    lh.u32(payload.length);
    lh.u32(content.length);
    const nameBytes = enc.encode(e.name);
    lh.u16(nameBytes.length);
    lh.u16(0);                       // drop extra: its contents described the old sizes
    lh.push(nameBytes);
    out.push(lh.bytes());
    out.push(payload);

    central.set(e.name, { e, localOffset, crc, comp: payload.length, uncomp: content.length, method, flags });
  }

  // ---- central directory, in the ORIGINAL directory order ----
  const cdStart = out.len;
  let cdCount = 0;
  for (const src of zip.entries) {
    const c = central.get(src.name);
    if (!c) continue;                       // removed
    cdCount++;
    const e = c.e;
    const nameBytes = enc.encode(e.name);
    const commentBytes = e.comment ? enc.encode(e.comment) : new Uint8Array(0);
    const extra = changes.has(e.name) ? new Uint8Array(0) : e.extra;
    out.u32(SIG_CEN);
    // `?? 20` not `|| 20`: versionMadeBy is legitimately 0 in files written
    // by some tools, and `0 || 20` silently rewrites it to 20. One corpus
    // workbook differed by exactly those two bytes.
    out.u16(e.versionMadeBy ?? 20);
    out.u16(e.versionNeeded ?? 20);
    out.u16(c.flags);
    out.u16(c.method);
    out.u16(e.modTime);
    out.u16(e.modDate);
    out.u32(c.crc);
    out.u32(c.comp);
    out.u32(c.uncomp);
    out.u16(nameBytes.length);
    out.u16(extra.length);
    out.u16(commentBytes.length);
    out.u16(e.diskStart || 0);
    out.u16(e.internalAttr || 0);
    out.u32(e.externalAttr || 0);
    out.u32(c.localOffset);
    out.push(nameBytes);
    if (extra.length) out.push(extra);
    if (commentBytes.length) out.push(commentBytes);
  }
  const cdSize = out.len - cdStart;

  out.u32(SIG_EOCD);
  out.u16(0);
  out.u16(0);
  out.u16(cdCount);
  out.u16(cdCount);
  out.u32(cdSize);
  out.u32(cdStart);
  const ac = zip.archiveComment || new Uint8Array(0);
  out.u16(ac.length);
  if (ac.length) out.push(ac);

  return out.bytes();
}
