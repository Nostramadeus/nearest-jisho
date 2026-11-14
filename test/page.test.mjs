// SPEC 16.1: Settings is a view like Favorites (fake page around app/main.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadFixtureStore } from './helpers/fixture.mjs';
import { makePage, tick } from './helpers/page.mjs';

const { store, cleanup } = await loadFixtureStore();
test.after(cleanup);
const appFile = (name) => readFileSync(fileURLToPath(new URL(`../app/${name}`, import.meta.url)), 'utf8');

test('gear from search pushes a history step; Back closes Settings and restores the list and scroll', async () => {
  const p = await makePage(store, '#q=jisho');
  assert.equal(p.view(), 'searchview');
  assert.match(p.els.results.innerHTML, /辞書/);
  p.scrollY = 300;
  const len = p.historyLength;
  await p.click('gear');
  assert.equal(p.view(), 'settings');
  assert.equal(p.url, '#settings');
  assert.equal(p.historyLength, len + 1);
  assert.deepEqual(p.pressed(), { fav: 'false', gear: 'true', favTitle: 'Favorites', gearTitle: 'Close Settings' });
  assert.equal(p.els.gear.getAttribute('aria-expanded'), null);
  await p.back(); // browser Back / Android back gesture
  assert.equal(p.view(), 'searchview');
  assert.equal(p.url, '#q=jisho');
  assert.equal(p.scrollY, 300);
  assert.equal(p.leftApp, undefined);
  assert.deepEqual(p.pressed(), { fav: 'false', gear: 'false', favTitle: 'Favorites', gearTitle: 'Settings' });
});

test('gear twice returns to the previous view (entry page)', async () => {
  const p = await makePage(store, '#w=%E8%BE%9E%E6%9B%B8&r=%E3%81%98%E3%81%97%E3%82%87&p=words');
  assert.equal(p.view(), 'entry');
  await p.click('gear');
  assert.equal(p.view(), 'settings');
  await p.click('gear');
  await tick(10);
  assert.equal(p.view(), 'entry');
  assert.equal(p.url, '#w=%E8%BE%9E%E6%9B%B8&r=%E3%81%98%E3%81%97%E3%82%87&p=words');
  assert.equal(p.index, 0); // back at the first step: nothing left over in the history
});

test('star while in Settings switches with replaceState; one Back returns to the view before Settings', async () => {
  const p = await makePage(store, '#q=jisho');
  const len = p.historyLength;
  await p.click('gear');
  await p.click('favbtn');
  assert.equal(p.view(), 'favview');
  assert.equal(p.url, '#fav');
  assert.equal(p.historyLength, len + 1); // no new step for the switch
  assert.deepEqual(p.pressed(), { fav: 'true', gear: 'false', favTitle: 'Close Favorites', gearTitle: 'Settings' });
  await p.back();
  assert.equal(p.view(), 'searchview');
  assert.equal(p.url, '#q=jisho');
});

test('gear while in Favorites switches with replaceState; star then closes back to search', async () => {
  const p = await makePage(store, '#q=jisho');
  const len = p.historyLength;
  await p.click('favbtn');
  assert.equal(p.view(), 'favview');
  await p.click('gear');
  assert.equal(p.view(), 'settings');
  assert.equal(p.url, '#settings');
  assert.equal(p.historyLength, len + 1);
  assert.deepEqual(p.pressed(), { fav: 'false', gear: 'true', favTitle: 'Favorites', gearTitle: 'Close Settings' });
  await p.click('gear'); // close: back to the view before Favorites
  await tick(10);
  assert.equal(p.view(), 'searchview');
  assert.equal(p.url, '#q=jisho');
});

test('only one of the two buttons is pressed at a time', async () => {
  const p = await makePage(store, '#q=kusa');
  const states = [];
  for (const id of ['favbtn', 'gear', 'favbtn', 'gear', 'gear']) {
    await p.click(id);
    await tick(10);
    const s = p.pressed();
    states.push(`${p.view()}:${s.fav}/${s.gear}`);
    assert.ok(!(s.fav === 'true' && s.gear === 'true'));
  }
  assert.deepEqual(states, ['favview:true/false', 'settings:false/true', 'favview:true/false', 'settings:false/true', 'searchview:false/false']);
});

test('typing leaves Settings and shows results; Back returns to Settings', async () => {
  const p = await makePage(store, '#q=jisho');
  await p.click('gear');
  await p.type('kusa');
  assert.equal(p.view(), 'searchview');
  assert.equal(p.url, '#q=kusa');
  assert.match(p.els.results.innerHTML, /草/);
  assert.equal(p.pressed().gear, 'false');
  await p.back();
  assert.equal(p.view(), 'settings');
});

