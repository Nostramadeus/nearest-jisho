// SPEC 29: other ways to split a pasted text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePack, fsReader, loadFixtureStore } from './helpers/fixture.mjs';
import { PackStore } from '../app/search/packs.js';
import { search } from '../app/search/engine.js';
import { segmentText, ALT_MARGIN, ALT_MAX, ALT_PARTICLES } from '../app/search/segment.js';
import { groupsHtml } from '../app/render.js';

const N = (p, g, extra = {}) => ({ p, g, ...extra });
const WORDS = [
  [{ k: ['車'], r: ['くるま'], c: 1, s: [N(['n'], ['car'])] }, 500, 500],                       // 0
  [{ r: ['で'], c: 1, s: [N(['prt'], ['at', 'in'])] }, 3, 3],                                   // 1
  [{ k: ['待つ'], r: ['まつ'], c: 1, s: [N(['v5t'], ['to wait'])] }, 400, 400],                 // 2
  [{ k: ['来る'], r: ['くる'], c: 1, s: [N(['vk'], ['to come'])] }, 90, 90],                    // 3
  [{ k: ['迄'], r: ['まで'], c: 1, s: [N(['prt'], ['until'], { m: ['uk'] })] }, 30, 30],        // 4
  [{ k: ['今日は'], r: ['こんにちは'], c: 1, s: [N(['int'], ['hello'])] }, 200, 200],           // 5
  [{ k: ['今日'], r: ['きょう'], c: 1, s: [N(['n'], ['today'])] }, 97, 97],                     // 6
  [{ r: ['は'], c: 1, s: [N(['prt'], ['topic marker'])] }, 2, 2],                               // 7
  [{ r: ['い'], s: [N(['prt'], ['strengthens a question'])] }, 600, 600],                       // 8: one kana, not in ALT_PARTICLES
  [{ k: ['何れ'], r: ['どれ'], c: 1, s: [N(['pn'], ['which'], { m: ['uk'] })] }, 300, 300],     // 9
  [{ k: ['奴隷'], r: ['どれい'], c: 1, s: [N(['n'], ['slave'])] }, 1000, 1000],                 // 10
  [{ k: ['学校'], r: ['がっこう'], c: 1, s: [N(['n'], ['school'])] }, 300, 300],                // 11
  [{ k: ['学'], r: ['がく'], c: 1, s: [N(['n'], ['learning'])] }, 800, 800],                    // 12
  [{ k: ['校'], r: ['こう'], c: 1, s: [N(['n'], ['school', 'proof'])] }, 900, 900],             // 13
  [{ k: ['待'], r: ['まち'], s: [N(['n'], ['wait'])] }, 300000, 300000],                        // 14: rare (P 15)
  [{ k: ['つ'], r: ['つ'], s: [N(['n'], ['harbour'])] }, 700, 700],                             // 15: one kana noun: never a word
];
const dir = mkdtempSync(join(tmpdir(), 'nj-alt-'));
writePack(dir, 'words', WORDS.map((r) => r[0]), WORDS.map((r) => [r[1], r[2]]));
const store = new PackStore(fsReader(dir));
await store.loadPack('words');
store.warm('words');
const fx = await loadFixtureStore();
test.after(() => { rmSync(dir, { recursive: true, force: true }); fx.cleanup(); });

const chosen = (s, text) => segmentText(s, text).segments.map((x) => (x.kind === 'word' ? `[${x.text}]` : `?${x.text}`)).join('');
const alts = (s, text, o) => segmentText(s, text, o).alts.map((a) => `${a.segments.map((x) => x.text).join(' / ')} <- ${a.instead.join(' / ')} +${a.delta}`);
const textGroup = (s, q) => search(s, q, { phase: 'full' }).groups.find((g) => g.id === 'text');

test('a moved boundary is listed: くるま / で or くる / まで', () => {
  assert.equal(chosen(store, 'くるまでまつ'), '[くるま][で][まつ]');
  assert.deepEqual(alts(store, 'くるまでまつ'), ['くる / まで <- くるま / で +0']);
  // on the fixture packs: 草草 / 草 is chosen (longer first segment), 草 / 草草 is the other split
  assert.equal(chosen(fx.store, '草草草'), '[草草][草]');
  assert.deepEqual(alts(fx.store, '草草草'), ['草 / 草草 <- 草草 / 草 +0']);
});

test('one chosen word cut in two: only "word + function word"', () => {
  assert.equal(chosen(store, '今日はまつ'), '[今日は][まつ]');
  assert.deepEqual(alts(store, '今日はまつ'), ['今日 / は <- 今日は +10']);
  // 学校 is never offered as 学 / 校; どれい is never offered as どれ / い (い is not one of the listed particles)
  assert.deepEqual(alts(store, '学校でまつ'), []);
  assert.equal(chosen(store, 'どれいはまつ'), '[どれい][は][まつ]');
  assert.deepEqual(alts(store, 'どれいはまつ'), []);
  assert.ok(ALT_PARTICLES.has('は') && !ALT_PARTICLES.has('い'));
});

