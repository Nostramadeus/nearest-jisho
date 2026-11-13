// Local preview: `node tools/serve.mjs [port]` serves app/ on 127.0.0.1 (default port 8377).
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)), 'app');
const port = Number(process.argv[2]) || 8377;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};

createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  if (!st.isFile()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, {
    'content-type': types[extname(file)] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
