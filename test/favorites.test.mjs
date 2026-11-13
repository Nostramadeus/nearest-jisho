import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFavorites, favoritesText, firstGloss, FAV_KEY } from '../app/favorites.js';
import { favoritesHtml, cardHtml, FAV_EMPTY } from '../app/render.js';

function memoryStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const appFile = (name) => readFileSync(fileURLToPath(new URL(`../app/${name}`, import.meta.url)), 'utf8');

test('favorites: add, remove, identity (w, r, p), newest first, stored as { w, r, p, g, t }', () => {
  const ls = memoryStorage();
  let clock = 1000;
  const fav = createFavorites(ls, () => clock++);
  assert.equal(fav.available, true);
  assert.equal(fav.add({ w: '辞書', r: 'じしょ', p: 'words', g: 'dictionary' }), true);
  fav.add({ w: '辞書', r: 'じしょ', p: 'names', g: 'Jisho' });       // other pack: other favorite
  fav.add({ w: '辞書', r: 'じしょ', p: 'words', g: 'changed' });    // same identity: kept once, unchanged
  fav.add({ w: '草', r: 'くさ', p: 'words', g: 'grass' });
  assert.deepEqual(fav.list().map((f) => `${f.w}/${f.p}`), ['草/words', '辞書/names', '辞書/words']);
  assert.deepEqual(JSON.parse(ls.getItem(FAV_KEY))[0], { w: '辞書', r: 'じしょ', p: 'words', g: 'dictionary', t: 1000 });
  assert.equal(fav.has('辞書', 'じしょ', 'words'), true);
  assert.equal(fav.has('辞書', 'ちがう', 'words'), false);
  fav.remove('辞書', 'じしょ', 'words');
  assert.equal(fav.has('辞書', 'じしょ', 'words'), false);
  assert.equal(fav.has('辞書', 'じしょ', 'names'), true);
  assert.equal(fav.toggle({ w: '草', r: 'くさ', p: 'words' }), false);
  assert.equal(fav.toggle({ w: '草', r: 'くさ', p: 'words', g: 'grass' }), true);
  // restoring a row removed in the Favorites view keeps its old time (old place)
  fav.remove('辞書', 'じしょ', 'names');
  fav.add({ w: '辞書', r: 'じしょ', p: 'names', g: 'Jisho', t: 1 });
  assert.equal(fav.list().at(-1).t, 1);
  ls.setItem(FAV_KEY, '{broken');
  assert.deepEqual(fav.list(), []); // unreadable data: empty, no exception
});

test('favorites: storage unavailable', () => {
  const blocked = createFavorites(() => { throw new Error('SecurityError'); });
  assert.equal(blocked.available, false);
  assert.deepEqual(blocked.list(), []);
  assert.equal(blocked.add({ w: 'a', r: 'a', p: 'words' }), false);
  assert.equal(blocked.has('a', 'a', 'words'), false);
  const full = createFavorites({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} });
  assert.equal(full.available, false);
  assert.equal(createFavorites(null).available, false);
  // the page hides every star when storage is unavailable
  assert.match(appFile('style.css'), /\.no-fav \.star, \.no-fav \.favbtn \{ display: none !important; \}/);
  assert.match(appFile('main.js'), /if \(!fav\.available\) document\.documentElement\.classList\.add\('no-fav'\)/);
});

test('first gloss: words / Wiktionary sense, names translation', () => {
  assert.equal(firstGloss({ s: [{ g: ['dictionary', 'lexicon'] }] }), 'dictionary');
  assert.equal(firstGloss({ g: ['Tanaka'] }), 'Tanaka');
  assert.equal(firstGloss({}), '');
});

test('Favorites view markup: header, rows, greyed removed row, empty state', () => {
  const list = [
    { w: '草', r: 'くさ', p: 'words', g: 'grass', t: 3 },
    { w: 'ラーメン', r: 'ラーメン', p: 'words', g: 'ramen', t: 2 },
    { w: '田中', r: 'たなか', p: 'names', g: 'Tanaka', t: 1 },
  ];
  const html = favoritesHtml(list, new Set(['田中\tたなか\tnames']));
  assert.match(html, /<h2>Favorites \(2\)<\/h2><button type="button" class="copy" data-act="copy-favorites">Copy list<\/button>/);
  assert.match(html, /<li class="fav" data-t="3"><a href="#w=%E8%8D%89&amp;r=%E3%81%8F%E3%81%95&amp;p=words" lang="ja" class="fav-word">草<\/a> <span class="kana" lang="ja">くさ<\/span> <span class="info">grass<\/span><button type="button" class="star fav-star" aria-pressed="true"/);
  assert.match(html, /<a href="#w=[^"]*" lang="ja" class="fav-word">ラーメン<\/a> <span class="info">ramen<\/span>/); // reading equal to word: not repeated
  assert.match(html, /<li class="fav removed" data-t="1">.*class="star fav-star" aria-pressed="false"/);
  const empty = favoritesHtml([]);
  assert.match(empty, /<h2>Favorites \(0\)<\/h2>/);
  assert.ok(empty.includes(FAV_EMPTY));
  assert.equal(FAV_EMPTY, 'No favorites yet. Click the star on a word to keep it here.');
});

test('Copy list text: word<TAB>reading<TAB>gloss per line', () => {
  const text = favoritesText([
    { w: '草', r: 'くさ', p: 'words', g: 'grass' },
    { w: '田中', r: 'たなか', p: 'names', g: 'Tanaka\t(surname)\nline' },
  ]);
  assert.equal(text, '草\tくさ\tgrass\n田中\tたなか\tTanaka (surname) line');
});

test('star buttons on cards and in the search row', () => {
  const hit = { pack: 'words', id: 0, tier: 0, hl: null, rec: { k: ['辞書'], r: ['じしょ'], s: [{ p: ['n'], g: ['dictionary'] }] } };
  const off = cardHtml(hit, 0, 0);
  assert.match(off, /<article class="card"[^>]*><button type="button" class="star" aria-pressed="false" aria-label="Favorite" data-w="辞書" data-r="じしょ" data-p="words" data-g="dictionary">/);
  const on = cardHtml(hit, 0, 0, { fav: (w, r, p) => w === '辞書' && r === 'じしょ' && p === 'words' });
  assert.match(on, /class="star" aria-pressed="true"/);
  const css = appFile('style.css');
  assert.match(/\.star \{([^}]*)\}/.exec(css)[1], /width: 44px; height: 44px;/);
  const index = appFile('index.html');
  // Favorites button left of the settings gear, same class (size) as the gear
  assert.ok(index.indexOf('id="favbtn" class="gear favbtn" type="button" aria-label="Favorites"') < index.indexOf('id="gear"'));
  assert.match(index, /Favorites and recent searches are stored on this device only\./);
  assert.match(index, /App version: <span id="appversion">/);
  assert.match(index, /Offline cache: <span id="offline">/);
  assert.match(appFile('sw.js'), /'\.\/favorites\.js'/);
});
