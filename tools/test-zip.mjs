#!/usr/bin/env node
/**
 * tools/test-zip.mjs
 *
 * Round-trip test for the hand-rolled ZIP writer (tools/lib/zip.mjs). Since
 * the writer emits a binary container format, the strongest check is to read
 * it back: parse the local file headers, extract each STORE'd entry, and
 * verify names + content + an INDEPENDENTLY computed CRC-32 all agree. Also
 * asserts the central-directory / end-of-central-directory structure so the
 * archive opens in real unzip tools. Exit 0 = pass.
 */

import { makeZip } from './lib/zip.mjs';

import { createHarness } from './lib/harness.mjs';
const { assert, report } = createHarness();

// Independent CRC-32 (do NOT reuse the writer's table, so a bug there is caught).
function crc32(bytes) {
  let c = ~0 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
  }
  return (~c) >>> 0;
}

const rd16 = (b, o) => b[o] | (b[o + 1] << 8);
const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Parse a STORE-only zip by walking local file headers from the start.
function readZip(buf) {
  const dec = new TextDecoder();
  const entries = [];
  let p = 0;
  while (rd32(buf, p) === 0x04034b50) {
    const method = rd16(buf, p + 8);
    const crc = rd32(buf, p + 14);
    const size = rd32(buf, p + 22);          // uncompressed size
    const nameLen = rd16(buf, p + 26);
    const extraLen = rd16(buf, p + 28);
    const name = dec.decode(buf.subarray(p + 30, p + 30 + nameLen));
    const dataStart = p + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + size);
    entries.push({ name, method, crc, size, data });
    p = dataStart + size;
  }
  return { entries, cdStart: p };
}

// --- Fixtures: text, nested paths, unicode name, binary, and an empty file ---
const files = [
  { name: 'pack.yaml', data: 'apiVersion: observability.platform/v1\nkind: ObservabilityPack\n' },
  { name: 'artefacts/rules/svc.rules.yaml', data: 'groups:\n  - name: g\n    rules: []\n' },
  { name: 'artefacts/empty.txt', data: '' },
  { name: 'ünïcödé-name.txt', data: 'café — déjà vu' },
  { name: 'artefacts/binary.bin', data: Uint8Array.from([0, 1, 2, 253, 254, 255, 0, 128]) },
];

const enc = new TextEncoder();
const zip = makeZip(files);

assert(zip instanceof Uint8Array && zip.length > 0, 'makeZip returns a non-empty Uint8Array');
assert(rd32(zip, 0) === 0x04034b50, 'starts with a local file header signature (PK\\x03\\x04)');
// End-of-central-directory record lives in the last 22 bytes (no zip comment).
const eocd = zip.length - 22;
assert(rd32(zip, eocd) === 0x06054b50, 'ends with an end-of-central-directory record');
assert(rd16(zip, eocd + 10) === files.length, 'EOCD total-entry count matches input', rd16(zip, eocd + 10), files.length);

const { entries, cdStart } = readZip(zip);
assert(entries.length === files.length, 'every entry round-trips back out', entries.length, files.length);
assert(rd32(zip, cdStart) === 0x02014b50, 'central directory follows the file data (PK\\x01\\x02)');
assert(rd32(zip, eocd + 16) === cdStart, 'EOCD points at the central directory offset', rd32(zip, eocd + 16), cdStart);

for (let i = 0; i < files.length; i++) {
  const want = files[i];
  const got = entries[i];
  const wantBytes = typeof want.data === 'string' ? enc.encode(want.data) : want.data;
  assert(got.name === want.name, `entry ${i} name preserved (${want.name})`, got.name, want.name);
  assert(got.method === 0, `entry ${i} uses STORE (method 0)`, got.method, 0);
  assert(got.size === wantBytes.length, `entry ${i} size correct`, got.size, wantBytes.length);
  const sameBytes = got.data.length === wantBytes.length && got.data.every((b, j) => b === wantBytes[j]);
  assert(sameBytes, `entry ${i} content round-trips byte-for-byte`);
  assert(got.crc === crc32(wantBytes), `entry ${i} CRC-32 matches an independent computation`, got.crc, crc32(wantBytes));
}

// Unsafe entry names are rejected (zip-slip guard); safe relatives pass.
function rejects(name) {
  try { makeZip([{ name, data: 'x' }]); return false; } catch { return true; }
}
assert(rejects('../escape.txt'), 'rejects ../ traversal name');
assert(rejects('a/../../escape.txt'), 'rejects nested .. traversal name');
assert(rejects('..\\escape.txt'), 'rejects backslash .. traversal name');
assert(rejects('/etc/passwd'), 'rejects absolute path name');
assert(rejects('C:/windows/evil.txt'), 'rejects drive-letter path name');
assert(rejects(''), 'rejects empty name');
assert(!rejects('a/b..c/d.txt'), 'allows dots inside path segments');
{
  const z = makeZip([{ name: 'dir\\file.txt', data: 'x' }]);
  const { entries: es } = readZip(z);
  assert(es[0].name === 'dir/file.txt', 'backslash separators normalised to /', es[0].name, 'dir/file.txt');
}

// Empty archive is still a valid (if trivial) zip: just an EOCD record.
const empty = makeZip([]);
assert(empty.length === 22, 'empty file list → 22-byte EOCD-only archive', empty.length, 22);
assert(rd32(empty, 0) === 0x06054b50, 'empty archive is a lone EOCD record');

report('zip', 'all zip round-trip assertions pass.');
