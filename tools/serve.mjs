/**
 * serve.mjs — dependency-free static server for local testing.
 *
 * Serves the repo root the way GitHub Pages does: NO COOP/COEP headers,
 * no caching. That matters — it is the only honest way to verify that
 * coi-serviceworker.js (the shim that makes the page crossOriginIsolated)
 * works on a host that cannot send those headers itself.
 *
 *   node tools/serve.mjs                 # http://127.0.0.1:8123
 *   node tools/serve.mjs --port 0        # pick a free port (prints the URL)
 *   node tools/serve.mjs --coop-coep     # simulate a host that DOES send them
 *   node tools/serve.mjs --root /other/path
 *
 * Prints `listening on http://host:port` on stdout once ready — the headed
 * test runner parses that line to learn the port it actually got.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.cact': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * @param {{root?: string, port?: number, coopCoep?: boolean}} [opts]
 * @returns {Promise<{port: number, url: string, close: () => Promise<void>}>}
 */
export function startStaticServer(opts = {}) {
  const root = resolve(opts.root ?? ROOT);
  const coopCoep = opts.coopCoep ?? false;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      // Contain the served path inside root (no ../ escapes).
      const target = normalize(join(root, pathname));
      if (target !== root && !target.startsWith(root + sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      let filePath = target;
      try {
        if ((await stat(filePath)).isDirectory()) filePath = join(filePath, 'index.html');
      } catch { /* fall through to the 404 below */ }

      const body = await readFile(filePath);
      const headers = {
        'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      };
      // Opt-in only: the default mimics GitHub Pages (no isolation headers).
      if (coopCoep) {
        headers['Cross-Origin-Opener-Policy'] = 'same-origin';
        headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
        headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
      }
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.on('error', reject);
    server.listen(opts.port ?? 8123, '127.0.0.1', () => {
      const { port } = server.address();
      resolvePromise({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// CLI entry — `node tools/serve.mjs`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const getFlag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  const srv = await startStaticServer({
    root: getFlag('root', ROOT),
    port: Number(getFlag('port', 8123)),
    coopCoep: args.includes('--coop-coep'),
  });
  console.log(`listening on ${srv.url}`);
  console.log(`serving ${resolve(getFlag('root', ROOT))} ` +
    `(COOP/COEP: ${args.includes('--coop-coep') ? 'sent' : 'not sent — GitHub Pages style'})`);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { srv.close().then(() => process.exit(0)); });
  }
}
