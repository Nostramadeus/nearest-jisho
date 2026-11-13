// SPEC 17: words in a pasted text, and 17.5 words that end with the headword.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtureStore } from './helpers/fixture.mjs';
import { search, TEXT_NOTE, TEXT_CUT_NOTE, TEXT_MORE_NOTE } from '../app/search/engine.js';
import { segmentText } from '../app/search/segment.js';
import { findEntry, entryData, suffixRecords } from '../app/search/entry.js';
import { groupsHtml, entryHtml } from '../app/render.js';

const { store, cleanup } = await loadFixtureStore();
test.after(cleanup);

const full = (q, o = {}) => search(store, q, { phase: 'full', ...o });
const head = (pack, id) => { const r = store.getRecord(pack, id); return (r.k && r.k[0]) || r.r[0]; };
const split = (text) => segmentText(store, text).segments.map((x) => (x.kind === 'word' ? `[${x.text}]` : x.kind === 'sep' ? x.text : `?${x.text}`)).join('');
const words = (text) => segmentText(store, text).segments.filter((x) => x.kind === 'word');
const textGroup = (r) => r.groups.find((g) => g.id === 'text');

test('trigger: no group when the whole query is a word or a deinflected word; first group otherwise; never Latin', () => {
  assert.equal(textGroup(full('辞書')), undefined);
  assert.equal(textGroup(full('食べさせられた')), undefined); // deinflected hit counts as a hit
  assert.equal(textGroup(full('jisho no sora')), undefined);
  assert.equal(textGroup(full('辞書の空', { phase: 'fast' })), undefined); // phase full only
  assert.equal(textGroup(full('の空')), undefined); // 2 characters: below the minimum of 3
  const r = full('彼方の空まで');
  assert.equal(r.groups[0].id, 'text');
  assert.equal(r.groups[0].title, 'Words in this text');
  assert.ok(r.groups[0].notes.includes(TEXT_NOTE));
  assert.equal(r.didYouMean, null);
});

test('longest match, separators, unknown runs', () => {
  assert.equal(split('彼方の空まで'), '[彼方][の][空][まで]');
  assert.equal(split('学校教育の辞書'), '[学校教育][の][辞書]'); // 学校教育, not 学校 + 教育
  assert.equal(split('辞書、ゑ。学校!'), '[辞書]、?ゑ。[学校]!');
  assert.equal(split('abc辞書'), 'abc[辞書]'); // Latin letters are separators
});

test('one-kana rule: only function words; one kanji matches normally', () => {
  // は: 歯 (noun) ranks better, but a one-kana match only takes function words -> the particle
  const w = words('空は辞書');
  assert.deepEqual(w.map((x) => x.text), ['空', 'は', '辞書']);
  assert.deepEqual(store.getRecord(w[1].pack, w[1].id).s[0].p, ['prt']);
  assert.equal(w[1].others, 0);
  assert.equal(split('辞書え学校'), '[辞書]?え[学校]'); // え is only a noun here: unknown
  assert.equal(split('空空空'), '[空][空][空]');
});

test('deinflected segment with its note', () => {
  const g = textGroup(full('食べさせられた子供'));
  assert.deepEqual(g.results.map((h) => head(h.pack, h.id)), ['食べる', '子供']);
  assert.equal(g.results[0].via, 'causative-passive + past');
  assert.equal(g.results[0].note, '食べさせられた is the causative-passive + past form of 食べる');
  assert.equal(g.results[0].segment, '食べさせられた');
});

test('names only as a fallback', () => {
  const w = words('佐藤の辞書');
  assert.deepEqual(w.map((x) => `${x.text}:${x.pack}`), ['佐藤:names', 'の:words', '辞書:words']);
  // 辞書 is in words AND names: words wins (rules 1-3 matched a length >= 2)
  assert.equal(words('辞書の空')[0].pack, 'words');
});

test('record chosen by rank; other entries counted', () => {
  const w = words('じしょの空');
  assert.equal(head(w[0].pack, w[0].id), '辞書'); // ff 500 beats 地所, 字書, 自署
  assert.equal(w[0].others, 3);
  const news = segmentText(store, 'じしょの空', { ranking: 'news' }).segments[0];
  assert.equal(head(news.pack, news.id), '辞書'); // fn 1000 is still the best
  const g = textGroup(full('じしょの空'));
  for (const h of g.results) h.rec = store.getRecord(h.pack, h.id);
  assert.match(groupsHtml([g]), /<p class="others"><a href="#q=%E3%81%98%E3%81%97%E3%82%87">3 other entries for <span lang="ja">じしょ<\/span><\/a><\/p>/);
});

