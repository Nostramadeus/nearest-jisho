// Words in a pasted text (SPEC 17.2 / 17.3). Pure module: runs in the worker and in node.
// Lowest-total-weight split (SPEC 19.1): common words win over rare ones; it can still be wrong (stated in the note).
import { toHiragana, isKana } from './romaji.js';
import { deinflect, posBits } from './deinflect.js';
import { pRank } from './cost.js';

export const TEXT_MAX_CHARS = 500;
export const TEXT_MIN_CHARS = 3;
export const SEGMENT_MAX_LEN = 12;
/** First-sense parts of speech that let ONE kana character be a word (17.2). */
export const ONE_KANA_POS = new Set(['prt', 'aux', 'aux-v', 'cop', 'conj', 'int']);
/** Parts of speech shown as a compact row (17.4), for segments of at most 2 characters. */
export const FUNCTION_POS = new Set(['prt', 'aux', 'aux-v', 'cop', 'conj']);

const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々\u{20000}-\u{3134f}]/u;
/** Part of a word: kana (incl. ー), kanji or 々. Anything else separates words. */
export function isWordChar(ch) {
  const c = ch.codePointAt(0);
  return isKana(c) || KANJI_RE.test(ch);
}
const allKana = (s) => Array.from(s).every((ch) => isKana(ch.codePointAt(0)));
const firstPos = (rec) => ((rec.s && rec.s[0] && rec.s[0].p) || []);

/** Records of `pack` whose written form (space k) is exactly `form`. */
function exact(store, pack, form) {
  const ks = store.keySpace(pack, 'k');
  if (!ks) return [];
  const i = ks.find(form);
  return i < 0 ? [] : Array.from(ks.idsOf(i));
}

/** Rule 1-3 candidates for substring s: [{ pack, id, rule, via?, base? }] of the first rule that matches. */
function rulesOneToThree(store, s) {
  // 1. written form in words, or for kana its hiragana form as a kana form
  const c1 = new Set(exact(store, 'words', s));
  if (allKana(s)) {
    const h = toHiragana(s);
    if (h !== s) for (const id of exact(store, 'words', h)) if ((store.getRecord('words', id).r || []).includes(h)) c1.add(id);
  }
  if (c1.size) return Array.from(c1, (id) => ({ pack: 'words', id, rule: 1 }));
  // 2. deinflection to a verified words record
  const c2 = [];
  const seen = new Set();
  for (const cand of deinflect(allKana(s) ? toHiragana(s) : s)) {
    for (const id of exact(store, 'words', cand.form)) {
      if (seen.has(id)) continue;
      const rec = store.getRecord('words', id);
      const ok = (rec.s || []).some((sense) => (sense.p || []).some((p) => posBits(p) & cand.type));
      if (!ok) continue;
      seen.add(id);
      c2.push({ pack: 'words', id, rule: 2, via: cand.via.join(' + '), base: cand.form });
    }
  }
  if (c2.length) return c2;
  // 3. written form in the Wiktionary pack
  const c3 = store.has('wikt') ? exact(store, 'wikt', s) : [];
  return c3.map((id) => ({ pack: 'wikt', id, rule: 3 }));
}

/** One-kana rule (17.2): keep only records whose first sense is a function word; none -> no match. */
function oneKanaFilter(store, s, cands) {
  if (Array.from(s).length !== 1 || !allKana(s)) return cands;
  return cands.filter((c) => firstPos(store.getRecord(c.pack, c.id)).some((p) => ONE_KANA_POS.has(p)));
}

