// Sentence pack (SPEC 13.3 / 13.4) on the fixture pack written in the same layout as the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtureStore } from './helpers/fixture.mjs';
import { findEntry, entryData, sentenceKeys, sentencesFor } from '../app/search/entry.js';
import { entryHtml, markForm, sentenceHtml, SENT_LOADING } from '../app/render.js';
import { packFiles, packFilesBinary, LOAD_ORDER } from '../app/search/packs.js';

const { store, cleanup } = await loadFixtureStore();
const bare = await loadFixtureStore('json', { sent: false });
test.after(() => { cleanup(); bare.cleanup(); });

const words = (w, r) => findEntry(store, 'words', w, r);
const tids = (list) => list.map((s) => s.id);

test('pack reading: keys, forms parallel to ids, records', () => {
  assert.equal(store.has('sent'), true);
  assert.equal(store.size('sent'), 37);
  assert.deepEqual(store.sentencesOf('辞書'), [{ id: 2, form: '辞書' }, { id: 1, form: '辞書' }, { id: 0, form: '辞書' }]);
  assert.deepEqual(store.sentencesOf('食べる\tたべる'), [{ id: 6, form: '食べちゃった' }]);
  assert.deepEqual(store.sentencesOf('ない'), []);
  assert.deepEqual(store.sentence(3), ['この草は高い。', 'This grass is tall.', 1004]);
  assert.deepEqual(packFiles('sent'), ['sent.dat', 'sent.off', 'sent.keys.json']); // no .meta
  assert.deepEqual(packFilesBinary('sent'), packFiles('sent'));
  assert.deepEqual(LOAD_ORDER, ['words', 'kanji', 'wikt', 'sent', 'names']);
});

test('lookup keys: k<TAB>r then k for every kanji form; kana keys only without kanji or with uk', () => {
  assert.deepEqual(sentenceKeys('words', { k: ['辞書', '辭書'], r: ['じしょ'] }), ['辞書\tじしょ', '辞書', '辭書\tじしょ', '辭書']);
  assert.deepEqual(sentenceKeys('words', { k: ['草'], r: ['くさ'], s: [{ g: ['grass'] }] }), ['草\tくさ', '草']);
  assert.deepEqual(sentenceKeys('words', { k: ['牡蠣'], r: ['かき'], s: [{ m: ['uk'] }] }), ['牡蠣\tかき', '牡蠣', 'かき']);
  assert.deepEqual(sentenceKeys('words', { r: ['ラーメン'] }), ['ラーメン']);
  assert.deepEqual(sentenceKeys('words', { k: ['珈琲'], r: ['コーヒー'] }), ['珈琲\tこーひー', '珈琲']); // index readings are hiragana
  assert.deepEqual(sentenceKeys('names', { k: ['田中'], r: ['たなか'] }), []);
});

test('union in key order, duplicates removed, examples under a meaning left out', () => {
  // 辞書<TAB>じしょ -> #1003; 辞書 -> #1003 again (dropped), #1002 (equals the meaning example, dropped), #1001
  const d = entryData(store, 'words', words('辞書', 'じしょ'));
  assert.deepEqual(tids(d.sentences), [1003, 1001]);
});

test('uk and no-kanji rules', () => {
  assert.deepEqual(tids(entryData(store, 'words', words('柿', 'かき')).sentences), []);      // no uk: no kana key
  assert.deepEqual(tids(entryData(store, 'words', words('牡蠣', 'かき')).sentences), [1008]); // uk: kana key かき
  assert.deepEqual(tids(entryData(store, 'words', words('ラーメン', 'ラーメン')).sentences), [1006]); // no kanji form
});

test('at most 25 sentences, in pack order', () => {
  const s = entryData(store, 'words', words('草', 'くさ')).sentences;
  assert.equal(s.length, 25);
  assert.deepEqual(tids(s.slice(0, 3)), [1004, 2000, 2001]);
  assert.ok(!tids(s).includes(1005)); // くさ key not used: 草 has a kanji form and no uk
  // wikt records use the same lookup
  assert.equal(entryData(store, 'wikt', findEntry(store, 'wikt', '草', 'くさ')).sentences.length, 25);
});

test('names records get no sentences', () => {
  const d = entryData(store, 'names', findEntry(store, 'names', '田中', 'たなか'));
  assert.deepEqual(d.sentences, []);
  assert.ok(!entryHtml(d).includes('Sentences with this word'));
  assert.deepEqual(sentencesFor(store, 'names', d.rec), []);
});

test('entry page section: title with N, marked form, English, Tatoeba link, between Meanings and Kanji', () => {
  const html = entryHtml(entryData(store, 'words', words('辞書', 'じしょ')));
  assert.match(html, /<h3>Meanings<\/h3>[\s\S]*<h3>Sentences with this word \(2\)<\/h3>[\s\S]*<h3>Kanji in this word<\/h3>/);
  assert.match(html, /<li class="sent"><span class="ja" lang="ja">新しい<mark>辞書<\/mark>。<\/span><span class="en">A new dictionary.<\/span><a class="tatoeba" href="https:\/\/tatoeba.org\/sentences\/show\/1003" target="_blank" rel="noopener">Tatoeba #1003<\/a><\/li>/);
  // stored form absent from the text: no mark
  const eat = entryHtml(entryData(store, 'words', words('食べる', 'たべる')));
  assert.match(eat, /<span class="ja" lang="ja">もう食べたよ。<\/span>/);
  assert.equal(markForm('もう食べたよ。', '食べる'), 'もう食べたよ。');
  assert.equal(markForm('a<b>辞書辞書', '辞書'), 'a&lt;b&gt;<mark>辞書</mark>辞書'); // first occurrence only, escaped
  assert.ok(!sentenceHtml({ ja: '<x>', en: '<y>', id: 1, form: '' }).includes('<x>'));
});

test('no sentences: section omitted; pack still loading: "Loading sentences…"', () => {
  const none = entryHtml(entryData(store, 'words', words('学校', 'がっこう')));
  assert.ok(!none.includes('Sentences with this word'));
  const id = findEntry(bare.store, 'words', '辞書', 'じしょ');
  const loading = entryData(bare.store, 'words', id, { sentLoading: true });
  assert.equal(loading.sentences, null);
  assert.equal(SENT_LOADING, 'Loading sentences…');
  assert.match(entryHtml(loading), /<h3>Sentences with this word<\/h3><p class="dim">Loading sentences…<\/p><\/section>/);
  // pack missing or failed (not loading): omitted, nothing blocked
  const missing = entryData(bare.store, 'words', id, { sentLoading: false });
  assert.deepEqual(missing.sentences, []);
  assert.ok(!entryHtml(missing).includes('Sentences with this word'));
});
