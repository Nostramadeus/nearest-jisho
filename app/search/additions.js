// Nearest Jisho additions (SPEC 32.4): a small hand-made word list shipped with the APP CODE, for words the
// dictionary data lacks (checked 2026-11-26: not in JMdict, not in the Wiktionary pack). No data rebuild needed.
// PackStore.loadPack('words') merges these records into the words pack (packs.js mergeRecords): every search path
// (worker, tools/query.mjs, the text splitter, deinflection) then finds them like any other record.
// Record shape = a words record (SPEC 3) plus src "nj". Parts of speech are JMdict codes, so deinflection works.
// A record is skipped when the words pack already has the same written form with the same reading (a later JMdict
// that gains the word wins).

export const ADDITIONS_SOURCE = 'Nearest Jisho additions';
/** Rank of every addition (SPEC 32.4: treated as a common, mid-frequency word; P = 7 of the SPEC 18 table). */
export const ADDITION_RANK = 15000;

export const ADDITIONS = [
  { r: ['くちい'], c: 1, src: 'nj', s: [{ p: ['adj-i'], g: ['full (stomach)', 'satiated', 'sated'] }] },
  { k: ['血判状'], r: ['けっぱんじょう'], c: 1, src: 'nj', s: [{ p: ['n'], g: ['written pledge sealed with blood', 'blood-sealed oath'] }] },
];
