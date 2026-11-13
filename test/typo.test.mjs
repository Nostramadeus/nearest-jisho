// SPEC 18 (design/typo-study.md) and SPEC 19: costs, P table, gate, promotion, variants, rewrites, stems, labels,
// the lowest-weight text split and kana headwords for uk words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePack, fsReader, loadFixtureStore } from './helpers/fixture.mjs';
import { PackStore } from '../app/search/packs.js';
import { prepareQuery, distance, reasonFor, COST, pRank, P_LIMITS } from '../app/search/cost.js';
import { canon, latinRewrite, romajiToKana } from '../app/search/romaji.js';
import { search, eiVariants, waVariants, englishStems, LABELS } from '../app/search/engine.js';
import { kanaVariants, latinVoicedVariants, KANA_LABEL } from '../app/search/kanavariants.js';
import { segmentText, UNKNOWN_WEIGHT } from '../app/search/segment.js';
import { findEntry, entryData, shownHead } from '../app/search/entry.js';
import { headParts, cardHtml } from '../app/render.js';

const d = (q, k, o) => distance(prepareQuery(q, o), k);

// ---- a small store with real-data ranks for the study's cases ----
const N = (p, g, extra = {}) => ({ p, g, ...extra });
const MINI = [
  [{ k: ['内緒'], r: ['ないしょ'], c: 1, s: [N(['n'], ['secrecy'])] }, 2844, 15000],
  [{ k: ['内装'], r: ['ないそう'], c: 1, s: [N(['n'], ['interior design'])] }, 9974, 7000],
  [{ k: ['活気'], r: ['かっき'], c: 1, s: [N(['n'], ['liveliness'])] }, 8542, 6000],
  [{ k: ['書き込む'], r: ['かきこむ'], c: 1, s: [N(['v5m'], ['to write in'])] }, 3000, 3000],
  [{ k: ['柿'], r: ['かき'], c: 1, s: [N(['n'], ['persimmon'])] }, 9000, 20000],
  [{ k: ['鍵'], r: ['かぎ'], c: 1, s: [N(['n'], ['key'])] }, 900, 900],
  [{ k: ['学校'], r: ['がっこう'], c: 1, s: [N(['n'], ['school'])] }, 673, 500],
  [{ k: ['先生'], r: ['せんせい'], c: 1, s: [N(['n'], ['teacher'])] }, 300, 300],
  [{ k: ['実は'], r: ['じつは'], c: 1, s: [N(['exp', 'adv'], ['as a matter of fact'])] }, 900, 900],
  [{ k: ['実話'], r: ['じつわ'], s: [N(['n'], ['true story'])] }, 30000, 30000],
  [{ k: ['平仮名'], r: ['ひらがな'], c: 1, s: [N(['n'], ['hiragana'])] }, 9000, 9000],
  [{ k: ['猫'], r: ['ねこ'], c: 1, s: [N(['n'], ['cat'])] }, 1536, 3500],
  [{ r: ['キャッツ'], s: [N(['n'], ['cats (esp. the musical: Cats)'])] }, 64849, 999999],
  [{ k: ['今日'], r: ['きょう'], c: 1, s: [N(['n'], ['today'])] }, 97, 97],
  [{ r: ['は'], c: 1, s: [N(['prt'], ['topic marker'])] }, 2, 2],
  [{ k: ['良い'], r: ['いい', 'よい'], c: 1, s: [N(['adj-ix'], ['good'], { m: ['uk'] })] }, 33, 33],
  [{ k: ['天気'], r: ['てんき'], c: 1, s: [N(['n'], ['weather'])] }, 3354, 3354],
  [{ r: ['です'], c: 1, s: [N(['cop'], ['be'])] }, 16, 16],
  [{ r: ['ね'], c: 1, s: [N(['prt'], ['right?'])] }, 17, 17],
  [{ k: ['迄'], r: ['まで'], c: 1, s: [N(['prt'], ['until'], { m: ['uk'] })] }, 30, 30],
];
const dir = mkdtempSync(join(tmpdir(), 'nj-typo-'));
writePack(dir, 'words', MINI.map((r) => r[0]), MINI.map((r) => [r[1], r[2]]));
const mini = new PackStore(fsReader(dir));
await mini.loadPack('words');
mini.warm('words');
const fx = await loadFixtureStore();
test.after(() => { rmSync(dir, { recursive: true, force: true }); fx.cleanup(); });

