// SPEC 34 (outside audit R-001), page parts: 34.13 "Show more words", 34.18 no keyboard on Recent / chips and
// "Show more" appends, 34.19 the Android back gesture follows the page's own steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtureStore } from './helpers/fixture.mjs';
import { makePage, tick } from './helpers/page.mjs';

const { store, cleanup } = await loadFixtureStore();
test.after(cleanup);

const W = (w, r) => `#w=${encodeURIComponent(w)}&r=${encodeURIComponent(r)}&p=words`;
const cardClick = (el, href) => el.fire('click', { target: { closest: (sel) => (sel === '.card' ? { dataset: { entry: href } } : null) } });
const btnClick = (el, selector, btn) => el.fire('click', { target: { closest: (sel) => (sel === selector ? btn : null) } });

test('34.18 tapping a Recent search or a suggestion chip does not focus the search box', async () => {
  const p = await makePage(store, '');
  p.els.q.focusCount = 0;
  p.els.recent.fire('click', { target: { closest: () => ({ dataset: { recent: 'jisho' } }) } });
  await tick(30);
  assert.equal(p.els.q.value, 'jisho');
  assert.equal(p.els.q.focusCount, 0, 'Recent: no focus (no keyboard over the results)');
  btnClick(p.els.dym, 'button[data-q]', { dataset: { q: 'gakko' } });
  await tick(30);
  assert.equal(p.els.q.value, 'gakko');
  assert.equal(p.els.q.focusCount, 0, 'chip: no focus');
});

test('34.18 "Show more" appends the new cards; the cards above (and open toggles) are not re-rendered', async () => {
  const p = await makePage(store, '');
  await p.type('kaki');
  await tick(50);
  const before = p.els.results.innerHTML;
  assert.match(before, /data-group="words"/);
  const inserted = [];
  let removed = false;
  const sec = { querySelector: (s) => (s === 'button[data-more]' ? { remove() { removed = true; } } : null), insertAdjacentHTML: (pos, html) => inserted.push([pos, html]) };
  p.els.results.querySelector = (s) => (s === 'section[data-group="words"]' ? sec : null);
  btnClick(p.els.results, 'button[data-more]', { dataset: { more: 'words' } });
  await tick(50);
  const last = p.posted.filter((m) => m.type === 'search').pop();
  assert.equal(last.phase, 'full');
  assert.equal(last.groupLimits.words, 100);
  assert.equal(p.els.results.innerHTML, before, 'the list was not re-rendered');
  assert.equal(removed, true, 'the old Show more button goes');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][0], 'beforeend');
});

test('34.13 "Show more words" asks for every word and replaces only the text group', async () => {
  const p = await makePage(store, '');
  const text = '辞書'.repeat(61); // 61 words
  await p.type(text);
  await tick(50);
  assert.match(p.els.results.innerHTML, /data-textmore="1">Show more words \(1\)/);
  let replaced = null;
  const sec = { set outerHTML(h) { replaced = h; } };
  p.els.results.querySelector = (s) => (s === 'section[data-group="text"]' ? sec : null);
  const before = p.els.results.innerHTML;
  btnClick(p.els.results, 'button[data-textmore]', {});
  await tick(50);
  const last = p.posted.filter((m) => m.type === 'search').pop();
  assert.equal(last.textAll, true);
  assert.ok(replaced && replaced.includes('data-group="text"'), 'the text group is replaced');
  assert.doesNotMatch(replaced, /data-textmore/, 'every word is listed');
  assert.equal(p.els.results.innerHTML, before, 'the other groups are not re-rendered');
  await p.type('jisho'); // a new query starts again with 60 words
  await tick(50);
  assert.equal(p.posted.filter((m) => m.type === 'search').pop().textAll, false);
});

test('34.19 Android back gesture: the page steps decide, not the WebView canGoBack()', async () => {
  let onBack = null, exits = 0;
  const Capacitor = { Plugins: { App: { addListener: (name, cb) => { if (name === 'backButton') onBack = cb; }, exitApp: () => { exits++; } } } };
  const p = await makePage(store, '', { win: { Capacitor } });
  await p.type('jisho');
  await tick(1100);
  cardClick(p.els.results, W('辞書', 'じしょ'));
  await tick(30);
  assert.equal(p.view(), 'entry');
  // Chromium may report canGoBack() = false for entries pushed without a user gesture: the page still goes back
  onBack({ canGoBack: false });
  await tick(30);
  assert.deepEqual([p.view(), p.url, exits], ['searchview', '#q=jisho', 0]);
  onBack({ canGoBack: false });
  await tick(30);
  assert.deepEqual([p.view(), p.url, p.els.q.value, exits], ['searchview', '/', '', 0]);
  onBack({ canGoBack: true });
  assert.equal(exits, 1, 'only the empty start screen leaves the app');
});
