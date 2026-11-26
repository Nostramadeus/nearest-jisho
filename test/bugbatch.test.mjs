// SPEC 32: the owner's bug batch of 2026-11-26 (items 1 to 8 on a small fixture; item 10 in scroll.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePack, fsReader } from './helpers/fixture.mjs';
import { PackStore } from '../app/search/packs.js';
import { search, bracketReadings } from '../app/search/engine.js';
import { segmentText } from '../app/search/segment.js';
import { ADDITIONS, ADDITIONS_SOURCE } from '../app/search/additions.js';
import { groupsHtml, cardHtml } from '../app/render.js';

const N = (p, g, extra = {}) => ({ p, g, ...extra });
const WORDS = [
  [{ k: ['悩ましい'], r: ['なやましい'], s: [N(['adj-i'], ['seductive'])] }, 14146, 19000], // 0
  [{ k: ['悩ましげ'], r: ['なやましげ'], s: [N(['adj-na'], ['anxious (appearance)'])] }, 23610, 999999], // 1
  [{ r: ['ボディー', 'ボディ'], c: 1, s: [N(['n'], ['body'])] }, 5000, 5000], // 2
  [{ r: ['を'], c: 1, s: [N(['prt'], ['object marker'])] }, 2, 2], // 3
  [{ k: ['胡乱'], r: ['うろん'], s: [N(['adj-na', 'n'], ['suspicious-looking', 'fishy'], { m: ['uk'] })] }, 26912, 999999], // 4
  [{ r: ['しょぼつく'], s: [N(['v5k', 'vi'], ['to drizzle'])] }, 101037, 999999], // 5
  [{ k: ['尻'], r: ['しり'], c: 1, s: [N(['n'], ['buttocks'])] }, 3000, 3000], // 6
  [{ r: ['も'], c: 1, s: [N(['prt'], ['too', 'also'])] }, 4, 4], // 7
  [{ k: ['掻く'], r: ['かく'], c: 1, s: [N(['v5k', 'vt'], ['to scratch'])] }, 2000, 2000], // 8
  [{ k: ['藻掻く'], r: ['もがく'], s: [N(['v5k', 'vi'], ['to struggle'], { m: ['uk'] })] }, 9000, 9000], // 9
  [{ k: ['状'], r: ['じょう'], c: 1, s: [N(['n', 'n-suf'], ['form']), N(['n', 'n-suf'], ['letter'])] }, 4715, 15000], // 10
  [{ k: ['様', '状'], r: ['さま'], c: 1, s: [N(['suf'], ['Mr', 'Mrs'], { m: ['hon'] })] }, 443, 15000], // 11
  [{ r: ['ゼリー'], c: 1, s: [N(['n'], ['jelly'])] }, 9000, 9000], // 12
  [{ k: ['寒い'], r: ['さむい'], c: 1, s: [N(['adj-i'], ['cold'])] }, 1287, 20000], // 13
  [{ k: ['寒がる'], r: ['さむがる'], s: [N(['v5r'], ['to feel the cold'])] }, 109200, 999999], // 14
  [{ r: ['の'], c: 1, s: [N(['prt'], ['possessive'])] }, 1, 1], // 15
  [{ k: ['腹'], r: ['はら'], c: 1, s: [N(['n'], ['belly'])] }, 1500, 1500], // 16
  [{ r: ['が'], c: 1, s: [N(['prt'], ['subject marker'])] }, 3, 3], // 17
];
const KANJI = {
  撃: { m: ['beat', 'attack'], on: ['ゲキ'], kun: ['う.つ'] },
  状: { m: ['form'], on: ['ジョウ'] },
  掻: { m: ['scratch'], on: ['ソウ'], kun: ['か.く'] },
  藻: { m: ['seaweed'], on: ['ソウ'], kun: ['も'] },
  尻: { m: ['buttocks'], kun: ['しり'] },
};
const dir = mkdtempSync(join(tmpdir(), 'nj-batch-'));
writePack(dir, 'words', WORDS.map((r) => r[0]), WORDS.map((r) => [r[1], r[2]]));
writeFileSync(join(dir, 'kanji.json'), JSON.stringify(KANJI));
const store = new PackStore(fsReader(dir));
await store.loadPack('words');
await store.loadKanji();
store.warm('words');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const full = (q, o = {}) => search(store, q, { phase: 'full', ...o });
const head = (h) => { const r = store.getRecord(h.pack, h.id); return (r.k && r.k[0]) || r.r[0]; };
const first = (r) => r.groups[0].results[0];
const words = (text) => segmentText(store, text).segments.filter((x) => x.kind === 'word');

