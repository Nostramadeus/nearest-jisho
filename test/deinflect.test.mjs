import test from 'node:test';
import assert from 'node:assert/strict';
import { deinflect, posBits, T } from '../app/search/deinflect.js';

function has(word, base, type, via) {
  const c = deinflect(word).find((x) => x.form === base && (x.type & type));
  assert.ok(c, `${word} -> ${base}`);
  if (via) assert.equal(c.via.join(' + '), via, word);
}

test('ichidan forms', () => {
  const v1 = {
    '食べます': 'polite', '食べました': 'polite past', '食べません': 'polite negative',
    '食べませんでした': 'polite past negative', '食べましょう': 'polite volitional', '食べて': 'te-form', '食べた': 'past',
    '食べない': 'negative', '食べなかった': 'negative past', '食べなくて': 'negative te-form', '食べず': 'classical negative (-zu)',
    '食べれば': 'conditional (-ba)', '食べたら': 'conditional (-tara)', '食べたり': 'listing (-tari)',
    '食べられる': 'potential or passive', '食べさせる': 'causative', '食べさせられる': 'causative-passive',
    '食べよう': 'volitional', '食べろ': 'imperative', '食べたい': 'want (-tai)', '食べたくない': 'negative want (-takunai)',
    '食べたかった': 'past want (-takatta)', '食べている': 'progressive (-te iru)', '食べてる': 'progressive (-te iru)',
    '食べちゃう': 'completed (-chau)', '食べすぎる': 'too much (-sugiru)', '食べなさい': 'command (-nasai)',
  };
  for (const [w, via] of Object.entries(v1)) has(w, '食べる', T.V1, via);
});

test('two chained rules', () => {
  has('食べさせられた', '食べる', T.V1, 'causative-passive + past');
  has('食べていた', '食べる', T.V1, 'progressive (-te iru) + past');
  has('食べてた', '食べる', T.V1, 'progressive (-te iru) + past');
  has('食べちゃった', '食べる', T.V1, 'completed (-chau) + past');
  has('たべた', 'たべる', T.V1, 'past');
});

test('godan, kuru, suru, adjectives', () => {
  for (const w of ['書きます', '書いて', '書いた', '書かない', '書ける', '書かれる', '書かせる', '書こう', '書け', '書けば', '書いちゃう']) has(w, '書く', T.V5);
  has('泳いだ', '泳ぐ', T.V5, 'past');
  has('死んだ', '死ぬ', T.V5, 'past');
  has('行った', '行く', T.V5KS, 'past');
  has('来ました', '来る', T.VK, 'polite past');
  has('こない', 'くる', T.VK, 'negative');
  has('しなかった', 'する', T.VS, 'negative past');
  has('させられる', 'する', T.VS, 'causative-passive');
  for (const [w, via] of Object.entries({ '高く': 'adverb (-ku)', '高くて': 'te-form', '高かった': 'past', '高くない': 'negative',
    '高くなかった': 'negative past', '高ければ': 'conditional (-ba)', '高さ': 'noun (-sa)', '高そう': 'looks like (-sou)' })) {
    has(w, '高い', T.ADJ, via);
  }
});

test('POS tag bits', () => {
  assert.equal(posBits('v1'), T.V1);
  assert.ok(posBits('v5k') & T.V5);
  assert.ok(posBits('v5k-s') & T.V5KS);
  assert.ok(posBits('v5r-i') & T.V5);
  assert.equal(posBits('vk'), T.VK);
  assert.equal(posBits('vs-i'), T.VS);
  assert.equal(posBits('vs-s'), T.VS);
  assert.equal(posBits('vz'), T.VZ);
  assert.equal(posBits('adj-i'), T.ADJ);
  assert.equal(posBits('n'), 0);
});
