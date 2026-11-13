import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtureStore } from './helpers/fixture.mjs';
import { search } from '../app/search/engine.js';
import { cardHtml, groupsHtml, kanjiHtml, markText, markTokens, esc } from '../app/render.js';

const { store, cleanup } = await loadFixtureStore();
test.after(cleanup);

function resolved(q, o = {}) {
  const r = search(store, q, { phase: 'full', ...o });
  for (const g of r.groups) for (const h of g.results) h.rec = store.getRecord(h.pack, h.id);
  return r;
}

test('escaping and marks', () => {
  assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(markText('じしょけい', 2, false), '<mark>じし</mark>ょけい');
  assert.equal(markText('辞書', -1, true).match(/data-kanji/g).length, 2);
  assert.equal(markTokens('dictionary form (of a verb)', ['dictionary']), '<mark>dictionary</mark> form (of a verb)');
  assert.equal(markTokens('dictionaries', ['dictio']), '<mark>dictio</mark>naries'); // last token as prefix
  assert.equal(markTokens('condition', ['on']), 'condition'); // whole words only
  assert.equal(markTokens('<b>x</b>', ['b']), '&lt;<mark>b</mark>&gt;x&lt;/<mark>b</mark>&gt;');
});

test('reading match marks the reading; prefix marks the typed length', () => {
  const r = resolved('jisho');
  const html = groupsHtml(r.groups);
  assert.match(html, /<div class="kana" lang="ja"><mark>じしょ<\/mark><\/div>/);
  assert.match(html, /<mark>じしょ<\/mark>けい/); // tier 2 prefix: the kana that cover the typed "jisho"
  assert.match(html, /<h2>Japanese words <span class="count">6<\/span><\/h2>/);
  assert.match(html, /<span class="tag">common<\/span><span class="tag g">N5<\/span>/);
  assert.match(html, /I look it up in the dictionary/); // first example of the first sense inline
});

test('near results sit under a Did you mean line; English tokens are marked', () => {
  const html = groupsHtml(resolved('jihso').groups);
  assert.ok(html.indexOf('<div class="near">Did you mean</div>') < html.indexOf('辞書'));
  const en = groupsHtml(resolved('plot of land').groups);
  assert.match(en, /<mark>plot<\/mark> of <mark>land<\/mark>/);
});

test('kanji match marks the headword; deinflection note shown', () => {
  const html = groupsHtml(resolved('辞書').groups);
  assert.match(html, /<div class="kanji" lang="ja"><mark><button type="button" class="kj" data-kanji="辞"/);
  const d = groupsHtml(resolved('たべた').groups);
  assert.match(d, /<div class="note">たべた is the past form of 食べる<\/div>/);
});

test('slang labels in full words, Wiktionary tag and link, names card', () => {
  const k = groupsHtml(resolved('kusa').groups);
  assert.match(k, /<span class="tag s">Internet slang<\/span>/);
  assert.match(k, /<span class="tag g">Wiktionary<\/span>/);
  assert.match(k, /Open in Wiktionary/);
  const n = groupsHtml(resolved('tanaka').groups);
  assert.match(n, /<span class="tag g">surname<\/span>/);
  assert.match(n, /Tanaka/);
});

test('show more button when total exceeds shown', () => {
  const html = groupsHtml(resolved('jisho', { limit: 2 }).groups);
  assert.match(html, /<button type="button" class="more" data-more="words">Show more<\/button>/);
});

test('kanji panel', () => {
  const html = kanjiHtml('辞', { m: ['resign', 'word'], on: ['ジ'], kun: ['や.める'], n: ['こと'], s: 13, g: 4, j: 2, f: 633 });
  for (const s of ['Meanings', 'On readings', 'Kun readings', 'Name readings', 'Strokes', 'School grade']) assert.ok(html.includes(s), s);
  assert.match(kanjiHtml('猫', null), /No kanji information available/);
});

test('card has no raw HTML from data', () => {
  const hit = { pack: 'words', id: 0, tier: 0, hl: { space: 'r', form: 'じしょ', len: -1 },
    rec: { k: ['<i>'], r: ['じしょ'], s: [{ p: ['n'], g: ['<script>alert(1)</script>'] }] } };
  assert.ok(!cardHtml(hit, 0, 0).includes('<script>'));
});
