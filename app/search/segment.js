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

/** SPEC 29: other ways to split. An alternative may weigh at most this much more than the chosen split of its span. */
export const ALT_MARGIN = 10;
/** SPEC 29: an alternative replaces at most this many neighbouring segments of the chosen split. */
export const ALT_SPAN_SEGMENTS = 4;
/** SPEC 29: at most this many alternatives for one span, and this many for one text. */
export const ALT_PER_SPAN = 2;
export const ALT_MAX = 5;
/** SPEC 29: the one-kana particles an alternative may use at their normal weight; any other one-kana piece weighs 8 more. */
export const ALT_PARTICLES = new Set(Array.from('はがをにでとものへやかねよな'));
export const ALT_ONE_KANA_EXTRA = 8;
/** SPEC 29: every piece more than the chosen split has raises the margin by this much (a piece costs at least 10). */
export const ALT_MARGIN_PER_PIECE = 5;

/**
 * Split a text into segments (SPEC 19.1, replacing the greedy rule of 17.2): every substring of up to 12 word
 * characters that matches rule 1-4 is an edge of weight 10 + P(rank of the record 17.3 chooses) (+4 deinflection only,
 * +6 wikt only, +8 names only; a one-kana function word weighs exactly 10); any character can be "unknown" at 40.
 * Separators cost 0 and end a segment. The path with the lowest total weight wins; ties: fewer segments, then the
 * longer first segment. Returns { segments, truncated, alts }; a segment is
 * { kind: 'word', text, start, end, pack, id, rule, via?, base?, others, weight } | { kind: 'unknown' | 'sep', text }.
 * alts (SPEC 29) = other ways to split, in text order:
 * [{ start, end, segments: [word segments], instead: [texts of the chosen segments it replaces], delta }].
 * opts.wordLimit: alternatives are only looked for among the first N word segments (the ones the page shows).
 */
export function segmentText(store, text, { ranking = 'fiction', wordLimit = Infinity, margin = ALT_MARGIN, altMax = ALT_MAX } = {}) {
  let chars = Array.from(String(text));
  const truncated = chars.length > TEXT_MAX_CHARS;
  if (truncated) chars = chars.slice(0, TEXT_MAX_CHARS);
  const segments = [];
  let alts = [];
  let wordCount = 0;
  const push = (kind, str) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && kind !== 'word') last.text += str; else segments.push({ kind, text: str });
  };
  let i = 0;
  while (i < chars.length) {
    if (!isWordChar(chars[i])) { push('sep', chars[i]); i++; continue; }
    let end = i;
    while (end < chars.length && isWordChar(chars[end])) end++;
    const edges = runEdges(store, chars, i, end, ranking);
    const path = bestPath(edges, end - i);
    if (wordCount < wordLimit) {
      // only the part of the run whose words are shown
      let room = wordLimit - wordCount, upto = 0;
      for (const e of path) { if (e.seg.kind === 'word') { if (room === 0) break; room--; } upto++; }
      for (const a of altSplits(store, edges, path.slice(0, upto), i, margin)) alts.push(a);
    }
    for (const e of path) {
      if (e.seg.kind === 'unknown') push('unknown', e.seg.text); else { segments.push(e.seg); wordCount++; }
    }
    i = end;
  }
  // the same change at two places of the text (a repeated phrase) is listed once
  const seenAlt = new Set();
  alts = alts.filter((a) => { const k = a.segments.map((x) => x.text).join('/') + '|' + a.instead.join('/'); return seenAlt.has(k) ? false : (seenAlt.add(k), true); });
  if (alts.length > altMax) { // keep the closest ones, shown in text order
    alts = alts.slice().sort((x, y) => x.delta - y.delta || x.start - y.start).slice(0, altMax);
  }
  alts.sort((x, y) => x.start - y.start || x.end - y.end || x.delta - y.delta);
  return { segments, truncated, alts };
}

/** edges[k] = every edge { L, w, seg } that starts at chars[from + k] (the last one is the "unknown" edge). */
function runEdges(store, chars, from, to, ranking) {
  const n = to - from;
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
  return edges;
}

/** Lowest-weight path over a run of n characters: the list of its edges. */
function bestPath(edges, n) {
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
  for (let k = 0; k < n; k += best[k].edge.L) out.push(best[k].edge);
  return out;
}

const charLen = (s) => Array.from(s).length;
const oneKana = (seg) => charLen(seg.text) === 1 && allKana(seg.text);

/** Weight of an edge inside an alternative (SPEC 29.2); null = not allowed there (unknown, or matched by names only). */
function altWeight(e) {
  if (e.seg.kind !== 'word' || e.seg.rule === 4) return null;
  return e.w + (oneKana(e.seg) && !ALT_PARTICLES.has(e.seg.text) ? ALT_ONE_KANA_EXTRA : 0);
}

