// SPEC 34: outside audit R-001 (2026-11-26). Unit tests on a small fixture of their own (the shared fixture stays as it
// is, so the ids of the other tests do not move).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePack, fsReader } from './helpers/fixture.mjs';
import { PackStore } from '../app/search/packs.js';
import { search, stripBrackets, kanjiSlipChips, SEARCH_ONLY_NOTE } from '../app/search/engine.js';
import { segmentText, deinflectInputs, wiktPosBits } from '../app/search/segment.js';
import { deinflect, T } from '../app/search/deinflect.js';
import { mixedSpans } from '../app/search/mixed.js';
import { nnAltCanon, romajiToKana } from '../app/search/romaji.js';
import { entryAddress, entryHash, parseEntryHash, findEntry, addressOrdinal } from '../app/search/entry.js';
import { readingsFor } from '../app/search/pitch.js';
import { headParts, textGroupHtml } from '../app/render.js';
import { restrictedReadings, wiktKeep } from '../build/lib/packs.mjs';

const N = (p, g) => ({ p, g });
// [record, ff, fn]
const WORDS = [
  [{ k: ['居る'], r: ['いる'], c: 1, s: [N(['v1', 'vi'], ['to be'])] }, 37, 37], // 0
  [{ k: ['板'], r: ['いた'], c: 1, s: [N(['n'], ['board'])] }, 5611, 5611],
  [{ k: ['為る'], r: ['する'], c: 1, s: [N(['vs-i'], ['to do'])] }, 10, 10],
  [{ k: ['白'], r: ['しろ'], c: 1, s: [N(['n'], ['white'])] }, 1963, 1963],
  [{ k: ['呉れる'], r: ['くれる'], c: 1, s: [N(['v1-s', 'vt'], ['to give'])] }, 535, 535],
  [{ k: ['暮れ'], r: ['くれ'], c: 1, s: [N(['n'], ['sunset'])] }, 17242, 17242], // 5
  [{ k: ['抉る'], r: ['えぐる', 'くる'], s: [N(['v5r', 'vt'], ['to gouge'])] }, 345, 345],
  [{ k: ['彼'], r: ['あれ'], c: 1, s: [N(['pn'], ['that'])] }, 104, 104],
  [{ k: ['有る'], r: ['ある'], c: 1, s: [N(['v5r-i', 'vi'], ['to be'])] }, 18, 18],
  [{ k: ['来る'], r: ['くる'], c: 1, s: [N(['vk', 'vi'], ['to come'])] }, 59, 59],
  [{ k: ['来た'], r: ['きた'], s: [N(['int'], ["let's do this!"])] }, 322731, 322731], // 10
  [{ k: ['勉強'], r: ['べんきょう'], c: 1, s: [N(['n', 'vs', 'vt'], ['study'])] }, 778, 778],
  [{ r: ['バグる'], s: [N(['v5r', 'vi'], ['to behave buggily'])] }, 25698, 25698],
  [{ k: ['箇'], r: ['つ'], s: [N(['ctr'], ['general-purpose counter'])] }, 4443, 4443],
  [{ r: ['っつ'], h: ['つ'], s: [N(['prt'], ['called'])] }, 3047, 3047],
  [{ k: ['林檎'], r: ['りんご'], c: 1, s: [N(['n'], ['apple'])] }, 3000, 3000], // 15
  [{ r: ['を'], c: 1, s: [N(['prt'], ['object marker'])] }, 5, 5],
  [{ k: ['買う'], r: ['かう'], c: 1, s: [N(['v5u', 'vt'], ['to buy'])] }, 134, 134],
  [{ k: ['高い'], r: ['たかい'], c: 1, s: [N(['adj-i'], ['high'])] }, 363, 363],
  [{ k: ['単に'], r: ['たんに'], c: 1, s: [N(['adv'], ['simply'])] }, 2838, 2838],
  [{ k: ['単位'], r: ['たんい'], c: 1, s: [N(['n'], ['unit'])] }, 5268, 5268], // 20
  [{ k: ['体育'], r: ['たいいく'], h: ['たいく'], c: 1, s: [N(['n'], ['physical education'])] }, 6458, 6458],
  [{ r: ['ロック'], c: 1, s: [N(['n'], ['rock (music)'])] }, 3000, 3000],
  [{ r: ['ロック'], c: 1, s: [N(['n', 'vs'], ['lock'])] }, 4000, 4000],
  [{ k: ['知る'], r: ['しる'], c: 1, s: [N(['v5r', 'vt'], ['to know'])] }, 66, 66],
  [{ k: ['止める'], r: ['やめる'], c: 1, s: [N(['v1', 'vt'], ['to stop'])] }, 900, 900], // 25
  [{ r: ['で'], c: 1, s: [N(['prt'], ['at'])] }, 5, 5],
  [{ k: ['駅'], r: ['えき'], c: 1, s: [N(['n'], ['station'])] }, 900, 900],
  [{ k: ['会う'], r: ['あう'], c: 1, s: [N(['v5u', 'vi'], ['to meet'])] }, 134, 134],
  [{ k: ['出会う'], r: ['であう'], c: 1, s: [N(['v5u', 'vi'], ['to meet by chance'])] }, 134, 134],
  [{ k: ['食べる'], r: ['たべる'], c: 1, s: [N(['v1', 'vt'], ['to eat'])] }, 188, 188], // 30
  [{ r: ['た'], c: 1, s: [N(['aux-v'], ['past'])] }, 5, 5],
  [{ r: ['よ'], c: 1, s: [N(['prt'], ['emphasis'])] }, 5, 5],
  [{ k: ['今夜'], r: ['こんや'], c: 1, s: [N(['n'], ['tonight'])] }, 996, 996],
  [{ k: ['笠に着る', '嵩に着る'], r: ['かさにきる'], s: [N(['exp', 'v1'], ['to wear the mantle of authority'])] }, 44369, 44369],
  [{ k: ['振り返る'], r: ['ふりかえる'], c: 1, s: [N(['v5r', 'vi'], ['to turn around'])] }, 1500, 1500], // 35
  [{ k: ['振り'], r: ['ふり'], c: 1, s: [N(['n'], ['swing'])] }, 3000, 3000],
  [{ k: ['帰る'], r: ['かえる'], c: 1, s: [N(['v5r', 'vi'], ['to return'])] }, 200, 200],
  [{ k: ['太鼓'], r: ['たいこ'], c: 1, s: [N(['n'], ['drum'])] }, 9000, 9000],
];
const WIKT = [
  [{ src: 'wj', k: ['エモい'], r: ['エモい'], s: [{ p: ['形容詞'], g: ['感情が揺さぶられる'], m: ['若者言葉'] }] }, 999999, 999999],
];
const NAMES = [[{ k: ['田中'], r: ['たなか'], t: ['surname'], g: ['Tanaka'] }, 999999, 999999]];
const KANJI = {
  '帰': { m: ['return'], on: ['キ'], kun: ['かえ.る', 'かえ.す'], f: 317 },
  '返': { m: ['return'], on: ['ヘン'], kun: ['かえ.す', 'かえ.る'], f: 714 },
};

