// Service worker (SPEC 6 and 12): app shell and data files from Cache Storage; no re-download on page open.
// In the installed apps (host localhost / 127.0.0.1) it also fetches newer app files from the website (SPEC 12).
const SHELL_VERSION = '2026-11-13.2';
const SHELL_BUILT = 0; // epoch seconds of the build, stamped by CI together with SHELL_VERSION
const SHELL_CACHE = `nj-shell-${SHELL_VERSION}`;
const DATA_CACHE = 'nj-bundled-data';
const SHELL = [
  './', './index.html', './about.html', './style.css', './main.js', './render.js', './labels.js', './favorites.js', './worker.js',
  './search/romaji.js', './search/fold.js', './search/cost.js', './search/deinflect.js', './search/engine.js', './search/entry.js', './search/packs.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

// ---- SPEC 12: app code updates inside the installed apps ----
const REMOTE_BASE = 'https://nostramadeus.github.io/nearest-jisho/';
const REMOTE_PREFIX = 'nj-remote-shell-';
const COMPLETE = '__complete__';
const META_CACHE = 'nj-shell-meta';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const isApp = () => self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';
const scopeUrl = () => new URL(self.registration.scope);
const keyFor = (rel) => new URL(rel, scopeUrl()).href; // cache key: path relative to the scope
const relOf = (path) => String(path).replace(/^\.\//, '').replace(/^\//, '');

/** Newest complete remote shell: { name, built, version } or null. */
async function newestRemote() {
  let best = null;
  for (const name of await caches.keys()) {
    if (!name.startsWith(REMOTE_PREFIX)) continue;
    const built = Number(name.slice(REMOTE_PREFIX.length)) || 0;
    const marker = await (await caches.open(name)).match(keyFor(COMPLETE));
    if (!marker) continue;
    if (!best || built > best.built) {
      let version = '';
      try { version = (await marker.json()).version || ''; } catch { /* keep empty */ }
      best = { name, built, version };
    }
  }
  return best;
}

// The remote shell in use is chosen at a navigation (an app start); a download that finishes later is used from
// the next start, so one page never mixes two versions.
let inUse; // undefined = not chosen yet; null = bundled shell
async function chooseInUse() {
  inUse = null;
  if (!isApp()) return inUse;
  const r = await newestRemote();
  if (r && r.built > SHELL_BUILT) inUse = r;
  return inUse;
}

/** Check for newer app files (at most once per 6 hours). Never throws. */
async function checkRemoteShell() {
  if (!isApp()) return;
  try {
    const meta = await caches.open(META_CACHE);
    const last = await meta.match(keyFor('__last_check__'));
    if (last) {
      const t = Number(await last.text()) || 0;
      if (Date.now() - t < CHECK_EVERY_MS) return;
    }
    await meta.put(keyFor('__last_check__'), new Response(String(Date.now())));
    // leftovers of an interrupted download (no marker) are removed
    for (const name of await caches.keys()) {
      if (!name.startsWith(REMOTE_PREFIX)) continue;
      if (!(await (await caches.open(name)).match(keyFor(COMPLETE)))) await caches.delete(name);
    }
    const resp = await fetch(REMOTE_BASE + 'shell.json', { cache: 'no-store' });
    if (!resp.ok) return;
    const info = await resp.json();
    const built = Number(info && info.built) || 0;
    const have = await newestRemote();
    if (!(built > SHELL_BUILT && built > (have ? have.built : 0))) return;
    if (!Array.isArray(info.files) || !info.files.length) return;
    const name = REMOTE_PREFIX + built;
    const cache = await caches.open(name);
    try {
      for (const f of info.files) {
        const rel = relOf(f);
        const r = await fetch(REMOTE_BASE + rel, { cache: 'no-store' });
        if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${rel}`);
        // stored as a fresh same-origin response (no URL): a module's import.meta.url and the page's own URL stay
        // on this origin instead of the website's
        const type = r.headers.get('content-type') || 'application/octet-stream';
        await cache.put(keyFor(rel), new Response(await r.arrayBuffer(), { status: 200, headers: { 'content-type': type } }));
      }
      await cache.put(keyFor(COMPLETE), new Response(JSON.stringify({ built, version: String(info.version || '') })));
      for (const n of await caches.keys()) if (n.startsWith(REMOTE_PREFIX) && n !== name) await caches.delete(n);
    } catch {
      await caches.delete(name); // a failed or partial download changes nothing
    }
  } catch { /* offline or blocked: try again later */ }
}

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('nj-shell-') && name !== SHELL_CACHE && name !== META_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
  // not part of waitUntil: activation (and every fetch waiting for it) must not wait for downloads
  checkRemoteShell();
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = scopeUrl();
  if (!url.pathname.startsWith(scope.pathname)) return;
  const isData = url.pathname.startsWith(scope.pathname + 'data/');
  if (isData) {
    // the worker's update check and update downloads ask for fresh copies: go to the network
    if (req.cache === 'no-cache' || req.cache === 'no-store' || req.cache === 'reload') return;
    ev.respondWith(cacheFirst(req, DATA_CACHE));
    return;
  }
  const nav = req.mode === 'navigate';
  if (nav && isApp()) ev.waitUntil(checkRemoteShell()); // never awaited by the response
  ev.respondWith(serveShell(req, url.pathname.slice(scope.pathname.length), nav));
});

async function serveShell(req, rel, nav) {
  if (isApp()) {
    const r = nav || inUse === undefined ? await chooseInUse() : inUse;
    if (r) {
      const hit = await (await caches.open(r.name)).match(keyFor(rel), { ignoreSearch: true });
      if (hit) return hit;
    }
  }
  return cacheFirst(req, SHELL_CACHE);
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok && resp.status === 200 && resp.type === 'basic') cache.put(req, resp.clone()).catch(() => {});
  return resp;
}

// shell-info (SPEC 12): which app files are in use
self.addEventListener('message', (ev) => {
  if (!ev.data || ev.data.type !== 'shell-info') return;
  const reply = async () => {
    const r = inUse === undefined ? await chooseInUse() : inUse;
    const msg = {
      type: 'shell-info', bundled: SHELL_VERSION, bundledBuilt: SHELL_BUILT,
      active: r ? (r.version || String(r.built)) : SHELL_VERSION, remoteBuilt: r ? r.built : 0,
    };
    if (ev.ports && ev.ports[0]) ev.ports[0].postMessage(msg);
    else if (ev.source) ev.source.postMessage(msg);
  };
  if (ev.waitUntil) ev.waitUntil(reply()); else reply();
});
