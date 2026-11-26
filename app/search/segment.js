// Words in a pasted text (SPEC 17.2 / 17.3). Pure module: runs in the worker and in node.
// Lowest-total-weight split (SPEC 19.1): common words win over rare ones; it can still be wrong (stated in the note).
import { toHiragana, isKana } from './romaji.js';
import { deinflect, posBits, isStemLabel, T } from './deinflect.js';
import { pRank } from './cost.js';
import { mixedSpans } from './mixed.js';

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

const KATA_RE = /[ァ-ヺ]/;
const HIRA_RE = /[ぁ-ゖ]/;
/**
 * SPEC 34.7: the strings deinflection is tried on. Kana: its hiragana form, and as typed when it mixes katakana and
 * hiragana (バグってる -> バグる: the pack has the katakana key only). Kanji + katakana okurigana (喰ッタ): also with
 * the katakana turned into hiragana.
 */
export function deinflectInputs(s) {
  const kana = allKana(s);
  const out = [kana ? toHiragana(s) : s];
  if (KATA_RE.test(s) && (!kana || HIRA_RE.test(s))) {
    const v = kana ? s : toHiragana(s);
    if (!out.includes(v)) { if (kana) out.unshift(v); else out.push(v); } // as typed first: ググった -> ググる
  }
  return out;
}
/** Deinflected candidates of s, for every input of deinflectInputs, each (form, type) once. */
export function deinflectAll(s) {
  const out = [], seen = new Set();
  for (const w of deinflectInputs(s)) {
    for (const c of deinflect(w)) {
      const k = c.form + '|' + c.type;
      if (!seen.has(k)) { seen.add(k); out.push(c); }
    }
  }
  return out;
}
const VERB_BITS = T.V1 | T.V5 | T.VK | T.VS | T.VZ | T.V5KS | T.V5ARU | T.V1S;
/** SPEC 34.7: Wiktionary parts of speech (English or Japanese names) -> deinflection type bits. */
export function wiktPosBits(p) {
  const t = String(p);
  if (/verb|動詞/i.test(t)) return VERB_BITS;
  if (/形容動詞|adjectival noun/i.test(t)) return T.ADJNA;
  if (/^adj|形容詞/i.test(t)) return T.ADJ;
  return 0;
}
const posOk = (pack, rec, type) => (rec.s || []).some((sense) => (sense.p || []).some((p) => (pack === 'wikt' ? wiktPosBits(p) : posBits(p)) & type));
const viaIsStem = (via) => String(via || '').split(' + ').some(isStemLabel);

/** Deinflected candidates of s in the pack: a record with that form whose part of speech fits the rule chain. */
function deinflectCands(store, pack, s, rule) {
  const out = [];
  const seen = new Set();
  for (const cand of deinflectAll(s)) {
    for (const id of exact(store, pack, cand.form)) {
      if (seen.has(id)) continue;
      if (!posOk(pack, store.getRecord(pack, id), cand.type)) continue;
      seen.add(id);
      const c = { pack, id, rule, via: cand.via.join(' + '), base: cand.form };
      if (cand.suru) c.suru = true;
      out.push(c);
    }
  }
  return out;
}

