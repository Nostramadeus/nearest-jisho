// Data packs in use and the per-pack update check (SPEC 6, replaced in part by SPEC 14.3).
// No DOM. Cache Storage and fetch are passed in, so node tests can stub them.
import { packFiles, KANJI_FILE, VERSION_FILE } from './search/packs.js';

export const DATA_BASE = './data/';
export const REMOTE_BASE = 'https://nostramadeus.github.io/nearest-jisho/data/';
export const DATA_PACKS = ['words', 'kanji', 'wikt', 'sent', 'names']; // version.json "packs" keys, load order
export const PACK_PREFIX = 'nj-pack-';           // one Cache Storage cache per downloaded pack copy
export const OLD_SET_PREFIX = 'nj-data-';        // whole data sets of the first update scheme (SPEC 6), superseded
export const BUNDLED_CACHE = 'nj-bundled-data';  // filled by sw.js for ./data/ requests
export const COMPLETE = 'complete.json';         // marker written last; a copy without it is ignored and removed

/** File names of a pack: the version.json "files" list (SPEC 14.2), else the fixed layout. */
export function filesOf(pack, entry) {
  if (entry && Array.isArray(entry.files) && entry.files.length) return entry.files;
  return pack === 'kanji' ? [KANJI_FILE] : packFiles(pack);
}

/** Identity of a pack copy: its hash; a copy without a hash (older build) is identified by its build date. */
export const copyKey = (entry, built) => (entry && entry.hash ? entry.hash : `built-${built}`);
export const cacheNameOf = (pack, key) => `${PACK_PREFIX}${pack}-${key}`;
const markerUrl = () => REMOTE_BASE + COMPLETE;

/**
 * Pick, per pack, the newest complete copy among the bundled data (./data/) and downloaded pack copies.
 * Ties go to the downloaded copy (no network). Older downloaded copies, incomplete ones and old whole-set
 * caches are removed. Returns { bundled, inUse: { pack: { source, cacheName?, entry, built } } }.
 */
export async function chooseData({ caches, fetch, base = DATA_BASE }) {
  let bundled = null;
  try {
    const r = await fetch(base + VERSION_FILE);
    if (r.ok) bundled = await r.json();
  } catch { /* no bundled data */ }
  const downloaded = {};
  if (caches) {
    for (const name of await caches.keys()) {
      if (name.startsWith(OLD_SET_PREFIX)) { await caches.delete(name); continue; }
      if (!name.startsWith(PACK_PREFIX)) continue;
      try {
        const m = await (await caches.open(name)).match(markerUrl());
        if (!m) { await caches.delete(name); continue; }
        const info = await m.json();
        (downloaded[info.pack] ||= []).push({ source: 'cache', cacheName: name, entry: info.entry, built: info.built });
      } catch { await caches.delete(name).catch(() => {}); }
    }
  }
  const inUse = {};
  for (const p of DATA_PACKS) {
    const cands = [];
    if (bundled && bundled.packs && bundled.packs[p]) cands.push({ source: 'bundled', entry: bundled.packs[p], built: bundled.built });
    cands.push(...(downloaded[p] || []));
    if (!cands.length) continue;
    cands.sort((a, b) => (a.built < b.built ? 1 : a.built > b.built ? -1 : (a.source === 'cache' ? -1 : 1)));
    inUse[p] = cands[0];
    if (caches) for (const c of cands.slice(1)) if (c.source === 'cache') await caches.delete(c.cacheName);
  }
  return { bundled, inUse };
}

/** The date shown as "Dictionary data": the newest build date among the packs in use. */
export function builtOf(inUse) {
  let b = '';
  for (const u of Object.values(inUse)) if (u.built > b) b = u.built;
  return b;
}

/** A version.json-like object describing the data in use (for PackStore progress and sizes). */
export function versionOf(inUse) {
  const packs = {};
  for (const [p, u] of Object.entries(inUse)) packs[p] = u.entry;
  return { built: builtOf(inUse), packs };
}

/** File reader for PackStore over the packs in use: Cache Storage copy or bundled ./data/. */
export function readerFor(inUse, { caches, fetch, base = DATA_BASE, read }) {
  const owner = new Map();
  for (const [p, u] of Object.entries(inUse)) for (const f of filesOf(p, u.entry)) owner.set(f, u);
  return async (name, onBytes) => {
    const u = owner.get(name);
    if (u && u.source === 'cache') {
      const resp = await (await caches.open(u.cacheName)).match(REMOTE_BASE + name);
      if (!resp) throw new Error(`missing ${name}`);
      return read(resp, onBytes);
    }
    return read(await fetch(base + name), onBytes);
  };
}

