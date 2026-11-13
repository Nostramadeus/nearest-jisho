// SPEC 21: exact matches first (21.1), suggestion chips (21.2, 21.3); text-group chip scrolling below the sticky row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePack, fsReader, loadFixtureStore } from './helpers/fixture.mjs';
import { makePage, tick } from './helpers/page.mjs';
import { PackStore } from '../app/search/packs.js';
import { search, SUGGEST_JA_MAX, SUGGEST_EN_MAX } from '../app/search/engine.js';
import { suggestionBarHtml, scrollTargetY } from '../app/render.js';

const N = (p, g, extra = {}) => ({ p, g, ...extra });
const MINI = [
  [{ k: ['甲斐差'], r: ['かいさ'], c: 1, s: [N(['n'], ['common exact'])] }, 50000, 50000],     // 0 tier 0, common
  [{ k: ['階差'], r: ['かいさ'], s: [N(['n'], ['difference'])] }, 146345, 999999],             // 1 tier 0, rare
  [{ r: ['かいさあ'], c: 1, s: [N(['n'], ['fold word'])] }, 2000, 2000],                        // 2 tier 1 fold, common
  [{ k: ['会社'], r: ['かいしゃ'], c: 1, s: [N(['n'], ['company'])] }, 1447, 500],              // 3 near, promoted
  [{ k: ['会話'], r: ['かいわ'], c: 1, s: [N(['n'], ['conversation'])] }, 1127, 2000],          // 5 near (s -> w)
  [{ k: ['海田'], r: ['かいだ'], s: [N(['n'], ['place'])] }, 90000, 90000],                     // 6 near (s -> d)
  [{ k: ['外座'], r: ['かいさ', 'かいざ'], s: [N(['n'], ['two readings'])] }, 80000, 80000], // 7 kaiza: its record is tier 0
  [{ k: ['貝殻'], r: ['かいが'], s: [N(['n'], ['shell'])] }, 70000, 70000],                     // 8 near (other)
  [{ k: ['怪異'], r: ['かいい'], s: [N(['n'], ['mystery'])] }, 60000, 60000],                   // 9 near
  [{ k: ['傘'], r: ['かさ'], c: 1, s: [N(['n'], ['umbrella'])] }, 900, 900],                    // 10 near; exact common for "kasa"
  [{ k: ['内緒'], r: ['ないしょ'], c: 1, s: [N(['n'], ['secrecy'])] }, 2844, 15000],
  [{ k: ['内装'], r: ['ないそう'], c: 1, s: [N(['n'], ['interior design'])] }, 9974, 7000],
  [{ k: ['辞書'], r: ['じしょ'], c: 1, s: [N(['n'], ['dictionary'])] }, 500, 1000],
];
const dir = mkdtempSync(join(tmpdir(), 'nj-chips-'));
writePack(dir, 'words', MINI.map((r) => r[0]), MINI.map((r) => [r[1], r[2]]));
const mini = new PackStore(fsReader(dir));
await mini.loadPack('words');
mini.warm('words');
const fx = await loadFixtureStore();
test.after(() => { rmSync(dir, { recursive: true, force: true }); fx.cleanup(); });

const run = (q, o = {}) => search(mini, q, { phase: 'full', ...o });
const words = (r) => (r.groups.find((g) => g.id === 'words') || { results: [] }).results;
const headOf = (h) => { const r = mini.getRecord(h.pack, h.id); return (r.k && r.k[0]) || r.r[0]; };

test('21.1 LATIN block order: tier-0 common, tier-1 common, tier-0 rare, then the rest by S', () => {
  // gate open: tiers 0-2 have 4 hits (< 5) for a 5-letter query
  const w = words(run('kaisa'));
  assert.deepEqual(w.slice(0, 6).map(headOf), ['甲斐差', 'かいさあ', '外座', '階差', '会社', '会話']);
  assert.deepEqual(w.slice(0, 5).map((h) => h.tier), [0, 1, 0, 0, 3]);
  assert.equal(w[4].promoted, true);
  // the rest after the promoted rows: near hits by S, none promoted
  assert.ok(w.slice(6).every((h) => h.tier === 3 && !h.promoted));
  // no rare exact hit: the common fold hit stays in the S order (naiso: 内緒 S 7 before 内装 S 8)
  assert.deepEqual(words(run('naiso')).slice(0, 2).map(headOf), ['内緒', '内装']);
  // KANA: tier 0 strictly first, unchanged
  const k = words(run('かいさ'));
  assert.deepEqual(k.slice(0, 3).map((h) => h.tier), [0, 0, 0]);
});

