// esbuild bundle + a dev server that also serves data/ and the static shell.
//
// Every build also emits a maximum-compression .gz next to each served asset (bundle and
// data files alike). The dev server serves those when the client advertises gzip support;
// a production host with gzip_static/brotli_static-style serving can use the same files
// directly. The data payload is JSON topology, which compresses roughly 5-10x — without
// this, first load ships tens of MB that the wire never needed to carry.

import { createServer } from 'node:http';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { ROOT, DIST_DIR, SRC_DIR, DATA_DIR } from './paths.mjs';

const serve = process.argv.includes('--serve');
const PORT = Number(process.env.PORT || 5173);

const buildOptions = {
  entryPoints: [join(SRC_DIR, 'main.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: join(DIST_DIR, 'bundle.js'),
  sourcemap: serve,
  minify: !serve,
  logLevel: 'info',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Write `file.gz` alongside `file`, compressed once at build time instead of per request. */
async function precompress(file) {
  const gz = await gzipSync(await readFile(file), { level: 9 });
  await writeFile(`${file}.gz`, gz);
}

if (!serve) {
  await esbuild.build(buildOptions);
  await precompress(join(DIST_DIR, 'bundle.js'));
  for (const name of await readdir(DATA_DIR)) {
    // Only top-level data assets; skip anything already compressed (.gz) or non-data.
    if (name.endsWith('.json')) await precompress(join(DATA_DIR, name));
  }
  console.log('bundled to dist/bundle.js');
} else {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();

  createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';

    // Contain path traversal: resolve, then require the result stays under ROOT.
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(normalize(ROOT))) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const headers = {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      Vary: 'Accept-Encoding',
    };

    try {
      // Read fully before touching the response: a watch-mode rebuild can rewrite or
      // briefly remove a file between the existence check and the read, and once a 200
      // has gone out the only legal fallback left is destroying the socket.
      let body;
      if (/gzip/.test(req.headers['accept-encoding'] ?? '') && existsSync(`${file}.gz`)) {
        // Serve the precompressed sibling when the client accepts gzip.
        body = await readFile(`${file}.gz`);
        headers['Content-Encoding'] = 'gzip';
      } else {
        body = await readFile(file);
      }

      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }).listen(PORT, () => {
    console.log(`\n  Atlas de Montevideo — http://localhost:${PORT}\n`);
  });
}
