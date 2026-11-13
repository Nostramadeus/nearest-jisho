import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtureStore, WORDS } from './helpers/fixture.mjs';
import { search } from '../app/search/engine.js';

for (const layout of ['json', 'binary']) {
  test(`PackStore reads the ${layout} layout`, async () => {
    const { store, cleanup } = await loadFixtureStore(layout);
    try {
      assert.equal(store.size('words'), WORDS.length);
      assert.deepEqual(store.getRecord('words', 0).k, ['辞書']);
      assert.deepEqual(store.meta('words', 0), { ff: 500, fn: 1000 });
      assert.equal(store.rank('words', 0, 'news'), 1000);
      const ks = store.keySpace('words', 'r');
      const i = ks.find('jisho');
      assert.ok(i >= 0);
      assert.equal(ks.keys.get(i), 'jisho');
      assert.deepEqual(Array.from(ks.idsOf(i)).sort((a, b) => a - b), [0, 2, 3, 31]);
      assert.equal(ks.find('nothing'), -1);
      const [lo, hi] = ks.prefixRange('jisho');
      assert.equal(hi - lo, 3); // jisho, jishokei, jishou
      assert.deepEqual(ks.foldLookup('jisho').map((x) => ks.keys.get(x)).sort(), ['jisho', 'jishou']);
      assert.equal(store.keySpace('names', 'e'), null);
      assert.equal(store.kanji('辞').s, 13);
      assert.equal(store.kanji('猫'), null);
      assert.equal(store.isCommon('words', 0), true);
      assert.equal(store.isCommon('words', 1), false);
      assert.equal(search(store, 'jihso', { phase: 'full' }).didYouMean.key, 'jisho');
    } finally {
      cleanup();
    }
  });
}

test('progress callback reaches 1', async () => {
  const { store, cleanup } = await loadFixtureStore();
  try {
    const seen = [];
    await store.loadPack('words', (f) => seen.push(f));
    assert.equal(seen[seen.length - 1], 1);
  } finally {
    cleanup();
  }
});