test('a repeated word is listed once; its chips point to the first item', () => {
  const g = textGroup(full('辞書の辞書'));
  assert.equal(g.results.length, 2); // 辞書, の
  assert.deepEqual(g.segments.filter((x) => x.kind === 'word').map((x) => `${x.text}>${x.item}`), ['辞書>0', 'の>1', '辞書>0']);
});

test('function-word rows and the rendered group', () => {
  const g = textGroup(full('彼方の空まで'));
  for (const h of g.results) h.rec = store.getRecord(h.pack, h.id);
  assert.deepEqual(g.results.map((h) => [h.segment, h.fn]), [['彼方', false], ['の', true], ['空', false], ['まで', true]]);
  const html = groupsHtml([g]);
  assert.match(html, /<p class="textline" lang="ja"><button type="button" class="chip" data-item="0">彼方<\/button><button type="button" class="chip" data-item="1">の<\/button><button type="button" class="chip" data-item="2">空<\/button><button type="button" class="chip" data-item="3">まで<\/button><\/p>/);
  assert.match(html, /<div class="titem" id="t-1"><a class="fnrow" href="#w=%E3%81%AE&amp;r=%E3%81%AE&amp;p=words"><span class="seg" lang="ja">の<\/span> <span class="pos">Particle<\/span> <span class="info">indicates possessive<\/span><\/a><\/div>/);
  assert.match(html, /<div class="titem" id="t-0"><article class="card"/);
  // the match highlight marks the segment in the headword
  assert.match(html, /<a class="hw" href="[^"]*"><mark>彼方<\/mark><\/a>/);
  assert.match(html, /<p class="textnote">Split automatically; long kana runs can be wrong\.<\/p>/);
});

test('limits: 500 characters and 60 segments', () => {
  const long = '辞書の'.repeat(200); // 600 characters
  const seg = segmentText(store, long);
  assert.equal(seg.truncated, true);
  assert.equal(seg.segments.reduce((n, x) => n + Array.from(x.text).length, 0), 500);
  const g = textGroup(full(long));
  assert.ok(g.notes.includes(TEXT_CUT_NOTE));
  assert.ok(g.notes.includes(TEXT_MORE_NOTE));
  assert.equal(g.segments.filter((x) => x.kind === 'word').length, 60);
  assert.ok(g.segments.some((x) => x.kind === 'more'));
  assert.equal(g.results.length, 2);
  const g2 = textGroup(full('辞書の'.repeat(10)));
  assert.ok(!g2.notes.includes(TEXT_CUT_NOTE) && !g2.notes.includes(TEXT_MORE_NOTE));
});

test('entry page: words that end with the headword (itself and start-with rows excluded)', () => {
  const kusa = entryData(store, 'words', findEntry(store, 'words', '草', 'くさ'));
  assert.deepEqual(kusa.startsWith.map((x) => x.head), ['草草']);
  assert.deepEqual(kusa.endsWith.map((x) => x.head), ['若草']); // 草草 ends with 草 too but is a start-with row
  const school = entryData(store, 'words', findEntry(store, 'words', '学校', 'がっこう'));
  assert.deepEqual(school.startsWith.map((x) => x.head), ['学校教育']);
  assert.deepEqual(school.endsWith.map((x) => x.head), ['中学校']);
  const html = entryHtml(school);
  assert.match(html, /<h3>Words that start with <span lang="ja">学校<\/span><\/h3>[\s\S]*<h3>Words that end with <span lang="ja">学校<\/span><\/h3>/);
  assert.match(html, /<a href="#w=%E4%B8%AD%E5%AD%A6%E6%A0%A1&amp;r=[^"]*"><span lang="ja">中学校<\/span> <span class="kana" lang="ja">ちゅうがっこう<\/span><\/a> <span class="info">junior high school<\/span>/);
  assert.deepEqual(suffixRecords(store, 'words', '学校', { skip: new Set([findEntry(store, 'words', '中学校', 'ちゅうがっこう')]) }), []);
  // no kanji form / names: omitted
  assert.deepEqual(entryData(store, 'words', findEntry(store, 'words', 'まで', 'まで')).endsWith, []);
  assert.deepEqual(entryData(store, 'names', findEntry(store, 'names', '田中', 'たなか')).endsWith, []);
});