const dir = mkdtempSync(join(tmpdir(), 'nj-audit-'));
for (const [name, rows] of [['words', WORDS], ['wikt', WIKT], ['names', NAMES]]) writePack(dir, name, rows.map((r) => r[0]), rows.map((r) => [r[1], r[2]]));
writeFileSync(join(dir, 'kanji.json'), JSON.stringify(KANJI));
writeFileSync(join(dir, 'version.json'), JSON.stringify({ built: '2026-11-26', jmdict: 'fixture', packs: { words: { n: WORDS.length }, wikt: { n: 1 }, names: { n: 1 } } }));
const store = new PackStore(fsReader(dir), { additions: false });
await store.loadVersion();
for (const p of ['words', 'wikt', 'names']) await store.loadPack(p);
await store.loadKanji();
test.after(() => rmSync(dir, { recursive: true, force: true }));

const head = (pack, id) => { const r = store.getRecord(pack, id); return (r.k && r.k[0]) || r.r[0]; };
const words = (text) => segmentText(store, text).segments.filter((x) => x.kind === 'word');
const full = (q, o = {}) => search(store, q, { phase: 'full', ...o });
const group = (r, id) => r.groups.find((g) => g.id === id);
/** As the worker does before posting: every result carries its record. */
const withRec = (g) => { for (const h of g.results) if (h.pack !== 'kanji') h.rec = store.getRecord(h.pack, h.id); return g; };
const has = (word, form, type, via) => {
  const c = deinflect(word).find((x) => x.form === form && (x.type & type) && (!via || x.via.join(' + ') === via));
  assert.ok(c, `${word} -> ${form}${via ? ` (${via})` : ''}; got ${JSON.stringify(deinflect(word).filter((x) => x.form === form))}`);
  return c;
};

