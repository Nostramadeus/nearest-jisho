import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadFixtureStore } from './helpers/fixture.mjs';
import { findEntry, entryData, entryAddress, entryHash, parseEntryHash } from '../app/search/entry.js';
import { entryHtml } from '../app/render.js';

const { store, cleanup } = await loadFixtureStore();
test.after(cleanup);

const appFile = (name) => readFileSync(fileURLToPath(new URL(`../app/${name}`, import.meta.url)), 'utf8');
const sectionTitles = (html) => Array.from(html.matchAll(/<h3>(.*?)<\/h3>/g), (m) => m[1].replace(/<[^>]+>/g, ''));

test('entry lookup by w / r / p', () => {
  assert.equal(findEntry(store, 'words', '辞書', 'じしょ'), 0);
  assert.equal(findEntry(store, 'words', '地所', 'じしょ'), 2);
  assert.equal(findEntry(store, 'words', '辞書', 'ちがう'), -1);   // kana form must match
  assert.equal(findEntry(store, 'words', 'じしょ', 'じしょ'), 0);  // kana address, several records: lowest id
  assert.equal(findEntry(store, 'words', 'カキ', 'カキ'), 27);     // kana-only record via space r, exact form
  assert.equal(findEntry(store, 'words', 'がっこ', 'がっこ'), 32);
  assert.equal(findEntry(store, 'names', '田中', 'たなか'), 0);
  assert.equal(findEntry(store, 'names', '辞書', 'じしょ'), 2);
  assert.equal(findEntry(store, 'wikt', '草', 'くさ'), 0);
  assert.equal(findEntry(store, 'nopack', '草', 'くさ'), -1);
  assert.equal(findEntry(store, 'words', '存在しない', ''), -1);
});

test('entry address: first written form, first kana form, round trip through the hash', () => {
  const a = entryAddress('words', store.getRecord('words', 8));
  assert.deepEqual(a, { w: '今日は', r: 'こんにちは', p: 'words' });
  const kanaOnly = entryAddress('words', store.getRecord('words', 26));
  assert.deepEqual(kanaOnly, { w: 'ラーメン', r: 'ラーメン', p: 'words' });
  const odd = { w: 'a&b=c #', r: 'x', p: 'wikt' };
  assert.deepEqual(parseEntryHash(entryHash(odd)), odd);
  assert.equal(parseEntryHash('#q=jisho'), null);
  assert.ok(!entryHash(a).match(/id=|\b8\b/)); // no record ids in addresses
});

test('entry data: kanji blocks, romaji, words that start with the headword', () => {
  const d = entryData(store, 'words', 0);
  assert.equal(d.head, '辞書');
  assert.equal(d.romaji, 'jisho');
  assert.deepEqual(d.kanji.map((b) => b.literal), ['辞', '書']);
  assert.equal(d.kanji[0].data.s, 13);
  assert.deepEqual(d.startsWith.map((x) => x.head), ['辞書形']); // the record itself excluded
  assert.deepEqual(d.startsWith[0], { w: '辞書形', r: 'じしょけい', p: 'words', head: '辞書形', reading: 'じしょけい', gloss: 'dictionary form (of a verb)' });
  assert.deepEqual(entryData(store, 'words', 26).startsWith, []); // no kanji form: section omitted
  assert.deepEqual(entryData(store, 'names', 2).startsWith, []);  // names: section omitted
});