test('21.2 suggestions: order by S, at most 5 Japanese + 3 English, no tier-0 key, none when the gate is closed', () => {
  const r = run('kaisa');
  const ja = r.suggestions.filter((x) => x.side === 'ja');
  assert.ok(ja.length <= SUGGEST_JA_MAX && ja.length === 5);
  assert.equal(ja[0].key, 'kaisaa'); // tier 1 fold, S 2 + P(2000) = 3
  assert.equal(ja[1].key, 'kaisha'); // S 4 + P(1447) = 5
  for (let i = 1; i < ja.length; i++) assert.ok(ja[i - 1].S <= ja[i].S);
  assert.ok(!r.suggestions.some((x) => x.key === 'kaiza')); // its only record is already a tier-0 row
  assert.ok(!r.suggestions.some((x) => x.key === 'kaisa'));
  assert.ok(r.suggestions.filter((x) => x.side === 'en').length <= SUGGEST_EN_MAX);
  assert.equal(ja[1].head, '会社');
  assert.equal(ja[1].label, 'h or y missing');
  // kasa: a common exact word, no tier-1 or variant key -> no chips at all
  assert.deepEqual(run('kasa').suggestions, []);
  // phase fast: only tier-1 / variant keys
  assert.deepEqual(run('kaisa', { phase: 'fast' }).suggestions.map((x) => x.key), ['kaisaa']);
});

test('21.2 / 21.3 chip text per query kind; none for kanji queries or text input', () => {
  assert.equal(run('kaisa').suggestions.find((x) => x.head === '会社').chip, 'kaisha');
  assert.equal(run('かいさ').suggestions.find((x) => x.head === '会社').chip, 'かいしゃ');
  const en = run('dictonary').suggestions;
  assert.deepEqual(en.map((x) => [x.side, x.chip]), [['en', 'dictionary']]);
  assert.deepEqual(run('階差').suggestions, []);
  const text = search(fx.store, '彼方の空まで', { phase: 'full' });
  assert.equal(text.groups[0].id, 'text');
  assert.deepEqual(text.suggestions, []);
});

test('21.2 / 21.3 bar texts; chips show the spelling only', () => {
  const r = run('kaisa');
  assert.equal(r.anyExact, true);
  const html = suggestionBarHtml(r);
  assert.match(html, /^<span class="dymtext">Did you mean:<\/span><button type="button" class="sugg" data-q="kaisaa" title="long vowel \/ double letter"><span>kaisaa<\/span><\/button>/);
  assert.ok(!html.includes('会社')); // no headword on a chip (21.3)
  const r2 = run('naiso');
  const r3 = run('dictonary');
  assert.equal(r3.anyExact, false);
  assert.match(suggestionBarHtml(r3), /^<span class="dymtext">No exact match for &quot;dictonary&quot;\. Did you mean:<\/span><button type="button" class="sugg" data-q="dictionary" title="one letter missing"><span>dictionary<\/span><\/button>$/);
  assert.match(suggestionBarHtml(run('かいさ')), /<span lang="ja">かいしゃ<\/span>/);
  assert.equal(suggestionBarHtml({ suggestions: [] }), '');
  assert.ok(r2.suggestions.length > 0);
});

test('chip tap: puts the spelling into the box and searches, one history step', async () => {
  const p = await makePage(fx.store, '#q=jihso');
  await tick(30);
  assert.equal(p.els.dym.hidden, false);
  assert.match(p.els.dym.innerHTML, /data-q="jisho"/);
  const len = p.historyLength;
  const chip = { dataset: { q: 'jisho' } };
  p.els.dym.fire('click', { target: { closest: (sel) => (sel === 'button[data-q]' ? chip : null) } });
  await tick(30);
  assert.equal(p.url, '#q=jisho');
  assert.equal(p.els.q.value, 'jisho');
  assert.equal(p.historyLength, len + 1);
  await p.back();
  assert.equal(p.els.q.value, 'jihso');
});

test('text-group chip: the target ends fully below the sticky row; no scroll when already visible', async () => {
  // pure computation: sticky row bottom 64 px, target 8 px below it
  assert.equal(scrollTargetY({ scrollY: 500, top: 30, bottom: 200, sticky: 64, viewport: 800 }), 458);
  assert.equal(scrollTargetY({ scrollY: 500, top: 900, bottom: 1100, sticky: 64, viewport: 800 }), 1328);
  assert.equal(scrollTargetY({ scrollY: 500, top: 100, bottom: 300, sticky: 64, viewport: 800 }), null);
  // on the fake page: the search row is sticky and 72 px high at tap time (measured, not a fixed number)
  const p = await makePage(fx.store, '#q=彼方の空まで');
  await tick(30);
  const searchRow = { hidden: false, getBoundingClientRect: () => ({ top: 0, bottom: 72 }) };
  globalThis.document.querySelector = (sel) => (sel === '.search' ? searchRow : null);
  globalThis.window.getComputedStyle = (el) => ({ position: el === searchRow ? 'sticky' : 'static' });
  globalThis.window.innerHeight = 800;
  let rect = { top: 40, bottom: 240 };
  const classes = new Set();
  const item = { getBoundingClientRect: () => rect, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  p.els.results.querySelector = (sel) => (sel === '#t-0' ? item : null);
  const chip = { dataset: { item: '0' } };
  const tap = () => p.els.results.fire('click', { target: { closest: (sel) => (sel === 'button.chip' ? chip : null) } });
  p.scrollY = 300;
  tap();
  assert.equal(p.scrollY, 300 + 40 - 72 - 8); // headword no longer under the sticky row
  assert.ok(classes.has('flash'));
  rect = { top: 200, bottom: 400 }; // already fully visible below the sticky row
  p.scrollY = 260;
  tap();
  assert.equal(p.scrollY, 260);
  await tick(650);
  assert.ok(!classes.has('flash')); // the flash class is removed after 600 ms
});
