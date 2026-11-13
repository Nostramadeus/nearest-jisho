// Service worker (SPEC 6): app shell and data files from Cache Storage; no re-download on page open.
const SHELL_VERSION = '2026-11-13.1';
const SHELL_CACHE = `nj-shell-${SHELL_VERSION}`;
const DATA_CACHE = 'nj-bundled-data';
const SHELL = [
  './', './index.html', './about.html', './style.css', './main.js', './render.js', './labels.js', './worker.js',
  './search/romaji.js', './search/fold.js', './search/cost.js', './search/deinflect.js', './search/engine.js', './search/packs.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('nj-shell-') && name !== SHELL_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  const isData = url.pathname.startsWith(scope.pathname + 'data/');
  // the worker's update check and update downloads ask for fresh copies: go to the network
  if (isData && (req.cache === 'no-cache' || req.cache === 'no-store' || req.cache === 'reload')) return;
  ev.respondWith(cacheFirst(req, isData ? DATA_CACHE : SHELL_CACHE));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok && resp.status === 200 && resp.type === 'basic') cache.put(req, resp.clone()).catch(() => {});
  return resp;
}