test('direct visit to #settings; closing it shows the search view without leaving the app', async () => {
  const p = await makePage(store, '#settings');
  assert.equal(p.view(), 'settings');
  assert.equal(p.pressed().gear, 'true');
  await p.click('gear');
  assert.equal(p.view(), 'searchview');
  assert.equal(p.leftApp, undefined);
  assert.equal(p.url, '/');
  assert.equal(p.els.recent.hidden, false); // the empty search view shows Recent
});

test('update bar and credits footer stay present in the Settings view', async () => {
  const p = await makePage(store, '#settings');
  await p.fromWorker({ type: 'updateOffer', manual: false, built: '2026-12-01', packs: ['names'], text: 'New dictionary data is available (2026-12-01, about 1 MB).', signature: 'x' });
  assert.equal(p.view(), 'settings');
  assert.equal(p.els.updatebar.hidden, false);
  assert.match(p.els.updatebar.innerHTML, /New dictionary data is available/);
  // static page structure: settings, bar and footer are outside the swapped <main> content
  const html = appFile('index.html');
  const iBar = html.indexOf('id="updatebar"'), iSet = html.indexOf('id="settings"'), iMain = html.indexOf('<main id="view">');
  const iFoot = html.indexOf('<footer class="foot">'), iCredits = html.indexOf('<p class="credits">Data: <a href="https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project"');
  assert.ok(iBar > 0 && iBar < iSet && iSet < iMain && iMain < iFoot && iFoot < iCredits);
  assert.ok(!html.includes('aria-expanded'));
  const css = appFile('style.css');
  assert.match(css, /\.foot \.credits \{ margin: 0; font-size: 11px; line-height: 1\.4; color: var\(--dim\); text-align: center; \}/);
  assert.match(css, /\.foot \.credits a \{ color: var\(--dim\); text-decoration: none; \}/);
  assert.match(css, /\.foot \.wiki \{ font-size: 13px;/);
  // SPEC 16.2 sizes
  assert.match(css, /\.gear \{\s*position: relative; flex: 0 0 auto; width: 40px; height: 44px; border: 0; padding: 0; background: transparent;/);
  assert.match(css, /\.search \.tools \{ display: flex; gap: 2px;/);
  assert.match(css, /gap: 6px; align-items: center; \/\* 6 px to the search box \*\//);
  assert.match(css, /height: 48px;[^}]*font-size: 18px;/);
  assert.match(css, /@media \(min-width: 600px\) \{ \.search input \{ font-size: 20px; \} \}/);
  assert.match(css, /\.gear\[aria-pressed="true"\]::after \{[^}]*height: 2px; background: var\(--acc\);/);
});

// SPEC 23: one history step per screen state, so Back never leaves the app from a state the user reached inside it
test('Back from the first query returns to the start screen; the next Back leaves the app', async () => {
  const p = await makePage(store, '');
  await p.type('jis');
  await p.type('jisho'); // letters typed in one go: one step
  assert.equal(p.url, '#q=jisho');
  assert.equal(p.historyLength, 2);
  await p.back();
  assert.equal(p.leftApp, undefined);
  assert.ok(!p.url.startsWith('#'));
  assert.equal(p.view(), 'searchview');
  assert.equal(p.els.q.value, '');
  await p.back();
  assert.equal(p.leftApp, true);
});

test('a query that stayed 1 second is its own Back step', async () => {
  const p = await makePage(store, '');
  await p.type('jisho');
  await tick(1000);
  await p.type('kusa');
  assert.equal(p.historyLength, 3);
  await p.click('gear'); // Settings on top of a query typed less than a second ago
  await p.back();
  assert.equal(p.url, '#q=kusa');
  await p.back();
  assert.equal(p.url, '#q=jisho');
  await tick(100); // the search for the restored query answers a moment later
  assert.match(p.els.results.innerHTML, /辞書/);
  await p.back();
  assert.ok(!p.url.startsWith('#'));
  assert.equal(p.leftApp, undefined);
});

test('text typed and deleted again within a second adds no dead Back step', async () => {
  const p = await makePage(store, '');
  await p.type('jisho');
  await tick(1000);
  await p.type('jishox');
  await p.type('jisho');
  await p.back(); // one press: the start screen, not the same list again
  await tick(10);
  assert.ok(!p.url.startsWith('#'));
  assert.equal(p.els.q.value, '');
  assert.equal(p.leftApp, undefined);
});
