// One-kana variants for slips on the 12-key flick keyboard (SPEC 18, design/typo-study.md 2.9 and 2.10).
// Pure module. Variants change exactly ONE kana of the query.

export const KANA_COST = { mark: 4, flick: 7, voiced: 6 };
export const KANA_LABEL = { mark: '゛゜ or small kana', flick: 'flick direction', voiced: 'voiced / unvoiced' };

// V1 "mark key": plain <-> dakuten, は-row plain / dakuten / handakuten, and the small kana つ っ, や ゃ, ゆ ゅ, よ ょ.
const DAKUTEN = [
  ['かきくけこ', 'がぎぐげご'], ['さしすせそ', 'ざじずぜぞ'], ['たちつてと', 'だぢづでど'], ['はひふへほ', 'ばびぶべぼ'],
];
const MARK = new Map();
const VOICED = new Map(); // dakuten pairs only (LATIN voiced / unvoiced rule)
const link = (map, a, b) => {
  if (!map.has(a)) map.set(a, []);
  if (!map.get(a).includes(b)) map.get(a).push(b);
};
for (const [plain, dak] of DAKUTEN) {
  for (let i = 0; i < 5; i++) {
    link(MARK, plain[i], dak[i]); link(MARK, dak[i], plain[i]);
    link(VOICED, plain[i], dak[i]); link(VOICED, dak[i], plain[i]);
  }
}
const HA = 'はひふへほ', BA = 'ばびぶべぼ', PA = 'ぱぴぷぺぽ';
for (let i = 0; i < 5; i++) {
  link(MARK, HA[i], PA[i]); link(MARK, PA[i], HA[i]);
  link(MARK, BA[i], PA[i]); link(MARK, PA[i], BA[i]);
}
for (const [a, b] of [['つ', 'っ'], ['や', 'ゃ'], ['ゆ', 'ゅ'], ['よ', 'ょ']]) { link(MARK, a, b); link(MARK, b, a); }

// V2 "flick direction": the other kana on the same key, with the same mark. One string per key and mark, aligned
// by flick position ('・' = no kana there).
const KEYS = [
  'あいうえお', 'ぁぃぅぇぉ', 'かきくけこ', 'がぎぐげご', 'さしすせそ', 'ざじずぜぞ', 'たちつてと', 'だぢづでど', '・・っ・・',
  'なにぬねの', 'はひふへほ', 'ばびぶべぼ', 'ぱぴぷぺぽ', 'まみむめも', 'やゆよ', 'ゃゅょ', 'らりるれろ', 'わをんー', 'ゎ・・・',
];
const FLICK = new Map();
for (const k of KEYS) {
  const chars = Array.from(k);
  chars.forEach((c, i) => {
    if (c === '・') return;
    const others = chars.filter((x, j) => j !== i && x !== '・');
    if (others.length) FLICK.set(c, others);
  });
}

/**
 * Variants of a KANA query (hiragana) of 2 to 12 kana: V1 mark key (cost 4, 2 or more kana) and V2 flick direction
 * (cost 7, 3 or more kana). Returns [{ kana, cost, kind }].
 */
export function kanaVariants(kana) {
  const chars = Array.from(kana);
  if (chars.length < 2 || chars.length > 12) return [];
  const out = [];
  const seen = new Set([kana]);
  const add = (i, c, kind) => {
    const v = chars.slice(0, i).join('') + c + chars.slice(i + 1).join('');
    if (seen.has(v)) return;
    seen.add(v);
    out.push({ kana: v, cost: KANA_COST[kind], kind });
  };
  chars.forEach((ch, i) => { for (const c of MARK.get(ch) || []) add(i, c, 'mark'); });
  if (chars.length >= 3) chars.forEach((ch, i) => { for (const c of FLICK.get(ch) || []) add(i, c, 'flick'); });
  return out;
}

/**
 * LATIN queries that convert cleanly to kana (study 2.9 last rule, 2.10): plain <-> dakuten pairs only, never on the
 * first kana, cost 6. The caller checks canon length >= 5.
 */
export function latinVoicedVariants(kana) {
  const chars = Array.from(kana);
  const out = [];
  chars.forEach((ch, i) => {
    if (i === 0) return;
    for (const c of VOICED.get(ch) || []) {
      out.push({ kana: chars.slice(0, i).join('') + c + chars.slice(i + 1).join(''), cost: KANA_COST.voiced, kind: 'voiced' });
    }
  });
  return out;
}
