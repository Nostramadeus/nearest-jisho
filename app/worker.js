// Web Worker shell (SPEC 6, 14.3): picks the data in use pack by pack, loads packs, runs the engine, posts results.
import { PackStore, SENT, LOAD_ORDER } from './search/packs.js';
import { search } from './search/engine.js';
import { findEntry, entryData } from './search/entry.js';
import {
  chooseData, readerFor, versionOf, builtOf, checkUpdates, filesOf, DATA_BASE, BUNDLED_CACHE,
  updateAction, findUpdate, downloadPacks, updateOfferText, updateSignature, allMatch,
} from './datasets.js';

const post = (m) => self.postMessage(m);
const hasCaches = typeof caches !== 'undefined';

let store = null;
let inUse = {};     // pack -> { source: 'bundled' | 'cache', cacheName?, entry, built } (datasets.js)
let latestSeq = 0;
const loaded = {};
const failed = {};
let kanjiDone = false;
const pendingEntries = []; // entry requests that wait for their pack (direct visit to an entry address)
let started = false;      // all packs attempted
const settings = { updates: 'ask', connectionType: undefined }; // from the page (SPEC 14.3, 15)
let offer = null;      // the update found last: { remote, packs } (SPEC 15 bar)
let download = null;   // AbortController of the running download

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

// ---------- loading ----------

async function start() {
  const deps = { caches: hasCaches ? caches : null, fetch: (...a) => fetch(...a) };
  ({ inUse } = await chooseData(deps));
  if (!Object.keys(inUse).length) { post({ type: 'error', message: 'Dictionary data not found.' }); return; }
  if (hasCaches) dropBundledCopies();
  store = new PackStore(readerFor(inUse, { ...deps, read: readResponse }));
  store.version = versionOf(inUse);
  post({ type: 'version', built: builtOf(inUse) });
  // SPEC 13.4 load order: words, kanji, wikt, sent, names. A missing or failed pack never blocks the others.
  for (const p of LOAD_ORDER) {
    if (p === 'kanji') {
      try { await store.loadKanji(); } catch { /* kanji blocks show only the character */ }
      kanjiDone = true;
      flushEntries();
      continue;
    }
    if (!inUse[p]) continue;
    try {
      const onProgress = (f) => post({ type: 'progress', pack: p, pct: Math.floor(f * 100) });
      post({ type: 'progress', pack: p, pct: 0 });
      if (p === SENT) await store.loadSent(onProgress);
      else { await store.loadPack(p, onProgress); store.warm(p); }
      loaded[p] = true;
      post({ type: 'loaded', pack: p });
      flushEntries();
    } catch (e) {
      failed[p] = true;
      if (p === SENT) post({ type: 'loaded', pack: p, failed: true }); // the entry page drops "Loading sentences…"
      else post({ type: 'packError', pack: p, message: String(e && e.message || e) });
    }
  }
  started = true;
  flushEntries();
  post({ type: 'done' });
  checkUpdate();
}

/** The sw.js copy of a bundled pack is not needed once a downloaded copy of that pack is in use. */
async function dropBundledCopies() {
  try {
    const c = await caches.open(BUNDLED_CACHE);
    for (const [p, u] of Object.entries(inUse)) {
      if (u.source !== 'cache') continue;
      for (const f of filesOf(p, u.entry)) await c.delete(new URL(DATA_BASE + f, self.location.href).href);
    }
  } catch { /* nothing to clean */ }
}

// ---------- update check (SPEC 14.3, 15) ----------

const deps = () => ({ caches, fetch: (...a) => fetch(...a) });
function connType() {
  const c = settings.connectionType !== undefined ? settings.connectionType
    : (self.navigator && self.navigator.connection && self.navigator.connection.type) || undefined;
  return c || undefined;
}
function postOffer(f, manual) {
  offer = { remote: f.remote, packs: f.packs };
  post({
    type: 'updateOffer', manual, built: f.remote.built, packs: f.packs,
    text: updateOfferText(f.remote, f.packs), signature: updateSignature(f.remote),
  });
}

