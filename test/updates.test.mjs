// SPEC 15: ask before downloading dictionary updates; gz sizes in version.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './helpers/fixture.mjs';
import { addPackHashes, packHash, packGz } from '../build/lib/packwriter.mjs';
import { reuseData } from '../tools/reuse-data.mjs';
import {
  REMOTE_BASE, cacheNameOf, chooseData, findUpdate, downloadPacks, updateSize, updateOfferText, updateSignature,
  shouldShowOffer, loadUpdateChoice, updateAction, checkResultText, UPDATE_DONE_TEXT, UPDATE_FAILED_TEXT,
} from '../app/datasets.js';
import { updateBarHtml } from '../app/render.js';

const PACKS = ['words', 'names', 'wikt', 'sent', 'kanji'];
const appFile = (name) => readFileSync(fileURLToPath(new URL(`../app/${name}`, import.meta.url)), 'utf8');

function hashedFixture() {
  const fx = makeFixture();
  const v = JSON.parse(readFileSync(join(fx.dir, 'version.json'), 'utf8'));
  v.packs.kanji = { n: 2, bytes: readFileSync(join(fx.dir, 'kanji.json')).length };
  addPackHashes(fx.dir, v);
  writeFileSync(join(fx.dir, 'version.json'), JSON.stringify(v));
  return { ...fx, v };
}
function editVersion(dir, mutate) {
  const v = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'));
  mutate(v);
  writeFileSync(join(dir, 'version.json'), JSON.stringify(v));
  return v;
}
/** Remote B = A with a changed names pack (new hash), built 2026-12-01. */
function remoteWithNewNames(B) {
  const f = join(B.dir, 'names.meta'); const b = readFileSync(f); b[0] ^= 1; writeFileSync(f, b);
  return editVersion(B.dir, (v) => { v.built = '2026-12-01'; v.packs.names.hash = packHash(B.dir, v.packs.names.files); });
}

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
/** fetch: ./data/ -> folder A, REMOTE_BASE -> folder B; hooks[url] = status number | function. */
function world(A, B, hooks = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(url);
    if (init.signal && init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (url in hooks) { const h = hooks[url]; if (typeof h === 'function') { const r = h(); if (r) return r; } else return new Response('x', { status: h }); }
    const [dir, rel] = url.startsWith('./data/') ? [A.dir, url.slice(7)] : url.startsWith(REMOTE_BASE) ? [B.dir, url.slice(REMOTE_BASE.length)] : [null, null];
    if (!dir || !existsSync(join(dir, rel))) return new Response('not found', { status: 404 });
    return new Response(readFileSync(join(dir, rel)), { status: 200 });
  };
  return { caches: fakeCaches(), fetch, calls };
}
const remoteFileCalls = (calls) => calls.filter((u) => u.startsWith(REMOTE_BASE) && !u.endsWith('version.json'));
const packCaches = (w) => Array.from(w.caches.store.keys()).filter((n) => n.startsWith('nj-pack-'));

test('choice: default Ask each time; a stored Always / Only on Wi-Fi / Never is kept', () => {
  assert.equal(loadUpdateChoice(null), 'ask');
  assert.equal(loadUpdateChoice(undefined), 'ask');
  assert.equal(loadUpdateChoice('something'), 'ask');
  for (const v of ['ask', 'always', 'wifi', 'never']) assert.equal(loadUpdateChoice(v), v);
  assert.equal(updateAction('ask', 'wifi'), 'ask');
  assert.equal(updateAction('always', 'cellular'), 'auto');
  assert.equal(updateAction('never', 'wifi'), 'skip');
  assert.equal(updateAction('wifi', 'wifi'), 'auto');
  assert.equal(updateAction('wifi', 'cellular'), 'ask'); // off Wi-Fi: show the bar instead of skipping
  assert.equal(updateAction('wifi', undefined), 'auto'); // type not reported: as Always (14.3)
  const html = appFile('index.html');
  assert.match(html, /<legend>Download dictionary updates<\/legend>\s*<label><input type="radio" name="updates" value="ask"> Ask each time<\/label>\s*<label><input type="radio" name="updates" value="always"> Always<\/label>\s*<label><input type="radio" name="updates" value="wifi"> Only on Wi-Fi<\/label>\s*<label><input type="radio" name="updates" value="never"> Never<\/label>/);
  assert.match(html, /<button type="button" id="checknow" class="checknow">Check for dictionary updates now<\/button>/);
  assert.match(html, /<div id="updatebar" class="updatebar" role="status" hidden><\/div>\s*<div id="progress"/); // under the search row
  assert.match(appFile('main.js'), /S\.updates = loadUpdateChoice\(store\.get\('nj-updates', null\)\);/);
});