const run = (q, o = {}) => search(mini, q, { phase: 'full', ...o });
const words = (r) => (r.groups.find((g) => g.id === 'words') || { results: [] }).results;
const headOf = (h) => { const r = mini.getRecord(h.pack, h.id); return (r.k && r.k[0]) || r.r[0]; };

test('cost constants: DIGRAPH, YOON_I, DEVOICED, FATFINGER; one key between = 1.0', () => {
  assert.deepEqual([COST.DIGRAPH, COST.YOON_I, COST.DEVOICED, COST.FATFINGER, COST.TOUCH, COST.OTHER], [4, 5, 5, 6, 5, 10]);
  assert.equal(COST.ONE_BETWEEN, undefined);
  assert.equal(d('naiso', 'naisho'), 4);   // h after s, missing in the query
  assert.equal(d('naishho', 'naisho'), 3); // a doubled letter stays 0.3
  assert.equal(d('chikara', 'cikara'), 4); // h after c, extra in the query (either side)
  assert.equal(d('rokou', 'ryokou'), 4);   // y in a ky-type sound before o
  assert.equal(d('sukue', 'tsukue'), 4);   // t before s (insert at 0: no first-letter extra)
  assert.equal(d('kiyou', 'kyou'), 5);     // YOON_I
  assert.equal(d('taksan', 'takusan'), 5); // DEVOICED u (key side)
  assert.equal(d('yoroshku', 'yoroshiku'), 5); // DEVOICED i
  assert.equal(d('takusan', 'taksan'), 10); // DEVOICED is key side only
  assert.equal(d('nekjo', 'neko'), 6);     // FATFINGER: j touches k
  assert.equal(d('neko', 'nekjo'), 10);    // FATFINGER is query side only
  assert.equal(d('nekjo', 'neko', { keyboard: false }), 10); // no keyboard (kana queries): no fat finger
  assert.equal(d('pkq', 'pnq'), 10);       // one key between: 1.0
  assert.equal(d('xaiso', 'naisho', { first: true }) > d('naiso', 'naisho'), true);
});

test('labels of the mistake kinds', () => {
  assert.equal(reasonFor('naiso', 'naisho'), 'h or y missing');
  assert.equal(reasonFor('chikara', 'cikara'), 'h or y extra');
  assert.equal(reasonFor('kiyou', 'kyou'), 'small ゃゅょ');
  assert.equal(reasonFor('taksan', 'takusan'), 'silent u / i missing');
  assert.equal(reasonFor('nekjo', 'neko'), 'one extra letter');
  assert.deepEqual(LABELS, { fold: 'long vowel / double letter', ei: 'ei / ee', wa: 'は typed as wa', l: 'l read as r', stem: 'plural / -ing / -ed' });
  assert.deepEqual(KANA_LABEL, { mark: '゛゜ or small kana', flick: 'flick direction', voiced: 'voiced / unvoiced' });
});

test('P table (study 1.1)', () => {
  assert.equal(P_LIMITS.length, 18);
  assert.deepEqual([1, 1000, 1211, 1212, 2844, 9974, 12115, 12116, 825404, 825405, 999999].map(pRank), [0, 0, 0, 1, 3, 6, 6, 7, 17, 18, 18]);
});

test('canonical rewrites: m before b/p, oh / uh, l as r', () => {
  assert.equal(canon('shimbun'), 'shinbun');
  assert.equal(canon('sempai'), 'senpai');
  assert.equal(canon('ohsaka'), 'ousaka');
  assert.equal(canon('ohkii'), 'oukii');
  assert.equal(canon('ohayou'), 'ohayou'); // h before a vowel stays
  assert.equal(latinRewrite('koh'), 'koh'); // fewer than 4 letters: no oh rewrite
  assert.equal(latinRewrite('shuhto'), 'shuuto');
  assert.equal(canon('kalaoke'), 'karaoke');
  assert.equal(canon('lyokou'), 'ryokou');
  assert.equal(romajiToKana('xa').kana, 'ぁ');  // small kana through x
  assert.equal(romajiToKana('ltu').kana, 'っ');
  assert.equal(romajiToKana('la').kana, 'ら');
});