test('entry page for a words record: sections in order, every example, kanji, links', () => {
  const d = entryData(store, 'words', 0);
  d.rec = { ...d.rec, k: ['辞書', '辭書'], s: [
    { p: ['n'], g: ['dictionary', 'lexicon'], x: [['辞書を引く。', 'I look it up in the dictionary.'], ['新しい辞書だ。', 'It is a new dictionary.']] },
    { p: ['n'], g: ['letter of resignation'], m: ['arch'], f: ['law'], d: ['ksb'], i: 'old use', x: [['辞書を出す。', 'He handed in his resignation.']] },
  ] };
  const html = entryHtml(d);
  assert.deepEqual(sectionTitles(html), ['Other forms', 'Meanings', 'Kanji in this word', 'Words that start with 辞書', 'Links']);
  assert.match(html, /<div class="kana" lang="ja">じしょ<\/div><div class="romaji">jisho<\/div><div class="entry-title"><h2 class="entry-word" lang="ja">辞書<\/h2><button type="button" class="star entry-star" aria-pressed="false"/);
  assert.match(html, /<span class="tag">common<\/span><span class="tag g">N5<\/span>/);
  assert.match(html, /<p lang="ja">辭書<\/p>/);
  for (const ex of ['I look it up in the dictionary.', 'It is a new dictionary.', 'He handed in his resignation.']) assert.ok(html.includes(ex), ex);
  assert.match(html, /archaic/);
  assert.match(html, /\(law, Kansai dialect\)/);
  assert.match(html, /old use/);
  assert.match(html, /<div class="big" lang="ja">辞<\/div>/);
  assert.match(html, /<a href="#w=%E8%BE%9E%E6%9B%B8%E5%BD%A2&amp;r=%E3%81%98%E3%81%97%E3%82%87%E3%81%91%E3%81%84&amp;p=words">/);
  assert.match(html, /<a href="https:\/\/ja.wikipedia.org\/w\/index.php\?search=%E8%BE%9E%E6%9B%B8" target="_blank" rel="noopener">Search Wikipedia for "辞書"<\/a>/);
  assert.match(html, /<a href="https:\/\/jisho.org\/search\/%E8%BE%9E%E6%9B%B8" target="_blank" rel="noopener">Look up on Jisho.org<\/a>/);
});

test('entry page for a names record', () => {
  const html = entryHtml(entryData(store, 'names', 0));
  assert.deepEqual(sectionTitles(html), ['Name type', 'Translations', 'Kanji in this word', 'Links']);
  assert.match(html, /<p>surname<\/p>/);
  assert.match(html, /<li>Tanaka<\/li>/);
  assert.match(html, /<div class="romaji">tanaka<\/div>/);
  assert.ok(!html.includes('Jisho.org'));
});

test('entry page for a Wiktionary record', () => {
  const html = entryHtml(entryData(store, 'wikt', 0));
  // no words-pack record starts with 草 in the fixture (草 itself is the exact key, not a prefix match): omitted
  assert.deepEqual(sectionTitles(html), ['Meanings', 'Kanji in this word', 'Links']);
  assert.ok(!html.includes('Other forms'));
  assert.match(html, /<span class="tag g">Wiktionary<\/span>/);
  assert.match(html, /Internet slang/);
  assert.match(html, /href="https:\/\/en.wiktionary.org\/wiki\/草#Japanese" target="_blank" rel="noopener">Open in Wiktionary</);
  const ja = entryHtml(entryData(store, 'wikt', 1));
  assert.match(ja, /<span class="tag g">Japanese definition<\/span>/);
  assert.ok(!ja.includes('Jisho.org'));
});

test('clear button markup (SPEC 10.1)', () => {
  const html = appFile('index.html');
  const box = /<div class="box">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.match(box, /<input id="q" type="text" inputmode="search"/);
  assert.match(box, /<button id="clear" class="clear" type="button" aria-label="Clear search">/);
  assert.match(box, /<svg viewBox="0 0 24 24" width="22" height="22"/);
  assert.ok(!/id="clear"[^>]*hidden/.test(html), 'always visible');
  const css = appFile('style.css');
  const rule = /\.clear \{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /width: 44px; height: 44px;/);
  assert.match(rule, /position: absolute; right: 1px;/);
  assert.ok(!/\.clear[^{]*\{[^}]*display: none/.test(css));
  assert.ok(appFile('sw.js').includes("'./search/entry.js'"), 'new module is in the service worker shell list');
});