test('size text: about N MB from gz, up to N MB with bytes when a pack has no gz', () => {
  const remote = { built: '2026-12-01', packs: {
    words: { hash: 'a', gz: 20791434, bytes: 63779622 }, wikt: { hash: 'b', gz: 1798890, bytes: 6934951 }, sent: { hash: 'c', bytes: 15902604 },
  } };
  assert.equal(updateSize(remote, ['words', 'wikt']), 'about 22 MB'); // 22,590,324 bytes = 21.5 MB, rounded up
  assert.equal(updateSize(remote, ['wikt']), 'about 2 MB');
  assert.equal(updateSize(remote, ['words', 'sent']), 'up to 35 MB'); // 20,791,434 + 15,902,604 bytes
  assert.equal(updateOfferText(remote, ['words', 'wikt']), 'New dictionary data is available (2026-12-01, about 22 MB).');
});

test('bar markup: offer, progress, done, failed', () => {
  assert.equal(updateBarHtml({ kind: 'offer', text: 'New dictionary data is available (2026-12-01, about 22 MB).' }),
    '<span class="msg">New dictionary data is available (2026-12-01, about 22 MB).</span><button type="button" data-update="download">Download</button><button type="button" data-update="notnow">Not now</button><button type="button" data-update="never">Never ask</button>');
  assert.equal(updateBarHtml({ kind: 'progress', pack: 'sent', pct: 42 }),
    '<span class="msg">Downloading dictionary data: sentences 42%</span><button type="button" data-update="cancel">Cancel</button>');
  assert.equal(updateBarHtml({ kind: 'done', text: UPDATE_DONE_TEXT }),
    '<span class="msg">Dictionary data updated. It is used the next time the app starts.</span><button type="button" data-update="close">Close</button>');
  assert.equal(updateBarHtml({ kind: 'failed', text: UPDATE_FAILED_TEXT }),
    '<span class="msg">The download did not finish. Nothing was changed.</span><button type="button" data-update="retry">Try again</button><button type="button" data-update="close">Close</button>');
});

test('Not now remembers exactly this hash set; a different set is offered again; Never ask', () => {
  const r1 = { built: 'x', packs: { words: { hash: 'aa' }, names: { hash: 'bb' } } };
  const r2 = { built: 'x', packs: { words: { hash: 'aa' }, names: { hash: 'cc' } } };
  const sig1 = updateSignature(r1);
  assert.equal(sig1, 'names:bb,words:aa');
  assert.equal(updateSignature({ built: 'y', packs: { names: { hash: 'bb' }, words: { hash: 'aa' } } }), sig1); // order-free, date-free
  assert.equal(shouldShowOffer(sig1, sig1, false), false);
  assert.equal(shouldShowOffer(updateSignature(r2), sig1, false), true);
  assert.equal(shouldShowOffer(sig1, sig1, true), true); // the manual check ignores "Not now"
  const main = appFile('main.js');
  assert.match(main, /case 'notnow': store\.set\(DISMISSED_KEY, offerSignature\); hideBar\(\); break;/);
  assert.match(main, /case 'never': setUpdateChoice\('never'\); hideBar\(\); break;/);
});

test('manual check: three outcomes', async () => {
  const A = hashedFixture(), B = hashedFixture();
  try {
    const w = world(A, B);
    const { inUse } = await chooseData(w);
    assert.equal((await findUpdate({ ...w, inUse })).status, 'uptodate');
    assert.equal(checkResultText('uptodate'), 'Dictionary data is up to date.');
    remoteWithNewNames(B);
    const f = await findUpdate({ ...w, inUse });
    assert.equal(f.status, 'available');
    assert.deepEqual(f.packs, ['names']);
    assert.equal(checkResultText('available'), ''); // the bar is shown instead
    const off = world(A, B, { [REMOTE_BASE + 'version.json']: 503 });
    assert.equal((await findUpdate({ ...off, inUse })).status, 'unreachable');
    const down = world(A, B, { [REMOTE_BASE + 'version.json']: () => { throw new TypeError('fetch failed'); } });
    assert.equal((await findUpdate({ ...down, inUse })).status, 'unreachable');
    assert.equal(checkResultText('unreachable'), 'Could not reach the update server.');
    assert.deepEqual(remoteFileCalls(w.calls), []); // finding an update never downloads
  } finally { A.cleanup(); B.cleanup(); }
});

