// SPEC 14: per-pack hashes (build), reuse of the published data (CI), per-pack update check (app).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './helpers/fixture.mjs';
import { addPackHashes, packHash, packFileList } from '../build/lib/packwriter.mjs';
import { reuseData } from '../tools/reuse-data.mjs';
import {
  chooseData, checkUpdates, mayDownload, wifiNoteShown, WIFI_UNKNOWN_NOTE, REMOTE_BASE, cacheNameOf, versionOf, readerFor,
} from '../app/datasets.js';

const PACKS = ['words', 'names', 'wikt', 'sent', 'kanji', 'pitch'];
const appFile = (name) => readFileSync(fileURLToPath(new URL(`../app/${name}`, import.meta.url)), 'utf8');

/** Fixture data folder with "files" and "hash" in version.json. */
function hashedFixture() {
  const fx = makeFixture();
  const v = JSON.parse(readFileSync(join(fx.dir, 'version.json'), 'utf8'));
  v.packs.kanji = { n: 2, bytes: readFileSync(join(fx.dir, 'kanji.json')).length };
  addPackHashes(fx.dir, v);
  writeFileSync(join(fx.dir, 'version.json'), JSON.stringify(v));
  return { ...fx, v };
}

test('build: files and hash written for every pack, hash over the files in order', () => {
  const fx = hashedFixture();
  try {
    for (const p of PACKS) {
      const e = fx.v.packs[p];
      assert.deepEqual(e.files, packFileList(fx.dir, p), p);
      assert.match(e.hash, /^[0-9a-f]{16}$/, p);
      assert.equal(packHash(fx.dir, e.files), e.hash, p);
    }
    assert.deepEqual(fx.v.packs.sent.files, ['sent.dat', 'sent.off', 'sent.keys.json']);
    assert.deepEqual(fx.v.packs.kanji.files, ['kanji.json']);
    assert.equal(fx.v.built, '2026-11-13'); // built untouched by hashing
    // one changed byte changes the hash; order matters
    const before = packHash(fx.dir, fx.v.packs.words.files);
    assert.notEqual(packHash(fx.dir, [...fx.v.packs.words.files].reverse()), before);
    const f = join(fx.dir, 'words.meta');
    const b = readFileSync(f); b[0] ^= 1; writeFileSync(f, b);
    assert.notEqual(packHash(fx.dir, fx.v.packs.words.files), before);
  } finally { fx.cleanup(); }
});

