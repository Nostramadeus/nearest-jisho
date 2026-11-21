// SPEC 30: a word typed partly in kana. SPEC 31: brackets and the text inside them are left out of a query.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePack, fsReader } from './helpers/fixture.mjs';
import { PackStore } from '../app/search/packs.js';
import { search, stripBrackets } from '../app/search/engine.js';
import { segmentText, mixedWhole } from '../app/search/segment.js';
import { mixedSpans, mixedNote } from '../app/search/mixed.js';

const N = (p, g, extra = {}) => ({ p, g, ...extra });
const WORDS = [
  [{ k: ['笠に着る', '嵩に着る'], r: ['かさにきる'], s: [N(['exp', 'v1'], ['to wear the mantle of authority'])] }, 44369, 999999], // 0
  [{ k: ['嵩'], r: ['かさ'], s: [N(['n'], ['bulk'])] }, 9000, 9000],                              // 1
  [{ r: ['に'], c: 1, s: [N(['prt'], ['at', 'in'])] }, 3, 3],                                     // 2
  [{ r: ['て'], c: 1, s: [N(['prt'], ['and'])] }, 4, 4],                                          // 3
  [{ r: ['き'], s: [N(['aux-v'], ['past (classical)'])] }, 5000, 5000],                           // 4
  [{ k: ['気持ち', '気持'], r: ['きもち'], c: 1, s: [N(['n'], ['feeling'])] }, 214, 500],         // 5
  [{ k: ['昆虫'], r: ['こんちゅう'], c: 1, s: [N(['n'], ['insect'])] }, 8000, 8000],              // 6
  [{ k: ['虫'], r: ['むし'], c: 1, s: [N(['n'], ['bug'])] }, 1500, 1500],                         // 7
  [{ k: ['首都'], r: ['しゅと'], c: 1, s: [N(['n'], ['capital city'])] }, 5000, 5000],            // 8
  [{ k: ['首'], r: ['くび'], c: 1, s: [N(['n'], ['neck'])] }, 1400, 1400],                        // 9
  [{ r: ['と'], c: 1, s: [N(['prt'], ['and', 'with'])] }, 5, 5],                                  // 10
  [{ k: ['取り消す'], r: ['とりけす'], c: 1, s: [N(['v5s'], ['to cancel'])] }, 9000, 9000],       // 11
  [{ k: ['友達'], r: ['ともだち'], c: 1, s: [N(['n'], ['friend'])] }, 541, 2500],                 // 12
  [{ k: ['彼'], r: ['かれ'], c: 1, s: [N(['pn'], ['he'])] }, 60, 60],                             // 13
  [{ r: ['は'], c: 1, s: [N(['prt'], ['topic marker'])] }, 2, 2],                                 // 14
  [{ k: ['傘'], r: ['かさ'], c: 1, s: [N(['n'], ['umbrella'])] }, 2000, 2000],                    // 15
  [{ k: ['生物'], r: ['せいぶつ'], c: 1, s: [N(['n'], ['living thing'])] }, 3000, 3000],          // 16
  [{ k: ['コーヒー豆'], r: ['コーヒーまめ'], s: [N(['n'], ['coffee bean'])] }, 20000, 20000],     // 17
];
const dir = mkdtempSync(join(tmpdir(), 'nj-mixed-'));
writePack(dir, 'words', WORDS.map((r) => r[0]), WORDS.map((r) => [r[1], r[2]]));
const store = new PackStore(fsReader(dir));
await store.loadPack('words');
store.warm('words');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const first = (q, opts = {}) => {
  const g = search(store, q, { phase: 'full', ...opts }).groups[0];
  return g ? { group: g.id, id: g.results[0].id, note: g.results[0].note || '', tier: g.results[0].tier } : null;
};
const split = (text) => segmentText(store, text).segments.map((x) => (x.kind === 'word' ? `[${x.text}]` : `?${x.text}`)).join('');

test('30: the reported case, 嵩にきて finds 笠に着る through its spelling 嵩に着る', () => {
  const r = first('嵩にきて');
  assert.deepEqual([r.group, r.id, r.tier], ['words', 0, 0]);
  assert.equal(r.note, '嵩にきて is the te-form form of 嵩に着る');
});

