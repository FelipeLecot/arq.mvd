// Maximum-compression .gz siblings for every built data asset.
//
// Run standalone (by the Build Data workflow, before the S3 sync) or imported by
// scripts/bundle.mjs for local builds. Compressing once at build time keeps the dev
// server and any static host from re-compressing multi-MB topology per request, and
// keeps the wire payload ~5-10x smaller than the JSON alone.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { DATA_DIR } from './paths.mjs';

/** Write `file.gz` alongside `file`. */
export async function precompress(file) {
  const gz = await gzipSync(await readFile(file), { level: 9 });
  await writeFile(`${file}.gz`, gz);
}

/** Precompress every top-level data/*.json. Skips cleanly when data/ doesn't exist —
 * a fresh checkout (e.g. the Deploy workflow) has none, since data is never committed. */
export async function precompressData() {
  if (!existsSync(DATA_DIR)) return;
  for (const name of await readdir(DATA_DIR)) {
    if (name.endsWith('.json')) await precompress(join(DATA_DIR, name));
  }
}

const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await precompressData();
  console.log('precompressed data/');
}
