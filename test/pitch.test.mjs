// SPEC 25 (pitch accent) and SPEC 26 (romaji on cards, speaker button, "Phrases with").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { morae, highs, accentValues, pitchKey, fittingValues, pitchHtml } from '../app/search/pitch.js';
import { findEntry, entryData, middleRecords } from '../app/search/entry.js';
import { entryHtml, cardHtml } from '../app/render.js';
import { filesOf, DATA_PACKS } from '../app/datasets.js';
import { loadFixtureStore, PITCH } from './helpers/fixture.mjs';
import { csvFields, sysDicFeatures } from '../build/lib/pitch.mjs';

const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

/** Pattern as text: high morae in [brackets], "ꜜ" kept, so one string shows the whole rendering. */
function shape(html) {
  return html.replace(/<span class="mo hi">([^<]*)<\/span>/g, '[$1]').replace(/<span class="mo">([^<]*)<\/span>/g, '$1')
    .replace(/<span class="drop" aria-hidden="true">ꜜ<\/span>/g, 'ꜜ').replace(/<span class="pn">\[(\d+)\]<\/span>/g, '#$1')
    .replace(/<\/?span[^>]*>/g, '');
}

test('mora split: small kana join the mora before; ー, っ and ん are morae of their own', () => {
  assert.deepEqual(morae('とうきょう'), ['と', 'う', 'きょ', 'う']);
  assert.deepEqual(morae('しゃしん'), ['しゃ', 'し', 'ん']);
  assert.deepEqual(morae('きって'), ['き', 'っ', 'て']);
  assert.deepEqual(morae('コーヒー'), ['コ', 'ー', 'ヒ', 'ー']);
  assert.deepEqual(morae('ファイル'), ['ファ', 'イ', 'ル']);
  assert.deepEqual(morae('ぐゎ'), ['ぐゎ']);
  assert.deepEqual(morae(''), []);
});

test('pattern per accent type: 0 heiban, 1 atamadaka, n>=2 nakadaka / odaka', () => {
  assert.deepEqual(highs(0, 3), [false, true, true]);
  assert.deepEqual(highs(1, 3), [true, false, false]);
  assert.deepEqual(highs(2, 3), [false, true, false]);
  assert.deepEqual(highs(3, 3), [false, true, true]);
  assert.deepEqual(accentValues('0,3'), [0, 3]);
  assert.deepEqual(accentValues('*'), []);
  assert.deepEqual(accentValues('2,2'), [2]);
  assert.deepEqual(fittingValues('はし', '1,5'), [1]); // 5 does not fit 2 morae
});

test('renderer fixtures: 箸 [1], 橋 [2], 端 [0], 雨 [1], 飴 [0], 東京 [0]', () => {
  assert.equal(shape(pitchHtml('はし', [1])), '[は]ꜜし #1');
  assert.equal(shape(pitchHtml('はし', [2])), 'は[し]ꜜ #2');
  assert.equal(shape(pitchHtml('はし', [0])), 'は[し] #0');
  assert.equal(shape(pitchHtml('あめ', [1])), '[あ]ꜜめ #1');
  assert.equal(shape(pitchHtml('あめ', [0])), 'あ[め] #0');
  assert.equal(shape(pitchHtml('とうきょう', [0])), 'と[う][きょ][う] #0');
  assert.equal(shape(pitchHtml('いっぽん', [1])), '[い]ꜜっぽん #1');
  // several values: each pattern, comma-separated
  assert.equal(shape(pitchHtml('おとこ', [0, 3])), 'お[と][こ] #0, お[と][こ]ꜜ #3');
  assert.match(pitchHtml('はし', [2]), /^<span class="pat" lang="ja">/);
});

