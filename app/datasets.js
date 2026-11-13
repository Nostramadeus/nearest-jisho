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

/**
 * SPEC 14.3 "Download dictionary updates": 'always' | 'wifi' | 'never'. connectionType = navigator.connection.type
 * or undefined when the browser does not report it (then 'wifi' behaves as 'always').
 */
export function mayDownload(policy, connectionType) {
  if (policy === 'never') return false;
  if (policy === 'wifi' && connectionType) return connectionType === 'wifi' || connectionType === 'ethernet';
  return true;
}
export const WIFI_UNKNOWN_NOTE = 'This device does not report its connection type; updates download on any connection.';
export const wifiNoteShown = (policy, connectionType) => policy === 'wifi' && !connectionType;

/**
 * Update check (SPEC 14.3): download only the packs whose remote hash differs from the copy in use; a pack with
 * an equal hash is never downloaded again; a copy without a hash counts as different once. Each pack copy is
 * stored complete (all files answered 200, then the marker) or not at all.
 * Returns { remote, downloaded: [packs], failed: [packs], allMatch, skipped }.
 */
export async function checkUpdates({ caches, fetch, inUse, policy = 'always', connectionType, onPackReady }) {
  const out = { remote: null, downloaded: [], failed: [], allMatch: false, skipped: null };
  if (!caches) { out.skipped = 'no Cache Storage'; return out; }
  if (!mayDownload(policy, connectionType)) { out.skipped = `policy ${policy}`; return out; }
  let remote;
  try {
    const r = await fetch(REMOTE_BASE + VERSION_FILE, { cache: 'no-cache' });
    if (!r.ok) { out.skipped = `version.json HTTP ${r.status}`; return out; }
    remote = await r.json();
  } catch { out.skipped = 'offline'; return out; }
  out.remote = remote;
  const names = await caches.keys();
  for (const p of DATA_PACKS) {
    const re = remote.packs && remote.packs[p];
    if (!re) continue;
    const use = inUse[p];
    if (use && use.entry && use.entry.hash && re.hash && use.entry.hash === re.hash) continue; // equal: never again
    const name = cacheNameOf(p, copyKey(re, remote.built));
    if (use && use.cacheName === name) continue; // this very copy is in use (data without hashes)
    if (names.includes(name) && await (await caches.open(name)).match(markerUrl())) continue; // waits for next start
    const cache = await caches.open(name);
    try {
      for (const f of filesOf(p, re)) {
        const r = await fetch(REMOTE_BASE + f, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${f}`);
        await cache.put(REMOTE_BASE + f, r);
      }
      await cache.put(markerUrl(), new Response(JSON.stringify({ pack: p, entry: re, built: remote.built }),
        { headers: { 'content-type': 'application/json' } }));
      out.downloaded.push(p);
      if (onPackReady) onPackReady(p);
      // other downloaded copies of this pack, except the one in use, are no longer needed
      for (const n of await caches.keys()) {
        if (n.startsWith(`${PACK_PREFIX}${p}-`) && n !== name && !(use && use.cacheName === n)) await caches.delete(n);
      }
    } catch {
      await caches.delete(name).catch(() => {}); // a failed or partial download changes nothing
      out.failed.push(p);
    }
  }
  out.allMatch = !!remote.packs && Object.entries(remote.packs).every(([p, re]) =>
    re && re.hash && inUse[p] && inUse[p].entry && inUse[p].entry.hash === re.hash);
  return out;
}