/** Rule 1-3 and 5 candidates for substring s: [{ pack, id, rule, via?, base?, ord? }] of the first rule that matches. */
function rulesOneToThree(store, s, mixed, at, ranking = 'fiction') {
  // 1. written form in words, or for kana its hiragana form as a kana form
  const c1 = new Set(exact(store, 'words', s));
  if (allKana(s)) {
    const h = toHiragana(s);
    if (h !== s) for (const id of exact(store, 'words', h)) if ((store.getRecord('words', id).r || []).includes(h)) c1.add(id);
  }
  // 2. deinflection to a verified words record
  const c2 = deinflectCands(store, 'words', s, 2);
  if (c1.size) {
    const one = Array.from(c1, (id) => ({ pack: 'words', id, rule: 1 }));
    // SPEC 34.1: a deinflected word whose frequency band P is lower than that of every true match wins the segment
    // (しろ: する before 白; いた: いる before 板; 来た: 来る before the interjection 来た). The true matches stay as
    // "other entries". A stem suffix (SPEC 32.6) never wins this way: an own entry stays first.
    const P = (c) => pRank(store.rank(c.pack, c.id, ranking));
    const best1 = Math.min(...one.map(P));
    const win = c2.filter((c) => !viaIsStem(c.via) && P(c) < best1);
    if (!win.length) return one;
    // among the winners a common word first (the common-first rule of SPEC 21.1): くれ = 呉れる (common), not 抉る (くる)
    for (const c of win) c.ord = store.isCommon(c.pack, c.id) ? 0 : 0.5;
    for (const c of one) c.ord = 1;
    const rest = c2.filter((c) => !win.includes(c));
    for (const c of rest) c.ord = 2;
    return [...win, ...one, ...rest];
  }
  if (c2.length) return c2;
  // 3. written form in the Wiktionary pack; then deinflected to a Wiktionary record (SPEC 34.7)
  const c3 = store.has('wikt') ? exact(store, 'wikt', s) : [];
  if (c3.length) return c3.map((id) => ({ pack: 'wikt', id, rule: 3 }));
  const c3d = store.has('wikt') ? deinflectCands(store, 'wikt', s, 3) : [];
  if (c3d.length) return c3d;
  // 5. a word with part typed in kana (SPEC 30), found for the whole run by mixedSpans(). base = its written form
  const hits = mixed ? mixed.get(at) : null;
  if (!hits) return [];
  const direct = hits.filter((m) => !m.via); // as typed before deinflected
  return (direct.length ? direct : hits).map((m) => ({ pack: 'words', id: m.id, rule: 5, via: m.via, base: m.key }));
}

/** One-kana rule (17.2): keep only records whose first sense is a function word; none -> no match. */
function oneKanaFilter(store, s, cands) {
  if (Array.from(s).length !== 1 || !allKana(s)) return cands;
  return cands.filter((c) => firstPos(store.getRecord(c.pack, c.id)).some((p) => ONE_KANA_POS.has(p)));
}