test('34.1 a kana piece: a much more frequent deinflected verb beats the homophone noun', () => {
  const one = (t) => { const w = words(t); assert.equal(w.length, 1, t); return w[0]; };
  for (const [t, want] of [['くれ', '呉れる'], ['しろ', '為る'], ['いた', '居る'], ['来た', '来る']]) {
    const s = one(t);
    assert.equal(head('words', s.id), want, t);
    assert.ok(s.via, `${t} is deinflected`);
    assert.ok(s.others >= 1, `${t}: the homophone stays an other entry`);
  }
  assert.equal(head('words', one('くれ').id), '呉れる', 'the common 呉れる, not 抉る (くる)');
  assert.equal(one('くれ').via, 'imperative');
  assert.equal(head('words', one('あれ').id), '彼', 'same frequency band: the true match stays (あれ is not ある)');
});

test('34.2 conditionals and connectives', () => {
  has('高かったら', '高い', T.ADJ, 'conditional (-tara)');
  has('高かったり', '高い', T.ADJ, 'listing (-tari)');
  has('食べなかったら', '食べる', T.V1, 'negative + conditional (-tara)');
  has('行きたかったら', '行く', T.V5, 'want (-tai) + conditional (-tara)');
  has('食べなくても', '食べる', T.V1, 'negative + even if (-te mo)');
  has('食べても', '食べる', T.V1, 'even if (-te mo)');
  has('行かないで', '行く', T.V5, 'without doing (-naide)');
  has('食べちゃ', '食べる', T.V1, 'te + wa (-cha)');
  has('読んじゃ', '読む', T.V5, 'te + wa (-cha)');
  assert.deepEqual(words('高かったら').map((x) => x.text), ['高かったら']);
});

test('34.3 partly-kana words: no particle as the first kanji after other text; deinflected ones weigh +4', () => {
  const at = (text) => Array.from(mixedSpans(store, 'words', Array.from(text)).keys()).map((k) => Math.floor(k / 64));
  assert.ok(!at('駅で会った').includes(1), 'で会った after 駅 is not 出会う');
  assert.ok(at('で会った').includes(0), 'at the start of the text it still is (SPEC 32.7)');
  assert.deepEqual(words('駅で会った').map((x) => x.text), ['駅', 'で', '会った']);
  const w = words('嵩にきて');
  assert.equal(w.length, 1);
  assert.equal(w[0].rule, 5);
  assert.equal(w[0].weight, 10 + 10 + 8 + 4, 'rank 44369 = P 10; + 8 partly kana; + 4 deinflected');
});

test('34.4 romaji nn before a vowel or y: both readings', () => {
  assert.equal(nnAltCanon('tanni'), "tan'i");
  assert.equal(nnAltCanon('konnya'), "kon'ya");
  assert.equal(nnAltCanon('tani'), null);
  assert.equal(romajiToKana('konnnichiwa', { nnBoth: true }).kana, 'こんにちわ');
  const rows = group(full('tanni'), 'words').results;
  const t0 = rows.filter((h) => h.tier === 0).map((h) => head('words', h.id));
  assert.deepEqual(t0.slice(0, 2), ['単に', '単位'], 'both, by frequency');
  assert.equal(head('words', group(full('konnya'), 'words').results[0].id), '今夜');
});

