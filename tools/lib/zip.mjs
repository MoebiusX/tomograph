// tools/lib/zip.mjs
//
// A tiny ZIP writer — STORE method only (no compression). Enough to bundle a
// pack manifest plus its compiled artefacts into one download. No external
// dependencies; the same module runs in Node (server export endpoint) and in
// the browser. Text artefacts compress poorly enough that STORE is a fine
// trade for zero deps, and every unzip tool reads it.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

// files: [{ name: string, data: string | Uint8Array }] → Uint8Array (the .zip).
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];        // Uint8Array chunks, in order
  const central = [];      // central-directory records
  let offset = 0;          // running offset of each local header

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);

    const local = Uint8Array.from([
      ...u32(0x04034b50),                 // local file header signature
      ...u16(20),                         // version needed to extract (2.0)
      ...u16(0),                          // general purpose flags
      ...u16(0),                          // compression method: 0 = store
      ...u16(0), ...u16(0),               // mod time, mod date (unset)
      ...u32(crc),                        // CRC-32
      ...u32(data.length),                // compressed size
      ...u32(data.length),                // uncompressed size
      ...u16(nameBytes.length),           // file name length
      ...u16(0),                          // extra field length
      ...nameBytes,
    ]);
    parts.push(local, data);
    central.push({ crc, size: data.length, nameBytes, offset });
    offset += local.length + data.length;
  }

  const cdStart = offset;
  const cdParts = [];
  for (const c of central) {
    cdParts.push(Uint8Array.from([
      ...u32(0x02014b50),                 // central file header signature
      ...u16(20),                         // version made by
      ...u16(20),                         // version needed to extract
      ...u16(0),                          // general purpose flags
      ...u16(0),                          // compression method: store
      ...u16(0), ...u16(0),               // mod time, mod date
      ...u32(c.crc),                      // CRC-32
      ...u32(c.size),                     // compressed size
      ...u32(c.size),                     // uncompressed size
      ...u16(c.nameBytes.length),         // file name length
      ...u16(0),                          // extra field length
      ...u16(0),                          // comment length
      ...u16(0),                          // disk number start
      ...u16(0),                          // internal attributes
      ...u32(0),                          // external attributes
      ...u32(c.offset),                   // local header offset
      ...c.nameBytes,
    ]));
  }
  const cdBytes = concat(cdParts);

  const eocd = Uint8Array.from([
    ...u32(0x06054b50),                   // end of central directory signature
    ...u16(0), ...u16(0),                 // disk numbers
    ...u16(central.length),               // entries on this disk
    ...u16(central.length),               // total entries
    ...u32(cdBytes.length),               // central directory size
    ...u32(cdStart),                      // central directory offset
    ...u16(0),                            // comment length
  ]);

  return concat([...parts, cdBytes, eocd]);
}

function concat(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
