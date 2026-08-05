/* A ZIP writer, for the source downloads on the front door.
 *
 * The app already ships one — src/core/ooxml/zipwrite.js — but that writer's
 * entire job is rebuilding an archive it just read, re-emitting untouched
 * entries from their ORIGINAL compressed bytes. There is no archive to read
 * here; this makes one out of nothing. Sixty lines, node's own deflate, and
 * the app's own crc32 so the project has exactly one implementation of that.
 *
 * Timestamps are pinned rather than taken from file mtimes. A source archive
 * whose hash changes because the working copy was checked out on a different
 * day is not something anybody can verify, and verifiable is the point.
 */

import zlib from 'node:zlib';
import { crc32 } from '../src/core/ooxml/crc32.js';

const DOS_DATE = ((2026 - 1980) << 9) | (8 << 5) | 4; // 2026-08-04
const DOS_TIME = 12 << 11;                            // 12:00:00
const EXT_ATTR = (0o100644 << 16) >>> 0;              // rw-r--r--, so unzip on
                                                      // unix does not produce
                                                      // a folder of 000 files

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
 * @param {Array<{name:string, data:Uint8Array|Buffer|string}>} entries
 *        `name` is the path inside the archive, forward slashes.
 * @returns {Uint8Array}
 */
export function makeZip(entries) {
  const out = new Out();
  const central = [];

  for (const e of entries) {
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : new Uint8Array(e.data);
    const name = enc.encode(e.name);
    const crc = crc32(raw);

    // Deflate is a size optimisation, not an obligation. If it makes the
    // entry bigger — happens on tiny or already-dense files — store it.
    const packed = new Uint8Array(zlib.deflateRawSync(Buffer.from(raw), { level: 9 }));
    const deflated = packed.length < raw.length;
    const body = deflated ? packed : raw;
    const method = deflated ? 8 : 0;

    const localOffset = out.len;
    out.u32(0x04034b50);
    out.u16(20);            // version needed
    out.u16(0);             // flags — names here are ascii, so no utf-8 bit
    out.u16(method);
    out.u16(DOS_TIME); out.u16(DOS_DATE);
    out.u32(crc);
    out.u32(body.length); out.u32(raw.length);
    out.u16(name.length); out.u16(0);
    out.push(name);
    out.push(body);

    central.push({ name, method, crc, csize: body.length, usize: raw.length, localOffset });
  }

  const cdOffset = out.len;
  for (const c of central) {
    out.u32(0x02014b50);
    out.u16(20); out.u16(20);
    out.u16(0);
    out.u16(c.method);
    out.u16(DOS_TIME); out.u16(DOS_DATE);
    out.u32(c.crc);
    out.u32(c.csize); out.u32(c.usize);
    out.u16(c.name.length); out.u16(0); out.u16(0);
    out.u16(0);             // disk
    out.u16(0);             // internal attrs
    out.u32(EXT_ATTR);
    out.u32(c.localOffset);
    out.push(c.name);
  }
  const cdSize = out.len - cdOffset;

  out.u32(0x06054b50);
  out.u16(0); out.u16(0);
  out.u16(central.length); out.u16(central.length);
  out.u32(cdSize); out.u32(cdOffset);
  out.u16(0);

  return out.bytes();
}
