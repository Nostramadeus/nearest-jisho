// Entry page data (SPEC 10.2). Pure: no DOM, no fetch. Works on a PackStore.
import { kanaToRomaji } from './romaji.js';
import { prefixRecords } from './engine.js';

const KANJI_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u{20000}-\u{3134f}]/u;
export const hasKanji = (s) => KANJI_RE.test(s || '');

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

/** Everything the entry page shows for one record. */
export function entryData(store, pack, id, { ranking = 'fiction' } = {}) {
  const rec = store.getRecord(pack, id);
  const head = (rec.k && rec.k[0]) || (rec.r && rec.r[0]) || '';
  const reading = (rec.r && rec.r[0]) || '';
  const data = {
    pack, rec, head, reading,
    romaji: reading ? kanaToRomaji(reading) : '',
    kanji: kanjiBlocks(store, head),
    startsWith: [],
  };
  // section 5: words that start with the headword (words pack only; not for names or records without kanji)
  if (pack !== 'names' && rec.k && rec.k.length && store.has('words')) {
    const exclude = pack === 'words' ? id : -1;
    data.startsWith = prefixRecords(store, 'words', head, { ranking, max: 20, exclude }).map(({ id: wid }) => {
      const wr = store.getRecord('words', wid);
      const a = entryAddress('words', wr);
      const first = wr.s && wr.s[0] && wr.s[0].g ? wr.s[0].g[0] : '';
      return { ...a, head: a.w, reading: (wr.k && wr.k.length) ? a.r : '', gloss: first };
    });
  }
  return data;
}