test('pitch key: first kanji form + first kana form in hiragana; kana-only records use the kana form', () => {
  assert.equal(pitchKey({ k: ['橋', '槗'], r: ['はし'] }), '橋\tはし');
  assert.equal(pitchKey({ k: ['洋袴'], r: ['ズボン'] }), '洋袴\tずぼん');
  assert.equal(pitchKey({ r: ['テレビ'] }), 'てれび');
  assert.equal(pitchKey({ k: ['x'] }), '');
});

test('entry page: pitch line after the romaji only when the pitch pack has the key; never guessed', async () => {
  const { store, cleanup } = await loadFixtureStore();
  try {
    const id = findEntry(store, 'words', '辞書', 'じしょ');
    assert.equal(entryData(store, 'words', id).pitch, null); // pack not loaded yet
    await store.loadPitch();
    assert.equal(store.pitch('辞書\tじしょ'), PITCH['辞書\tじしょ']);
    const d = entryData(store, 'words', id);
    assert.deepEqual(d.pitch, { kana: 'じしょ', values: [1] });
    const html = entryHtml(d);
    assert.match(html, /<div class="romaji">jisho <button type="button" class="say"[^]*?<\/button><\/div><div class="pitch"><span class="pat" lang="ja"><span class="mo hi">じ<\/span><span class="drop" aria-hidden="true">ꜜ<\/span><span class="mo">しょ<\/span><\/span> <span class="pn">\[1\]<\/span><\/div><div class="entry-title">/);
    // a record without a key: no line
    const kusa = entryData(store, 'words', findEntry(store, 'words', '草', 'くさ'));
    assert.equal(kusa.pitch, null);
    assert.doesNotMatch(entryHtml(kusa), /class="pitch"/);
    // names and Wiktionary records: no pitch
    assert.equal(entryData(store, 'names', findEntry(store, 'names', '田中', 'たなか')).pitch, null);
  } finally { cleanup(); }
});

test('pitch pack plumbing: listed as a data pack, one file, CI checks 橋 = 2 and 箸 = 1', () => {
  assert.ok(DATA_PACKS.includes('pitch'));
  assert.deepEqual(filesOf('pitch', null), ['pitch.json']);
  const verify = src('../build/verify-data.mjs');
  assert.match(verify, /\['橋\\tはし', '2'\], \['箸\\tはし', '1'\]/);
  assert.match(src('../build/build-data.mjs'), /'sent', 'pitch'\]/);
  assert.match(src('../app/index.html'), /UniDic<\/a> \(BSD\)/);
  // MeCab CSV: quoted fields keep their comma
  assert.deepEqual(csvFields('名詞,普通名詞,"0,3",ハシ'), ['名詞', '普通名詞', '0,3', 'ハシ']);
  assert.deepEqual(csvFields('a,"b""c",'), ['a', 'b"c', '']);
});

