// Search engine (SPEC 4). Pure module: no DOM, no fetch. Works on a PackStore (packs.js).

import { canon, hasKana, romajiToKana, kanaToRomaji, toHiragana, latinRewrite } from './romaji.js';
import { fold } from './fold.js';
import { prepareQuery, distance, budget, reasonFor, letterMask, popcount, INF, P_LIMITS, pRank } from './cost.js';
import { kanaVariants, latinVoicedVariants, KANA_LABEL } from './kanavariants.js';
import { deinflect, posBits } from './deinflect.js';
import { segmentText, isFunctionWord, TEXT_MAX_CHARS, TEXT_MIN_CHARS } from './segment.js';

export const TITLES = {
  text: 'Words in this text',
  words: 'Japanese words',
  en: 'English meanings',
  names: 'Names',
  wikt: 'Slang and Wiktionary',
};
export const FOLD_NOTE = 'long vowel / double letter';
export const STOP = new Set('a an the of to in on at for and or by with as is be it that from'.split(' '));

const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々-〇\u{20000}-\u{3134f}]/u;
const LATIN_RE = /^[\p{Script=Latin}\s'\-]+$/u;

/** 'kanji' | 'kana' | 'latin' (SPEC 4.3). Anything else (digits, symbols) is searched as written, like kanji. */
export function queryKind(q) {
  if (KANJI_RE.test(q)) return 'kanji';
  if (hasKana(q)) return 'kana';
  if (LATIN_RE.test(q)) return 'latin';
  return 'kanji';
}

export function tokenize(q) {
  const all = q.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  const kept = all.filter((t) => !STOP.has(t));
  return kept.length ? kept : all;
}

const CLS_A = 1, CLS_B = 2, CLS_C = 3;

// ---------- SPEC 18 / design/typo-study.md section 1: one score S = cost + P(rank), in tenths ----------
export { P_LIMITS, pRank }; // the P table lives in cost.js (also used by segment.js)
/** Hit cost in tenths (study 1.1): tier 0 = 0, deinflected = 1, fold = 2, variants and near hits = their own cost. */
export function hitCost10(h) {
  if (h.c10 !== undefined) return h.c10;
  if (h.tier === 0) return h.via ? 1 : 0;
  return Math.round((h.cost || 0) * 10);
}
export const PROMOTE_MAX_COST = 5;
export const PROMOTE_MAX_SCORE = 9;
export const PROMOTE_COUNT = 3;
/** The record's first sense is marked "usually written in kana" (misc uk). */
export const usuallyKana = (rec) => !!(rec && rec.s && rec.s[0] && (rec.s[0].m || []).includes('uk') && rec.r && rec.r.length);

/**
 * Headword shown for a record (SPEC 19.2): its first kana form when the first sense is marked uk, else the first
 * written form. `typed`: a query or text segment that equals one of the record's forms wins whatever uk says.
 */
export function shownHead(rec, typed) {
  const kf = rec.k || [], rf = rec.r || [];
  if (typed && (kf.includes(typed) || rf.includes(typed))) return typed;
  if (usuallyKana(rec)) return rf[0];
  return kf[0] || rf[0] || '';
}

export const LABELS = {
  fold: 'long vowel / double letter', ei: 'ei / ee', wa: 'は typed as wa', l: 'l read as r', stem: 'plural / -ing / -ed',
};
const TIER2_MAX = 200;
const CONTAINS_MAX = 100;

// ---------- hit bookkeeping ----------
// hit: { pack, id, tier, sub, cost, via, space, key, keyLen, cls, sense, useCommon, form, hlLen }

function better(a, b) { // is a better than b (best tier wins; record listed once)
  if (a.tier !== b.tier) return a.tier < b.tier;
  if ((a.sub || 0) !== (b.sub || 0)) return (a.sub || 0) < (b.sub || 0);
  if ((a.cls || 0) !== (b.cls || 0)) return (a.cls || 0) < (b.cls || 0);
  if ((a.sense || 0) !== (b.sense || 0)) return (a.sense || 0) < (b.sense || 0);
  return a.cost < b.cost;
}
function put(map, hit) {
  const old = map.get(hit.id);
  if (!old || better(hit, old)) map.set(hit.id, hit);
}

// Ruling 2026-11-13 (SPEC 4.6): tier 3 sorts by exact cost, then rank (no cost bucket).
function bucket(h) { return h.tier === 3 && h.space !== 'e' ? h.cost : 0; }

function makeComparator(store, ctx) {
  const ranking = ctx.ranking;
  const rankOf = (h) => (h.rank !== undefined ? h.rank : (h.rank = store.rank(h.pack, h.id, ranking)));
  const commonOf = (h) => (h.common !== undefined ? h.common : (h.common = store.isCommon(h.pack, h.id) ? 1 : 0));
  // Ruling 2026-11-13 (SPEC 4.6): LATIN queries merge reading tiers 0 and 1 into one block ordered by class
  // (1 = tier 0 common, 2 = tier 1 common, 3 = tier 0 not common, 4 = tier 1 not common), then rank.
  // Deinflected hits (sub 2) still follow the true hits of that block (SPEC 4.8).
  const merge = ctx.kind === 'latin';
  const blockOf = (h) => (merge && h.tier <= 1 && h.space !== 'e' ? 0 : h.tier);
  const mergedClass = (h) => (commonOf(h) ? (h.tier === 0 ? 1 : 2) : (h.tier === 0 ? 3 : 4));
  return (a, b) => {
    const ta = blockOf(a), tb = blockOf(b);
    if (ta !== tb) return ta - tb;
    if ((a.sub || 0) !== (b.sub || 0)) return (a.sub || 0) - (b.sub || 0);
    if (merge && ta === 0 && a.space !== 'e' && b.space !== 'e' && a.tier <= 1 && b.tier <= 1) {
      const ca = mergedClass(a), cb = mergedClass(b);
      if (ca !== cb) return ca - cb;
    }
    const ba = bucket(a), bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if ((a.cls || 0) !== (b.cls || 0)) return (a.cls || 0) - (b.cls || 0);
    if ((a.sense || 0) !== (b.sense || 0)) return (a.sense || 0) - (b.sense || 0);
    if (a.tier === 2 && a.useCommon && b.useCommon) {
      const ca = commonOf(a), cb = commonOf(b);
      if (ca !== cb) return cb - ca;
    }
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    if ((a.keyLen || 0) !== (b.keyLen || 0)) return (a.keyLen || 0) - (b.keyLen || 0);
    if (ctx.recentAny) {
      const xa = isRecent(store, ctx, a), xb = isRecent(store, ctx, b);
      if (xa !== xb) return xb - xa;
    }
    if (a.pack !== b.pack) return a.pack < b.pack ? -1 : 1;
    return a.id - b.id;
  };
}

function isRecent(store, ctx, h) {
  if (h.recent !== undefined) return h.recent;
  let r = 0;
  if (h.space === 'r' && ctx.recentCanon.has(h.key)) r = 1;
  else {
    const rec = store.getRecord(h.pack, h.id);
    for (const f of rec.k || []) if (ctx.recent.has(f)) { r = 1; break; }
    if (!r) for (const f of rec.r || []) if (ctx.recent.has(f)) { r = 1; break; }
  }
  h.recent = r;
  return r;
}

// ---------- Japanese reading search (space r), SPEC 4.4 ----------

function readingT012(store, ctx, pack, c, kanaTyped, hits) {
  const ks = store.keySpace(pack, 'r');
  if (!ks || !c) return { t01: 0, t2: 0 };
  let t01 = 0;
  const ex = ks.find(c);
  if (ex >= 0) {
    for (const id of ks.idsOf(ex)) {
      let sub = 0;
      if (kanaTyped) {
        const rec = store.getRecord(pack, id);
        sub = (rec.r || []).includes(kanaTyped) ? 0 : 1;
      }
      put(hits, { pack, id, tier: 0, sub, cost: 0, space: 'r', key: c, keyLen: c.length });
    }
  }
  // tier 1: fold
  for (const i of ks.foldLookup(fold(c))) {
    if (i === ex) continue;
    const key = ks.key(i);
    for (const id of ks.idsOf(i)) {
      put(hits, { pack, id, tier: 1, cost: 0.2, c10: 2, space: 'r', key, keyLen: key.length, label: LABELS.fold });
    }
  }
  t01 = hits.size;
  // tier 2: prefix
  let t2 = 0;
  if (c.length >= 2) t2 = prefixTier2(store, ctx, pack, ks, c, ex, hits, 'r');
  return { t01, t2 };
}

/** Tier 2 prefix: up to 200 records not yet listed, taken in rank order. Returns count added. */
function prefixTier2(store, ctx, pack, ks, p, exactIdx, hits, space) {
  const [lo, hi] = ks.prefixRange(p);
  if (hi <= lo) return 0;
  let total = 0;
  for (let i = lo; i < hi; i++) if (i !== exactIdx) total += ks.ptr[i + 1] - ks.ptr[i];
  if (!total) return 0;
  // score = (rank * 64 + min(keyLen, 63)) * 2^20 + id  (rank < 2^20, id < 2^20: exact in a double)
  const scores = new Float64Array(total);
  const keyOf = new Uint32Array(total);
  let n = 0;
  const meta = store.packs[pack].meta, mo = ctx.ranking === 'news' ? 1 : 0;
  for (let i = lo; i < hi; i++) {
    if (i === exactIdx) continue;
    const len = Math.min(ks.keyLen(i), 63);
    const ids = ks.idsOf(i);
    for (let j = 0; j < ids.length; j++) {
      const id = ids[j];
      scores[n] = ((meta[id * 2 + mo] & 0xfffff) * 64 + len) * 1048576 + id;
      keyOf[n] = i;
      n++;
    }
  }
  // native numeric sort of a copy, pick the 200 best new records, then recover the key of each winner
  const sorted = scores.slice().sort();
  const want = new Map(); // id -> winning score
  for (let k = 0; k < sorted.length && want.size < TIER2_MAX; k++) {
    const id = sorted[k] % 1048576;
    if (hits.has(id) || want.has(id)) continue;
    want.set(id, sorted[k]);
  }
  const added = want.size;
  for (let k = 0; k < n && want.size; k++) {
    const id = scores[k] % 1048576;
    if (want.get(id) === scores[k]) {
      const key = ks.key(keyOf[k]);
      hits.set(id, { pack, id, tier: 2, cost: 0, space, key, keyLen: key.length, useCommon: true });
      want.delete(id);
    }
  }
  return added;
}

/** Tier 3 near search over space r. Returns [{ key, cost(tenths) }] of keys that added records. */
function readingT3(store, ctx, pack, c, isKana, hits) {
  const ks = store.keySpace(pack, 'r');
  if (!ks) return [];
  const len = c.length;
  const B = budget(len);
  if (!B) return [];
  const P = prepareQuery(c, { keyboard: !isKana, soft: true, first: true });
  const qm = letterMask(c);
  const masks = ks.masks();
  const off = ks.off, str = ks.str;
  const found = [];
  for (let i = 0; i < ks.count; i++) {
    const s = off[i], e = off[i + 1] - 1, kl = e - s;
    if (kl < len - 2 || kl > len + 2) continue;
    if (popcount(qm ^ masks[i]) > 4) continue;
    const d = distance(P, str, s, e, B);
    if (d === INF) continue;
    found.push([i, d]);
  }
  const keys = [];
  for (const [i, d] of found) {
    const key = ks.key(i);
    let added = false;
    for (const id of ks.idsOf(i)) {
      const old = hits.get(id);
      if (old && old.tier < 3) continue;
      put(hits, { pack, id, tier: 3, cost: d / 10, c10: d, space: 'r', key, keyLen: key.length, lq: c, kbd: !isKana });
      added = true;
    }
    if (added) keys.push({ key, cost: d, pack, ids: ks.idsOf(i), q: c });
  }
  return keys;
}

// ---------- spelling variants (study 2.3, 2.4), phase "fast" ----------

/** ei / ee / e variants of a canonical reading: one change each, left to right, at most 6. */
export function eiVariants(c) {
  const out = [];
  const add = (v) => { if (out.length < 6 && v !== c && !out.includes(v)) out.push(v); };
  for (let i = 0; i < c.length - 1 && out.length < 6; i++) {
    if (c[i] === 'e' && c[i + 1] === 'e') add(c.slice(0, i) + 'ei' + c.slice(i + 2));
    if (c[i] === 'e' && c[i + 1] === 'i') add(c.slice(0, i) + 'ee' + c.slice(i + 2));
  }
  for (let i = 0; i < c.length && out.length < 6; i++) {
    if (c[i] !== 'e' || c[i - 1] === 'e' || c[i + 1] === 'e' || c[i + 1] === 'i') continue;
    add(c.slice(0, i + 1) + 'i' + c.slice(i + 1));
  }
  return out;
}
/** Particle は typed as wa: each "wa" not after k or g, rightmost first, at most 3, -> "ha". */
export function waVariants(c) {
  const out = [];
  for (let i = c.length - 2; i >= 0 && out.length < 3; i--) {
    if (c[i] === 'w' && c[i + 1] === 'a' && c[i - 1] !== 'k' && c[i - 1] !== 'g') out.push(c.slice(0, i) + 'ha' + c.slice(i + 2));
  }
  return out;
}
const WA_POS = new Set(['exp', 'conj', 'adv', 'prt', 'int']);

/** Look up variant readings (exact: cost, fold: cost + 2) and add new hits with the given tier and label. */
function variantLookup(store, pack, variants, tier, cost10, label, hits, keep) {
  const ks = store.keySpace(pack, 'r');
  if (!ks) return;
  for (const v of variants) {
    const ex = ks.find(v);
    const add = (i, c10) => {
      const key = ks.key(i);
      for (const id of ks.idsOf(i)) {
        if (keep && !keep(id)) continue;
        put(hits, { pack, id, tier, cost: c10 / 10, c10, space: 'r', key, keyLen: key.length, label, variant: v });
      }
    };
    if (ex >= 0) add(ex, cost10);
    for (const i of ks.foldLookup(fold(v))) if (i !== ex) add(i, cost10 + 2);
  }
}

function spellingVariants(store, ctx, pack, c, hits) {
  variantLookup(store, pack, eiVariants(c), 1, 3, LABELS.ei, hits);
  if (pack === 'words') {
    const keep = (id) => (store.getRecord('words', id).s || []).some((x) => (x.p || []).some((p) => WA_POS.has(p)));
    variantLookup(store, pack, waVariants(c), 1, 2, LABELS.wa, hits, keep);
  }
}

/** One-kana variants (study 2.9): tier 3 hits with their own cost and label. */
function kanaVariantHits(store, pack, variants, hits) {
  const ks = store.keySpace(pack, 'r');
  if (!ks) return;
  for (const v of variants) {
    const rom = kanaToRomaji(v.kana);
    if (!rom) continue;
    const ex = ks.find(rom);
    const add = (i, c10) => {
      const key = ks.key(i);
      for (const id of ks.idsOf(i)) {
        const old = hits.get(id);
        if (old && old.tier < 3) continue;
        put(hits, { pack, id, tier: 3, cost: c10 / 10, c10, space: 'r', key, keyLen: key.length, label: KANA_LABEL[v.kind] });
      }
    };
    if (ex >= 0) add(ex, v.cost);
    for (const i of ks.foldLookup(fold(rom))) if (i !== ex) add(i, v.cost + 2);
  }
}

/** Promotion (study 1.3): cost <= 5, cost + P(min(ff, fn)) <= 9, the 3 best by S, then cost, then rank. */
function promote(store, ctx, hits) {
  const cands = [];
  for (const h of hits.values()) {
    if (h.tier !== 3 || h.via === 'contains' || h.space !== 'r') continue;
    const c10 = hitCost10(h);
    if (c10 > PROMOTE_MAX_COST) continue;
    const m = store.meta(h.pack, h.id);
    if (c10 + pRank(Math.min(m.ff, m.fn)) > PROMOTE_MAX_SCORE) continue;
    const rank = store.rank(h.pack, h.id, ctx.ranking);
    cands.push({ h, S: c10 + pRank(rank), c10, rank });
  }
  cands.sort((a, b) => a.S - b.S || a.c10 - b.c10 || a.rank - b.rank || a.h.id - b.h.id);
  for (const c of cands.slice(0, PROMOTE_COUNT)) c.h.promoted = true;
}

/**
 * Order of a Japanese group for LATIN and KANA queries (study 1.4, LATIN revised by SPEC 21.1, see blockOf).
 * KANA: tier 0 strictly first (typed kana form, then romaji, then deinflected; by rank); then tier 1 + variants +
 * promoted by S; prefix; the other near hits by S. English hits (wikt group) keep their own order after the reading
 * hits of the same block. Inside blocks other than KANA tier 0 and prefix: S, then cost, rank, shorter key, recent,
 * pack, id.
 */
/**
 * SPEC 27.2: 1 when a reading hit (space r, words pack) matched through a kana form that carries a JMdict reading
 * priority tag (rec.rp), else 0. Records without rp (older data, names, wikt) count 0.
 */
function priOf(store, h) {
  if (h.pri !== undefined) return h.pri;
  let p = 0;
  if (h.space === 'r' && h.key && h.pack === 'words') {
    const rec = store.getRecord(h.pack, h.id);
    if (Array.isArray(rec.rp) && rec.r) p = rec.rp.some((i) => rec.r[i] && kanaToRomaji(rec.r[i]) === h.key) ? 1 : 0;
  }
  return (h.pri = p);
}

function makeReadingComparator(store, ctx) {
  const ranking = ctx.ranking;
  const rankOf = (h) => (h.rank !== undefined ? h.rank : (h.rank = store.rank(h.pack, h.id, ranking)));
  const commonOf = (h) => (h.common !== undefined ? h.common : (h.common = store.isCommon(h.pack, h.id) ? 1 : 0));
  const latin = ctx.kind === 'latin';
  let rareT0 = false; // the group being sorted has a tier-0 hit without the common flag (set by forGroup)
  // SPEC 21.1 (replaces the LATIN part of study 1.4): what was typed comes first. Blocks:
  // 1 tier-0 common; 2 tier-1 common fold hit (LATIN only: a dropped long vowel is a spelling habit);
  // 3 tier-0 not common (KANA / KANJI: all tier 0 is block 1); 4 the rest of the top block (deinflected, other tier 1,
  // variants, promoted) by S; 5 prefix; 6 the remaining near hits by S.
  const blockOf = (h) => {
    if (h.space === 'e') return h.tier === 0 ? 4 : h.tier === 2 ? 5 : 6;
    if (h.tier === 0) {
      if (!latin) return 1;
      if (h.via) return 4;
      return commonOf(h) ? 1 : 3;
    }
    // the exception only lifts a common fold hit ABOVE rare exact hits; with no rare exact hit in the group it stays in
    // the S-ordered rest (naiso: 内緒 S 7 before 内装 S 8, SPEC 21.1 example; see PROGRESS-app Q57)
    if (h.tier === 1) return latin && rareT0 && h.label === LABELS.fold && commonOf(h) ? 2 : 4;
    if (h.tier === 2) return 5;
    return h.promoted ? 4 : 6;
  };
  const S = (h) => (h.S !== undefined ? h.S : (h.S = hitCost10(h) + pRank(rankOf(h))));
  const tail = (a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    if ((a.keyLen || 0) !== (b.keyLen || 0)) return (a.keyLen || 0) - (b.keyLen || 0);
    if (ctx.recentAny) {
      const xa = isRecent(store, ctx, a), xb = isRecent(store, ctx, b);
      if (xa !== xb) return xb - xa;
    }
    if (a.pack !== b.pack) return a.pack < b.pack ? -1 : 1;
    return a.id - b.id;
  };
  // SPEC 27.2: same tier and same mistake cost -> the hit matched through a reading with re_pri goes first
  const priTie = (a, b) => (a.tier === b.tier && hitCost10(a) === hitCost10(b) ? priOf(store, b) - priOf(store, a) : 0);
  const cmp = (a, b) => {
    const ba = blockOf(a), bb = blockOf(b);
    if (ba !== bb) return ba - bb;
    const ea = a.space === 'e', eb = b.space === 'e';
    if (ea !== eb) return ea ? 1 : -1;
    if (ea) { // English hits: (class, sense, rank) as in SPEC 4.9
      if ((a.cls || 0) !== (b.cls || 0)) return (a.cls || 0) - (b.cls || 0);
      if ((a.sense || 0) !== (b.sense || 0)) return (a.sense || 0) - (b.sense || 0);
      return tail(a, b);
    }
    if (ba === 1 && !latin) {
      if ((a.sub || 0) !== (b.sub || 0)) return (a.sub || 0) - (b.sub || 0);
      const pt = priTie(a, b);
      if (pt) return pt;
      return tail(a, b);
    }
    const pt = priTie(a, b);
    if (pt) return pt;
    if (ba === 5) {
      const ca = commonOf(a), cb = commonOf(b);
      if (ca !== cb) return cb - ca;
      return tail(a, b);
    }
    const sa = S(a), sb = S(b);
    if (sa !== sb) return sa - sb;
    const ca = hitCost10(a), cb = hitCost10(b);
    if (ca !== cb) return ca - cb;
    return tail(a, b);
  };
  cmp.forGroup = (list) => {
    rareT0 = list.some((h) => h.space !== 'e' && h.tier === 0 && !h.via && !commonOf(h));
    return cmp;
  };
  return cmp;
}

// ---------- written-form search (space k), SPEC 4.7 ----------

function writtenT02(store, ctx, pack, q, hits, kanaExact) {
  const ks = store.keySpace(pack, 'k');
  if (!ks) return 0;
  const ex = ks.find(q);
  if (ex >= 0) for (const id of ks.idsOf(ex)) put(hits, { pack, id, tier: 0, sub: 0, cost: 0, space: 'k', key: q, keyLen: q.length });
  if (kanaExact) return hits.size;
  if (Array.from(q).length >= 2) prefixTier2(store, ctx, pack, ks, q, ex, hits, 'k');
  return hits.size;
}

function writtenContains(store, ctx, pack, q, hits) {
  const ks = store.keySpace(pack, 'k');
  if (!ks || Array.from(q).length < 2) return;
  const str = ks.str;
  const keyIdx = new Set();
  for (let p = str.indexOf(q); p !== -1; p = str.indexOf(q, p + 1)) {
    const i = ks.indexAt(p);
    keyIdx.add(i);
  }
  const cands = [];
  for (const i of keyIdx) {
    for (const id of ks.idsOf(i)) {
      if (hits.has(id)) continue;
      cands.push([store.rank(pack, id, ctx.ranking), ks.keyLen(i), id, i]);
    }
  }
  cands.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  let added = 0;
  for (const [, , id, i] of cands) {
    if (added >= CONTAINS_MAX) break;
    if (hits.has(id)) continue;
    const key = ks.key(i);
    hits.set(id, { pack, id, tier: 3, cost: 1, via: 'contains', space: 'k', key, keyLen: key.length });
    added++;
  }
}

// ---------- deinflection, SPEC 4.8 ----------

function deinflectHits(store, ctx, word, hits, shown = word) {
  const ks = store.keySpace('words', 'k');
  if (!ks || !word) return;
  for (const cand of deinflect(word)) {
    const i = ks.find(cand.form);
    if (i < 0) continue;
    for (const id of ks.idsOf(i)) {
      const old = hits.get(id);
      if (old && old.tier === 0 && !old.via) continue;
      const rec = store.getRecord('words', id);
      let ok = false;
      for (const s of rec.s || []) {
        for (const p of s.p || []) if (posBits(p) & cand.type) { ok = true; break; }
        if (ok) break;
      }
      if (!ok) continue;
      put(hits, {
        pack: 'words', id, tier: 0, sub: 2, cost: 0, via: cand.via.join(' + '), base: cand.form, typed: shown,
        space: 'k', key: cand.form, keyLen: cand.form.length,
      });
    }
  }
}

// ---------- English search (space e), SPEC 4.9 ----------

function cleanGloss(g) {
  return g.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().replace(/^to /, '');
}
function glossClass(rec, sense, qn) {
  const senses = rec.s || [];
  const list = sense >= 15 ? senses.slice(15) : [senses[sense]];
  let best = CLS_C;
  for (const s of list) {
    if (!s) continue;
    for (const g of s.g || []) {
      const cg = cleanGloss(g);
      if (cg === qn) return CLS_A;
      if (cg.startsWith(qn) && cg.length > qn.length && !/\p{L}/u.test(cg[qn.length])) best = CLS_B;
    }
  }
  return best;
}

/** English stems (study 2.12): ies -> y; else es -> "" and s -> ""; ing -> "" / e; ed -> "" / e. */
export function englishStems(t) {
  if (t.length < 4 || /(ss|us|is)$/.test(t)) return [];
  const out = [];
  if (t.endsWith('ies')) out.push(t.slice(0, -3) + 'y');
  else if (t.endsWith('es')) out.push(t.slice(0, -2), t.slice(0, -1));
  else if (t.endsWith('s')) out.push(t.slice(0, -1));
  if (t.endsWith('ing')) out.push(t.slice(0, -3), t.slice(0, -3) + 'e');
  if (t.endsWith('ed')) out.push(t.slice(0, -2), t.slice(0, -2) + 'e');
  return out.filter((x) => x.length >= 2);
}

/** English match for a token list. Returns Map id -> hit. tierOverride = 3 for fuzzy re-search. */
function englishMatch(store, ctx, pack, tokens, qn, tierOverride, exactOnly = false) {
  const out = new Map();
  const es = store.keySpace(pack, 'e');
  if (!es || !tokens.length) return out;
  const last = tokens.length - 1;
  const exactIdx = tokens.map((t) => es.find(t));
  const exact = exactIdx.map((i) => (i >= 0 ? es.idsOf(i) : new Uint32Array(0)));
  const [plo, phi] = es.prefixRange(tokens[last]);
  const cand = new Map(); // packed -> lastExact
  let prefixOnly = null; // single token: prefix-only hits, materialized lazily (see below)
  if (tokens.length === 1) {
    for (const id of exact[0]) cand.set(id, true);
    prefixOnly = [plo, phi, exactIdx[0]];
  } else {
    const nonLast = exact.slice(0, last).map((a, k) => ({ a, k })).sort((x, y) => x.a.length - y.a.length);
    if (!nonLast[0].a.length) return out;
    const others = nonLast.slice(1).map((x) => new Set(x.a));
    let base = Array.from(nonLast[0].a).filter((id) => others.every((s) => s.has(id)));
    const lastExact = new Set(exact[last]);
    let prefixSet = null;
    for (const id of base) {
      if (lastExact.has(id)) { cand.set(id, true); continue; }
      if (!prefixSet) {
        prefixSet = new Set();
        for (let i = plo; i < phi; i++) if (i !== exactIdx[last]) for (const x of es.idsOf(i)) prefixSet.add(x);
      }
      if (prefixSet.has(id)) cand.set(id, false);
    }
  }
  for (const [packed, lastEx] of cand) {
    if (exactOnly && !lastEx) continue;
    const id = Math.floor(packed / 16), sense = packed % 16;
    let tier, cls;
    if (lastEx) {
      cls = glossClass(store.getRecord(pack, id), sense, qn);
      tier = cls === CLS_C ? 2 : 0;
    } else { cls = CLS_C; tier = 2; }
    if (tierOverride !== undefined) tier = tierOverride;
    const h = { pack, id, tier, cls, sense, cost: 0, space: 'e', tokens, keyLen: 0 };
    const old = out.get(id);
    if (!old || better(h, old)) out.set(id, h);
  }
  if (prefixOnly && !exactOnly) addPrefixOnly(store, ctx, pack, es, prefixOnly, tokens, tierOverride, out);
  return out;
}

/**
 * Single-token prefix-only English hits (tier 2, class C). A 1-2 letter prefix can match 100k+ senses, so only the
 * records that can appear in the shown list are turned into hit objects: the best `need` by (sense, rank, id), plus
 * every record tied with the last one on (sense, rank) so the recent tie-break still works. The rest are counted
 * in out.hidden (added to the group total).
 */
function addPrefixOnly(store, ctx, pack, es, [plo, phi, exactI], tokens, tierOverride, out) {
  let n = 0;
  for (let i = plo; i < phi; i++) if (i !== exactI) n += es.ptr[i + 1] - es.ptr[i];
  if (!n) return;
  const meta = store.packs[pack].meta, mo = ctx.ranking === 'news' ? 1 : 0;
  const scores = new Float64Array(n);
  let k = 0;
  for (let i = plo; i < phi; i++) {
    if (i === exactI) continue;
    const ids = es.idsOf(i);
    for (let j = 0; j < ids.length; j++) {
      const packed = ids[j], id = Math.floor(packed / 16), sense = packed % 16;
      if (out.has(id)) continue;
      scores[k++] = (sense * 1048576 + (meta[id * 2 + mo] & 0xfffff)) * 1048576 + id;
    }
  }
  const sorted = scores.subarray(0, k).sort();
  const need = ctx.need;
  const seen = new Set();
  let lastKey = -1, hidden = 0;
  for (let x = 0; x < sorted.length; x++) {
    const sc = sorted[x], id = sc % 1048576;
    if (seen.has(id)) continue;
    seen.add(id);
    const key = Math.floor(sc / 1048576); // sense and rank
    if (seen.size > need && key !== lastKey) { hidden++; continue; }
    if (hidden) { hidden++; continue; }
    lastKey = key;
    const sense = Math.floor(key / 1048576);
    out.set(id, { pack, id, tier: tierOverride !== undefined ? tierOverride : 2, cls: CLS_C, sense, cost: 0, space: 'e', tokens, keyLen: 0 });
  }
  out.hidden = (out.hidden || 0) + hidden;
}

function normQuery(q) {
  return q.toLowerCase().replace(/\s+/g, ' ').trim().replace(/^to /, '');
}

/** Fuzzy English corrections (phase full). Returns { queries: [[tokens], ...], dym } or null. */
function englishFuzzy(store, ctx, tokens) {
  const es = store.keySpace('words', 'e');
  if (!es) return null;
  const fixes = []; // per token: list of keys (best first) or null
  let any = false;
  for (const t of tokens) {
    if (es.find(t) >= 0 || t.length < 4) { fixes.push(null); continue; }
    const B = budget(t.length);
    const P = prepareQuery(t, { keyboard: true, soft: false, first: false, romaji: false });
    const qm = letterMask(t);
    const masks = es.masks();
    const found = [];
    for (let i = 0; i < es.count; i++) {
      const s = es.off[i], e = es.off[i + 1] - 1, kl = e - s;
      if (kl < t.length - 2 || kl > t.length + 2) continue;
      if (popcount(qm ^ masks[i]) > 4) continue;
      const d = distance(P, es.str, s, e, B);
      if (d === INF) continue;
      found.push({ key: es.key(i), d, n: es.ptr[i + 1] - es.ptr[i] });
    }
    found.sort((a, b) => a.d - b.d || b.n - a.n);
    const best = found.slice(0, 3);
    if (best.length) any = true;
    fixes.push(best.length ? best : null);
  }
  if (!any) return null;
  const queries = [];
  for (let r = 0; r < 3; r++) {
    let used = false;
    const q = tokens.map((t, k) => {
      const f = fixes[k];
      if (!f) return t;
      if (f[r]) used = true;
      return (f[r] || f[0]).key;
    });
    if (used) queries.push(q);
  }
  const k0 = fixes.findIndex(Boolean);
  const dym = {
    side: 'en',
    typed: ctx.typed,
    key: queries[0].join(' '),
    query: queries[0].join(' '),
    reason: reasonFor(tokens[k0], fixes[k0][0].key, { keyboard: true, soft: false, first: false, romaji: false }),
  };
  return { queries, dym };
}

function englishSide(store, ctx, query, packs) {
  const tokens = tokenize(query);
  const qn = normQuery(query);
  const res = {};
  for (const pack of packs) res[pack] = englishMatch(store, ctx, pack, tokens, qn);
  // study 2.12: plural / -ing / -ed stems, class + 1, exact matches of the stem only
  tokens.forEach((t, k) => {
    for (const stem of englishStems(t)) {
      const q = tokens.slice(); q[k] = stem;
      const qn2 = normQuery(q.join(' '));
      for (const pack of packs) {
        const es = store.keySpace(pack, 'e');
        if (!es || es.find(stem) < 0) continue;
        for (const h of englishMatch(store, ctx, pack, q, qn2, undefined, true).values()) {
          h.cls = Math.min(CLS_C, h.cls + 1);
          h.tier = h.cls === CLS_C ? 2 : 0;
          h.label = LABELS.stem;
          const old = res[pack].get(h.id);
          if (!old || better(h, old)) res[pack].set(h.id, h);
        }
      }
    }
  });
  let dym = null;
  let fz0 = null;
  if (ctx.phase === 'full' && tokens.length) {
    const fz = englishFuzzy(store, ctx, tokens);
    fz0 = fz;
    if (fz) {
      dym = fz.dym;
      for (const q of fz.queries) {
        const qn2 = normQuery(q.join(' '));
        for (const pack of packs) {
          for (const h of englishMatch(store, ctx, pack, q, qn2, 3).values()) {
            h.label = fz.dym.reason;
            const old = res[pack].get(h.id);
            if (!old || better(h, old)) res[pack].set(h.id, h);
          }
        }
      }
    }
  }
  return { res, dym, corrections: fz0 ? fz0.queries : [] };
}

// ---------- highlight info (SPEC 5 "Match highlight") ----------

function highlight(store, h, ctx) {
  const rec = store.getRecord(h.pack, h.id);
  if (h.space === 'e') return { space: 'e', tokens: h.tokens };
  if (h.space === 'k') return { space: 'k', form: h.key, len: -1 };
  // space r: find the kana form that produced the key
  for (const f of rec.r || []) {
    const rom = kanaToRomaji(f);
    if (h.tier === 2) {
      if (!rom.startsWith(ctx.canon)) continue;
      const chars = Array.from(f);
      for (let i = 1; i <= chars.length; i++) {
        // smallest kana prefix whose romaji covers the typed romaji (じしょけい for jisho -> じしょ)
        if (kanaToRomaji(chars.slice(0, i).join('')).startsWith(ctx.canon)) return { space: 'r', form: f, len: i };
      }
      return { space: 'r', form: f, len: -1 };
    }
    if (rom === h.key) return { space: 'r', form: f, len: -1 };
  }
  return { space: 'r', form: (rec.r || [])[0] || '', len: -1 };
}

// ---------- main entry ----------

export function createEngine(store) {
  return { search: (query, opts) => search(store, query, opts) };
}

export function search(store, query, opts = {}) {
  const typed = String(query || '').normalize('NFKC').trim();
  const out = { groups: [], didYouMean: null, kind: null, canon: '' };
  if (!typed) return out;
  const recentList = (opts.recent || []).map((s) => String(s).normalize('NFKC'));
  const ctx = {
    typed,
    ranking: opts.ranking === 'news' ? 'news' : 'fiction',
    phase: opts.phase === 'full' ? 'full' : 'fast',
    limit: opts.limit || 50,
    groupLimits: opts.groupLimits || {},
    recent: new Set(recentList),
    recentCanon: new Set(recentList.map((s) => canon(s)).filter(Boolean)),
    recentAny: recentList.length > 0,
    canon: '',
  };
  ctx.need = Math.max(ctx.limit, ...Object.values(ctx.groupLimits).map(Number).filter(Boolean));
  const kind = queryKind(typed);
  ctx.kind = kind;
  out.kind = kind;
  const has = (p) => store.has(p);
  const jaPacks = ['words', 'wikt'].filter(has);
  const hits = { words: new Map(), wikt: new Map(), names: new Map() };
  let jaDym = null;
  let en = null;

  if (kind === 'kanji') {
    for (const p of jaPacks) writtenT02(store, ctx, p, typed, hits[p], false);
    deinflectHits(store, ctx, typed, hits.words);
    if (has('names')) writtenT02(store, ctx, 'names', typed, hits.names, false);
    if (ctx.phase === 'full') {
      for (const p of jaPacks) writtenContains(store, ctx, p, typed, hits[p]);
      if (has('names') && hits.words.size + hits.wikt.size < 5) writtenContains(store, ctx, 'names', typed, hits.names);
    }
  } else {
    const c = canon(typed);
    ctx.canon = c;
    out.canon = c;
    const isKana = kind === 'kana';
    const kanaTyped = isKana ? typed : null;
    const counts = {};
    for (const p of [...jaPacks, ...(has('names') ? ['names'] : [])]) {
      counts[p] = readingT012(store, ctx, p, c, kanaTyped, hits[p]);
      if (isKana) writtenT02(store, ctx, p, typed, hits[p], true);
    }
    // study 2.3 / 2.4: spelling variants (ei / ee / e, particle は typed as wa), phase "fast"
    for (const p of jaPacks) spellingVariants(store, ctx, p, c, hits[p]);
    // study 2.6: l typed for r
    if (kind === 'latin' && /l(?=y?[aiueo])/.test(typed.toLowerCase())) {
      for (const p of jaPacks) for (const h of hits[p].values()) if (h.space === 'r' && h.tier <= 1 && !h.label) h.label = LABELS.l;
    }
    // deinflection: kana queries, and Latin queries that convert cleanly to kana
    if (isKana) deinflectHits(store, ctx, toHiragana(typed), hits.words, typed);
    else {
      const rk = romajiToKana(typed.toLowerCase().replace(/\s+/g, ''));
      if (rk.clean) deinflectHits(store, ctx, rk.kana, hits.words);
    }
    if (ctx.phase === 'full') {
      const len = c.length;
      const t3keys = [];
      // SPEC 4.4 tier-3 condition, counted over the Japanese side together (words + wikt; + names for names)
      const wantT3 = (packs) => {
        let t01 = 0, t012 = 0;
        for (const p of packs) { t01 += countTier(hits[p], 1); t012 += countTier(hits[p], 2); }
        return t01 === 0 || (len >= 5 && t012 < 5);
      };
      // study 1.2 gate: near matches unless a COMMON tier-0 word (not deinflected) was typed, or the old 2nd condition
      const gateOpen = (packs) => {
        let commonT0 = false, t012 = 0;
        for (const p of packs) {
          t012 += countTier(hits[p], 2);
          for (const h of hits[p].values()) if (h.tier === 0 && !h.via && store.isCommon(h.pack, h.id)) { commonT0 = true; }
        }
        return !commonT0 || (len >= 5 && t012 < 5);
      };
      // Ruling 2026-11-13 (tensia -> tensai): Latin queries are also compared as the raw typed letters, because
      // canon() turns "tensia" into "tenshia" and hides the swapped letters. The lower cost wins.
      const forms = [c];
      if (kind === 'latin') {
        const raw = latinRewrite(typed.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, ''));
        if (raw && raw !== c) forms.push(raw);
      }
      const open = gateOpen(jaPacks);
      ctx.nearRan = open;
      if (open) for (const p of jaPacks) for (const f of forms) t3keys.push(...readingT3(store, ctx, p, f, isKana, hits[p]));
      // study 2.9: one-kana variants (KANA queries of 2 to 12 kana; LATIN: voiced / unvoiced, canon length >= 5)
      if (open) {
        let variants = [];
        if (isKana) variants = kanaVariants(toHiragana(typed));
        else if (len >= 5) {
          const rk = romajiToKana(typed.toLowerCase().replace(/\s+/g, ''));
          if (rk.clean) variants = latinVoicedVariants(rk.kana);
        }
        if (variants.length) for (const p of jaPacks) kanaVariantHits(store, p, variants, hits[p]);
      }
      for (const p of jaPacks) promote(store, ctx, hits[p]);
      let namesKeys = [];
      if (has('names') && hits.words.size + hits.wikt.size < 5 && wantT3([...jaPacks, 'names'])) {
        for (const f of forms) namesKeys.push(...readingT3(store, ctx, 'names', f, isKana, hits.names));
      }
      // did-you-mean (study 1.4): the tier-3 hit with the best S, when tiers 0 + 1 are empty
      const t01ja = countTier(hits.words, 1) + countTier(hits.wikt, 1);
      if (t01ja === 0) {
        let best = null;
        const consider = (packs) => {
          for (const p of packs) for (const h of hits[p].values()) {
            if (h.tier !== 3 || h.space !== 'r') continue;
            const c10 = hitCost10(h), rank = store.rank(h.pack, h.id, ctx.ranking), S = c10 + pRank(rank);
            if (!best || S < best.S || (S === best.S && (c10 < best.c10 || (c10 === best.c10 && rank < best.rank)))) best = { h, S, c10, rank };
          }
        };
        consider(jaPacks);
        if (!best) consider(['names']);
        if (best) jaDym = { side: 'ja', typed, key: best.h.key, query: best.h.key, reason: labelOf(best.h, isKana) };
      }
    }
    if (kind === 'latin') en = englishSide(store, ctx, typed, jaPacks);
  }

  // ---- groups ----
  const cmp = makeComparator(store, ctx);
  const readingCmp = kind === 'kanji' ? cmp : makeReadingComparator(store, ctx);
  const mk = (id, map, extraMaps = []) => {
    const all = new Map(map);
    for (const m of extraMaps) for (const h of m.values()) put(all, h);
    const values = Array.from(all.values());
    const list = values.sort(id === 'en' ? cmp : (readingCmp.forGroup ? readingCmp.forGroup(values) : readingCmp));
    const hidden = (map.hidden || 0) + extraMaps.reduce((a, m) => a + (m.hidden || 0), 0);
    const lim = ctx.groupLimits[id] || ctx.limit;
    const results = list.slice(0, lim);
    for (const h of results) {
      h.hl = highlight(store, h, ctx);
      if (h.via && h.via !== 'contains') {
        const rec = store.getRecord(h.pack, h.id);
        const head = (rec.k || []).includes(h.base) ? h.base : ((rec.k || [])[0] || h.base);
        h.note = `${h.typed} is the ${h.via} form of ${head}`;
      }
      // SPEC 18: every non-exact row shows its reason label
      if (!h.note && (h.tier === 1 || (h.tier === 3 && h.via !== 'contains') || h.label)) {
        const l = labelOf(h, kind === 'kana');
        if (l) h.note = l;
      }
    }
    // exact: some tier-0 / tier-1 hit in the group (a promoted near hit can sort above them)
    const exact = list.find((h) => h.tier <= 1);
    const t0 = list.find((h) => h.tier === 0);
    return { id, title: TITLES[id], note: null, results: results.map(pub), total: list.length + hidden, dym: null, best: list[0], exact, t0 };
  };
  const gWords = mk('words', hits.words);
  const gWikt = mk('wikt', hits.wikt, en && en.res.wikt ? [en.res.wikt] : []);
  const gNames = mk('names', hits.names);
  if (jaDym) { gWords.dym = jaDym; }
  const jaSide = [gWords, gWikt, gNames];
  let order = jaSide;
  if (en) {
    const gEn = mk('en', en.res.words || new Map());
    gEn.dym = en.dym;
    const enT0 = !!gEn.t0;
    const jaT0 = !!gWords.t0;
    let enFirst = false;
    if (enT0 && !jaT0) enFirst = true;
    else if (enT0 && jaT0) {
      const re = store.rank(gEn.t0.pack, gEn.t0.id, ctx.ranking);
      const rj = store.rank(gWords.t0.pack, gWords.t0.id, ctx.ranking);
      enFirst = re < rj;
    }
    // English and "Japanese words" swap per SPEC 4.3; wikt and names follow (open question Q2)
    order = enFirst ? [gEn, gWords, gWikt, gNames] : [gWords, gEn, gWikt, gNames];
  }
  // Ruling 2026-11-14 (SPEC 4.3): the wikt group goes directly above "Japanese words" when it has a tier-0 hit and
  // "Japanese words" has no tier-0 or tier-1 hit (地団駄: JMdict only holds 地団駄を踏む, the word itself is a
  // Wiktionary record). Tier 1 counts so that sensee keeps 先生 above the Wiktionary record せんせー.
  if (gWikt.t0 && !gWords.exact) {
    order = order.filter((g) => g !== gWikt);
    order.splice(order.indexOf(gWords), 0, gWikt);
  }
  out.groups = order.filter((g) => g.results.length);
  // SPEC 21.2: suggestion chips
  out.typed = typed;
  // SPEC 21.3: no chips (and no yellow bar) for KANJI queries
  out.suggestions = kind === 'kanji' ? [] : suggestionsOf(store, ctx, hits, jaPacks, en, kind);
  // SPEC 17.1: "Words in this text" first, for kana / kanji queries without a tier-0 hit (phase full only)
  if (ctx.phase === 'full' && kind !== 'latin' && !hasTier0(hits.words) && !hasTier0(hits.wikt)) {
    const n = Array.from(typed).length;
    if (n >= TEXT_MIN_CHARS) {
      const tg = textGroup(store, ctx, typed);
      if (tg) { out.groups.unshift(tg); out.suggestions = []; } // SPEC 21.3: text input gets no chips
    }
  }
  // SPEC 27.1: kanji query without an exact written-form key: same-reading kanji chips (never mixed into the results)
  if (kind === 'kanji') {
    const slips = kanjiSlipChips(store, typed, ctx.ranking);
    if (slips.length) out.suggestions = slips;
  }
  // "No exact match" line: only when no group has a tier-0 or tier-1 hit; then the first group (in display order)
  // that carries a did-you-mean (Japanese 4.4 or English 4.9). See PROGRESS-app.md open question Q3.
  const anyExact = out.groups.some((g) => (g.exact !== undefined ? !!g.exact : g.best && g.best.tier <= 1));
  out.anyExact = anyExact;
  if (!anyExact) {
    for (const g of out.groups) if (g.dym && !out.didYouMean) out.didYouMean = g.dym;
    if (!out.didYouMean && jaDym) out.didYouMean = jaDym;
  }
  for (const g of out.groups) { delete g.best; delete g.exact; delete g.t0; }
  return out;
}

