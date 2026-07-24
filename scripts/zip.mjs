// Minimal zip reader — enough to pull entries out of the shapefile bundles and the
// permits CSV without adding a dependency for something this small.

import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIR = 0x06054b50;

/** List the entries in a zip, without decompressing them. */
export function listEntries(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== END_OF_CENTRAL_DIR) end--;
  if (end < 0) throw new Error('not a zip file: no end-of-central-directory record');

  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
      method: buf.readUInt16LE(p + 10),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress one entry to a Buffer. */
export function readEntry(buf, entry) {
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + (entry.method === 8 ? buf.length : entry.size));
  return entry.method === 8 ? inflateRawSync(raw) : raw.subarray(0, entry.size);
}

/** Find and read the first entry whose name matches a suffix (case-insensitive). */
export function readBySuffix(buf, suffix) {
  const entry = listEntries(buf).find((e) => e.name.toLowerCase().endsWith(suffix.toLowerCase()));
  if (!entry) throw new Error(`no ${suffix} entry in zip`);
  return readEntry(buf, entry);
}
