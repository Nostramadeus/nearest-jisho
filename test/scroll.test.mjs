// SPEC 32.10: where the result list stands (fake page around app/main.js). The positions of single cards ("Show more",
// "More examples") need a real layout; they were checked in headless Chrome (PROGRESS-fixes.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtureStore } from './helpers/fixture.mjs';
import { makePage, tick } from './helpers/page.mjs';

const { store, cleanup } = await loadFixtureStore();
test.after(cleanup);

test('a new query shows its results from the top', async () => {
  const p = await makePage(store, '#q=jisho');
  assert.match(p.els.results.innerHTML, /辞書/);
  p.scrollY = 500;
  await p.type('gakko');
  assert.match(p.els.results.innerHTML, /学校/);
  assert.equal(p.scrollY, 0);
});

test('the same query again (a pack arrived) keeps the scroll position', async () => {
  const p = await makePage(store, '#q=jisho');
  p.scrollY = 400;
  await p.fromWorker({ type: 'loaded', pack: 'names' });
  await tick(20);
  assert.equal(p.scrollY, 400);
});

test('Back to the previous query returns to its scroll position', async () => {
  const p = await makePage(store, '#q=jisho');
  p.scrollY = 300;
  await p.type('gakko'); // the start entry is settled: this pushes a new step
  assert.equal(p.url, '#q=gakko');
  assert.equal(p.scrollY, 0);
  await p.back();
  await tick(20);
  assert.equal(p.url, '#q=jisho');
  assert.match(p.els.results.innerHTML, /辞書/);
  assert.equal(p.scrollY, 300);
});

test('a link to another search inside the list is a history step; Back restores the list position', async () => {
  const p = await makePage(store, '#q=jisho');
  p.scrollY = 700;
  const len = p.historyLength;
  const href = `#q=${encodeURIComponent('学校')}`;
  const link = { getAttribute: (k) => (k === 'href' ? href : null) };
  p.els.results.fire('click', { target: { closest: (sel) => (sel === 'a[href^="#q="]' ? link : null) } });
  await tick(30);
  assert.equal(p.url, href);
  assert.equal(p.historyLength, len + 1);
  assert.equal(p.scrollY, 0);
  await p.back();
  await tick(20);
  assert.equal(p.url, '#q=jisho');
  assert.equal(p.scrollY, 700);
});

test('Back from an entry page still returns to the exact list position', async () => {
  const p = await makePage(store, '#q=jisho');
  p.scrollY = 250;
  const card = { dataset: { entry: '#w=%E8%BE%9E%E6%9B%B8&r=%E3%81%98%E3%81%97%E3%82%87&p=words' } };
  p.els.results.fire('click', { target: { closest: (sel) => (sel === '.card' ? card : null) } });
  await tick(20);
  assert.equal(p.view(), 'entry');
  assert.equal(p.scrollY, 0); // the entry page opens at its header
  await p.back();
  await tick(20);
  assert.equal(p.view(), 'searchview');
  assert.equal(p.scrollY, 250);
});