test('32.1 an i-adjective stem in し is a word piece: 悩ましボディを', () => {
  const ws = words('悩ましボディを');
  assert.deepEqual(ws.map((x) => x.text), ['悩まし', 'ボディ', 'を']);
  assert.equal(head(ws[0]), '悩ましい');
  assert.equal(ws[0].via, 'adjective stem');
  for (const q of ['悩まし', 'なやまし', 'nayamashi']) {
    const h = first(full(q));
    assert.equal(head(h), '悩ましい', q);
    assert.equal(h.via, 'adjective stem', q);
  }
  assert.match(first(full('悩まし')).note, /^悩まし is the adjective stem form of 悩ましい$/);
});

test('32.2 a kanji that matches no word gets its kanji row (meanings, on / kun readings)', () => {
  const g = full('尻の撃').groups[0];
  assert.equal(g.id, 'text');
  const k = g.results.find((h) => h.pack === 'kanji');
  assert.ok(k);
  assert.equal(k.kanji, '撃');
  assert.deepEqual(k.kd, { m: ['beat', 'attack'], on: ['ゲキ'], kun: ['う.つ'] });
  const chip = g.segments.find((x) => x.text === '撃');
  assert.equal(chip.kind, 'unknown');
  assert.equal(chip.item, g.results.indexOf(k));
  for (const h of g.results) h.rec = store.getRecord(h.pack, h.id);
  const html = groupsHtml([g]);
  assert.match(html, /<button type="button" class="chip unk" data-item="\d+">撃<\/button>/);
  assert.match(html, /<a class="fnrow krow" href="#q=%E6%92%83"><span class="seg" lang="ja">撃<\/span> <span class="pos">kanji<\/span> <span class="info">beat, attack<\/span> <span class="kread">On <span lang="ja">ゲキ<\/span> · Kun <span lang="ja">う.つ<\/span><\/span><\/a>/);
});

test('32.3 kana in brackets after a kanji is a reading: its words follow the main words', () => {
  assert.deepEqual(bracketReadings('氷霜撃(アイシクルブレイク)'), [{ base: '氷霜撃', reading: 'アイシクルブレイク' }]);
  assert.deepEqual(bracketReadings('撃（げき）と撃《げき》'), [{ base: '撃', reading: 'げき' }]);
  assert.deepEqual(bracketReadings('撃(attack)'), []); // not kana: unchanged (SPEC 31)
  assert.deepEqual(bracketReadings('ボディ(ぼでぃ)'), []); // not after a kanji
  const g = full('尻の撃(ボディを)').groups[0];
  assert.equal(g.id, 'text');
  assert.deepEqual(g.segments.filter((x) => x.kind === 'word').map((x) => x.text), ['尻', 'の']); // the split as before (SPEC 31)
  assert.equal(g.readings.length, 1);
  assert.equal(g.readings[0].reading, 'ボディを');
  assert.deepEqual(g.readings[0].chips.map((x) => x.text), ['ボディ', 'を']);
  const fromR = g.results.filter((h) => h.fromReading);
  assert.deepEqual(fromR.map((h) => h.segment), ['ボディ', 'を']);
  assert.equal(fromR[0].readingHead, 'From the reading in brackets');
  assert.ok(g.results.indexOf(fromR[0]) > g.results.findIndex((h) => h.segment === '撃'), 'after the main words');
  for (const h of g.results) h.rec = store.getRecord(h.pack, h.id);
  const html = groupsHtml([g]);
  assert.match(html, /<p class="readline">Reading given in the text: <span lang="ja"><button type="button" class="chip" data-item="\d+">ボディ<\/button><button type="button" class="chip" data-item="\d+">を<\/button><\/span><\/p>/);
  assert.match(html, /<p class="altsub">From the reading in brackets<\/p><div class="titem reading"/);
  // brackets setting off: searched as typed, no reading line
  assert.ok(!(full('尻の撃(ボディを)', { keepBrackets: true }).groups[0].readings || []).length);
});