// ---------- SPEC 27.1: wrong kanji with the same reading (chips only) ----------
export const KANJI_SLIP_PER_POS = 30;
export const KANJI_SLIP_MAX = 3;
export const KANJI_SLIP_LABEL = 'Same reading, other kanji';
const slipIndex = new WeakMap();
function kanjiReadingIndex(store) {
  const data = store.kanjiData;
  if (!data) return null;
  let ix = slipIndex.get(data);
  if (ix) return ix;
  const byReading = new Map(), readsOf = new Map();
  const norm = (s) => toHiragana(String(s).replace(/[.\-]/g, '')); // か.く -> かく, -がた -> がた, ショ -> しょ
  for (const [lit, k] of Object.entries(data)) {
    const rs = new Set([...(k.on || []), ...(k.kun || [])].map(norm).filter(Boolean));
    readsOf.set(lit, rs);
    for (const r of rs) { let a = byReading.get(r); if (!a) byReading.set(r, (a = [])); a.push(lit); }
  }
  ix = { byReading, readsOf, freq: (c) => (data[c] && data[c].f) || 999999 };
  slipIndex.set(data, ix);
  return ix;
}

/** Kanji sharing an on or kun reading with `ch` (KANJIDIC), most frequent first, at most 30. */
export function sameReadingKanji(store, ch, max = KANJI_SLIP_PER_POS) {
  const ix = kanjiReadingIndex(store);
  if (!ix || !ix.readsOf.has(ch)) return [];
  const set = new Set();
  for (const r of ix.readsOf.get(ch)) for (const c of ix.byReading.get(r)) if (c !== ch) set.add(c);
  return Array.from(set).sort((a, b) => ix.freq(a) - ix.freq(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, max);
}

/**
 * SPEC 27.1: a query with kanji and no exact key in space k: swap ONE kanji at a time for a kanji with the same
 * reading; keep forms that are shown spellings of words records; best rank first; at most 3 chips.
 */
export function kanjiSlipChips(store, query, ranking = 'fiction') {
  const ks = store.keySpace('words', 'k');
  const q = String(query || '').trim().normalize('NFKC');
  if (!ks || !q || !KANJI_RE.test(q) || ks.find(q) >= 0) return [];
  const chars = Array.from(q);
  const found = new Map(); // form -> { id, rank }
  chars.forEach((ch, i) => {
    if (!KANJI_RE.test(ch)) return;
    for (const c of sameReadingKanji(store, ch)) {
      const form = chars.slice(0, i).join('') + c + chars.slice(i + 1).join('');
      const ki = ks.find(form);
      if (ki < 0) continue;
      for (const id of ks.idsOf(ki)) {
        const rec = store.getRecord('words', id);
        if (!(rec.k || []).some((f) => f.normalize('NFKC') === form)) continue; // shown spellings only (SPEC 24)
        const rank = store.rank('words', id, ranking);
        const old = found.get(form);
        if (!old || rank < old.rank || (rank === old.rank && id < old.id)) found.set(form, { id, rank });
      }
    }
  });
  return Array.from(found).sort((a, b) => a[1].rank - b[1].rank || a[1].id - b[1].id).slice(0, KANJI_SLIP_MAX)
    .map(([form, x]) => ({ side: 'ja', key: form, chip: form, head: form, pack: 'words', id: x.id, label: KANJI_SLIP_LABEL, S: null }));
}

export const SUGGEST_JA_MAX = 5;
export const SUGGEST_EN_MAX = 3;

/**
 * Suggestions (SPEC 21.2): keys that are not what was typed. Japanese side: tier-1, spelling-variant and near keys
 * (words + wikt), each with its best record (lowest S), ordered by S, cost, rank, at most 5; then English corrections,
 * at most 3. Only when the near search ran or a tier-1 / variant key exists.
 * Each: { side, key, chip (text in the typed script), head, pack, id, label, S }.
 */
function suggestionsOf(store, ctx, hits, jaPacks, en, kind) {
  const byKey = new Map();
  let tier1 = false;
  for (const p of jaPacks) {
    for (const h of hits[p].values()) {
      if (h.space !== 'r' || !h.key || h.key === ctx.canon) continue;
      if (!(h.tier === 1 || (h.tier === 3 && h.via !== 'contains'))) continue;
      if (h.tier === 1) tier1 = true;
      const c10 = hitCost10(h), rank = store.rank(h.pack, h.id, ctx.ranking), S = c10 + pRank(rank);
      const old = byKey.get(h.key);
      if (!old || S < old.S || (S === old.S && (c10 < old.c10 || (c10 === old.c10 && rank < old.rank)))) {
        byKey.set(h.key, { h, S, c10, rank });
      }
    }
  }
  if (!ctx.nearRan && !tier1) return [];
  const ja = Array.from(byKey.values())
    .sort((x, y) => x.S - y.S || x.c10 - y.c10 || x.rank - y.rank || (x.h.key < y.h.key ? -1 : 1))
    .slice(0, SUGGEST_JA_MAX)
    .map(({ h, S }) => {
      const rec = store.getRecord(h.pack, h.id);
      let chip = h.key;
      if (kind === 'kana') chip = (rec.r || []).find((f) => kanaToRomaji(f) === h.key) || (rec.r || [])[0] || h.key;
      return { side: 'ja', key: h.key, chip, head: shownHead(rec), pack: h.pack, id: h.id, label: labelOf(h, kind === 'kana'), S };
    });
  const out = ja;
  // Ruling 2026-11-13: English corrections are chips only when the Japanese side has no good guess (no exact
  // Japanese hit and no Japanese suggestion with S <= 9); otherwise `kaisa` offered `laksa` and `naiso` offered `daiso`.
  const jaGood = jaPacks.some((p) => hasTier0(hits[p])) || (ja.length > 0 && ja[0].S <= 9);
  if (!jaGood && en && en.corrections && en.corrections.length) {
    const enHits = Array.from((en.res.words || new Map()).values()).filter((h) => h.tier === 3 && h.tokens);
    for (const q of en.corrections.slice(0, SUGGEST_EN_MAX)) {
      const text = q.join(' ');
      const mine = enHits.filter((h) => h.tokens.join(' ') === text)
        .sort((x, y) => (x.cls - y.cls) || (x.sense - y.sense) || store.rank(x.pack, x.id, ctx.ranking) - store.rank(y.pack, y.id, ctx.ranking));
      const best = mine[0];
      if (!best) continue; // a correction that finds no entry is not offered
      out.push({
        side: 'en', key: text, chip: text, head: best ? shownHead(store.getRecord(best.pack, best.id)) : '',
        pack: best ? best.pack : null, id: best ? best.id : null, label: en.dym ? en.dym.reason : '', S: null,
      });
    }
  }
  // the same spelling twice (a Japanese key and an English correction) would search the same thing: keep the first
  const seen = new Set();
  return out.filter((x) => (seen.has(x.chip) ? false : (seen.add(x.chip), true)));
}

/** Reason label of a hit (SPEC 18: every non-exact row). */
function labelOf(h, isKana) {
  if (h.label) return h.label;
  if (h.tier === 1) return LABELS.fold;
  if (h.tier === 3 && h.lq && h.key) return reasonFor(h.lq, h.key, { keyboard: h.kbd !== undefined ? h.kbd : !isKana, soft: true, first: true });
  return null;
}

function hasTier0(map) {
  for (const h of map.values()) if (h.tier === 0) return true;
  return false;
}

export const TEXT_SEGMENTS_MAX = 60;
export const TEXT_NOTE = 'Split automatically by the most common words; it can be wrong.';
export const TEXT_CUT_NOTE = 'Only the first 500 characters are analysed.';
export const TEXT_MORE_NOTE = 'Showing the first 60 words.';

/**
 * The "Words in this text" group (SPEC 17): segments in text order, one result per distinct record (at most 60
 * word segments), function words as compact rows. group.segments = line 1 (chips, unknown runs, separators).
 */
function textGroup(store, ctx, typed) {
  const { segments, truncated } = segmentText(store, typed, { ranking: ctx.ranking });
  const words = segments.filter((x) => x.kind === 'word');
  if (!words.length) return null;
  const results = [];
  const itemOf = new Map(); // pack:id -> result index
  const line = [];
  let shown = 0;
  for (const seg of segments) {
    if (seg.kind !== 'word') { line.push({ kind: seg.kind, text: seg.text }); continue; }
    if (shown >= TEXT_SEGMENTS_MAX) { line.push({ kind: 'more', text: seg.text }); continue; }
    shown++;
    const key = `${seg.pack}:${seg.id}`;
    if (!itemOf.has(key)) {
      itemOf.set(key, results.length);
      const rec = store.getRecord(seg.pack, seg.id);
      const fn = isFunctionWord(store, seg);
      const r = {
        pack: seg.pack, id: seg.id, tier: 0, cost: 0, via: seg.via || null, space: 'k', key: seg.text,
        hl: { space: 'k', form: seg.text, len: -1 }, segment: seg.text, others: seg.others, fn,
      };
      if (seg.via) {
        r.base = seg.base;
        const head = (rec.k || []).includes(seg.base) ? seg.base : ((rec.k || [])[0] || seg.base);
        r.note = `${seg.text} is the ${seg.via} form of ${head}`;
      }
      results.push(r);
    }
    line.push({ kind: 'word', text: seg.text, item: itemOf.get(key) });
  }
  const notes = [TEXT_NOTE];
  if (truncated) notes.push(TEXT_CUT_NOTE);
  if (words.length > TEXT_SEGMENTS_MAX) notes.push(TEXT_MORE_NOTE);
  return { id: 'text', title: TITLES.text, note: notes.join(' '), notes, results, total: results.length, dym: null,
    best: results[0], segments: line, wordCount: words.length };
}

function countTier(map, maxTier) {
  let n = 0;
  for (const h of map.values()) if (h.tier <= maxTier) n++;
  return n;
}

function pub(h) {
  const o = { pack: h.pack, id: h.id, tier: h.tier, cost: h.cost, via: h.via || null, space: h.space, key: h.key || null, hl: h.hl };
  if (h.note) o.note = h.note;
  if (h.sense !== undefined) o.sense = h.sense;
  if (h.base) o.base = h.base;
  if (h.promoted) o.promoted = true;
  return o;
}

/** Text of the did-you-mean line (SPEC 4.4). */
export function didYouMeanText(d) {
  return `No exact match for "${d.typed}". Nearest: ${d.key} (${d.reason})`;
}

/**
 * Records of `pack` whose written form (space k) starts with `prefix`, excluding the exact key (SPEC 10.2 section 5):
 * the tier-2 prefix rule (max 200 candidates in rank order), ordered like tier 2 (common first, rank, shorter key).
 * Returns [{ id, key }].
 */
export function prefixRecords(store, pack, prefix, { ranking = 'fiction', max = 20, exclude = -1 } = {}) {
  const ks = store.keySpace(pack, 'k');
  if (!ks || !prefix) return [];
  const ctx = { ranking: ranking === 'news' ? 'news' : 'fiction', kind: 'kanji', recentAny: false };
  const hits = new Map();
  if (exclude >= 0) hits.set(exclude, { tier: -1 }); // keeps the record itself out of the candidates
  prefixTier2(store, ctx, pack, ks, prefix, ks.find(prefix), hits, 'k');
  hits.delete(exclude);
  return Array.from(hits.values()).sort(makeComparator(store, ctx)).slice(0, max).map((h) => ({ id: h.id, key: h.key }));
}