test('34.5 suru nouns deinflect (benkyoushita)', () => {
  const c = has('べんきょうした', 'べんきょう', T.VSN, 'past');
  assert.equal(c.suru, true);
  for (const q of ['benkyoushita', '勉強した', 'べんきょうして']) {
    const h = group(full(q), 'words').results[0];
    assert.equal(head('words', h.id), '勉強', q);
    assert.match(h.note, /of 勉強する$/, q);
  }
});

test('34.6 spoken contractions and run-final っ / ー', () => {
  has('買っといた', '買う', T.V5, 'do in advance (-toku = -te oku) + past');
  has('読んどく', '読む', T.V5, 'do in advance (-toku = -te oku)');
  has('殺しちまった', '殺す', T.V5, 'completed (-chimau = -te shimau) + past');
  has('死んじまえ', '死ぬ', T.V5, 'completed (-chimau = -te shimau) + imperative');
  has('連れてった', '連れる', T.V1, 'go on doing (-te ku = -te iku) + past');
  has('行かなきゃ', '行く', T.V5, 'must (-nakya)');
  has('食べなくちゃ', '食べる', T.V1, 'must (-nakucha)');
  has('知らねー', '知る', T.V5, 'negative + colloquial (-ee)');
  has('すげえ', 'すごい', T.ADJ, 'colloquial (-ee)');
  has('行きてえ', '行く', T.V5, 'want (-tai) + colloquial (-ee)');
  assert.deepEqual(words('知らねーよ').map((x) => x.text), ['知らねー', 'よ']);
  const seg = segmentText(store, 'やめろっ！').segments;
  assert.deepEqual(seg.map((x) => [x.kind, x.text]), [['word', 'やめろ'], ['sep', 'っ！']]);
  assert.equal(head('words', seg[0].id), '止める');
});

test('34.7 katakana stems and Wiktionary words deinflect', () => {
  assert.deepEqual(deinflectInputs('バグってる'), ['バグってる', 'ばぐってる']);
  assert.deepEqual(deinflectInputs('喰ッタ'), ['喰ッタ', '喰った']);
  assert.deepEqual(deinflectInputs('たべた'), ['たべた']);
  assert.equal(wiktPosBits('形容詞'), T.ADJ);
  assert.ok(wiktPosBits('verb') & T.V5);
  const h = group(full('バグってる'), 'words').results[0];
  assert.equal(head('words', h.id), 'バグる');
  assert.equal(h.tier, 0);
  assert.equal(head('words', words('バグってる')[0].id), 'バグる');
  const w = group(full('エモかった'), 'wikt');
  assert.ok(w && head('wikt', w.results[0].id) === 'エモい' && w.results[0].via === 'past', 'エモかった -> wikt エモい');
});

test('34.9 three rules deep; masu-stem -sou na / -nikui / -yasui / -ppanashi', () => {
  has('食べられていなかった', '食べる', T.V1, 'potential or passive + progressive (-te iru) + negative past');
  has('食べすぎちゃった', '食べる', T.V1, 'too much (-sugiru) + completed (-chau) + past');
  has('読ませたくなかった', '読む', T.V5, 'causative + negative want (-takunai) + past');
  has('壊れそうな', '壊れる', T.V1, 'looks like (-sou)');
  has('嬉しそうに', '嬉しい', T.ADJ, 'looks like (-sou)');
  has('読みやすい', '読む', T.V5, 'easy to (-yasui)');
  has('書きにくかった', '書く', T.V5, 'hard to (-nikui) + past');
  has('開けっぱなし', '開ける', T.V1, 'left as it is (-ppanashi)');
});

test('34.10 irrealis + ん: negative or literary volitional; あらん is never the negative', () => {
  has('戦わん', '戦う', T.V5, "negative (-n) or literary volitional (-n, 'will / let us')");
  has('あらん', 'ある', T.V5, "literary volitional (-n, 'will / let us')");
  has('有らん', '有る', T.V5, "literary volitional (-n, 'will / let us')");
  assert.ok(!deinflect('あらん').some((x) => x.form === 'ある' && x.via.join().includes('negative')));
});

