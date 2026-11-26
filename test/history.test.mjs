// SPEC 33: every visible state is one history step; Back goes exactly one step back with its scroll position and
// leaves the app only from the empty start screen (fake page around app/main.js, fixture packs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtureStore } from './helpers/fixture.mjs';
import { makePage, tick } from './helpers/page.mjs';

const { store, cleanup } = await loadFixtureStore();
test.after(cleanup);

const W = (w, r) => `#w=${encodeURIComponent(w)}&r=${encodeURIComponent(r)}&p=words`;
/** A click whose target sits inside a link (or card) matching `sel` with these attributes. */
const linkClick = (el, href) => el.fire('click', {
  target: { closest: (sel) => (sel.includes(href.startsWith('#q=') ? 'a[href^="#q="]' : 'a[href^="#w="]') ? { getAttribute: () => href } : null) },
});
const cardClick = (el, href) => el.fire('click', { target: { closest: (sel) => (sel === '.card' ? { dataset: { entry: href } } : null) } });

test('search -> entry -> another entry -> kanji search, then Back step by step to the start screen', async () => {
  const p = await makePage(store, '');
  assert.equal(p.view(), 'searchview');
  assert.equal(p.index, 0);
  const at = () => ({ view: p.view(), url: p.url, q: p.els.q.value, scroll: p.scrollY, index: p.index });

  await p.type('jisho'); // 1: a committed query
  await tick(1100);
  assert.equal(p.url, '#q=jisho');
  assert.equal(p.index, 1);
  p.scrollY = 300;

  cardClick(p.els.results, W('辞書', 'じしょ')); // 2: the entry page of a result
  await tick(30);
  assert.deepEqual([p.view(), p.url, p.index, p.scrollY], ['entry', W('辞書', 'じしょ'), 2, 0]);
  p.scrollY = 120;

  linkClick(p.els.entry, W('辞書形', 'じしょけい')); // 3: a "Words that start with" row
  await tick(30);
  assert.deepEqual([p.view(), p.url, p.index, p.scrollY], ['entry', W('辞書形', 'じしょけい'), 3, 0]);
  assert.match(p.els.entry.innerHTML, /辞書形/);
  p.scrollY = 50;

  linkClick(p.els.entry, `#q=${encodeURIComponent('辞')}`); // 4: a search for one kanji
  await tick(30);
  assert.deepEqual([p.view(), p.url, p.index, p.scrollY], ['searchview', `#q=${encodeURIComponent('辞')}`, 4, 0]);
  assert.equal(p.els.q.value, '辞');

  const steps = [];
  for (let i = 0; i < 4; i++) { await p.back(); await tick(30); steps.push(at()); }
  assert.deepEqual(steps, [
    { view: 'entry', url: W('辞書形', 'じしょけい'), q: '辞', scroll: 50, index: 3 },
    { view: 'entry', url: W('辞書', 'じしょ'), q: '辞', scroll: 120, index: 2 },
    { view: 'searchview', url: '#q=jisho', q: 'jisho', scroll: 300, index: 1 },
    { view: 'searchview', url: '/', q: '', scroll: 0, index: 0 },
  ]);
  assert.match(p.els.entry.innerHTML, /^$/); // entry view left
  assert.equal(p.leftApp, undefined, 'history did not run out before the start screen');
  await p.back();
  assert.equal(p.leftApp, true, 'Back leaves only from the start screen');
});

test('typing pushes one step per committed query, not one per letter', async () => {
  const p = await makePage(store, '');
  const len = p.historyLength;
  for (const t of ['j', 'ji', 'jis', 'jish', 'jisho']) await p.type(t);
  assert.equal(p.historyLength, len + 1);
  await tick(1100); // the query settles
  for (const t of ['g', 'ga', 'gakko']) await p.type(t);
  assert.equal(p.historyLength, len + 2);
  await p.back();
  await tick(20);
  assert.equal(p.url, '#q=jisho');
  await p.back();
  await tick(20);
  assert.equal(p.url, '/');
  assert.equal(p.leftApp, undefined);
});

test('a first visit straight to an entry page has the start screen below it', async () => {
  const p = await makePage(store, W('辞書', 'じしょ'));
  assert.equal(p.view(), 'entry');
  assert.equal(p.index, 1);
  await p.back();
  await tick(20);
  assert.equal(p.view(), 'searchview');
  assert.equal(p.url, '/');
  assert.equal(p.leftApp, undefined);
});

test('Favorites -> entry -> Back returns to Favorites; Back again to the list', async () => {
  const p = await makePage(store, '#q=jisho');
  p.scrollY = 200;
  await p.click('favbtn');
  assert.equal(p.view(), 'favview');
  linkClick(p.els.favview, W('辞書', 'じしょ'));
  await tick(30);
  assert.equal(p.view(), 'entry');
  await p.back();
  await tick(20);
  assert.equal(p.view(), 'favview');
  await p.back();
  await tick(20);
  assert.deepEqual([p.view(), p.url, p.scrollY], ['searchview', '#q=jisho', 200]);
});

test('Android app back gesture (Capacitor App plugin): one step back; leaves only from the start screen', async () => {
  let onBack = null, exits = 0;
  const Capacitor = { Plugins: { App: { addListener: (name, cb) => { if (name === 'backButton') onBack = cb; }, exitApp: () => { exits++; } } } };
  const p = await makePage(store, '', { win: { Capacitor } });
  assert.equal(typeof onBack, 'function', 'main.js listens to the back gesture');
  await p.type('jisho');
  await tick(1100);
  cardClick(p.els.results, W('辞書', 'じしょ'));
  await tick(30);
  onBack({ canGoBack: true });
  await tick(30);
  assert.deepEqual([p.view(), p.url], ['searchview', '#q=jisho']);
  onBack({ canGoBack: true });
  await tick(30);
  assert.deepEqual([p.view(), p.url, exits], ['searchview', '/', 0]);
  onBack({ canGoBack: false });
  assert.equal(exits, 1);
  // the WebView has nothing to go back to, but the screen is not the start screen: show the start screen first
  const p2 = await makePage(store, '', { win: { Capacitor } });
  await p2.type('gakko');
  exits = 0;
  onBack({ canGoBack: false });
  await tick(30);
  assert.deepEqual([p2.view(), p2.els.q.value, exits], ['searchview', '', 0]);
  onBack({ canGoBack: false });
  assert.equal(exits, 1);
});
