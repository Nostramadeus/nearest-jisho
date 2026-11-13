// Web Worker shell (SPEC 6): picks the data set, loads packs, runs the engine, posts results.
import { PackStore, PACKS, packFiles, packFilesBinary, KANJI_FILE, VERSION_FILE } from './search/packs.js';
import { search } from './search/engine.js';

const DATA_BASE = './data/';
const REMOTE_BASE = 'https://nostramadeus.github.io/nearest-jisho/data/';
const SET_PREFIX = 'nj-data-';          // Cache Storage sets downloaded by the update check
const BUNDLED_CACHE = 'nj-bundled-data'; // filled by sw.js for ./data/ requests
const COMPLETE = 'complete.json';        // marker written last; a set without it is ignored

const post = (m) => self.postMessage(m);
const hasCaches = typeof caches !== 'undefined';

let store = null;
let current = null; // { kind: 'bundled' | 'cache', cacheName, version }
let latestSeq = 0;
const loaded = {};

// ---------- reading files ----------

async function readResponse(resp, onBytes) {
  if (!resp || !resp.ok) throw new Error(`HTTP ${resp ? resp.status : 'none'}`);
  if (!resp.body || !resp.body.getReader) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (onBytes) onBytes(buf.length);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (onBytes) onBytes(value.length);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function makeReader(source) {
  if (source.kind === 'cache') {
    return async (name, onBytes) => {
      const cache = await caches.open(source.cacheName);
      const resp = await cache.match(REMOTE_BASE + name);
      if (!resp) throw new Error(`missing ${name}`);
      return readResponse(resp, onBytes);
    };
  }
  return async (name, onBytes) => readResponse(await fetch(DATA_BASE + name), onBytes);
}

// ---------- choosing the data set ----------

async function cacheSets() {
  if (!hasCaches) return [];
  const out = [];
  for (const name of await caches.keys()) {
    if (!name.startsWith(SET_PREFIX)) continue;
    try {
      const cache = await caches.open(name);
      const done = await cache.match(REMOTE_BASE + COMPLETE);
      const ver = await cache.match(REMOTE_BASE + VERSION_FILE);
      if (!done || !ver) { await caches.delete(name); continue; } // partial download: discard
      out.push({ kind: 'cache', cacheName: name, version: await ver.json() });
    } catch { /* ignore broken set */ }
  }
  return out;
}

async function chooseSource() {
  const candidates = [];
  try {
    const resp = await fetch(DATA_BASE + VERSION_FILE);
    if (resp.ok) candidates.push({ kind: 'bundled', version: await resp.json() });
  } catch { /* no bundled data */ }
  candidates.push(...await cacheSets());
  if (!candidates.length) return null;
  // newest `built` wins; on a tie prefer a Cache Storage set (already downloaded, no network)
  candidates.sort((a, b) => (a.version.built < b.version.built ? 1 : a.version.built > b.version.built ? -1
    : (a.kind === 'cache' ? -1 : 1)));
  const pick = candidates[0];
  if (hasCaches) {
    for (const c of candidates) if (c.kind === 'cache' && c !== pick) caches.delete(c.cacheName).catch(() => {});
    // the bundled copy cached by sw.js is outdated once a downloaded set is in use
    if (pick.kind === 'cache') caches.delete(BUNDLED_CACHE).catch(() => {});
  }
  return pick;
}

// ---------- loading ----------

async function start() {
  current = await chooseSource();
  if (!current) { post({ type: 'error', message: 'Dictionary data not found.' }); return; }
  store = new PackStore(makeReader(current));
  store.version = current.version;
  post({ type: 'version', built: current.version.built });
  for (const p of PACKS) {
    if (!current.version.packs || !current.version.packs[p]) continue;
    try {
      post({ type: 'progress', pack: p, pct: 0 });
      await store.loadPack(p, (f) => post({ type: 'progress', pack: p, pct: Math.floor(f * 100) }));
      store.warm(p);
      loaded[p] = true;
      post({ type: 'loaded', pack: p });
    } catch (e) {
      post({ type: 'packError', pack: p, message: String(e && e.message || e) });
    }
  }
  try { await store.loadKanji(); } catch { /* kanji panel shows "not available" */ }
  post({ type: 'done' });
  checkUpdate();
}

// ---------- update check (SPEC 6) ----------

async function fetchToCache(cache, name) {
  const resp = await fetch(REMOTE_BASE + name, { cache: 'no-cache' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${name}`);
  await cache.put(REMOTE_BASE + name, resp);
}

async function checkUpdate() {
  if (!hasCaches || (self.navigator && self.navigator.onLine === false)) return;
  let remote;
  try {
    const resp = await fetch(REMOTE_BASE + VERSION_FILE, { cache: 'no-cache' });
    if (!resp.ok) return;
    remote = await resp.json();
  } catch { return; }
  if (!remote || !remote.built || !(remote.built > current.version.built)) return;
  const name = SET_PREFIX + remote.built;
  if ((await caches.keys()).includes(name)) {
    const c = await caches.open(name);
    if (await c.match(REMOTE_BASE + COMPLETE)) return; // already downloaded, used from the next start
  }
  const cache = await caches.open(name);
  try {
    for (const p of PACKS) {
      if (!remote.packs || !remote.packs[p]) continue;
      try {
        for (const f of packFiles(p)) await fetchToCache(cache, f);
      } catch {
        for (const f of packFilesBinary(p)) await fetchToCache(cache, f);
      }
    }
    await fetchToCache(cache, KANJI_FILE);
    await cache.put(REMOTE_BASE + VERSION_FILE, new Response(JSON.stringify(remote), { headers: { 'content-type': 'application/json' } }));
    await cache.put(REMOTE_BASE + COMPLETE, new Response(JSON.stringify({ built: remote.built })));
    post({ type: 'updateReady', built: remote.built });
  } catch {
    await caches.delete(name).catch(() => {}); // a failed or partial download changes nothing
  }
}

// ---------- messages ----------

function resolveGroups(res) {
  for (const g of res.groups) for (const h of g.results) h.rec = store.getRecord(h.pack, h.id);
  return res;
}

function runSearch(m, phase) {
  const opts = { ranking: m.ranking, limit: m.limit || 50, groupLimits: m.groupLimits || {}, recent: m.recent || [], phase };
  const res = resolveGroups(search(store, m.query, opts));
  post({ type: 'result', seq: m.seq, phase, query: m.query, result: res, loaded: { ...loaded } });
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'search') {
    latestSeq = m.seq;
    if (!store || !loaded.words) { post({ type: 'result', seq: m.seq, phase: 'full', query: m.query, result: null, loaded: { ...loaded } }); return; }
    if (m.phase !== 'full') runSearch(m, 'fast');
    // a newer query cancels older work: the full phase runs only if nothing newer arrived meanwhile
    setTimeout(() => { if (m.seq === latestSeq) runSearch(m, 'full'); }, 0);
  } else if (m.type === 'kanji') {
    post({ type: 'kanji', id: m.id, literal: m.literal, data: store ? store.kanji(m.literal) : null });
  }
};

start().catch((e) => post({ type: 'error', message: String(e && e.message || e) }));
