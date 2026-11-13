// Runs app/worker.js in node with a stubbed `self` and `fetch` over the fixture packs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers/fixture.mjs';

test('worker: progress, loaded packs, fast then full result, entry', async () => {
  const fx = makeFixture();
  const msgs = [];
  const waiters = [];
  const realFetch = globalThis.fetch;
  const hadSelf = 'self' in globalThis;
  globalThis.self = globalThis;
  globalThis.postMessage = (m) => { msgs.push(m); for (const w of waiters.splice(0)) w(); };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.startsWith('./data/')) return new Response('not found', { status: 404 });
    try { return new Response(readFileSync(join(fx.dir, u.slice(7)))); } catch { return new Response('not found', { status: 404 }); }
  };
  const until = async (pred) => { while (!msgs.some(pred)) await new Promise((r) => waiters.push(r)); return msgs.find(pred); };
  try {
    await import('../app/worker.js');
    await until((m) => m.type === 'done');
    assert.ok(msgs.some((m) => m.type === 'version' && m.built === '2026-11-13'));
    assert.ok(msgs.some((m) => m.type === 'progress' && m.pack === 'words' && m.pct === 100));
    for (const p of ['words', 'names', 'wikt']) assert.ok(msgs.some((m) => m.type === 'loaded' && m.pack === p), p);

    globalThis.onmessage({ data: { type: 'search', seq: 1, query: 'jihso', ranking: 'fiction', recent: [] } });
    const fast = await until((m) => m.type === 'result' && m.seq === 1 && m.phase === 'fast');
    assert.equal(fast.result.groups.length, 0);
    const full = await until((m) => m.type === 'result' && m.seq === 1 && m.phase === 'full');
    assert.deepEqual(full.result.groups[0].results[0].rec.k, ['辞書']);
    assert.equal(full.result.didYouMean.key, 'jisho');

    // a newer query cancels the older full phase
    globalThis.onmessage({ data: { type: 'search', seq: 2, query: 'jisho', ranking: 'fiction', recent: [] } });
    globalThis.onmessage({ data: { type: 'search', seq: 3, query: 'kaki', ranking: 'fiction', recent: [] } });
    await until((m) => m.type === 'result' && m.seq === 3 && m.phase === 'full');
    assert.ok(!msgs.some((m) => m.type === 'result' && m.seq === 2 && m.phase === 'full'));

    globalThis.onmessage({ data: { type: 'entry', id: 7, pack: 'words', w: '辞書', r: 'じしょ', ranking: 'fiction' } });
    const en = await until((m) => m.type === 'entry' && m.id === 7);
    assert.deepEqual(en.data.rec.k, ['辞書']);
    assert.equal(en.data.kanji[0].data.s, 13);
    globalThis.onmessage({ data: { type: 'entry', id: 8, pack: 'words', w: '無い語', r: 'ないご', ranking: 'fiction' } });
    assert.equal((await until((m) => m.type === 'entry' && m.id === 8)).data, null);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.onmessage;
    delete globalThis.postMessage;
    if (!hadSelf) delete globalThis.self;
    fx.cleanup();
  }
});