/** fetch over a folder, as if it were published at `base`; overrides: url -> status number | text. */
function folderFetch(dir, base, overrides = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (url in overrides) {
      const o = overrides[url];
      return typeof o === 'number' ? new Response('x', { status: o }) : new Response(o, { status: 200 });
    }
    if (!url.startsWith(base)) return new Response('not found', { status: 404 });
    const f = join(dir, url.slice(base.length));
    if (!existsSync(f)) return new Response('not found', { status: 404 });
    return new Response(readFileSync(f), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

test('CI reuse: downloads every listed file, checks hashes, keeps the published version.json', async () => {
  const fx = hashedFixture();
  const out = mkdtempSync(join(tmpdir(), 'nj-reuse-'));
  const base = 'https://example.org/data/';
  try {
    const r = await reuseData({ base, out, fetchFn: folderFetch(fx.dir, base) });
    assert.equal(r.built, '2026-11-13');
    assert.equal(readFileSync(join(out, 'version.json'), 'utf8'), readFileSync(join(fx.dir, 'version.json'), 'utf8'));
    for (const p of PACKS) for (const f of fx.v.packs[p].files) assert.ok(existsSync(join(out, f)), f);
    // hash mismatch -> failure (the workflow then rebuilds)
    const bad = folderFetch(fx.dir, base, { [base + 'wikt.dat']: 'tampered' });
    await assert.rejects(reuseData({ base, out, fetchFn: bad }), /wikt: hash .* does not match/);
    // 404 -> failure
    await assert.rejects(reuseData({ base, out, fetchFn: folderFetch(fx.dir, base, { [base + 'names.off']: 404 }) }), /names.off: HTTP 404/);
    // published version.json without "files" -> failure
    const old = JSON.parse(JSON.stringify(fx.v));
    delete old.packs.sent.files;
    await assert.rejects(reuseData({ base, out, fetchFn: folderFetch(fx.dir, base, { [base + 'version.json']: JSON.stringify(old) }) }),
      /pack sent has no "files" list/);
  } finally { fx.cleanup(); rmSync(out, { recursive: true, force: true }); }
});

// ---- app side: Cache Storage stub ----
class FakeCache {
  constructor() { this.m = new Map(); }
  async match(req) { const e = this.m.get(typeof req === 'string' ? req : req.url); return e ? new Response(e.body, { status: e.status }) : undefined; }
  async put(req, resp) { this.m.set(typeof req === 'string' ? req : req.url, { body: await resp.arrayBuffer(), status: resp.status }); }
  async delete(req) { return this.m.delete(typeof req === 'string' ? req : req.url); }
}
function fakeCaches() {
  const store = new Map();
  return {
    store,
    keys: async () => Array.from(store.keys()),
    open: async (n) => { if (!store.has(n)) store.set(n, new FakeCache()); return store.get(n); },
    delete: async (n) => store.delete(n),
  };
}

/** App world: bundled ./data/ = folder A (version vA), remote = folder B (version vB). */
function world(bundledDir, remoteDir, overrides = {}) {
  const calls = [];
  const local = folderFetch(bundledDir, './data/');
  const remote = folderFetch(remoteDir, REMOTE_BASE, overrides);
  const fetch = async (url) => { calls.push(url); return url.startsWith('./data/') ? local(url) : remote(url); };
  return { caches: fakeCaches(), fetch, calls };
}
const fileCalls = (calls) => calls.filter((u) => u.startsWith(REMOTE_BASE) && !u.endsWith('version.json'));

function withVersion(dir, mutate) {
  const v = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'));
  mutate(v);
  writeFileSync(join(dir, 'version.json'), JSON.stringify(v));
  return v;
}

test('update check: only packs whose hash differs are downloaded; next start uses them', async () => {
  const A = hashedFixture(), B = hashedFixture();
  try {
    withVersion(B.dir, (v) => { v.built = '2026-12-01'; v.packs.names.hash = 'ffffffffffffffff'; });
    // names files in B must hash to the published value for a real update: change a file and rehash
    const f = join(B.dir, 'names.meta'); const b = readFileSync(f); b[0] ^= 1; writeFileSync(f, b);
    const vB = withVersion(B.dir, (v) => { v.packs.names.hash = packHash(B.dir, v.packs.names.files); });
    const w = world(A.dir, B.dir);
    const { inUse } = await chooseData(w);
    assert.ok(Object.values(inUse).every((u) => u.source === 'bundled'));
    const r = await checkUpdates({ ...w, inUse });
    assert.deepEqual(r.downloaded, ['names']);
    assert.deepEqual(fileCalls(w.calls).sort(), vB.packs.names.files.map((x) => REMOTE_BASE + x).sort());
    assert.equal(r.allMatch, false);
    assert.ok(w.caches.store.has(cacheNameOf('names', vB.packs.names.hash)));
    // next start: names from the downloaded copy, everything else bundled
    const next = await chooseData(w);
    assert.equal(next.inUse.names.source, 'cache');
    assert.equal(next.inUse.names.entry.hash, vB.packs.names.hash);
    assert.equal(next.inUse.words.source, 'bundled');
    assert.equal(versionOf(next.inUse).built, '2026-12-01');
    const read = readerFor(next.inUse, { ...w, read: async (resp) => new Uint8Array(await resp.arrayBuffer()) });
    assert.deepEqual(Array.from(await read('names.meta')), Array.from(readFileSync(join(B.dir, 'names.meta'))));
    // a second check: names equal now, nothing downloaded again
    w.calls.length = 0;
    const r2 = await checkUpdates({ ...w, inUse: next.inUse });
    assert.deepEqual(r2.downloaded, []);
    assert.deepEqual(fileCalls(w.calls), []);
    assert.equal(r2.allMatch, true);
  } finally { A.cleanup(); B.cleanup(); }
});

test('update check: nothing downloaded when all hashes match (even with a newer built date)', async () => {
  const A = hashedFixture(), B = hashedFixture();
  try {
    withVersion(B.dir, (v) => { v.built = '2026-12-01'; });
    const w = world(A.dir, B.dir);
    const { inUse } = await chooseData(w);
    const r = await checkUpdates({ ...w, inUse });
    assert.deepEqual(r.downloaded, []);
    assert.deepEqual(fileCalls(w.calls), []);
    assert.equal(r.allMatch, true); // the settings line may now show the remote built
    assert.equal(r.remote.built, '2026-12-01');
  } finally { A.cleanup(); B.cleanup(); }
});

test('update check: data in use without hashes counts as different once', async () => {
  const A = hashedFixture(), B = hashedFixture();
  try {
    withVersion(A.dir, (v) => { for (const e of Object.values(v.packs)) { delete e.hash; delete e.files; } });
    const w = world(A.dir, B.dir);
    const { inUse } = await chooseData(w);
    const r = await checkUpdates({ ...w, inUse });
    assert.deepEqual(r.downloaded.sort(), PACKS.slice().sort());
    const next = await chooseData(w); // same built date: the downloaded copy wins the tie
    assert.ok(Object.values(next.inUse).every((u) => u.source === 'cache'));
    w.calls.length = 0;
    const r2 = await checkUpdates({ ...w, inUse: next.inUse });
    assert.deepEqual(r2.downloaded, []);
    assert.deepEqual(fileCalls(w.calls), []);
  } finally { A.cleanup(); B.cleanup(); }
});

test('update check: a failed pack download changes nothing', async () => {
  const A = hashedFixture(), B = hashedFixture();
  try {
    const vB = withVersion(B.dir, (v) => { v.packs.wikt.hash = '0123456789abcdef'; v.packs.sent.hash = 'fedcba9876543210'; });
    const w = world(A.dir, B.dir, { [REMOTE_BASE + 'wikt.keys.json']: 404 });
    const { inUse } = await chooseData(w);
    const r = await checkUpdates({ ...w, inUse });
    assert.deepEqual(r.failed, ['wikt']);
    assert.deepEqual(r.downloaded, ['sent']);
    assert.ok(!w.caches.store.has(cacheNameOf('wikt', vB.packs.wikt.hash))); // partial copy deleted
    const next = await chooseData(w);
    assert.equal(next.inUse.wikt.source, 'bundled');
    assert.equal(next.inUse.wikt.entry.hash, inUse.wikt.entry.hash);
  } finally { A.cleanup(); B.cleanup(); }
});

test('settings: Always / Only on Wi-Fi / Never, and the no-connection-type note', async () => {
  assert.equal(mayDownload('always', 'cellular'), true);
  assert.equal(mayDownload('never', 'wifi'), false);
  assert.equal(mayDownload('wifi', 'wifi'), true);
  assert.equal(mayDownload('wifi', 'ethernet'), true);
  assert.equal(mayDownload('wifi', 'cellular'), false);
  assert.equal(mayDownload('wifi', undefined), true); // type not reported: behaves as Always
  assert.equal(wifiNoteShown('wifi', undefined), true);
  assert.equal(wifiNoteShown('wifi', 'cellular'), false);
  assert.equal(wifiNoteShown('always', undefined), false);
  assert.equal(WIFI_UNKNOWN_NOTE, 'This device does not report its connection type; updates download on any connection.');
  const A = hashedFixture(), B = hashedFixture();
  try {
    withVersion(B.dir, (v) => { v.packs.words.hash = '0000000000000000'; });
    for (const [policy, conn, expectFetch] of [['never', 'wifi', false], ['wifi', 'cellular', false], ['wifi', 'wifi', true], ['wifi', undefined, true]]) {
      const w = world(A.dir, B.dir);
      const { inUse } = await chooseData(w);
      w.calls.length = 0;
      const r = await checkUpdates({ ...w, inUse, policy, connectionType: conn });
      assert.equal(w.calls.length > 0, expectFetch, `${policy}/${conn}`);
      if (!expectFetch) assert.match(r.skipped, /policy/);
    }
  } finally { A.cleanup(); B.cleanup(); }
  // markup and default choice: see updates.test.mjs (SPEC 15: four options, default Ask each time)
  assert.ok(appFile('index.html').includes('<p id="wifinote" class="dim" hidden></p>'));
  assert.match(appFile('sw.js'), /'\.\/datasets\.js'/);
});