/** 17.3: true written-form match before a deinflected one, then rank, then record id. */
function choose(store, cands, ranking) {
  const key = (c) => [c.rule === 2 ? 1 : 0, store.rank(c.pack, c.id, ranking), c.pack === 'words' ? 0 : c.pack === 'wikt' ? 1 : 2, c.id];
  return cands.slice().sort((a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
}

export const UNKNOWN_WEIGHT = 40;
const EXTRA = { 1: 0, 2: 4, 3: 6, 4: 8 }; // SPEC 19.1: + 4 deinflection only, + 6 wikt only, + 8 names only

/** Candidate records of one edge: the first matching rule 1, 2, 3 (one-kana rule applied), else 4 (names, L >= 2). */
function edgeCands(store, s, L) {
  const c = oneKanaFilter(store, s, rulesOneToThree(store, s));
  if (c.length) return c;
  if (L >= 2 && store.has('names')) return exact(store, 'names', s).map((id) => ({ pack: 'names', id, rule: 4 }));
  return [];
}

/**
 * Split a text into segments (SPEC 19.1, replacing the greedy rule of 17.2): every substring of up to 12 word
 * characters that matches rule 1-4 is an edge of weight 10 + P(rank of the record 17.3 chooses) (+4 deinflection only,
 * +6 wikt only, +8 names only; a one-kana function word weighs exactly 10); any character can be "unknown" at 40.
 * Separators cost 0 and end a segment. The path with the lowest total weight wins; ties: fewer segments, then the
 * longer first segment. Returns { segments, truncated }; a segment is
 * { kind: 'word', text, start, end, pack, id, rule, via?, base?, others, weight } | { kind: 'unknown' | 'sep', text }.
 */
export function segmentText(store, text, { ranking = 'fiction' } = {}) {
  let chars = Array.from(String(text));
  const truncated = chars.length > TEXT_MAX_CHARS;
  if (truncated) chars = chars.slice(0, TEXT_MAX_CHARS);
  const segments = [];
  const push = (kind, str) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && kind !== 'word') last.text += str; else segments.push({ kind, text: str });
  };
  let i = 0;
  while (i < chars.length) {
    if (!isWordChar(chars[i])) { push('sep', chars[i]); i++; continue; }
    let end = i;
    while (end < chars.length && isWordChar(chars[end])) end++;
    for (const seg of splitRun(store, chars, i, end, ranking)) {
      if (seg.kind === 'unknown') push('unknown', seg.text); else segments.push(seg);
    }
    i = end;
  }
  return { segments, truncated };
}

/** Lowest-weight split of chars[from..to) (no separators inside). */
function splitRun(store, chars, from, to, ranking) {
  const n = to - from;
  // edges[k] = list of { L, w, seg } starting at from + k
  const edges = Array.from({ length: n }, () => []);
  for (let k = 0; k < n; k++) {
    const maxL = Math.min(SEGMENT_MAX_LEN, n - k);
    for (let L = 1; L <= maxL; L++) {
      const s = chars.slice(from + k, from + k + L).join('');
      const cands = edgeCands(store, s, L);
      if (!cands.length) continue;
      const sorted = choose(store, cands, ranking);
      const best = sorted[0];
      const oneKanaFn = L === 1 && allKana(s);
      const w = oneKanaFn ? 10 : 10 + pRank(store.rank(best.pack, best.id, ranking)) + EXTRA[best.rule];
      const seg = { kind: 'word', text: s, start: from + k, end: from + k + L, pack: best.pack, id: best.id, rule: best.rule, others: sorted.length - 1, weight: w };
      if (best.via) { seg.via = best.via; seg.base = best.base; }
      edges[k].push({ L, w, seg });
    }
    edges[k].push({ L: 1, w: UNKNOWN_WEIGHT, seg: { kind: 'unknown', text: chars[from + k] } });
  }
  // dynamic programming from the right: best[k] = best path from k to the end of the run
  const best = new Array(n + 1);
  best[n] = { w: 0, count: 0, edge: null };
  for (let k = n - 1; k >= 0; k--) {
    let pick = null;
    for (const e of edges[k]) {
      const rest = best[k + e.L];
      const w = e.w + rest.w, count = 1 + rest.count;
      if (!pick || w < pick.w || (w === pick.w && (count < pick.count || (count === pick.count && e.L > pick.edge.L)))) {
        pick = { w, count, edge: e };
      }
    }
    best[k] = pick;
  }
  const out = [];
  for (let k = 0; k < n; k += best[k].edge.L) out.push(best[k].edge.seg);
  return out;
}

/** Function word (17.4): first-sense part of speech prt / aux / aux-v / cop / conj and at most 2 characters. */
export function isFunctionWord(store, seg) {
  if (seg.kind !== 'word' || Array.from(seg.text).length > 2 || seg.pack === 'names') return false;
  return firstPos(store.getRecord(seg.pack, seg.id)).some((p) => FUNCTION_POS.has(p));
}
