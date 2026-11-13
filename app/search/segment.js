// Words in a pasted text (SPEC 17.2 / 17.3). Pure module: runs in the worker and in node.
// Greedy longest match, no look-ahead (a long run of hiragana can be split wrongly; stated in the group's note).
import { toHiragana, isKana } from './romaji.js';
import { deinflect, posBits } from './deinflect.js';

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

/**
 * Split a text into segments (SPEC 17.2). Returns { segments, truncated }; a segment is
 * { kind: 'word', text, start, end, pack, id, rule, via?, base?, others } | { kind: 'unknown' | 'sep', text }.
 * start/end are code-point positions in the (possibly truncated) text.
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
    let runEnd = i;
    while (runEnd < chars.length && isWordChar(chars[runEnd])) runEnd++;
    const maxL = Math.min(SEGMENT_MAX_LEN, runEnd - i);
    let win = null; // { L, cands }
    let oneChar = null;
    for (let L = maxL; L >= 1; L--) {
      const s = chars.slice(i, i + L).join('');
      const cands = oneKanaFilter(store, s, rulesOneToThree(store, s));
      if (!cands.length) continue;
      if (L >= 2) { win = { L, cands }; break; }
      oneChar = { L, cands };
    }
    // 4. names, only when rules 1-3 found nothing of length >= 2 here
    if (!win && store.has('names')) {
      for (let L = maxL; L >= 2; L--) {
        const ids = exact(store, 'names', chars.slice(i, i + L).join(''));
        if (ids.length) { win = { L, cands: ids.map((id) => ({ pack: 'names', id, rule: 4 })) }; break; }
      }
    }
    if (!win) win = oneChar;
    if (!win) { push('unknown', chars[i]); i++; continue; }
    const sorted = choose(store, win.cands, ranking);
    const best = sorted[0];
    const seg = { kind: 'word', text: chars.slice(i, i + win.L).join(''), start: i, end: i + win.L, pack: best.pack, id: best.id, rule: best.rule, others: sorted.length - 1 };
    if (best.via) { seg.via = best.via; seg.base = best.base; }
    segments.push(seg);
    i += win.L;
  }
  return { segments, truncated };
}

/** Function word (17.4): first-sense part of speech prt / aux / aux-v / cop / conj and at most 2 characters. */
export function isFunctionWord(store, seg) {
  if (seg.kind !== 'word' || Array.from(seg.text).length > 2 || seg.pack === 'names') return false;
  return firstPos(store.getRecord(seg.pack, seg.id)).some((p) => FUNCTION_POS.has(p));
}
