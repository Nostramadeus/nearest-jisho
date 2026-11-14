// Entry page data (SPEC 10.2). Pure: no DOM, no fetch. Works on a PackStore.
import { kanaToRomaji, toHiragana } from './romaji.js';
import { prefixRecords, shownHead } from './engine.js';

const KANJI_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u{20000}-\u{3134f}]/u;
export const hasKanji = (s) => KANJI_RE.test(s || '');

export { usuallyKana, shownHead } from './engine.js'; // SPEC 19.2 headword rule (defined in engine.js)

/** Address parts of a record: w = first written form or first kana form, r = first kana form. */
export function entryAddress(pack, rec) {
  const w = (rec.k && rec.k[0]) || (rec.r && rec.r[0]) || '';
  const r = (rec.r && rec.r[0]) || '';
  return { w, r, p: pack };
}

/** Hash for an entry address: #w=..&r=..&p=.. */
export function entryHash({ w, r, p }) {
  return `#w=${encodeURIComponent(w)}&r=${encodeURIComponent(r)}&p=${encodeURIComponent(p)}`;
}

/** Parse "#w=..&r=..&p=.." (or without #). Returns null when it is not an entry address. */
export function parseEntryHash(hash) {
  const s = String(hash || '').replace(/^#/, '');
  if (!/^w=/.test(s)) return null;
  const out = {};
  for (const part of s.split('&')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    let v = part.slice(i + 1);
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    out[part.slice(0, i)] = v;
  }
  if (!out.w || !out.p) return null;
  return { w: out.w, r: out.r || '', p: out.p };
}

/**
 * Resolve an address to a record id (SPEC 10.2): exact lookup of w in space k of the pack (space r via canonical
 * romaji when w has no kanji), then the record whose kana forms include r; several -> lowest id. -1 if none.
 */
export function findEntry(store, pack, w, r) {
  if (!store.has(pack) || !w) return -1;
  const ids = new Set();
  const k = store.keySpace(pack, 'k');
  const nw = w.normalize('NFKC');
  if (k) { const i = k.find(nw); if (i >= 0) for (const id of k.idsOf(i)) ids.add(id); }
  if (!hasKanji(w)) {
    const rs = store.keySpace(pack, 'r');
    const key = kanaToRomaji(w);
    if (rs && key) { const i = rs.find(key); if (i >= 0) for (const id of rs.idsOf(i)) ids.add(id); }
  }
  let best = -1;
  for (const id of ids) {
    const rec = store.getRecord(pack, id);
    const forms = [...(rec.k || []), ...(rec.r || [])].map((f) => f.normalize('NFKC'));
    if (!forms.includes(nw)) continue;
    if (r && !(rec.r || []).includes(r)) continue;
    if (best < 0 || id < best) best = id;
  }
  return best;
}

/** Distinct kanji of a headword, in order, with their KANJIDIC data (null when missing). */
export function kanjiBlocks(store, headword) {
  const seen = new Set();
  const out = [];
  for (const ch of Array.from(headword || '')) {
    if (!hasKanji(ch) || seen.has(ch)) continue;
    seen.add(ch);
    out.push({ literal: ch, data: store.kanji(ch) });
  }
  return out;
}

export const SENTENCE_MAX = 25;

/**
 * Sentence-pack keys for a words or wikt record (SPEC 13.4), in lookup order: for every kanji form k, the keys
 * k<TAB>r for every kana form r (reading in hiragana, as in the index), then k; then, when the record has no kanji
 * form or a sense marked "uk", the keys r for every kana form. Duplicates removed.
 */
export function sentenceKeys(pack, rec) {
  if (pack === 'names') return [];
  const kf = [...(rec.k || []), ...(rec.h || [])], rf = (rec.r || []); // rec.h: search-only forms (SPEC 24)
  const keys = [];
  for (const k of kf) {
    for (const r of rf) keys.push(`${k}\t${toHiragana(r)}`);
    keys.push(k);
  }
  const uk = (rec.s || []).some((s) => (s.m || []).includes('uk'));
  if (!kf.some(hasKanji) || uk) for (const r of rf) keys.push(r);
  return Array.from(new Set(keys));
}

/**
 * Up to 25 sentences for a record: union over sentenceKeys() in order, one entry per sentence, minus sentences
 * whose Japanese text equals an example already shown under a meaning. Returns [{ ja, en, id (Tatoeba), form }].
 */
export function sentencesFor(store, pack, rec, max = SENTENCE_MAX) {
  if (pack === 'names' || !store.has('sent')) return [];
  const shown = new Set();
  for (const s of rec.s || []) for (const x of s.x || []) shown.add(x[0]);
  const seen = new Set();
  const out = [];
  for (const key of sentenceKeys(pack, rec)) {
    for (const { id, form } of store.sentencesOf(key)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const [ja, en, tid] = store.sentence(id);
      if (shown.has(ja)) continue;
      out.push({ ja, en, id: tid, form });
      if (out.length >= max) return out;
    }
  }
  return out;
}

export const SUFFIX_SCAN_MAX = 2000;

/**
 * Records whose written form (space k) ends with `suffix` and is longer than it (SPEC 17.5): substring scan over the
 * key string, keeping hits at a key end, at most 2,000 scanned hits; ordered by rank, shorter key, record id.
 */
export function suffixRecords(store, pack, suffix, { ranking = 'fiction', max = 20, skip = new Set() } = {}) {
  const ks = store.keySpace(pack, 'k');
  if (!ks || !suffix) return [];
  const str = ks.str, n = suffix.length;
  const best = new Map(); // id -> key length
  let scanned = 0;
  for (let pos = str.indexOf(suffix); pos !== -1 && scanned < SUFFIX_SCAN_MAX; pos = str.indexOf(suffix, pos + 1)) {
    scanned++;
    const end = pos + n;
    if (end !== str.length && str.charCodeAt(end) !== 10) continue; // not at the end of a key
    const i = ks.indexAt(pos);
    const len = ks.keyLen(i);
    if (len <= n) continue; // the headword itself
    for (const id of ks.idsOf(i)) {
      if (skip.has(id)) continue;
      if (!best.has(id) || len < best.get(id)) best.set(id, len);
    }
  }
  return Array.from(best, ([id, len]) => ({ id, len, rank: store.rank(pack, id, ranking) }))
    .sort((a, b) => a.rank - b.rank || a.len - b.len || a.id - b.id)
    .slice(0, max)
    .map((x) => x.id);
}

/**
 * Everything the entry page shows for one record.
 * opts.sentLoading: the sentence pack is still on its way -> sentences = null (page says "Loading sentences…").
 */
export function entryData(store, pack, id, { ranking = 'fiction', sentLoading = false } = {}) {
  const rec = store.getRecord(pack, id);
  // SPEC 19.2: uk words show their kana form; the written form still names the kanji blocks and the start / end lists
  const written = (rec.k && rec.k[0]) || (rec.r && rec.r[0]) || '';
  const head = shownHead(rec);
  const reading = (rec.r && rec.r[0]) || '';
  const data = {
    pack, rec, head, reading,
    romaji: reading ? kanaToRomaji(reading) : '',
    kanji: kanjiBlocks(store, written),
    written,
    startsWith: [],
    endsWith: [],
    sentences: pack === 'names' ? [] : store.has('sent') ? sentencesFor(store, pack, rec) : sentLoading ? null : [],
  };
  // section 5: words that start with the headword (words pack only; not for names or records without kanji)
  if (pack !== 'names' && rec.k && rec.k.length && store.has('words')) {
    const exclude = pack === 'words' ? id : -1;
    const row = (wid) => {
      const wr = store.getRecord('words', wid);
      const a = entryAddress('words', wr);
      const first = wr.s && wr.s[0] && wr.s[0].g ? wr.s[0].g[0] : '';
      const shown = shownHead(wr);
      return { ...a, head: shown, reading: shown !== a.r ? a.r : '', gloss: first };
    };
    const starts = prefixRecords(store, 'words', written, { ranking, max: 20, exclude });
    data.startsWith = starts.map(({ id: wid }) => row(wid));
    // section 17.5: words that END with the headword (the record itself and the start-with rows excluded)
    const skip = new Set(starts.map((x) => x.id));
    if (exclude >= 0) skip.add(exclude);
    data.endsWith = suffixRecords(store, 'words', written, { ranking, max: 20, skip }).map(row);
  }
  return data;
}