test('34.11 brackets: only a reading after a kanji and Aozora ruby are left out', () => {
  assert.equal(stripBrackets('嵩(かさ)にきて'), '嵩にきて');
  assert.equal(stripBrackets('氷霜撃(アイシクルブレイク)'), '氷霜撃');
  assert.equal(stripBrackets('魔法(magic)'), '魔法');
  assert.equal(stripBrackets('｜漢字《かんじ》を読む'), '漢字を読む');
  assert.equal(stripBrackets('漢字《かんじ》｜a|b'), '漢字｜a|b', 'a bar that starts no ruby run stays');
  assert.equal(stripBrackets('「大丈夫だよ」（嘘だ、本当は泣きたい）'), '「大丈夫だよ」（嘘だ、本当は泣きたい）');
  assert.equal(stripBrackets('彼は（昨日買ったばかりの）剣'), '彼は（昨日買ったばかりの）剣');
  assert.equal(stripBrackets('ね（わらい）'), 'ね（わらい）', 'after a non-kanji: stays');
});

test('34.12 entry addresses: an ordinal n when records share (w, r, p)', () => {
  const [a, b] = [22, 23];
  assert.equal(addressOrdinal(store, 'words', a), 0);
  assert.equal(addressOrdinal(store, 'words', b), 1);
  const addr = entryAddress('words', store.getRecord('words', b), 1);
  assert.equal(entryHash(addr), `#w=${encodeURIComponent('ロック')}&r=${encodeURIComponent('ロック')}&p=words&n=1`);
  assert.deepEqual(parseEntryHash(entryHash(addr)), { w: 'ロック', r: 'ロック', p: 'words', n: 1 });
  assert.equal(findEntry(store, 'words', 'ロック', 'ロック', 1), b);
  assert.equal(findEntry(store, 'words', 'ロック', 'ロック'), a, 'an old address without n is the first record');
  assert.equal(findEntry(store, 'words', 'ロック', 'ロック', 7), a, 'an n out of range: the first record');
  assert.equal(entryHash(entryAddress('words', store.getRecord('words', a))), `#w=${encodeURIComponent('ロック')}&r=${encodeURIComponent('ロック')}&p=words`);
});

test('34.13 "Show more words": the first render lists 60 words, textAll lists every word', () => {
  const text = '林檎を'.repeat(40); // 80 words
  const g = withRec(group(full(text), 'text'));
  assert.equal(g.moreWords, 20);
  assert.match(textGroupHtml(g, 0), /data-textmore="1">Show more words \(20\)</);
  const all = withRec(group(full(text, { textAll: true }), 'text'));
  assert.equal(all.moreWords, 0);
  assert.ok(!all.segments.some((x) => x.kind === 'more'));
  assert.doesNotMatch(textGroupHtml(all, 0), /data-textmore/);
});

test('34.15 digits + counter are one piece with the counter entry', () => {
  const w = words('林檎を2つ買った');
  assert.deepEqual(w.map((x) => x.text), ['林檎', 'を', '2つ', '買った']);
  assert.equal(head('words', w[2].id), '箇');
  assert.equal(w[2].counter, 'つ');
  assert.deepEqual(segmentText(store, '12を').segments.map((x) => [x.kind, x.text]), [['sep', '12'], ['word', 'を']], 'no counter: digits stay plain');
});

test('34.16 slip chips: inflected words; at most 12 characters; not for a real word', () => {
  assert.deepEqual(kanjiSlipChips(store, '振り帰った').map((x) => x.chip), ['振り返った']);
  assert.deepEqual(kanjiSlipChips(store, '帰った'), [], 'an inflected real word gets no chip');
  assert.deepEqual(kanjiSlipChips(store, '振り帰った林檎を林檎を林檎'), [], 'longer than 12 characters');
});

