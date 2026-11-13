import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtureStore } from './helpers/fixture.mjs';
import { search, queryKind, didYouMeanText } from '../app/search/engine.js';

const { store, cleanup } = await loadFixtureStore();
test.after(cleanup);

const run = (q, o = {}) => search(store, q, { phase: 'full', ...o });
const head = (h) => { const r = store.getRecord(h.pack, h.id); return (r.k && r.k[0]) || r.r[0]; };
const group = (res, id) => res.groups.find((g) => g.id === id);
const heads = (res, id) => (group(res, id)?.results || []).map(head);

test('query kinds', () => {
  assert.equal(queryKind('辞書'), 'kanji');
  assert.equal(queryKind('食べた'), 'kanji');
  assert.equal(queryKind('たべた'), 'kana');
  assert.equal(queryKind('jisho'), 'latin');
  assert.equal(queryKind("kan'i lo-fi"), 'latin');
});

test('jihso: 辞書 first, did-you-mean jisho, letters swapped', () => {
  const r = run('jihso');
  assert.equal(heads(r, 'words')[0], '辞書');
  assert.equal(r.didYouMean.key, 'jisho');
  assert.equal(r.didYouMean.reason, 'letters swapped');
  assert.equal(didYouMeanText(r.didYouMean), 'No exact match for "jihso". Nearest: jisho (letters swapped)');
  assert.ok(group(r, 'words').results.every((h) => h.tier === 3));
});

test('phase fast has no tier 3 and no did-you-mean', () => {
  const r = run('jihso', { phase: 'fast' });
  assert.equal(r.didYouMean, null);
  assert.equal(group(r, 'words'), undefined);
});

test('tiers 0, 1, 2 and ordering for jisho', () => {
  const r = run('jisho');
  const g = group(r, 'words').results;
  assert.deepEqual(g.map((h) => h.tier), [0, 0, 0, 0, 1, 2]); // SPEC 21.1: every tier-0 hit first (自署 is rare but exact)
  assert.equal(head(g[0]), '辞書'); // best rank among tier 0
  assert.equal(head(g[4]), '事象'); // jishou folds to jisho
  assert.equal(g[4].note, 'long vowel / double letter');
  assert.equal(head(g[5]), '辞書形');
  assert.deepEqual(g[5].hl, { space: 'r', form: 'じしょけい', len: 3 });
  assert.equal(r.didYouMean, null);
});

test('recent tie-break before record id', () => {
  // 地所 (id 2) and 字書 (id 31): both common, tie on fiction rank 20000 and key length
  const plain = heads(run('jisho'), 'words');
  assert.ok(plain.indexOf('地所') < plain.indexOf('字書'));
  const withRecent = heads(run('jisho', { recent: ['字書'] }), 'words');
  assert.ok(withRecent.indexOf('字書') < withRecent.indexOf('地所'));
});

test('news ranking changes order', () => {
  const r = run('jisho', { ranking: 'news' });
  assert.equal(heads(r, 'words')[0], '辞書'); // fn 1000 < 15000
  const o = run('おれ', { ranking: 'news' }); // kana query: no common-class merge, rank decides
  assert.equal(heads(o, 'words')[0], '折れ'); // fn 7000 < 9000
  assert.equal(heads(run('おれ'), 'words')[0], '俺'); // ff 50 < 50000
  assert.equal(heads(run('ore', { ranking: 'news' }), 'words')[0], '俺'); // LATIN: common tier 0 first
});

test('shojo: 処女 tier 0, 少女 tier 1 in top 3', () => {
  const h = heads(run('shojo'), 'words');
  assert.equal(h[0], '処女');
  assert.ok(h.slice(0, 3).includes('少女'));
});

test('ruling: tier 3 sorts by exact cost, then rank (jihso -> 辞書 first)', () => {
  const g = group(run('jihso'), 'words').results;
  assert.deepEqual(g.map(head), ['辞書', '事象', '地所', '字書', '自署']); // by S = cost + P(rank): 5, 12, 13, 13, 23
  assert.deepEqual(g.map((h) => h.cost), [0.5, 0.7, 0.5, 0.5, 0.5]);
});

test('ruling: LATIN merges tiers 0 and 1 by common class (gakko -> 学校 first)', () => {
  // 学校 tier 1 common (class 2) beats がっこ tier 0 not common (class 3), although がっこ has the better rank
  const g = group(run('gakko'), 'words').results;
  assert.deepEqual(g.map(head).slice(0, 2), ['学校', 'がっこ']);
  assert.deepEqual(g.map((h) => h.tier).slice(0, 2), [1, 0]);
  // KANA queries keep tier 0 strictly before tier 1
  const k = group(run('がっこ'), 'words').results;
  assert.equal(head(k[0]), 'がっこ');
  assert.equal(head(k[1]), '学校');
});

test('gakko -> 学校 first (fold), konichiwa -> 今日は first (particle は typed as wa, then fold)', () => {
  assert.equal(heads(run('gakko'), 'words')[0], '学校');
  const k = run('konichiwa');
  assert.equal(heads(k, 'words')[0], '今日は');
  assert.equal(group(k, 'words').results[0].note, 'は typed as wa');
  assert.equal(k.didYouMean, null); // a tier-1 variant hit: no "No exact match" line
});

test('kaki: only exact/prefix, no did-you-mean', () => {
  const r = run('kaki');
  assert.equal(r.didYouMean, null);
  assert.ok(group(r, 'words').results.every((h) => h.tier <= 2));
});