test('30: as typed (no inflection) and other inflections', () => {
  assert.equal(first('嵩にきる').note, mixedNote('嵩にきる', '嵩に着る'));
  assert.equal(first('嵩にきた').id, 0);
  assert.equal(first('取りけした').id, 11);
  assert.equal(first('取りけす').id, 11);
});

test('30: kana before the kept kanji, voiced reading, and the longest written form in the note', () => {
  assert.deepEqual([first('こん虫').id, first('こん虫').note], [6, 'こん虫 is 昆虫 with part written in kana']);
  assert.equal(first('友だち').id, 12);
  assert.equal(first('気もち').note, '気もち is 気持ち with part written in kana'); // not 気持
});

test('30.3: a last kanji as one particle kana is refused (首と is 首 + と, never 首都)', () => {
  assert.equal(mixedWhole(store, '首と'), null);
  assert.equal(split('首と'), '[首][と]');
  const g = search(store, '首と', { phase: 'full' }).groups.find((x) => x.id === 'words');
  assert.ok(!g || !g.results.some((h) => h.id === 8 && h.tier === 0));
});

test('30: the reading must fit, and a spelling that differs only in kana script is not such a word', () => {
  assert.equal(mixedSpans(store, 'words', Array.from('生きもの')).size, 0); // 生物 is せいぶつ
  assert.equal(mixedSpans(store, 'words', Array.from('こーひー豆')).size, 0); // no kanji was replaced
  assert.equal(mixedSpans(store, 'words', Array.from('かさ')).size, 0); // kana only
});

test('30: inside a pasted text the word is one piece, with its note', () => {
  assert.equal(split('彼は嵩にきて'), '[彼][は][嵩にきて]');
  const g = search(store, '彼は嵩にきて、こん虫', { phase: 'full' }).groups[0];
  assert.equal(g.id, 'text');
  const hit = g.results.find((r) => r.segment === '嵩にきて');
  assert.equal(hit.id, 0);
  assert.equal(hit.note, '嵩にきて is the te-form form of 嵩に着る');
  assert.equal(g.results.find((r) => r.segment === 'こん虫').note, 'こん虫 is 昆虫 with part written in kana');
});

test('30: a true written form still wins over a partly-kana reading', () => {
  const r = first('気持ち');
  assert.deepEqual([r.id, r.note], [5, '']);
});

test('31: stripBrackets', () => {
  assert.equal(stripBrackets('嵩(かさ)にきて'), '嵩にきて');
  assert.equal(stripBrackets('嵩（かさ）にきて'), '嵩にきて');
  assert.equal(stripBrackets('｜嵩《かさ》にきて'), '嵩にきて');
  assert.equal(stripBrackets('無職(むしょく)転生(てんせい)'), '無職転生');
  assert.equal(stripBrackets('a (b (c) d) e'), 'a  e');
  assert.equal(stripBrackets('(かさ)'), '(かさ)'); // nothing would be left: kept as typed
  assert.equal(stripBrackets('嵩(かさ'), '嵩(かさ'); // not closed: kept
  assert.equal(stripBrackets('a|b'), 'a|b'); // the bar goes only together with 《》
});

test('31: a query with furigana in brackets is searched without it; the setting can keep them', () => {
  assert.equal(first('嵩(かさ)にきて').id, 0);
  assert.equal(first('嵩（かさ）にきて').id, 0);
  const kept = search(store, '嵩(かさ)にきて', { phase: 'full', keepBrackets: true }).groups[0];
  assert.equal(kept.id, 'text');
});

test('31: the setting is in the page, on by default, and reaches the worker', () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(src('../app/index.html'), /<input type="checkbox" id="ignorebrackets"> Ignore brackets and the text inside them/);
  assert.match(src('../app/main.js'), /S\.ignoreBrackets = store\.get\('nj-ignore-brackets', true\) !== false;/);
  assert.match(src('../app/main.js'), /keepBrackets: !S\.ignoreBrackets/);
  assert.match(src('../app/worker.js'), /keepBrackets: !!m\.keepBrackets/);
  assert.match(src('../app/sw.js'), /'\.\/search\/mixed\.js'/);
});