test('34.17 search-only readings, re_restr, reading priority on cards', () => {
  const r = full('taiku');
  const h = group(r, 'words').results.find((x) => head('words', x.id) === '体育');
  assert.ok(h && h.tier === 0);
  assert.equal(h.note, `${SEARCH_ONLY_NOTE} 体育`);
  assert.ok(group(r, 'words').results.some((x) => head('words', x.id) === '太鼓' && x.tier === 3), 'the gate stays open: 太鼓 is offered');
  const rec = { k: ['行く', '逝く'], r: ['ゆく', 'いく'], rp: [1], rr: { ゆく: ['逝く'] }, s: [] };
  assert.deepEqual(readingsFor(rec, '行く'), ['いく']);
  assert.deepEqual(readingsFor(rec, '逝く'), ['いく', 'ゆく']);
  assert.equal(headParts(rec, null).reading, 'いく');
  assert.equal(headParts({ k: ['A'], r: ['あ', 'い'], rp: [1], s: [] }, null).reading, 'い', 'cards follow rec.rp like the entry page');
  assert.deepEqual(restrictedReadings([{ text: 'いく', appliesToKanji: ['*'] }, { text: 'ゆく', appliesToKanji: ['逝く', '往く'] }], ['いく', 'ゆく'], ['行く', '逝く']), { ゆく: ['逝く'] });
  assert.equal(restrictedReadings([{ text: 'いく', appliesToKanji: ['*'] }], ['いく'], ['行く']), null);
});

test('34.8 Wiktionary build rule: drop only a same form with the same reading (wide rule), dialect and colloquial kept', () => {
  const ctx = { forms: new Set(['魔道士', 'まどうし', '猫', 'ねこ']), pairs: new Set(['魔道士\tまどうし', 'まどうし\tまどうし', '猫\tねこ', 'ねこ\tねこ']), toHiragana: (s) => s };
  const e = (o) => ({ src: 'we', readings: [], slang: false, labelled: false, ...o });
  assert.equal(wiktKeep(e({ hw: '魔導師', readings: ['まどうし'] }), ctx, false), false, 'old rule: a homophone drops it');
  assert.equal(wiktKeep(e({ hw: '魔導師', readings: ['まどうし'] }), ctx, true), true, 'wide rule: kept');
  assert.equal(wiktKeep(e({ hw: '猫', readings: ['ねこ'] }), ctx, true), false, 'same form, same reading: dropped');
  assert.equal(wiktKeep(e({ hw: '猫', readings: ['みょう'] }), ctx, true), true, 'same form, other reading: kept');
  assert.equal(wiktKeep(e({ src: 'wj', hw: '猫', readings: ['ねこ'], labelled: true }), ctx, true), true, 'dialect / colloquial: kept');
  assert.equal(wiktKeep(e({ src: 'wj', hw: '猫', readings: ['ねこ'], labelled: true }), ctx, false), false, 'old rule: wj only slang');
  assert.equal(wiktKeep(e({ hw: '猫', slang: true }), ctx, false), true);
});

test('34.14 warm-up in slices builds the same indexes as warm()', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'nj-audit-w-'));
  try {
    writePack(dir2, 'words', WORDS.map((r) => r[0]), WORDS.map((r) => [r[1], r[2]]));
    writeFileSync(join(dir2, 'version.json'), JSON.stringify({ built: '2026-11-26', packs: { words: { n: WORDS.length } } }));
    const s2 = new PackStore(fsReader(dir2), { additions: false });
    await s2.loadVersion();
    await s2.loadPack('words');
    let pauses = 0;
    await s2.warmAsync('words', async () => { pauses++; }, 5);
    assert.ok(pauses > 3, 'it pauses between slices');
    const r1 = s2.keySpace('words', 'r'), r0 = store.keySpace('words', 'r');
    store.warm('words');
    assert.deepEqual(Array.from(r1._fold.bidx), Array.from(r0._fold.bidx));
    assert.deepEqual(Array.from(r1.masks()), Array.from(r0.masks()));
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});