test('speaker button: entry page only, kana reading, hidden until a Japanese voice is found', async () => {
  const { store, cleanup } = await loadFixtureStore();
  try {
    const d = entryData(store, 'words', findEntry(store, 'words', '辞書', 'じしょ'));
    assert.match(entryHtml(d), /<button type="button" class="say" data-say="じしょ" aria-label="Play the reading" title="Play the reading" hidden>/);
    const main = src('../app/main.js');
    assert.match(main, /lang: 'ja-JP', rate: 0\.9/);
    assert.match(main, /\/\^ja\/i\.test\(v\.lang/);
    assert.match(main, /u\.rate = 0\.9/);
    const pkg = JSON.parse(src('../packaging/android/package.json'));
    assert.match(pkg.dependencies['@capacitor-community/text-to-speech'], /^\d+\.\d+\.\d+$/); // pinned
  } finally { cleanup(); }
});

test('result cards: romaji line under the word (setting can hide it), none for non-kana text', async () => {
  const { store, cleanup } = await loadFixtureStore();
  try {
    const rec = store.getRecord('words', findEntry(store, 'words', '辞書', 'じしょ'));
    const html = cardHtml({ pack: 'words', rec, tier: 0 }, 0, 0);
    assert.match(html, /<\/a><\/div><div class="romaji">jisho<\/div>/);
    assert.doesNotMatch(html, /class="say"/); // speaker only on the entry page
    const kana = store.getRecord('words', findEntry(store, 'words', 'まで', 'まで'));
    assert.match(cardHtml({ pack: 'words', rec: kana, tier: 0 }, 0, 0), /<div class="romaji">made<\/div>/);
    const css = src('../app/style.css');
    assert.match(css, /\.no-card-romaji \.card \.romaji \{ display: none; \}/);
    assert.match(src('../app/index.html'), /<input type="checkbox" id="cardromaji"> Romaji on result cards/);
  } finally { cleanup(); }
});

test('entry page: "Phrases with" lists words holding the headword in the middle, start/end rows excluded', async () => {
  // Real data (local packs, 2026-11-14): 気 -> 一気に, 人気者 ...; 学校 -> 小学校区, 中学校区 ... (気をつける starts with 気).
  const { store, cleanup } = await loadFixtureStore();
  try {
    const school = entryData(store, 'words', findEntry(store, 'words', '学校', 'がっこう'));
    assert.deepEqual(school.phrases.map((x) => x.head), ['小学校区']);
    assert.deepEqual(school.endsWith.map((x) => x.head), ['中学校']); // 小学校区 does not end with 学校
    assert.deepEqual(school.startsWith.map((x) => x.head), ['学校教育']);
    const html = entryHtml(school);
    assert.match(html, /<h3>Words that end with <span lang="ja">学校<\/span><\/h3>[\s\S]*<h3>Phrases with <span lang="ja">学校<\/span><\/h3><ul class="starts"><li><a href="#w=[^"]*"><span lang="ja">小学校区<\/span> <span class="kana" lang="ja">しょうがっこうく<\/span><\/a> <span class="info">elementary school district<\/span>/);
    // 草草 starts and ends with 草: never a phrase; no middle hit -> section omitted
    const kusa = entryData(store, 'words', findEntry(store, 'words', '草', 'くさ'));
    assert.deepEqual(kusa.phrases, []);
    assert.doesNotMatch(entryHtml(kusa), /Phrases with/);
    assert.deepEqual(middleRecords(store, 'words', '学校', { skip: new Set([findEntry(store, 'words', '小学校区', 'しょうがっこうく')]) }), []);
    // names and kana-only headwords: omitted
    assert.deepEqual(entryData(store, 'words', findEntry(store, 'words', 'まで', 'まで')).phrases, []);
    assert.deepEqual(entryData(store, 'names', findEntry(store, 'names', '田中', 'たなか')).phrases, []);
  } finally { cleanup(); }
});

test('sys.dic reader: skips header, double array and tokens; yields the NUL-separated feature strings across chunks', async () => {
  const feats = ['名詞,普通名詞,一般,*,*,*,ハシ,橋,橋,ハシ,橋,ハシ,和,*,*,*,*,*,*,体,ハシ,ハシ,ハシ,ハシ,2,C1,*,1,2', '名詞,"0,3",x'];
  const fbuf = Buffer.from(feats.map((f) => f + '\0').join(''), 'utf8');
  const head = Buffer.alloc(72);
  head.writeUInt32LE(5, 24); head.writeUInt32LE(3, 28); head.writeUInt32LE(fbuf.length, 32);
  head.write('UTF-8', 40, 'latin1');
  const all = Buffer.concat([head, Buffer.alloc(8, 7), fbuf, Buffer.from('trailing')]);
  async function* chunks() { for (let i = 0; i < all.length; i += 7) yield all.subarray(i, i + 7); }
  const out = [];
  for await (const s of sysDicFeatures(chunks())) out.push(s);
  assert.deepEqual(out, feats);
  const f = csvFields(out[0]);
  assert.equal(f[8], '橋'); assert.equal(f[20], 'ハシ'); assert.equal(f[24], '2'); // orth, kana, aType
});