/**
 * Other ways to split (SPEC 29). `path` = the chosen edges of a run (from its first character).
 * A. Moved boundary: for every stretch of 2 to ALT_SPAN_SEGMENTS neighbouring chosen segments, the lowest-weight
 *    paths over the same characters that use only allowed word edges and cut at none of the chosen cut points inside
 *    the stretch (so each alternative is the smallest change of its kind and two stretches never give the same one).
 *    One that only cuts another kept alternative of the same stretch into smaller pieces is dropped.
 * B. One chosen word cut in two: only "word of 2+ characters (rule 1) + function word" in either order, where the
 *    function word is a particle of ALT_PARTICLES or a 2-character function word (今日は -> 今日 / は).
 * Both: kept when the weight is at most `margin` above the chosen weight of the stretch (A: plus ALT_MARGIN_PER_PIECE
 * for every piece more than the chosen split has); at most ALT_PER_SPAN each.
 */
function altSplits(store, edges, path, from, margin) {
  const cuts = [0];
  for (const e of path) cuts.push(cuts[cuts.length - 1] + e.L);
  const isCut = new Set(cuts);
  const out = [];
  const mk = (i, j, segs, delta) => ({ start: from + cuts[i], end: from + cuts[j], segments: segs, instead: path.slice(i, j).map((e) => e.seg.text), delta });
  const fnPiece = (seg) => (oneKana(seg) ? ALT_PARTICLES.has(seg.text) : charLen(seg.text) === 2 && isFunctionWord(store, seg));
  const wordPiece = (seg) => seg.rule === 1 && charLen(seg.text) >= 2;
  for (let i = 0; i < path.length; i++) {
    // B. the chosen word i cut in two
    if (path[i].seg.kind === 'word') {
      const a = cuts[i], b = cuts[i + 1];
      const found = [];
      for (let p = a + 1; p < b; p++) {
        const e1 = edges[a].find((e) => e.L === p - a && e.seg.kind === 'word');
        const e2 = edges[p].find((e) => e.L === b - p && e.seg.kind === 'word');
        if (!e1 || !e2 || altWeight(e1) === null || altWeight(e2) === null) continue;
        if (!((wordPiece(e1.seg) && fnPiece(e2.seg)) || (fnPiece(e1.seg) && wordPiece(e2.seg)))) continue;
        const delta = e1.w + e2.w - path[i].w;
        if (delta <= margin) found.push(mk(i, i + 1, [e1.seg, e2.seg], delta));
      }
      found.sort((x, y) => x.delta - y.delta);
      for (const x of found.slice(0, ALT_PER_SPAN)) out.push(x);
    }
    // A. moved boundaries over the chosen segments i .. j-1
    let chosenW = path[i].w;
    for (let j = i + 2; j <= path.length && j - i <= ALT_SPAN_SEGMENTS; j++) {
      chosenW += path[j - 1].w;
      const a = cuts[i], b = cuts[j];
      // tops[k] = the lowest-weight allowed paths from k to b
      const K = ALT_PER_SPAN + 2;
      const tops = new Map([[b, [{ w: 0, edge: null, rest: null }]]]);
      for (let k = b - 1; k >= a; k--) {
        if (k !== a && isCut.has(k)) continue; // a chosen cut point inside the stretch: not allowed
        const list = [];
        for (const e of edges[k]) {
          const w = k + e.L <= b ? altWeight(e) : null;
          const rests = w === null ? null : tops.get(k + e.L);
          if (!rests) continue;
          for (const r of rests) list.push({ w: w + r.w, edge: e, rest: r });
        }
        if (!list.length) continue;
        list.sort((x, y) => x.w - y.w);
        tops.set(k, list.slice(0, K));
      }
      const kept = [];
      for (const p of tops.get(a) || []) {
        if (kept.length >= ALT_PER_SPAN) break;
        const segs = [];
        const inner = new Set();
        for (let q = p; q.edge; q = q.rest) { segs.push(q.edge.seg); inner.add(q.edge.seg.end); }
        if (p.w - chosenW > margin + ALT_MARGIN_PER_PIECE * Math.max(0, segs.length - (j - i))) continue;
        if (kept.some((x) => [...x.inner].every((c) => inner.has(c)))) continue; // only a finer cut of a kept one
        kept.push({ inner, alt: mk(i, j, segs, p.w - chosenW) });
      }
      for (const x of kept) out.push(x.alt);
    }
  }
  return out;
}

/** Function word (17.4): first-sense part of speech prt / aux / aux-v / cop / conj and at most 2 characters. */
export function isFunctionWord(store, seg) {
  if (seg.kind !== 'word' || Array.from(seg.text).length > 2 || seg.pack === 'names') return false;
  return firstPos(store.getRecord(seg.pack, seg.id)).some((p) => FUNCTION_POS.has(p));
}
