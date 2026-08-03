/* CRC-32 (IEEE 802.3), as required by the ZIP format.
 *
 * A MECHANISM in the strictest sense: the polynomial is fixed, there is one
 * correct output for any input, and there is no design decision to make. It
 * is written here only because no browser API exposes one — Node has
 * zlib.crc32, the web platform has nothing.
 *
 * Verified against the standard check value: crc32("123456789") = 0xCBF43926.
 */

let TABLE = null;

function buildTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}

export function crc32(bytes, seed = 0) {
  if (!TABLE) TABLE = buildTable();
  let c = ~seed;
  for (let i = 0; i < bytes.length; i++) {
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (~c) >>> 0;
}
