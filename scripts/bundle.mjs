// esbuild bundle + a dev server that also serves data/ and the static shell.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import * as esbuild from 'esbuild';
import { ROOT, DIST_DIR, SRC_DIR } from './paths.mjs';

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

if (!serve) {
  await esbuild.build(buildOptions);
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

    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }).listen(PORT, () => {
    console.log(`\n  Atlas del Centro — http://localhost:${PORT}\n`);
  });
}