/** 17.3: true written-form match before a deinflected one, then rank, then record id. */
function choose(store, cands, ranking) {
  // SPEC 34.1: ord (set by rulesOneToThree when a deinflected word outranks the true matches) comes first
  const key = (c) => [c.ord || 0, c.via ? (String(c.via).split(' + ').some(isStemLabel) ? 2 : 1) : 0, // SPEC 32.6: an own entry (寒がる) before base + stem suffix (寒い)
    store.rank(c.pack, c.id, ranking), c.pack === 'words' ? 0 : c.pack === 'wikt' ? 1 : 2, c.id];
  return cands.slice().sort((a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
}

export const UNKNOWN_WEIGHT = 40;
/**
 * SPEC 34.20: extra weight of a kana-only piece that matches a words record with a written (kanji) form, whose first
 * sense is not tagged uk (usually kana), through a reading that is not the record's first reading (にい for 新 = さら /
 * あら / にい: the record's frequency belongs to its written form, not to this kana spelling).
 */
export const KANA_READING_EXTRA = 8;
function laterKanaReading(store, c, s) {
  if (c.pack !== 'words' || !allKana(s)) return false;
  const rec = store.getRecord(c.pack, c.id);
  if (!rec.k || !rec.k.length || !rec.r || !rec.r.length) return false;
  if (((rec.s && rec.s[0] && rec.s[0].m) || []).includes('uk')) return false;
  return toHiragana(rec.r[0]) !== toHiragana(s);
}
// SPEC 19.1: + 4 deinflection only, + 6 wikt only, + 8 names only; SPEC 30: + 8 part typed in kana
const EXTRA = { 1: 0, 2: 4, 3: 6, 4: 8, 5: 8 };

/**
 * Candidate records of one edge: the first matching rule 1, 2, 3, 5 (one-kana rule applied), else 4 (names, L >= 2).
 * refuse5(cands): the rule-5 candidates to drop (SPEC 32.7); when none is left, rule 4 is tried.
 */
function edgeCands(store, s, L, mixed, at, refuse5, ranking) {
  let c = oneKanaFilter(store, s, rulesOneToThree(store, s, mixed, at, ranking));
  if (c.length && c[0].rule === 5 && refuse5) c = refuse5(c);
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
/** SPEC 32.7: a rule-5 word whose kana part is ONE leading kana of these, after a kanji word, is refused (尻も掻いて). */
export const LEAD_PARTICLES = new Set(Array.from('もはがをにとでのへやか'));
/** SPEC 32.5: parts of speech of a "noun piece", and the suffix tags preferred for a one-kanji piece after it. */
export const NOUN_POS = new Set(['n', 'n-adv', 'n-t', 'n-pr', 'n-suf']);
export const SUFFIX_POS = new Set(['suf', 'n-suf']);
const hasKanji = (s) => Array.from(s).some((ch) => !isKana(ch.codePointAt(0)));

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
    // SPEC 34.15: digits directly before word characters start the run (2つ, 10分): the counter is read with them
    let digits = 0;
    if (isDigit(chars[i])) {
      let d = i;
      while (d < chars.length && isDigit(chars[d])) d++;
      if (d < chars.length && isWordChar(chars[d])) digits = d - i;
      else { push('sep', chars.slice(i, d).join('')); i = d; continue; }
    }
    if (!digits && !isWordChar(chars[i])) { push('sep', chars[i]); i++; continue; }
    let end = i + digits;
    while (end < chars.length && isWordChar(chars[end])) end++;
    const edges = runEdges(store, chars, i, end, ranking, digits);
    const path = bestPath(edges, end - i);
    suffixAfterNoun(store, path);
    if (wordCount < wordLimit) {
      // only the part of the run whose words are shown
      let room = wordLimit - wordCount, upto = 0;
      for (const e of path) { if (e.seg.kind === 'word') { if (room === 0) break; room--; } upto++; }
      for (const a of altSplits(store, edges, path.slice(0, upto), i, margin)) alts.push(a);
    }
    for (const e of path) {
      if (e.seg.kind === 'unknown' || e.seg.kind === 'sep') push(e.seg.kind, e.seg.text); else { segments.push(e.seg); wordCount++; }
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

/**
 * SPEC 30.2: is the whole text ONE word with part typed in kana (嵩にきて, こん虫)? Returns that word segment when
 * its single edge weighs at most `margin` more than the lowest-weight split of the text, else null.
 */
export function mixedWhole(store, text, { ranking = 'fiction', margin = ALT_MARGIN } = {}) {
  const chars = Array.from(String(text));
  const n = chars.length;
  if (n < 2 || n > SEGMENT_MAX_LEN || !chars.every(isWordChar)) return null;
  const edges = runEdges(store, chars, 0, n, ranking);
  const whole = edges[0].find((e) => e.L === n && e.seg.kind === 'word');
  if (!whole || whole.seg.rule !== 5) return null;
  const best = bestPath(edges, n).reduce((sum, e) => sum + e.w, 0);
  return whole.w <= best + margin ? whole.seg : null;
}

/** On readings of a kanji (KANJIDIC) in hiragana; empty without kanji data. */
function onReadings(store, ch) {
  const d = store.kanji ? store.kanji(ch) : null;
  return new Set(((d && d.on) || []).map((r) => toHiragana(String(r).replace(/[.\-]/g, ''))));
}

/**
 * SPEC 32.5: a one-kanji piece directly after a noun piece takes the record whose part of speech includes a suffix
 * tag (suf, n-suf) and whose reading is an on reading of the kanji (血判 + 状 = じょう, not さま), best rank first.
 * The path and its weights stay as they are; only the record shown for the piece changes.
 */
function suffixAfterNoun(store, path) {
  for (let x = 1; x < path.length; x++) {
    const seg = path[x].seg, prev = path[x - 1].seg;
    if (seg.kind !== 'word' || prev.kind !== 'word' || path[x].L !== 1 || !seg.cands || !hasKanji(seg.text)) continue;
    const pr = store.getRecord(prev.pack, prev.id);
    if (!(pr.s || []).some((sense) => (sense.p || []).some((p) => NOUN_POS.has(p)))) continue;
    const on = onReadings(store, seg.text);
    if (!on.size) continue;
    const pick = seg.cands.find((c) => {
      if (c.rule !== 1 || c.pack !== 'words') return false;
      const rec = store.getRecord(c.pack, c.id);
      return (rec.s || []).some((sense) => (sense.p || []).some((p) => SUFFIX_POS.has(p))) && (rec.r || []).some((r) => on.has(toHiragana(r)));
    });
    if (pick && pick.id !== seg.id) { seg.id = pick.id; seg.suffix = true; }
  }
}

/** SPEC 34.15: ASCII or full-width digit. */
export const isDigit = (ch) => /^[0-9０-９]$/.test(ch);
/** SPEC 34.6: a run-final glottal stop or lengthening mark (やめろっ, 待ってー) is a separator when no word takes it. */
const TAIL_RE = /^[っッーｰ〜～]+$/;
/** SPEC 34.15 / 34.21: kanji numerals that start a number + counter piece like digits do (三人, 十分 -> also 十 + 分). */
export const KANJI_NUMERALS = new Set(Array.from('一二三四五六七八九十百千'));
/**
 * SPEC 34.21: counters JMdict does not tag as ctr (or tags only on another reading), used only right after a number:
 * counter -> its counter reading(s). The piece points at the record of that written form with that reading.
 */
export const COUNTER_READINGS = {
  分: ['ふん', 'ぷん'], 秒: ['びょう'], 時: ['じ'], 時間: ['じかん'], 日: ['にち'], 週: ['しゅう'], 週間: ['しゅうかん'],
  ヶ月: ['かげつ'], か月: ['かげつ'], カ月: ['かげつ'], 月: ['がつ'], 年: ['ねん'], 年間: ['ねんかん'], 人: ['にん'],
  回: ['かい'], 個: ['こ'], 本: ['ほん'], 枚: ['まい'], 円: ['えん'], 歳: ['さい'], 才: ['さい'], 階: ['かい'], 匹: ['ひき'],
  冊: ['さつ'], 台: ['だい'], 度: ['ど'], 番: ['ばん'], 件: ['けん'], 杯: ['はい'], 点: ['てん'], 着: ['ちゃく'],
};
export const COUNTER_NOTE = 'counter';
/**
 * SPEC 34.15 / 34.21: the counter records of a counter text after a number. A counter of the list above: the records
 * of that written form with a listed reading (a ctr sense first, then rank); none (or not listed): the records with a
 * sense tagged ctr.
 */
function counterCands(store, s) {
  const ids = exact(store, 'words', s);
  const isCtr = (id) => (store.getRecord('words', id).s || []).some((x) => (x.p || []).includes('ctr'));
  const listed = COUNTER_READINGS[s];
  if (listed) {
    const withReading = ids.filter((id) => (store.getRecord('words', id).r || []).some((r) => listed.includes(toHiragana(r))));
    if (withReading.length) return withReading.map((id) => ({ pack: 'words', id, rule: 1, ord: isCtr(id) ? 0 : 1 }));
  }
  return ids.filter(isCtr).map((id) => ({ pack: 'words', id, rule: 1 }));
}
/** Edges number + counter from position k of the run (the number is numLen characters long). */
function counterEdges(store, chars, from, k, numLen, n, ranking, edges) {
  const num = chars.slice(from + k, from + k + numLen).join('');
  for (let m = 1; m <= COUNTER_MAX_LEN && k + numLen + m <= n; m++) {
    const ctr = chars.slice(from + k + numLen, from + k + numLen + m).join('');
    const cands = counterCands(store, ctr);
    if (!cands.length) continue;
    const sorted = choose(store, cands, ranking);
    const best = sorted[0];
    const w = 10 + pRank(store.rank(best.pack, best.id, ranking));
    edges[k].push({ L: numLen + m, w, seg: { kind: 'word', text: num + ctr, start: from + k, end: from + k + numLen + m, pack: best.pack, id: best.id, rule: 1, others: sorted.length - 1, weight: w, counter: ctr } });
  }
}
export const COUNTER_MAX_LEN = 4;
export const DIGITS_WEIGHT = 10;

/**
 * edges[k] = every edge { L, w, seg } that starts at chars[from + k] (the last one is the "unknown" edge).
 * digits (SPEC 34.15): the run starts with that many digits. From its first character: an edge digits + counter for
 * every counter of 1 to 4 characters right after them (weight 10 + P), and the digits alone as a separator (weight 10).
 */
function runEdges(store, chars, from, to, ranking, digits = 0) {
  const n = to - from;
  const edges = Array.from({ length: n }, () => []);
  if (digits) {
    const num = chars.slice(from, from + digits).join('');
    counterEdges(store, chars, from, 0, digits, n, ranking, edges);
    edges[0].push({ L: digits, w: DIGITS_WEIGHT, seg: { kind: 'sep', text: num } });
    for (let k = 1; k < digits; k++) edges[k].push({ L: 1, w: UNKNOWN_WEIGHT, seg: { kind: 'unknown', text: chars[from + k] } });
  }
  // SPEC 30: partly-kana words of the run, Map(start * 64 + length -> hits); positions count from the run's start
  const mixed = mixedSpans(store, 'words', from === 0 && to === chars.length ? chars : chars.slice(from, to));
  // (digits are no kana or kanji, so mixedSpans never matches across them; positions still count from the run start)
  /**
   * SPEC 32.7 (mirror of 30.3): a rule-5 word whose kana part is one leading particle kana (も掻いて = 藻掻いて) is
   * refused when a kanji word ends right before it (尻) and the rest (掻いて) is a word by rule 1 to 3.
   */
  const refuseAt = (k, s, L) => (cands) => {
    const ch = Array.from(s);
    if (L < 2 || k === 0 || !LEAD_PARTICLES.has(toHiragana(ch[0])) || isKana(ch[1].codePointAt(0))) return cands;
    let kanjiBefore = false;
    for (let j = 0; j < k && !kanjiBefore; j++) {
      kanjiBefore = edges[j].some((e) => j + e.L === k && e.seg.kind === 'word' && hasKanji(e.seg.text));
    }
    if (!kanjiBefore) return cands;
    const rest = ch.slice(1).join('');
    if (!oneKanaFilter(store, rest, rulesOneToThree(store, rest, null, 0)).length) return cands;
    return cands.filter((c) => isKana(Array.from(c.base || '')[0]?.codePointAt(0) || 0x3042)); // drop: the kana stands for a kanji
  };
  let tailAt = n;
  while (tailAt > 0 && TAIL_RE.test(chars[from + tailAt - 1])) tailAt--;
  for (let k = digits; k < n; k++) {
    // SPEC 34.21: a kanji numeral sequence (三, 十二) followed by a counter: number + counter edges, competing with words
    if (KANJI_NUMERALS.has(chars[from + k]) && (k === 0 || !KANJI_NUMERALS.has(chars[from + k - 1]))) {
      let e = k;
      while (e < n && KANJI_NUMERALS.has(chars[from + e])) e++;
      counterEdges(store, chars, from, k, e - k, n, ranking, edges);
    }
    // SPEC 34.6: the run-final tail as a separator (weight 0)
    if (k > digits && k === tailAt) edges[k].push({ L: n - k, w: 0, seg: { kind: 'sep', text: chars.slice(from + k, to).join('') } });
    const maxL = Math.min(SEGMENT_MAX_LEN, n - k);
    for (let L = 1; L <= maxL; L++) {
      const s = chars.slice(from + k, from + k + L).join('');
      const cands = edgeCands(store, s, L, mixed.size ? mixed : null, k * 64 + L, refuseAt(k, s, L), ranking);
      if (!cands.length) continue;
      const sorted = choose(store, cands, ranking);
      const best = sorted[0];
      const oneKanaFn = L === 1 && allKana(s);
      // SPEC 34.3: a partly-kana (rule 5) or Wiktionary (rule 3) word that is also deinflected adds the +4 of rule 2.
      // SPEC 34.20: a kana piece that is a later reading of a kanji word not usually written in kana adds KANA_READING_EXTRA.
      const w = oneKanaFn ? 10 : 10 + pRank(store.rank(best.pack, best.id, ranking)) + EXTRA[best.rule] + ((best.rule === 5 || best.rule === 3) && best.via ? EXTRA[2] : 0)
        + (best.rule === 1 && laterKanaReading(store, best, s) ? KANA_READING_EXTRA : 0);
      const seg = { kind: 'word', text: s, start: from + k, end: from + k + L, pack: best.pack, id: best.id, rule: best.rule, others: sorted.length - 1, weight: w };
      if (best.via) { seg.via = best.via; seg.base = best.base; if (best.suru) seg.suru = true; }
      if (best.rule === 5) { seg.base = best.base; seg.cands = sorted; } // SPEC 30: every record of this reading
      else if (L === 1 && sorted.length > 1 && hasKanji(s)) seg.cands = sorted; // SPEC 32.5: suffixAfterNoun
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