test('Download: success, failure and cancel leave the right state; partial data deleted', async () => {
  const A = hashedFixture(), B = hashedFixture();
  try {
    remoteWithNewNames(B);
    editVersion(B.dir, (v) => { v.packs.sent.hash = '0123456789abcdef'; }); // second differing pack (download only)
    const base = world(A, B);
    const { inUse } = await chooseData(base);
    const f = await findUpdate({ ...base, inUse });
    assert.deepEqual(f.packs, ['sent', 'names']);
    // failure in the second pack: the first one, already complete, is removed too (nothing changed)
    const bad = world(A, B, { [REMOTE_BASE + 'names.keys.json']: 404 });
    const r1 = await downloadPacks({ ...bad, remote: f.remote, packs: f.packs, inUse, allOrNothing: true });
    assert.deepEqual([r1.ok, r1.cancelled, r1.downloaded], [false, false, []]);
    assert.deepEqual(packCaches(bad), []);
    // cancel during the first pack
    const ctl = new AbortController();
    const cancel = world(A, B, { [REMOTE_BASE + 'sent.off']: () => { ctl.abort(); return null; } });
    const r2 = await downloadPacks({ ...cancel, remote: f.remote, packs: f.packs, inUse, allOrNothing: true, signal: ctl.signal });
    assert.deepEqual([r2.ok, r2.cancelled], [false, true]);
    assert.deepEqual(packCaches(cancel), []);
    // success: both packs stored complete, progress reported per pack up to 100
    const ok = world(A, B);
    const seen = [];
    const r3 = await downloadPacks({ ...ok, remote: f.remote, packs: f.packs, inUse, allOrNothing: true, onProgress: (p, pct) => seen.push(`${p}:${pct}`) });
    assert.deepEqual([r3.ok, r3.downloaded], [true, ['sent', 'names']]);
    assert.ok(seen.includes('sent:100') && seen.includes('names:100') && seen[0] === 'sent:0');
    const names = cacheNameOf('names', f.remote.packs.names.hash);
    assert.ok(packCaches(ok).includes(names));
    const next = await chooseData(ok);
    assert.equal(next.inUse.names.source, 'cache');
    assert.equal((await findUpdate({ ...ok, inUse })).status, 'uptodate'); // downloaded copies wait for the next start
  } finally { A.cleanup(); B.cleanup(); }
});

/** app/worker.js, fresh module instance, with stubbed self / fetch / caches. */
async function runWorker(w, settings) {
  const msgs = [];
  let wake = [];
  const saved = { self: globalThis.self, location: globalThis.location, caches: globalThis.caches, fetch: globalThis.fetch };
  globalThis.self = globalThis;
  globalThis.location = new URL('https://localhost/');
  globalThis.caches = w.caches;
  globalThis.fetch = w.fetch;
  globalThis.postMessage = (m) => { msgs.push(m); for (const f of wake.splice(0)) f(); };
  const until = async (pred) => { while (!msgs.some(pred)) await new Promise((r) => wake.push(r)); return msgs.find(pred); };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
    delete globalThis.onmessage; delete globalThis.postMessage;
  };
  await import(`../app/worker.js?run=${Math.random()}`);
  const send = globalThis.onmessage;
  if (settings) send({ data: { type: 'settings', ...settings } });
  return { msgs, until, send, restore };
}

