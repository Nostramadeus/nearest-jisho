// app/sw.js run in a node vm with stubbed self, caches and fetch (SPEC 12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { stamp } from '../tools/stamp-shell.mjs';

const SW_SOURCE = readFileSync(fileURLToPath(new URL('../app/sw.js', import.meta.url)), 'utf8');
const REMOTE = 'https://nostramadeus.github.io/nearest-jisho/';

class FakeCache {
  constructor() { this.m = new Map(); }
  key(req, opts) {
    const u = new URL(typeof req === 'string' ? req : req.url);
    if (opts && opts.ignoreSearch) u.search = '';
    return u.href;
  }
  async match(req, opts) {
    const e = this.m.get(this.key(req, opts));
    return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined;
  }
  async put(req, resp) {
    this.m.set(this.key(req), { body: await resp.arrayBuffer(), status: resp.status, headers: Object.fromEntries(resp.headers) });
  }
}

/** One service worker instance on `origin`, with a fake network. files: url -> body | status number. */
function makeSW({ origin = 'https://localhost/', built = 0, version = 'test-1', net = {} } = {}) {
  const store = new Map();
  const caches = {
    keys: async () => Array.from(store.keys()),
    open: async (n) => { if (!store.has(n)) store.set(n, new FakeCache()); return store.get(n); },
    delete: async (n) => store.delete(n),
  };
  for (const n of ['addAll']) FakeCache.prototype[n] = async function (list) {
    for (const f of list) { const r = await fetchStub(new URL(f, origin).href); await this.put(new URL(f, origin).href, r); }
  };
  const calls = [];
  async function fetchStub(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    const v = net[url];
    if (v === undefined) return new Response('not found', { status: 404 });
    if (typeof v === 'number') return new Response('x', { status: v });
    if (typeof v === 'function') return v();
    return new Response(v, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  const listeners = {};
  const self = {
    location: new URL(origin),
    registration: { scope: origin },
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const { sw } = stamp(SW_SOURCE, version, built);
  const ctx = vm.createContext({ self, caches, fetch: fetchStub, Response, URL, Date, console, setTimeout });
  vm.runInContext(sw, ctx);
  const fire = async (type, ev) => { for (const f of listeners[type] || []) f(ev); };
  return {
    store, calls, caches, listeners,
    async install() { const w = []; await fire('install', { waitUntil: (p) => w.push(p) }); await Promise.all(w); },
    async activate() { const w = []; await fire('activate', { waitUntil: (p) => w.push(p) }); await Promise.all(w); await settle(); },
    async get(path, mode = 'no-cors') {
      const ev = { request: { method: 'GET', url: new URL(path, origin).href, mode, cache: 'default' }, respondWith(p) { this.r = p; }, waitUntil(p) { this.w = p; } };
      await fire('fetch', ev);
      const resp = ev.r ? await ev.r : null;
      if (ev.w) await ev.w;
      return resp ? await resp.text() : null;
    },
    async message(data) {
      let got;
      const w = [];
      await fire('message', { data, ports: [{ postMessage: (m) => { got = JSON.parse(JSON.stringify(m)); } }], waitUntil: (p) => w.push(p) });
      await Promise.all(w);
      return got;
    },
    shellJsonCalls: () => calls.filter((c) => c.url === REMOTE + 'shell.json').length,
  };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1)); };

const SHELL_FILES = stamp(SW_SOURCE, 'x', 0).shell.files;
function network(origin, { remoteBuilt = 1000, missing = null } = {}) {
  const net = {};
  for (const f of SHELL_FILES) {
    const rel = f.replace(/^\.\//, '');
    net[new URL(rel, origin).href] = `bundled ${rel || 'index'}`;
    net[REMOTE + rel] = rel === missing ? 404 : `remote ${rel || 'index'}`;
  }
  net[REMOTE + 'shell.json'] = JSON.stringify({ built: remoteBuilt, version: 'v-remote', files: SHELL_FILES });
  net[new URL('data/words.dat', origin).href] = 'bundled data';
  net[REMOTE + 'data/words.dat'] = 'remote data';
  return net;
}

test('newer shell.json: complete cache written, served from the next start (navigation)', async () => {
  const o = 'https://localhost/';
  const sw = makeSW({ origin: o, net: network(o) });
  await sw.install();
  assert.equal(await sw.get('main.js'), 'bundled main.js'); // before activation's check: bundled
  await sw.activate();
  const name = 'nj-remote-shell-1000';
  assert.ok(sw.store.has(name));
  assert.ok(await sw.store.get(name).match(o + '__complete__'));
  assert.equal(sw.shellJsonCalls(), 1);
  assert.equal(sw.calls.find((c) => c.url === REMOTE + 'shell.json').init.cache, 'no-store');
  // same start: a sub-resource keeps the version chosen before the download
  assert.equal(await sw.get('render.js'), 'bundled render.js');
  // next start (a navigation): the remote shell is used
  assert.equal(await sw.get('', 'navigate'), 'remote index');
  assert.equal(await sw.get('index.html?x=1', 'navigate'), 'remote index.html');
  assert.equal(await sw.get('main.js'), 'remote main.js');
  // data requests are untouched
  assert.equal(await sw.get('data/words.dat'), 'bundled data');
  // shell-info
  assert.deepEqual(await sw.message({ type: 'shell-info' }),
    { type: 'shell-info', bundled: 'test-1', bundledBuilt: 0, active: 'v-remote', remoteBuilt: 1000 });
});

test('one file 404: partial cache deleted, bundled shell still served', async () => {
  const o = 'https://localhost/';
  const sw = makeSW({ origin: o, net: network(o, { missing: 'worker.js' }) });
  await sw.install();
  await sw.activate();
  assert.ok(!Array.from(sw.store.keys()).some((n) => n.startsWith('nj-remote-shell-')));
  assert.equal(await sw.get('', 'navigate'), 'bundled index');
  assert.equal(await sw.get('main.js'), 'bundled main.js');
  assert.deepEqual(await sw.message({ type: 'shell-info' }),
    { type: 'shell-info', bundled: 'test-1', bundledBuilt: 0, active: 'test-1', remoteBuilt: 0 });
});

test('not newer than SHELL_BUILT: nothing downloaded', async () => {
  const o = 'http://127.0.0.1:47831/';
  const sw = makeSW({ origin: o, built: 2000, net: network(o, { remoteBuilt: 1000 }) });
  await sw.install();
  await sw.activate();
  assert.equal(sw.shellJsonCalls(), 1); // 127.0.0.1 counts as an installed app
  assert.ok(!Array.from(sw.store.keys()).some((n) => n.startsWith('nj-remote-shell-')));
  assert.equal(await sw.get('', 'navigate'), 'bundled index');
});

test('website host (not localhost): no check, normal shell cache', async () => {
  const o = 'https://example.org/nearest-jisho/'; // any website host
  const sw = makeSW({ origin: o, net: network(o) });
  await sw.install();
  await sw.activate();
  assert.equal(await sw.get('', 'navigate'), 'bundled index');
  assert.equal(sw.shellJsonCalls(), 0);
  assert.equal((await sw.message({ type: 'shell-info' })).remoteBuilt, 0);
});

test('6-hour throttle', async () => {
  const o = 'https://localhost/';
  const sw = makeSW({ origin: o, net: network(o, { remoteBuilt: 1000 }) });
  await sw.install();
  await sw.activate();
  assert.equal(sw.shellJsonCalls(), 1);
  await sw.get('', 'navigate');
  await sw.get('', 'navigate');
  assert.equal(sw.shellJsonCalls(), 1); // within 6 hours: no second check
  // pretend the last check was 7 hours ago
  const meta = sw.store.get('nj-shell-meta');
  await meta.put(o + '__last_check__', new Response(String(Date.now() - 7 * 3600 * 1000)));
  await sw.get('', 'navigate');
  assert.equal(sw.shellJsonCalls(), 2);
  // 5 hours ago: still throttled
  await meta.put(o + '__last_check__', new Response(String(Date.now() - 5 * 3600 * 1000)));
  await sw.get('', 'navigate');
  assert.equal(sw.shellJsonCalls(), 2);
});

test('stamp-shell: both constants stamped, shell.json from the SHELL list, missing line fails', () => {
  const { sw, shell } = stamp(SW_SOURCE, '2026-11-13-abc1234', 1763020800);
  assert.match(sw, /^const SHELL_VERSION = '2026-11-13-abc1234';$/m);
  assert.match(sw, /^const SHELL_BUILT = 1763020800;/m);
  assert.equal(shell.built, 1763020800);
  assert.equal(shell.version, '2026-11-13-abc1234');
  assert.ok(shell.files.includes('./index.html') && shell.files.includes('./favorites.js') && shell.files.includes('./search/entry.js'));
  assert.ok(!shell.files.some((f) => f.includes('shell.json')));
  assert.match(SW_SOURCE, /^const SHELL_BUILT = 0;/m); // placeholder in the repo
  assert.throws(() => stamp(SW_SOURCE.replace(/^const SHELL_BUILT = 0;.*$/m, ''), 'v', 1), /SHELL_BUILT/);
  assert.throws(() => stamp(SW_SOURCE.replace(/^const SHELL_VERSION = .*$/m, ''), 'v', 1), /SHELL_VERSION/);
});
