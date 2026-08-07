// Download every source into data/raw/ and leave it there.
//
// The raw cache is deliberate: intgis is the only working bulk route now that the WFS is
// down, so once a file is on disk the build must never need the network again. Re-run with
// --force to refresh.

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { RAW_DIR } from './paths.mjs';
import { SOURCES, SHP_GEN, SHP_TMP, WFS_BASE } from './sources.mjs';

const UA = 'Mozilla/5.0 (mvd-map data pipeline)';
const force = process.argv.includes('--force');

async function exists(path) {
  try {
    const s = await stat(path);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function get(url, { timeout = 300_000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function download(source) {
  const file = source.kind === 'shpgen' ? `${source.table}.zip` : source.file;
  const dest = join(RAW_DIR, file);

  if (!force && (await exists(dest))) {
    console.log(`  cached   ${file}`);
    return;
  }

  let buf;
  if (source.kind === 'shpgen') {
    // Step 1 asks the server to build the zip; its response is an HTML shim, not the data.
    // Step 2 collects the actual file from /sit/tmp/.
    await get(`${SHP_GEN}?nom_tab=${source.table}&tipo=gis`, { timeout: 300_000 });
    buf = await get(`${SHP_TMP}/${source.table}.zip`);
    // A missing table returns a ~300 byte HTML 404 page rather than a zip.
    if (buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error(`${source.table}: expected a zip, got ${buf.length} bytes of non-zip`);
    }
  } else if (source.kind === 'wfs') {
    // A WFS error comes back as an XML ExceptionReport with HTTP 200, not a clean failure —
    // check the body actually looks like the JSON GetFeature response asked for, the same
    // "don't trust a 200" discipline the shpgen branch applies via its zip-magic-number check.
    buf = await get(
      `${WFS_BASE}?service=wfs&version=2.0.0&request=GetFeature&typeName=${source.typeName}&outputFormat=application/json`,
    );
    const head = buf.toString('utf8', 0, 20).trimStart();
    if (!head.startsWith('{')) {
      throw new Error(`${source.typeName}: expected JSON, got: ${buf.toString('utf8', 0, 200)}`);
    }
  } else {
    buf = await get(source.url);
  }

  await writeFile(dest, buf);
  console.log(`  fetched  ${file}  (${(buf.length / 1e6).toFixed(2)} MB)`);
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  console.log(`Fetching ${SOURCES.length} sources into data/raw/${force ? ' (forced)' : ''}`);

  for (const source of SOURCES) {
    try {
      await download(source);
    } catch (err) {
      console.error(`  FAILED   ${source.id}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

main();