// ---------- update choice (SPEC 14.3, 15) ----------

/** "Download dictionary updates": 'ask' (default) | 'always' | 'wifi' | 'never'. */
export const UPDATE_CHOICES = ['ask', 'always', 'wifi', 'never'];
/** Stored choice -> choice in use: a stored always / wifi / never is kept, anything else is "Ask each time". */
export function loadUpdateChoice(stored) {
  return UPDATE_CHOICES.includes(stored) ? stored : 'ask';
}

/**
 * What the update check does with a found update: 'auto' (download), 'ask' (show the bar), 'skip'.
 * connectionType = navigator.connection.type, or undefined when the browser does not report it.
 * "Only on Wi-Fi" off Wi-Fi asks instead of skipping (SPEC 15); with an unknown type it behaves as Always (14.3).
 */
export function updateAction(policy, connectionType) {
  if (policy === 'never') return 'skip';
  if (policy === 'ask') return 'ask';
  if (policy === 'wifi' && connectionType) return connectionType === 'wifi' || connectionType === 'ethernet' ? 'auto' : 'ask';
  return 'auto';
}
/** True when the update check may download without asking. */
export const mayDownload = (policy, connectionType) => updateAction(policy, connectionType) === 'auto';
export const WIFI_UNKNOWN_NOTE = 'This device does not report its connection type; updates download on any connection.';
export const wifiNoteShown = (policy, connectionType) => policy === 'wifi' && !connectionType;

// ---------- finding and downloading an update ----------

/** Same identity for the same published update: the set of remote pack hashes ("Not now" remembers it). */
export function updateSignature(remote) {
  return Object.keys((remote && remote.packs) || {}).sort().map((p) => `${p}:${remote.packs[p].hash || `built-${remote.built}`}`).join(',');
}

/**
 * Look for an update without downloading: { status: 'available' | 'uptodate' | 'unreachable', remote, packs }.
 * packs = the packs whose remote hash differs from the copy in use and that are not already downloaded
 * (a downloaded copy waits for the next start).
 */
export async function findUpdate({ caches, fetch, inUse }) {
  let remote;
  try {
    const r = await fetch(REMOTE_BASE + VERSION_FILE, { cache: 'no-cache' });
    if (!r.ok) return { status: 'unreachable', remote: null, packs: [] };
    remote = await r.json();
  } catch { return { status: 'unreachable', remote: null, packs: [] }; }
  const names = caches ? await caches.keys() : [];
  const packs = [];
  for (const p of DATA_PACKS) {
    const re = remote.packs && remote.packs[p];
    if (!re) continue;
    const use = inUse[p];
    if (use && use.entry && use.entry.hash && re.hash && use.entry.hash === re.hash) continue; // equal: never again
    const name = cacheNameOf(p, copyKey(re, remote.built));
    if (use && use.cacheName === name) continue;
    if (caches && names.includes(name) && await (await caches.open(name)).match(markerUrl())) continue;
    packs.push(p);
  }
  return { status: packs.length ? 'available' : 'uptodate', remote, packs };
}

/** "about <N> MB" from gz, or "up to <N> MB" when a pack has no gz (its bytes are used); N rounded up. */
export function updateSize(remote, packs) {
  let sum = 0, upTo = false;
  for (const p of packs) {
    const e = remote.packs[p] || {};
    if (Number.isInteger(e.gz) && e.gz > 0) sum += e.gz;
    else { upTo = true; sum += e.bytes || 0; }
  }
  const mb = Math.max(1, Math.ceil(sum / (1024 * 1024)));
  return `${upTo ? 'up to' : 'about'} ${mb} MB`;
}

/** Text of the bar (SPEC 15). */
export function updateOfferText(remote, packs) {
  return `New dictionary data is available (${remote.built}, ${updateSize(remote, packs)}).`;
}

/**
 * Download packs of a found update into Cache Storage. Each pack copy is complete (all files 200, then the
 * marker) or deleted. allOrNothing: on any failure or cancel, the packs finished in this run are deleted too, so
 * nothing changes (the bar's Download button). onProgress(pack, percent). signal: AbortSignal for Cancel.
 * Returns { ok, cancelled, downloaded: [packs], failed: [packs] }.
 */