test('variant generators: ei / ee / e, particle wa, one-kana, voiced / unvoiced', () => {
  assert.deepEqual(eiVariants('sensee'), ['sensei', 'seinsee']);
  assert.deepEqual(eiVariants('eega'), ['eiga']);
  assert.deepEqual(eiVariants('keiki'), ['keeki']); // the e before i is not lengthened
  assert.ok(eiVariants('sense').includes('sensei'));
  assert.ok(eiVariants('eeeeeeee').length <= 6);
  assert.deepEqual(waVariants('jitsuwa'), ['jitsuha']);
  assert.deepEqual(waVariants('kawaii'), ['kahaii']); // generated; the part-of-speech filter keeps only は words
  assert.deepEqual(waVariants('gwaikoku'), []); // wa directly after k or g is not the particle
  assert.deepEqual(waVariants('wawawawa'), ['wawawaha', 'wawahawa', 'wahawawa']); // rightmost first, at most 3
  const v = kanaVariants('ないしよ');
  assert.ok(v.some((x) => x.kana === 'ないしょ' && x.cost === 4 && x.kind === 'mark'));
  assert.ok(v.some((x) => x.kana === 'ないしゆ' && x.cost === 7 && x.kind === 'flick'));
  assert.ok(kanaVariants('がつこう').some((x) => x.kana === 'がっこう' && x.kind === 'mark'));
  assert.ok(kanaVariants('たへもの').some((x) => x.kana === 'たべもの'));
  assert.ok(kanaVariants('はは').some((x) => x.kana === 'ぱは'));
  assert.ok(!kanaVariants('かき').some((x) => x.kind === 'flick')); // flick only from 3 kana
  assert.deepEqual(kanaVariants('か'), []);
  assert.equal(kanaVariants('あいうえおかきくけこさしす').length, 0); // more than 12 kana
  const lv = latinVoicedVariants('ひらかな');
  assert.ok(lv.some((x) => x.kana === 'ひらがな' && x.cost === 6));
  assert.ok(!lv.some((x) => x.kana.startsWith('び'))); // never the first kana
  assert.ok(!latinVoicedVariants('はは').some((x) => x.kana.includes('ぱ'))); // dakuten pairs only
});

test('English stems', () => {
  assert.deepEqual(englishStems('cats'), ['cat']);
  assert.deepEqual(englishStems('apples'), ['appl', 'apple']);
  assert.deepEqual(englishStems('cities'), ['city']);
  assert.deepEqual(englishStems('running'), ['runn', 'runne']);
  assert.deepEqual(englishStems('walked'), ['walk', 'walke']);
  for (const t of ['glass', 'virus', 'basis', 'cat']) assert.deepEqual(englishStems(t), [], t);
  // 猫 is reached through the stem (class A -> B, label); キャッツ's own gloss "cats (...)" is class A and stays first
  const r = run('cats');
  const en = r.groups.find((g) => g.id === 'en').results;
  assert.deepEqual(en.map(headOf).slice(0, 2), ['キャッツ', '猫']);
  assert.equal(en[1].note, 'plural / -ing / -ed');
  assert.equal(en[1].tier, 0);
});

test('gate: a typed common word closes the near search; promotion; group order by S', () => {
  // naiso: 内装 is only a fold hit (not exact), gate open; 内緒 costs 4, 4 + P(2844) = 7 <= 9 -> promoted
  const n = words(run('naiso'));
  assert.deepEqual(n.map(headOf).slice(0, 2), ['内緒', '内装']);
  assert.equal(n[0].tier, 3);
  assert.equal(n[0].promoted, true);
  assert.equal(n[0].note, 'h or y missing');
  assert.equal(n[1].note, 'long vowel / double letter');
  // kakik: 活気 is one swap away, 5 + P(min(8542, 6000)) = 10 > 9 -> not promoted; the prefix row stays first
  const k = words(run('kakik'));
  assert.equal(headOf(k[0]), '書き込む');
  const kakki = k.find((h) => headOf(h) === '活気');
  assert.ok(kakki && !kakki.promoted && kakki.tier === 3);
  // kaki: 柿 is an exact common word -> gate closed: no near rows (鍵 kagi is not offered)
  const kk = words(run('kaki'));
  assert.ok(!kk.some((h) => h.tier === 3));
  assert.ok(!kk.some((h) => headOf(h) === '鍵'));
  // phase fast never runs the near search
  assert.ok(!words(run('naiso', { phase: 'fast' })).some((h) => h.tier === 3));
});

