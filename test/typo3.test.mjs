// SPEC 27: typo round 3 (same-reading kanji chips, reading priority, searches with no results).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { search, kanjiSlipChips, sameReadingKanji, KANJI_SLIP_LABEL } from '../app/search/engine.js';
import { PackStore } from '../app/search/packs.js';
import { findEntry, entryData } from '../app/search/entry.js';
import { readingsByPriority, pitchKey } from '../app/search/pitch.js';
import { entryHtml, suggestionBarHtml } from '../app/render.js';
import { addMissedTo, missedText, MISSED_MAX } from '../app/favorites.js';
import { loadFixtureStore, writePack, fsReader } from './helpers/fixture.mjs';

const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('same-reading kanji: 講議 -> chip 講義, never in the results; exact keys and kana queries get none', async () => {
  const { store, cleanup } = await loadFixtureStore();
  try {
    assert.deepEqual(sameReadingKanji(store, '議'), ['義']);
    const chips = kanjiSlipChips(store, '講議');
    assert.deepEqual(chips.map((x) => x.chip), ['講義']); // 抗議 is not a fixture word
    assert.equal(chips[0].label, KANJI_SLIP_LABEL);
    const r = search(store, '講議', { phase: 'full' });
    assert.deepEqual(r.suggestions.map((x) => x.chip), ['講義']);
    assert.ok(!r.groups.some((g) => (g.results || []).some((h) => h.pack && (store.getRecord(h.pack, h.id).k || []).includes('講義'))));
    assert.match(suggestionBarHtml(r), /No exact match\. Did you mean:[\s\S]*data-q="講義" title="Same reading, other kanji"/);
    assert.deepEqual(kanjiSlipChips(store, '講義'), []); // exact key: no swap
    assert.deepEqual(search(store, '講義', { phase: 'full' }).suggestions, []);
    assert.deepEqual(kanjiSlipChips(store, 'こうぎ'), []); // no kanji
  } finally { cleanup(); }
});

test('same-reading kanji: one swap at a time, at most 30 per position, at most 3 chips, best rank first', () => {
  const engine = src('../app/search/engine.js');
  assert.match(engine, /export const KANJI_SLIP_PER_POS = 30;/);
  assert.match(engine, /export const KANJI_SLIP_MAX = 3;/);
});

/** Mini store: two records with the same reading; the rarer one has re_pri on it. */
async function priStore() {
  const dir = mkdtempSync(join(tmpdir(), 'nj-pri-'));
  const N = (g) => ({ p: ['n'], g: [g] });
  const recs = [
    { k: ['甲'], r: ['てすと'], s: [N('first')] },              // rank 100, no re_pri
    { k: ['乙'], r: ['てすと'], rp: [0], s: [N('second')] },     // rank 200, re_pri on てすと
    { k: ['丙'], r: ['ぺけ', 'ばつ'], rp: [1], s: [N('third')] }, // re_pri only on the second reading
  ];
  writePack(dir, 'words', recs, [[100, 100], [200, 200], [300, 300]]);
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ built: '2026-11-14', packs: { words: { n: 3, bytes: 1 } } }));
  const store = new PackStore(fsReader(dir));
  await store.loadVersion();
  await store.loadPack('words');
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('reading priority: same tier and cost -> the record matched through a re_pri reading ranks first', async () => {
  const { store, cleanup } = await priStore();
  try {
    for (const q of ['tesuto', 'てすと']) {
      const r = search(store, q, { phase: 'full' });
      const words = r.groups.find((g) => g.id === 'words');
      assert.deepEqual(words.results.map((h) => store.getRecord(h.pack, h.id).k[0]), ['乙', '甲'], q);
    }
    // a record without rp anywhere keeps the old order (rank)
    const plain = (rec) => ({ ...rec, rp: undefined });
    assert.deepEqual(readingsByPriority(plain({ r: ['a', 'b'] })), ['a', 'b']);
  } finally { cleanup(); }
});

test('reading priority on the entry page: readings with re_pri listed first; address keeps the first form', async () => {
  const { store, cleanup } = await priStore();
  try {
    const rec = store.getRecord('words', 2);
    assert.deepEqual(readingsByPriority(rec), ['ばつ', 'ぺけ']);
    assert.equal(pitchKey(rec), '丙\tばつ');
    const d = entryData(store, 'words', findEntry(store, 'words', '丙', 'ぺけ'));
    assert.equal(d.reading, 'ばつ');
    assert.deepEqual(d.readings, ['ばつ', 'ぺけ']);
    const html = entryHtml(d);
    assert.match(html, /<rt>ばつ<\/rt>|<div class="kana" lang="ja">ばつ<\/div>/);
    assert.match(html, /<h3>Other forms<\/h3><p lang="ja">ぺけ<\/p>/);
    assert.match(html, /href="#w=%E4%B8%99&amp;r=%E3%81%BA%E3%81%91&amp;p=words"|data-r="ぺけ"/); // address: first form ぺけ
  } finally { cleanup(); }
});

test('build: re_pri read per kana form from JMdict_e and stored as rec.rp indexes', () => {
  assert.match(src('../build/lib/sources.mjs'), /<re_pri>\[\^<\]\+<\\\/re_pri>/);
  assert.match(src('../build/lib/packs.mjs'), /rec\.rp = rp/);
});

test('searches with no results: newest first, one copy per query, at most 100, copy text, settings section', () => {
  let list = [];
  list = addMissedTo(list, 'kaisa', '2026-11-14');
  list = addMissedTo(list, ' xyzzy ', '2026-11-14');
  list = addMissedTo(list, 'kaisa', '2026-11-15');
  assert.deepEqual(list, [{ q: 'kaisa', d: '2026-11-15' }, { q: 'xyzzy', d: '2026-11-14' }]);
  assert.equal(missedText(list), '2026-11-15\tkaisa\n2026-11-14\txyzzy');
  for (let i = 0; i < 150; i++) list = addMissedTo(list, `q${i}`, '2026-11-14');
  assert.equal(list.length, MISSED_MAX);
  assert.equal(list[0].q, 'q149');
  assert.deepEqual(addMissedTo(list, '  ', 'x').length, MISSED_MAX);
  const html = src('../app/index.html');
  assert.match(html, /<legend>Searches with no results<\/legend>/);
  assert.match(html, /id="missedcopy" class="checknow">Copy all<\/button>/);
  assert.match(html, /id="missedclear" class="checknow">Clear<\/button>/);
  const main = src('../app/main.js');
  assert.match(main, /store\.set\(MISSED_KEY, addMissedTo\(/); // localStorage only
  assert.doesNotMatch(main.slice(main.indexOf('// ---------- searches with no results'), main.indexOf('// ---------- read the reading aloud')), /fetch\(/);
});