test('32.4 Nearest Jisho additions: merged into the words pack, found by every search path', () => {
  assert.equal(store.size('words'), WORDS.length + ADDITIONS.length);
  const k = first(full('くちい'));
  assert.equal(head(k), 'くちい');
  assert.equal(store.getRecord('words', k.id).src, 'nj');
  assert.equal(head(first(full('kuchii'))), 'くちい');
  assert.equal(head(first(full('satiated'))), 'くちい');
  assert.equal(head(first(full('血判状'))), '血判状');
  const d = first(full('くちくなった'));
  assert.equal(head(d), 'くちい');
  assert.equal(d.via, 'become (-ku naru) + past');
  const ws = words('腹がくちく');
  assert.deepEqual(ws.map((x) => x.text), ['腹', 'が', 'くちく']);
  assert.equal(head(ws[2]), 'くちい');
  const ks = store.keySpace('words', 'k');
  for (let i = 1; i < ks.count; i++) assert.ok(ks.cmp(i - 1, ks.key(i)) < 0, 'keys stay sorted');
  const h = first(full('くちい'));
  h.rec = store.getRecord(h.pack, h.id);
  assert.match(cardHtml(h, 0, 0), new RegExp(`<span class="tag g">${ADDITIONS_SOURCE}</span>`));
});

test('32.4 an addition the data already has is not added twice', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'nj-batch2-'));
  try {
    writePack(d2, 'words', [{ r: ['くちい'], s: [N(['adj-i'], ['full'])] }], [[20000, 20000]]);
    const s2 = new PackStore(fsReader(d2));
    await s2.loadPack('words');
    assert.equal(s2.size('words'), 1 + ADDITIONS.length - 1);
    const s3 = new PackStore(fsReader(d2), { additions: false });
    await s3.loadPack('words');
    assert.equal(s3.size('words'), 1);
  } finally { rmSync(d2, { recursive: true, force: true }); }
});

test('32.5 a one-kanji piece after a noun takes the suffix entry with an on reading: ゼリー状', () => {
  const ws = words('ゼリー状');
  assert.deepEqual(ws.map((x) => x.text), ['ゼリー', '状']);
  assert.equal(store.getRecord('words', ws[1].id).r[0], 'じょう');
  // not after a noun: the best-ranked entry as before
  assert.equal(store.getRecord('words', words('を状を')[1].id).r[0], 'さま');
});

test('32.6 stem suffixes: 胡乱げ, うろんげ, uronge; an own entry stays first', () => {
  for (const q of ['うろんげ', 'uronge', '胡乱げ']) {
    const h = first(full(q));
    assert.equal(head(h), '胡乱', q);
    assert.equal(h.via, '-ge: seeming, looking', q);
    assert.match(h.note, /胡乱 \+ -ge: seeming, looking$/, q);
  }
  assert.deepEqual(words('胡乱げ').map((x) => x.text), ['胡乱げ']);
  const r = full('悩ましげ').groups[0].results;
  assert.equal(head(r[0]), '悩ましげ');
  assert.equal(r[0].via, null);
  assert.equal(head(r[1]), '悩ましい');
  const s = full('寒がって').groups[0].results;
  assert.deepEqual(s.map(head), ['寒がる', '寒い']);
  assert.equal(s[1].note, '寒がって is 寒い + -garu: shows signs of feeling (te-form)');
});

test('32.7 a leading particle kana after a kanji word is not part of a partly-kana word: 尻も掻いて', () => {
  const ws = words('尻も掻いて');
  assert.deepEqual(ws.map((x) => x.text), ['尻', 'も', '掻いて']);
  assert.equal(head(ws[2]), '掻く');
  // alone, a search for も掻いて still lists 藻掻く first, typed partly in kana (SPEC 30). Since SPEC 34.3 the
  // splitter adds +4 for the te-form of a partly-kana word, so its own split of も掻いて is も / 掻いて.
  assert.equal(head(first(full('も掻いて'))), '藻掻く');
});

test('32.8 masu-stem endings after a derived stem: しょぼつかせながら', () => {
  for (const q of ['しょぼつかせながら', 'shobotsukasenagara']) {
    const h = first(full(q));
    assert.equal(head(h), 'しょぼつく', q);
    assert.equal(h.via, 'causative + while (-nagara)', q);
  }
});