test('spelling variants and kana variants find the intended word', () => {
  const s = words(run('sensee'));
  assert.equal(headOf(s[0]), '先生');
  assert.deepEqual([s[0].tier, s[0].cost, s[0].note], [1, 0.3, 'ei / ee']);
  const j = words(run('jitsuwa'));
  // SPEC 21.1: the exact (rare) 実話 comes first; 実は (a variant, not a fold hit) follows by S
  assert.deepEqual(j.map(headOf).slice(0, 2), ['実話', '実は']);
  assert.equal(j[1].note, 'は typed as wa');
  const nk = words(run('ないしよ'));
  assert.equal(headOf(nk[0]), '内緒');
  assert.deepEqual([nk[0].cost, nk[0].note, nk[0].promoted], [0.4, '゛゜ or small kana', true]);
  assert.equal(headOf(words(run('がつこう'))[0]), '学校');
  const h = words(run('hirakana'));
  assert.equal(headOf(h[0]), '平仮名');
  assert.equal(h[0].note, 'voiced / unvoiced');
  const k = words(run('kalaoke'));
  assert.ok(Array.isArray(k)); // no karaoke in this store; the l rewrite is checked in the rewrite test
});

test('DP split: lowest total weight, unknown 40, one-kana function words 10', () => {
  const seg = segmentText(mini, 'きょうはいいてんきですね').segments;
  assert.deepEqual(seg.map((x) => x.text), ['きょう', 'は', 'いい', 'てんき', 'です', 'ね']);
  assert.deepEqual(seg.map((x) => x.weight), [10, 10, 10, 10 + pRank(3354), 10, 10]);
  const u = segmentText(mini, 'ゑゑ今日').segments;
  assert.deepEqual(u.map((x) => `${x.kind}:${x.text}`), ['unknown:ゑゑ', 'word:今日']);
  assert.equal(UNKNOWN_WEIGHT, 40);
  // on the fixture packs: words beat names, names still work as edges
  const f = segmentText(fx.store, '佐藤の辞書').segments;
  assert.deepEqual(f.map((x) => `${x.text}:${x.pack}`), ['佐藤:names', 'の:words', '辞書:words']);
});

test('uk words show their kana headword everywhere; a typed form wins', () => {
  const id = findEntry(mini, 'words', '迄', 'まで');
  const rec = mini.getRecord('words', id);
  assert.equal(shownHead(rec), 'まで');
  assert.equal(shownHead(rec, '迄'), '迄');
  assert.deepEqual(headParts(rec, null), { head: 'まで', reading: '', headMark: null, readMark: null });
  assert.equal(headParts(rec, { space: 'k', form: '迄', len: -1 }).head, '迄');
  const card = cardHtml({ pack: 'words', id, tier: 0, hl: null, rec }, 0, 0);
  assert.match(card, /<a class="hw" href="#w=%E8%BF%84&amp;r=%E3%81%BE%E3%81%A7&amp;p=words">まで<\/a>/); // address keeps 迄
  assert.match(card, /Other forms: <span lang="ja">迄<\/span>/);
  assert.match(card, /data-h="まで"/);
  const e = entryData(mini, 'words', id);
  assert.equal(e.head, 'まで');
  assert.equal(e.written, '迄');
  assert.deepEqual(e.kanji.map((b) => b.literal), ['迄']);
  // not uk: written form first
  assert.equal(shownHead(mini.getRecord('words', findEntry(mini, 'words', '学校', 'がっこう'))), '学校');
});
