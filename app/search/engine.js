// Search engine (SPEC 4). Pure module: no DOM, no fetch. Works on a PackStore (packs.js).

import { canon, hasKana, romajiToKana, kanaToRomaji, toHiragana } from './romaji.js';
import { fold } from './fold.js';
import { prepareQuery, distance, budget, reasonFor, letterMask, popcount, INF } from './cost.js';
import { deinflect, posBits } from './deinflect.js';

export const TITLES = {
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
      put(hits, { pack, id, tier: 1, cost: 0.2, space: 'r', key, keyLen: key.length, note: FOLD_NOTE });
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
      put(hits, { pack, id, tier: 3, cost: d / 10, space: 'r', key, keyLen: key.length });
      added = true;
    }
    if (added) keys.push({ key, cost: d, pack, ids: ks.idsOf(i), q: c });
  }
  return keys;
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

/** English match for a token list. Returns Map id -> hit. tierOverride = 3 for fuzzy re-search. */
function englishMatch(store, ctx, pack, tokens, qn, tierOverride) {
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
  if (prefixOnly) addPrefixOnly(store, ctx, pack, es, prefixOnly, tokens, tierOverride, out);
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
    const P = prepareQuery(t, { keyboard: true, soft: false, first: false });
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
    reason: reasonFor(tokens[k0], fixes[k0][0].key, { keyboard: true, soft: false, first: false }),
  };
  return { queries, dym };
}

function englishSide(store, ctx, query, packs) {
  const tokens = tokenize(query);
  const qn = normQuery(query);
  const res = {};
  for (const pack of packs) res[pack] = englishMatch(store, ctx, pack, tokens, qn);
  let dym = null;
  if (ctx.phase === 'full' && tokens.length) {
    const fz = englishFuzzy(store, ctx, tokens);
    if (fz) {
      dym = fz.dym;
      for (const q of fz.queries) {
        const qn2 = normQuery(q.join(' '));
        for (const pack of packs) {
          for (const h of englishMatch(store, ctx, pack, q, qn2, 3).values()) {
            const old = res[pack].get(h.id);
            if (!old || better(h, old)) res[pack].set(h.id, h);
          }
        }
      }
    }
  }
  return { res, dym };
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
      // Ruling 2026-11-13 (tensia -> tensai): Latin queries are also compared as the raw typed letters, because
      // canon() turns "tensia" into "tenshia" and hides the swapped letters. The lower cost wins.
      const forms = [c];
      if (kind === 'latin') {
        const raw = typed.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, '');
        if (raw && raw !== c) forms.push(raw);
      }
      if (wantT3(jaPacks)) for (const p of jaPacks) for (const f of forms) t3keys.push(...readingT3(store, ctx, p, f, isKana, hits[p]));
      let namesKeys = [];
      if (has('names') && hits.words.size + hits.wikt.size < 5 && wantT3([...jaPacks, 'names'])) {
        for (const f of forms) namesKeys.push(...readingT3(store, ctx, 'names', f, isKana, hits.names));
      }
      const t01ja = countTier(hits.words, 1) + countTier(hits.wikt, 1);
      const pool = t3keys.length ? t3keys : namesKeys;
      if (t01ja === 0 && pool.length) {
        let best = null, bestRank = 0;
        for (const k of pool) {
          let r = Infinity;
          for (const id of k.ids) r = Math.min(r, store.rank(k.pack, id, ctx.ranking));
          if (!best || k.cost < best.cost || (k.cost === best.cost && r < bestRank)) { best = k; bestRank = r; }
        }
        jaDym = {
          side: 'ja', typed, key: best.key, query: best.key,
          reason: reasonFor(best.q, best.key, { keyboard: !isKana, soft: true, first: true }),
        };
      }
    }
    if (kind === 'latin') en = englishSide(store, ctx, typed, jaPacks);
  }

  // ---- groups ----
  const cmp = makeComparator(store, ctx);
  const mk = (id, map, extraMaps = []) => {
    const all = new Map(map);
    for (const m of extraMaps) for (const h of m.values()) put(all, h);
    const list = Array.from(all.values()).sort(cmp);
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
    }
    return { id, title: TITLES[id], note: null, results: results.map(pub), total: list.length + hidden, dym: null, best: list[0] };
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
    const enT0 = gEn.best && gEn.best.tier === 0;
    const jaT0 = gWords.best && gWords.best.tier === 0;
    let enFirst = false;
    if (enT0 && !jaT0) enFirst = true;
    else if (enT0 && jaT0) {
      const re = store.rank(gEn.best.pack, gEn.best.id, ctx.ranking);
      const rj = store.rank(gWords.best.pack, gWords.best.id, ctx.ranking);
      enFirst = re < rj;
    }
    // English and "Japanese words" swap per SPEC 4.3; wikt and names follow (open question Q2)
    order = enFirst ? [gEn, gWords, gWikt, gNames] : [gWords, gEn, gWikt, gNames];
  }
  out.groups = order.filter((g) => g.results.length);
  // "No exact match" line: only when no group has a tier-0 or tier-1 hit; then the first group (in display order)
  // that carries a did-you-mean (Japanese 4.4 or English 4.9). See PROGRESS-app.md open question Q3.
  const anyExact = out.groups.some((g) => g.best && g.best.tier <= 1);
  if (!anyExact) {
    for (const g of out.groups) if (g.dym && !out.didYouMean) out.didYouMean = g.dym;
    if (!out.didYouMean && jaDym) out.didYouMean = jaDym;
  }
  for (const g of out.groups) delete g.best;
  return out;
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
  return o;
}

/** Text of the did-you-mean line (SPEC 4.4). */
export function didYouMeanText(d) {
  return `No exact match for "${d.typed}". Nearest: ${d.key} (${d.reason})`;
}
