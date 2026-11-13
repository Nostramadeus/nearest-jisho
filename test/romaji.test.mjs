import test from 'node:test';
import assert from 'node:assert/strict';
import { kanaToRomaji, romajiToKana, canon, toHiragana } from '../app/search/romaji.js';
import { fold } from '../app/search/fold.js';

test('kanaToRomaji: Hepburn base and SPEC 4.1 rules', () => {
  const cases = {
    'じしょ': 'jisho', 'しんぶん': 'shinbun', 'ちず': 'chizu', 'つき': 'tsuki', 'ふじ': 'fuji', 'ぢ': 'ji', 'づ': 'zu',
    'を': 'o', 'しゃしん': 'shashin', 'ちゃ': 'cha', 'じゃま': 'jama', 'きゃく': 'kyaku', 'りょこう': 'ryokou',
    'ぜんいん': "zen'in", 'こんや': "kon'ya", 'さんぽ': 'sanpo', 'ほん': 'hon',
    'がっこう': 'gakkou', 'まっちゃ': 'maccha', 'きって': 'kitte',
    'おおきい': 'ookii', 'こうこう': 'koukou', 'ラーメン': 'raamen', 'コーヒー': 'koohii',
    'ファン': 'fan', 'ティー': 'tii', 'ウィキ': 'wiki', 'ヴ': 'vu', 'ヴァイオリン': 'vaiorin', 'シェフ': 'shefu',
    'てめえ': 'temee', 'こんにちは': 'konnichiha',
  };
  for (const [k, r] of Object.entries(cases)) assert.equal(kanaToRomaji(k), r, k);
});

test('katakana and hiragana give the same romaji', () => {
  assert.equal(toHiragana('カタカナ'), 'かたかな');
  assert.equal(kanaToRomaji('ジショ'), kanaToRomaji('じしょ'));
});

test('romajiToKana: Hepburn, Kunrei and variants', () => {
  const cases = {
    shi: 'し', si: 'し', chi: 'ち', ti: 'ち', tsu: 'つ', tu: 'つ', fu: 'ふ', hu: 'ふ', ji: 'じ', zi: 'じ',
    sha: 'しゃ', sya: 'しゃ', cha: 'ちゃ', tya: 'ちゃ', ja: 'じゃ', jya: 'じゃ', zya: 'じゃ',
    "kan'i": 'かんい', kanni: 'かんに', konnichiwa: 'こんにちわ', shinbun: 'しんぶん', xtu: 'っ', ltu: 'っ',
    gakkou: 'がっこう', matcha: 'まっちゃ', 'ra-men': 'らーめん', onna: 'おんな', hon: 'ほん',
  };
  for (const [r, k] of Object.entries(cases)) {
    const out = romajiToKana(r);
    assert.equal(out.kana, k, r);
    assert.equal(out.clean, true, r);
  }
  assert.equal(romajiToKana('jihso').clean, false);
});

test('round trips: kana -> romaji -> kana -> romaji is stable', () => {
  for (const k of ['じしょ', 'がっこう', 'しんぶん', 'ぜんいん', 'こんや', 'きゃく', 'まっちゃ', 'おおきい', 'りょこう', 'ちょっと']) {
    const r = kanaToRomaji(k);
    const back = romajiToKana(r);
    assert.equal(back.clean, true, k);
    assert.equal(back.kana, k, k);
    assert.equal(kanaToRomaji(back.kana), r, k);
  }
});

test('canon: kana, clean Latin, unclean Latin with variant rewrite', () => {
  assert.equal(canon('じしょ'), 'jisho');
  assert.equal(canon('JISHO'), 'jisho');
  assert.equal(canon('zisyo'), 'jisho');
  assert.equal(canon('tyotto'), 'chotto');
  assert.equal(canon('jihso'), 'jihso');
  assert.equal(canon('kon nichi wa'), 'konnichiwa');
  assert.equal(canon('ｊｉｓｈｏ'), 'jisho'); // NFKC
  assert.equal(canon('dictonary'), 'dictonary');
});

test('fold: SPEC 4.2 examples', () => {
  assert.equal(fold('shoujo'), 'shojo');
  assert.equal(fold('gakkou'), 'gako');
  assert.equal(fold('konnichiwa'), 'konichiwa');
  assert.equal(fold('ookii'), 'oki');
  assert.equal(fold("zen'in"), 'zenin');
  assert.equal(fold('raamen'), 'ramen');
});