test('worker, Ask each time: a differing hash shows the bar and downloads nothing; Download stores the pack', async () => {
  const A = hashedFixture(), B = hashedFixture();
  const w = world(A, B);
  remoteWithNewNames(B);
  const wk = await runWorker(w, null); // no settings message: the default (Ask each time)
  try {
    const offer = await wk.until((m) => m.type === 'updateOffer');
    assert.equal(offer.manual, false);
    assert.deepEqual(offer.packs, ['names']);
    assert.match(offer.text, /^New dictionary data is available \(2026-12-01, about 1 MB\)\.$/);
    assert.deepEqual(remoteFileCalls(w.calls), []);
    assert.deepEqual(packCaches(w), []);
    wk.send({ data: { type: 'download' } });
    const done = await wk.until((m) => m.type === 'downloadDone');
    assert.deepEqual([done.ok, done.cancelled], [true, false]);
    assert.ok(wk.msgs.some((m) => m.type === 'downloadProgress' && m.pack === 'names' && m.pct === 100));
    assert.equal(packCaches(w).length, 1);
    wk.send({ data: { type: 'checkNow' } });
    assert.equal((await wk.until((m) => m.type === 'checkResult')).status, 'uptodate');
  } finally { wk.restore(); A.cleanup(); B.cleanup(); }
});

test('worker, Only on Wi-Fi off Wi-Fi: the bar instead of a silent skip; Never: nothing; manual check offers', async () => {
  const A = hashedFixture(), B = hashedFixture();
  remoteWithNewNames(B);
  const w = world(A, B);
  const wk = await runWorker(w, { updates: 'wifi', connectionType: 'cellular' });
  try {
    await wk.until((m) => m.type === 'updateOffer');
    assert.deepEqual(remoteFileCalls(w.calls), []);
  } finally { wk.restore(); }
  const w2 = world(A, B);
  const wk2 = await runWorker(w2, { updates: 'never' });
  try {
    await wk2.until((m) => m.type === 'done');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!wk2.msgs.some((m) => m.type === 'updateOffer'));
    assert.deepEqual(w2.calls.filter((u) => u.startsWith(REMOTE_BASE)), []);
    wk2.send({ data: { type: 'checkNow' } }); // runs regardless of the setting
    const o = await wk2.until((m) => m.type === 'updateOffer');
    assert.equal(o.manual, true);
    assert.equal((await wk2.until((m) => m.type === 'checkResult')).status, 'available');
  } finally { wk2.restore(); A.cleanup(); B.cleanup(); }
});

test('gz: written by the build, verified as a positive integer, added on reuse without changing hash or built', async () => {
  const fx = hashedFixture();
  const out = mkdtempSync(join(tmpdir(), 'nj-gz-'));
  const base = 'https://example.org/data/';
  try {
    for (const p of PACKS) {
      const e = fx.v.packs[p];
      assert.ok(Number.isInteger(e.gz) && e.gz > 0, p);
      assert.equal(e.gz, packGz(fx.dir, e.files), p);
    }
    assert.match(readFileSync(fileURLToPath(new URL('../build/verify-data.mjs', import.meta.url)), 'utf8'),
      /Number\.isInteger\(e\.gz\) && e\.gz > 0/);
    // published version.json without gz (as before SPEC 15)
    const published = JSON.parse(JSON.stringify(fx.v));
    for (const e of Object.values(published.packs)) delete e.gz;
    const fetchFn = async (url) => {
      if (url === base + 'version.json') return new Response(JSON.stringify(published));
      const f = join(fx.dir, url.slice(base.length));
      return existsSync(f) ? new Response(readFileSync(f)) : new Response('no', { status: 404 });
    };
    const r = await reuseData({ base, out, fetchFn });
    assert.deepEqual(r.addedGz.sort(), PACKS.slice().sort());
    const v = JSON.parse(readFileSync(join(out, 'version.json'), 'utf8'));
    assert.equal(v.built, published.built);
    for (const p of PACKS) {
      assert.equal(v.packs[p].hash, published.packs[p].hash, p);
      assert.equal(v.packs[p].gz, fx.v.packs[p].gz, p);
    }
    // a published version.json that already has gz is written unchanged
    const r2 = await reuseData({ base, out, fetchFn: async (url) => (url === base + 'version.json'
      ? new Response(readFileSync(join(fx.dir, 'version.json'))) : fetchFn(url)) });
    assert.deepEqual(r2.addedGz, []);
    assert.equal(readFileSync(join(out, 'version.json'), 'utf8'), readFileSync(join(fx.dir, 'version.json'), 'utf8'));
  } finally { fx.cleanup(); rmSync(out, { recursive: true, force: true }); }
});