/** At start: Always (or Wi-Fi on Wi-Fi) downloads; Ask each time (or Wi-Fi off Wi-Fi) offers; Never does nothing. */
async function checkUpdate() {
  if (!hasCaches || (self.navigator && self.navigator.onLine === false)) return;
  const action = updateAction(settings.updates, connType());
  if (action === 'skip') return;
  if (action === 'auto') {
    const r = await checkUpdates({ ...deps(), inUse, policy: 'always' });
    if (r.downloaded.length) post({ type: 'updateReady', built: r.remote.built, packs: r.downloaded });
    if (r.allMatch && r.remote) post({ type: 'version', built: r.remote.built }); // every pack equals the published one
    return;
  }
  const f = await findUpdate({ ...deps(), inUse });
  if (f.status === 'available') postOffer(f, false);
  else if (f.status === 'uptodate' && allMatch(f.remote, inUse)) post({ type: 'version', built: f.remote.built });
}

/** "Check for dictionary updates now": runs regardless of the setting and of a remembered "Not now". */
async function checkNow() {
  if (!hasCaches || download) { post({ type: 'checkResult', status: download ? 'busy' : 'unreachable' }); return; }
  const f = await findUpdate({ ...deps(), inUse });
  if (f.status === 'available') { postOffer(f, true); post({ type: 'checkResult', status: 'available' }); return; }
  if (f.status === 'uptodate' && allMatch(f.remote, inUse)) post({ type: 'version', built: f.remote.built });
  post({ type: 'checkResult', status: f.status });
}

/** The bar's Download / Try again: all packs of the offer, or nothing (partial data is deleted). */
async function startDownload() {
  if (!offer || download || !hasCaches) return;
  download = new AbortController();
  const r = await downloadPacks({
    ...deps(), remote: offer.remote, packs: offer.packs, inUse, signal: download.signal, allOrNothing: true,
    onProgress: (pack, pct) => post({ type: 'downloadProgress', pack, pct }),
  });
  download = null;
  if (r.ok) offer = null;
  post({ type: 'downloadDone', ok: r.ok, cancelled: r.cancelled });
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

// Entry page (SPEC 10.2): answered once its pack and the kanji data are in (or every pack was tried).
function answerEntry(m) {
  const id = findEntry(store, m.pack, m.w, m.r);
  // sentences: still loading only while the sentence pack is listed and neither loaded nor failed
  const sentLoading = !!inUse[SENT] && !loaded[SENT] && !failed[SENT];
  const data = id < 0 ? null : entryData(store, m.pack, id, { ranking: m.ranking, sentLoading });
  post({ type: 'entry', id: m.id, pack: m.pack, w: m.w, r: m.r, data });
}
function entryReady(m) {
  return started || (loaded[m.pack] && kanjiDone);
}
function flushEntries() {
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    const m = pendingEntries[i];
    if (entryReady(m)) { pendingEntries.splice(i, 1); answerEntry(m); }
  }
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'search') {
    latestSeq = m.seq;
    if (!store || !loaded.words) { post({ type: 'result', seq: m.seq, phase: 'full', query: m.query, result: null, loaded: { ...loaded } }); return; }
    if (m.phase !== 'full') runSearch(m, 'fast');
    // a newer query cancels older work: the full phase runs only if nothing newer arrived meanwhile
    setTimeout(() => { if (m.seq === latestSeq) runSearch(m, 'full'); }, 0);
  } else if (m.type === 'settings') {
    if (m.updates) settings.updates = m.updates;
    settings.connectionType = m.connectionType || undefined;
  } else if (m.type === 'checkNow') {
    checkNow();
  } else if (m.type === 'download') {
    startDownload();
  } else if (m.type === 'cancelDownload') {
    if (download) download.abort();
  } else if (m.type === 'entry') {
    if (store && entryReady(m)) answerEntry(m);
    else pendingEntries.push(m);
  }
};

start().catch((e) => post({ type: 'error', message: String(e && e.message || e) }));