test('margin: a split that weighs more than the margin above the chosen one is not listed', () => {
  assert.equal(ALT_MARGIN, 10);
  // 待つ (10) -> 待 (25) + つ: つ is a noun here, so it is no word at all; and with margin 0 the +10 row is gone
  assert.deepEqual(alts(store, '今日は待つ'), ['今日 / は <- 今日は +10']);
  assert.deepEqual(alts(store, '今日はまつ', { margin: 9 }), []);
});

test('the same change at two places is listed once; at most ALT_MAX rows; only among the shown words', () => {
  assert.deepEqual(alts(store, 'くるまで、くるまで'), ['くる / まで <- くるま / で +0']);
  assert.equal(ALT_MAX, 5);
  assert.deepEqual(alts(store, 'くるまでまつ', { altMax: 0 }), []);
  // wordLimit 1: only くるま is shown, so the change that needs で is not looked for
  assert.deepEqual(alts(store, 'くるまでまつ', { wordLimit: 1 }), []);
  assert.deepEqual(alts(store, 'くるまでまつ', { wordLimit: 2 }), ['くる / まで <- くるま / で +0']);
});

test('the group: alternative rows point to items; every word sits where it starts in the text, the chosen one first', () => {
  const g = textGroup(store, 'くるまでまつ');
  assert.deepEqual(g.segments.map((x) => `${x.text}>${x.item}`), ['くるま>0', 'で>3', 'まつ>4']);
  assert.deepEqual(g.alts, [{ instead: ['くるま', 'で'], chips: [{ text: 'くる', item: 1 }, { text: 'まで', item: 2 }] }]);
  // くる starts where くるま starts: directly after it; まで starts before で
  assert.deepEqual(g.results.map((h) => [h.segment, !!h.alt, h.fn]), [['くるま', false, false], ['くる', true, false], ['まで', true, true], ['で', false, true], ['まつ', false, false]]);
  assert.deepEqual(g.results.map((h) => h.altHead || ''), ['', 'くる / まで', '', '', '']); // the label once per run of a split's words
  assert.equal(g.wordCount, 3); // the count in the title stays the chosen split's
  // a word the chosen split uses too stays one item at its chosen place: は is not repeated and not marked alt
  const g2 = textGroup(store, '今日はまつは');
  assert.deepEqual(g2.alts, [{ instead: ['今日は'], chips: [{ text: '今日', item: 1 }, { text: 'は', item: 3 }] }]);
  assert.deepEqual(g2.results.map((h) => [h.segment, !!h.alt]), [['今日は', false], ['今日', true], ['まつ', false], ['は', false]]);
  // a long text: the other split's words are in the middle of the list, not at its end
  const g4 = textGroup(store, 'まつ、まつ。学校でまつ、くるまでまつ、今日はまつ');
  assert.deepEqual(g4.results.map((h) => `${h.segment}${h.alt ? '*' : ''}`), ['まつ', '学校', 'で', 'くるま', 'くる*', 'まで*', '今日は', '今日*', 'は*']);
  // no other split: no rows, no heading
  const g3 = textGroup(store, '学校でまつ');
  assert.deepEqual(g3.alts, []);
});

test('rendered rows and the label above the extra words', () => {
  const g = textGroup(store, 'くるまでまつ');
  for (const h of g.results) h.rec = store.getRecord(h.pack, h.id);
  const html = groupsHtml([g]);
  assert.match(html, /<\/p><div class="altsplits"><p class="althead">Other ways to split:<\/p><p class="altline"><span lang="ja"><button type="button" class="chip" data-item="1">くる<\/button><button type="button" class="chip" data-item="2">まで<\/button><\/span> <span class="instead">instead of <span lang="ja">くるま \/ で<\/span><\/span><\/p><\/div><p class="textnote">/);
  assert.match(html, /<p class="altsub">Other split: <span lang="ja">くる \/ まで<\/span><\/p><div class="titem alt" id="t-1">/);
  assert.equal(html.match(/class="altsub"/g).length, 1);
  assert.match(html, /<div class="titem alt" id="t-2"><a class="fnrow"/);
  assert.match(html, /<div class="titem" id="t-3"><a class="fnrow"/);
  assert.match(html, /<div class="titem" id="t-4"><article class="card"/);
  const g3 = textGroup(store, '学校でまつ');
  for (const h of g3.results) h.rec = store.getRecord(h.pack, h.id);
  const plain = groupsHtml([g3]);
  assert.ok(!plain.includes('altsplits') && !plain.includes('altsub'));
});