export async function downloadPacks({ caches, fetch, remote, packs, inUse = {}, onProgress, signal, allOrNothing = false }) {
  const out = { ok: true, cancelled: false, downloaded: [], failed: [] };
  const done = [];
  for (const p of packs) {
    const re = remote.packs[p];
    const name = cacheNameOf(p, copyKey(re, remote.built));
    try {
      if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
      const cache = await caches.open(name);
      const total = re.bytes || 0;
      let got = 0;
      if (onProgress) onProgress(p, 0);
      for (const f of filesOf(p, re)) {
        const r = await fetch(REMOTE_BASE + f, { cache: 'no-cache', signal });
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${f}`);
        const body = await readAll(r, (n) => { got += n; if (onProgress && total) onProgress(p, Math.min(99, Math.floor((got / total) * 100))); }, signal);
        await cache.put(REMOTE_BASE + f, new Response(body, { status: 200, headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream' } }));
      }
      await cache.put(markerUrl(), new Response(JSON.stringify({ pack: p, entry: re, built: remote.built }),
        { headers: { 'content-type': 'application/json' } }));
      if (onProgress) onProgress(p, 100);
      done.push({ p, name });
      out.downloaded.push(p);
      for (const n of await caches.keys()) {
        if (n.startsWith(`${PACK_PREFIX}${p}-`) && n !== name && !(inUse[p] && inUse[p].cacheName === n)) await caches.delete(n);
      }
    } catch (e) {
      await caches.delete(name).catch(() => {}); // partial download deleted
      out.ok = false;
      out.failed.push(p);
      if (e && (e.cancelled || e.name === 'AbortError' || (signal && signal.aborted))) out.cancelled = true;
      if (allOrNothing || out.cancelled) break;
    }
  }
  if (!out.ok && allOrNothing) {
    for (const d of done) await caches.delete(d.name).catch(() => {});
    out.downloaded = [];
  }
  return out;
}

async function readAll(resp, onBytes, signal) {
  if (!resp.body || !resp.body.getReader) {
    const b = new Uint8Array(await resp.arrayBuffer());
    onBytes(b.length);
    return b;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    if (signal && signal.aborted) { try { await reader.cancel(); } catch { /* ignore */ } throw Object.assign(new Error('cancelled'), { cancelled: true }); }
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Automatic update (14.3, choices Always and Only on Wi-Fi on Wi-Fi): download only the packs whose hash differs,
 * pack by pack. Returns { remote, downloaded, failed, allMatch, skipped }.
 */
export async function checkUpdates({ caches, fetch, inUse, policy = 'always', connectionType, onPackReady }) {
  const out = { remote: null, downloaded: [], failed: [], allMatch: false, skipped: null };
  if (!caches) { out.skipped = 'no Cache Storage'; return out; }
  if (!mayDownload(policy, connectionType)) { out.skipped = `policy ${policy}`; return out; }
  const f = await findUpdate({ caches, fetch, inUse });
  if (f.status === 'unreachable') { out.skipped = 'offline'; return out; }
  out.remote = f.remote;
  if (f.packs.length) {
    const d = await downloadPacks({ caches, fetch, remote: f.remote, packs: f.packs, inUse });
    out.downloaded = d.downloaded;
    out.failed = d.failed;
    if (onPackReady) for (const p of d.downloaded) onPackReady(p);
  }
  out.allMatch = allMatch(f.remote, inUse);
  return out;
}

/** Every published pack equals the copy in use (the settings line may show the published date). */
export function allMatch(remote, inUse) {
  return !!(remote && remote.packs) && Object.entries(remote.packs).every(([p, re]) =>
    re && re.hash && inUse[p] && inUse[p].entry && inUse[p].entry.hash === re.hash);
}

// ---------- texts and small decisions of the bar (SPEC 15) ----------

/** The bar is shown unless this exact update was answered "Not now" (a manual check always shows it). */
export const shouldShowOffer = (signature, dismissed, manual) => !!manual || signature !== dismissed;

export const UPDATE_DONE_TEXT = 'Dictionary data updated. It is used the next time the app starts.';
export const UPDATE_FAILED_TEXT = 'The download did not finish. Nothing was changed.';
/** Line under "Check for dictionary updates now" for the outcomes without a bar. */
export function checkResultText(status) {
  if (status === 'uptodate') return 'Dictionary data is up to date.';
  if (status === 'unreachable') return 'Could not reach the update server.';
  if (status === 'busy') return 'A download is already running.';
  return '';
}
