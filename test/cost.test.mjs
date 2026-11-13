import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareQuery, distance, budget, keyRelation, reasonFor, INF, letterMask, popcount } from '../app/search/cost.js';

const d = (q, k, o) => distance(prepareQuery(q, o), k);

test('cost table row: insert/delete a doubled letter = 0.3', () => {
  assert.equal(d('gakko', 'gako'), 3);   // delete doubled k
  assert.equal(d('kaki', 'kakki'), 3);   // insert doubled k
});

test('cost table row: u after o/u, o after o, apostrophe, hyphen = 0.2', () => {
  assert.equal(d('gakko', 'gakkou'), 2);
  assert.equal(d('shojo', 'shoujo'), 2);
  assert.equal(d('kuki', 'kuuki'), 2);
  assert.equal(d('oki', 'ooki'), 2);
  assert.equal(d('zenin', "zen'in"), 2);
  assert.equal(d('ramen', 'ra-men'), 2);
});

test('cost table row: swap two adjacent letters = 0.5', () => {
  assert.equal(d('jihso', 'jisho'), 5);
});

test('cost table rows: substitute touch 0.5, any other 1.0 (SPEC 18 ruling 10: no 0.8)', () => {
  assert.equal(keyRelation('k', 'j'), 'touch');
  assert.equal(keyRelation('k', 'm'), 'touch');
  assert.equal(keyRelation('k', 'n'), 'far');
  assert.equal(keyRelation('k', 'a'), 'far');
  assert.equal(d('pkq', 'pjq'), 5);   // k -> j touch (not position 0)
  assert.equal(d('pkq', 'pnq'), 10);  // k -> n: one key between now costs 1.0
  assert.equal(d('pkq', 'paq'), 10);  // k -> a far
});

test('cost table row: other insert/delete = 1.0', () => {
  assert.equal(d('dictonary', 'dictionary', { soft: false, first: false }), 10);
  assert.equal(d('abpd', 'abd'), 10); // p touches neither b nor d (no fat-finger discount)
});

test('kana queries: keyboard table off, every substitute 1.0', () => {
  assert.equal(d('pkq', 'pjq', { keyboard: false }), 10);
  assert.equal(d('gakko', 'gakkou', { keyboard: false }), 2); // other rows still apply
});

test('position 0: substitute or delete costs +0.3', () => {
  assert.equal(d('kaku', 'jaku'), 8);   // touch 0.5 + 0.3
  assert.equal(d('xkana', 'kana'), 13); // delete at 0: 1.0 + 0.3
  assert.equal(d('kana', 'xkana'), 10); // insert at 0: no extra
  assert.equal(d('kaku', 'jaku', { first: false }), 5);
});

test('bounded distance returns INF over budget', () => {
  assert.equal(distance(prepareQuery('abcdef'), 'uvwxyz', 0, 6, 15), INF);
  assert.equal(distance(prepareQuery('jihso'), 'jisho', 0, 5, 5), 5);
  assert.equal(distance(prepareQuery('jihso'), 'jisho', 0, 5, 4), INF);
});

test('budget boundaries (SPEC 4.4)', () => {
  assert.equal(budget(3), 0);
  assert.equal(budget(4), 10);
  assert.equal(budget(5), 10);
  assert.equal(budget(6), 15);
  assert.equal(budget(8), 15);
  assert.equal(budget(9), 20);
  assert.equal(budget(20), 20);
});

test('did-you-mean reasons', () => {
  assert.equal(reasonFor('jihso', 'jisho'), 'letters swapped');
  assert.equal(reasonFor('pkq', 'pjq'), 'neighbouring key');
  assert.equal(reasonFor('pkq', 'paq'), 'one letter different');
  assert.equal(reasonFor('dictonary', 'dictionary'), 'one letter missing');
  assert.equal(reasonFor('abcxd', 'abcd'), 'one extra letter');
  assert.equal(reasonFor('gakko', 'gakkou'), 'long vowel / double letter');
});

test('letter mask and popcount', () => {
  assert.equal(popcount(letterMask('abc') ^ letterMask('abd')), 2);
  assert.equal(popcount(0xffffffff), 32);
});