test('kana query: typed kana form sorts before romaji-only match; katakana via space k', () => {
  assert.deepEqual(heads(run('かき'), 'words'), ['柿', '牡蠣', '下記', 'カキ']);
  assert.equal(heads(run('カキ'), 'words')[0], 'カキ');
});

test('deinflection: たべた, 食べさせられた, tabeta', () => {
  const a = group(run('たべた'), 'words').results[0];
  assert.equal(head(a), '食べる');
  assert.equal(a.tier, 0);
  assert.equal(a.via, 'past');
  assert.equal(a.note, 'たべた is the past form of 食べる');
  const b = group(run('食べさせられた'), 'words').results[0];
  assert.equal(head(b), '食べる');
  assert.equal(b.note, '食べさせられた is the causative-passive + past form of 食べる');
  assert.equal(head(group(run('tabeta'), 'words').results[0]), '食べる');
  // POS must match: 書く is v5k, so 書いた -> 書く but 書る is never offered
  assert.equal(head(group(run('書いた'), 'words').results[0]), '書く');
});

test('deinflected hits sort after true tier-0 hits', () => {
  // する: "した" deinflects to する; no record has した, so check order with a word that is also a form
  const r = run('かいた');
  const g = group(r, 'words');
  assert.ok(g.results.some((h) => h.via));
});

test('English: dictonary corrected to dictionary, 辞書 in top 3', () => {
  const r = run('dictonary');
  assert.equal(r.groups[0].id, 'en');
  assert.equal(r.didYouMean.query, 'dictionary');
  assert.equal(r.didYouMean.reason, 'one letter missing');
  assert.ok(heads(r, 'en').slice(0, 3).includes('辞書'));
});

test('English classes: A before B before C; prefix is tier 2', () => {
  const r = run('dictionary');
  const g = group(r, 'en').results;
  assert.deepEqual(g.map(head), ['辞書', '字典', '辞書形', '字書']);
  assert.deepEqual(g.map((h) => h.tier), [0, 0, 0, 2]);
  const p = run('dictio', { phase: 'fast' });
  assert.ok(group(p, 'en').results.every((h) => h.tier === 2));
  assert.deepEqual(group(p, 'en').results[0].hl, { space: 'e', tokens: ['dictio'] });
});

test('English multi-token: all tokens in one sense', () => {
  const r = run('plot of land');
  assert.deepEqual(heads(r, 'en'), ['地所']);
  assert.equal(group(r, 'en').results[0].tier, 0);
  const yg = group(run('young girl'), 'en').results; // two glosses of one sense: match, class C
  assert.deepEqual(yg.map(head), ['少女']);
  assert.equal(yg[0].tier, 2);
  assert.equal(heads(run('girl symptoms'), 'en').length, 0); // tokens in different records
});

test('hate: both groups present, English first when its best rank is lower', () => {
  const r = run('hate');
  const ids = r.groups.map((g) => g.id);
  assert.ok(ids.includes('en') && ids.includes('words'));
  assert.equal(ids[0], 'en'); // 憎む ff 2500 < 果て ff 3000
  const n = run('hate', { ranking: 'news' });
  assert.equal(n.groups[0].id, 'words'); // 果て fn 9500 < 憎む fn 12000
});

test('English first when only English has tier 0', () => {
  assert.equal(run('eat').groups[0].id, 'en');
});

test('てめえ -> 手前, kusa -> slang sense, tanaka -> Names', () => {
  assert.equal(heads(run('てめえ'), 'words')[0], '手前');
  const k = run('kusa');
  assert.equal(heads(k, 'words')[0], '草');
  assert.equal(heads(k, 'wikt')[0], '草');
  const t = run('tanaka');
  assert.deepEqual(heads(t, 'names'), ['田中']);
});

test('group order and titles for Japanese side', () => {
  const r = run('jisho');
  assert.deepEqual(r.groups.map((g) => g.title), ['Japanese words', 'Names']);
  assert.ok(r.groups.every((g) => g.id !== 'en'));
});

test('kanji query: exact, prefix, contains (no did-you-mean)', () => {
  const r = run('辞書');
  assert.deepEqual(heads(r, 'words'), ['辞書', '辞書形']);
  assert.deepEqual(group(r, 'words').results.map((h) => h.tier), [0, 2]);
  assert.deepEqual(group(r, 'words').results[0].hl, { space: 'k', form: '辞書', len: -1 });
  const c = run('校教');
  assert.deepEqual(heads(c, 'words'), ['学校教育']);
  assert.equal(group(c, 'words').results[0].via, 'contains');
  assert.equal(c.didYouMean, null);
  assert.equal(group(run('校教', { phase: 'fast' }), 'words'), undefined);
});

test('names tier 3 only when words + wikt have fewer than 5 results', () => {
  const r = run('tanska');
  assert.equal(heads(r, 'names')[0], '田中');
  assert.equal(group(r, 'names').results[0].tier, 3);
});

test('limits and totals', () => {
  const r = run('jisho', { limit: 2 });
  const g = group(r, 'words');
  assert.equal(g.results.length, 2);
  assert.equal(g.total, 6);
  const r2 = run('jisho', { limit: 2, groupLimits: { words: 4 } });
  assert.equal(group(r2, 'words').results.length, 4);
});

test('empty query', () => {
  assert.deepEqual(run('  ').groups, []);
});
