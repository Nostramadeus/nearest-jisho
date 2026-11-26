// Words typed partly in kana (SPEC 30): 嵩にきる for 嵩に着る, 友だち for 友達, こん虫 for 昆虫.
// Pure module: runs in the worker and in node.
import { toHiragana, isKana } from './romaji.js';
import { deinflect, posBits } from './deinflect.js';
import { readingsFor } from './pitch.js';

export const MIXED_MIN_LEN = 2;
export const MIXED_MAX_LEN = 12;
/** One kanji stands for at most this many kana. */
export const MIXED_KANJI_KANA_MAX = 6;
/** An inflected ending is at most this many kana after the stem. */
export const MIXED_TAIL_MAX = 8;
/** Kanji lists kept per key space (one list = the key indexes whose key holds that character). */
export const MIXED_INDEX_MAX = 300;
/** A last kanji typed as ONE of these kana is not accepted: 首と is 首 + と, not 首都 (SPEC 30.3). */
export const MIXED_END_PARTICLES = new Set(Array.from('はがをにでとものへやかねよな'));

const kanaCh = (ch) => isKana(ch.codePointAt(0));
/** Code unit with katakana folded to hiragana. */
const foldCU = (c) => (c >= 0x30a1 && c <= 0x30f6 ? c - 0x60 : c);

const lists = new WeakMap(); // KeySpace -> Map(character -> Uint32Array of key indexes)
/** Readings kept per key space, by key index: typing on re-reads the same keys (as-you-type search). */
export const MIXED_READINGS_MAX = 6000;
const readings = new WeakMap(); // KeySpace -> Map(key index -> { key, Kh, kFlag, recs })

/** Indexes of the keys that contain `ch`, in key order. Built by one scan of the key string, then remembered. */
function keysWith(ks, ch) {
  let m = lists.get(ks);
  if (!m) { m = new Map(); lists.set(ks, m); }
  const hit = m.get(ch);
  if (hit) return hit;
  const out = [];
  const str = ks.str;
  for (let p = str.indexOf(ch); p !== -1;) {
    const i = ks.indexAt(p);
    out.push(i);
    p = str.indexOf(ch, ks.keyEnd(i) + 1); // next key
  }
  const arr = Uint32Array.from(out);
  if (m.size >= MIXED_INDEX_MAX) m.delete(m.keys().next().value);
  m.set(ch, arr);
  return arr;
}

/**
 * True when F is K with at least one kanji written as its part of the reading R.
 * K, F, R: arrays of characters, kana already in hiragana. kFlag[i]: K[i] is kana.
 * Every kana of K must stand in F and in R. Every other character of K is either kept in F (then it takes one or
 * more kana of R) or replaced in F by exactly the kana it takes in R.
 */
function fits(K, kFlag, F, R) {
  const nk = K.length, nf = F.length, nr = R.length;
  const walk = (i, j, r, replaced, lastOne) => {
    if (i === nk) return j === nf && r === nr && replaced && !lastOne;
    const kc = K[i];
    if (kFlag[i]) return j < nf && r < nr && F[j] === kc && R[r] === kc && walk(i + 1, j + 1, r + 1, replaced, false);
    if (j < nf && F[j] === kc) {
      for (let n = 1; r + n <= nr; n++) if (walk(i + 1, j + 1, r + n, replaced, false)) return true;
    }
    for (let n = 1; j + n <= nf && r + n <= nr && F[j + n - 1] === R[r + n - 1] && kanaCh(F[j + n - 1]); n++) {
      // lastOne: this kanji was typed as one kana of the particle list; refused when it is the last character of K
      if (walk(i + 1, j + n, r + n, true, n === 1 && MIXED_END_PARTICLES.has(F[j]))) return true;
    }
    return false;
  };
  return walk(0, 0, 0, false, false);
}

const hira = (s) => Array.from(s, (ch) => (kanaCh(ch) ? toHiragana(ch) : ch));
const END_PARTICLE_CU = new Set(Array.from(MIXED_END_PARTICLES, (ch) => ch.charCodeAt(0)));
/** SPEC 34.3: particles refused as the key's first kanji typed as one kana (same list as SPEC 32.7). */
export const MIXED_LEAD_PARTICLES = new Set(Array.from('もはがをにとでのへやか'));
const LEAD_PARTICLE_CU = new Set(Array.from(MIXED_LEAD_PARTICLES, (ch) => ch.charCodeAt(0)));

// ---- quick refusal by the kanji's own readings (KANJIDIC), so that almost no record has to be read ----
const VOICED = 'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ';
const PLAIN = 'かきくけこさしすせそたちつてとはひふへほはひふへほ';
const UNVOICE = new Map(Array.from(VOICED, (ch, x) => [ch.charCodeAt(0), PLAIN.charCodeAt(x)]));
/** Hiragana with the voicing marks taken off (rendaku: 友だち, the reading of 達 is たち). */
const plain = (s) => Array.from(s, (ch) => String.fromCharCode(UNVOICE.get(ch.charCodeAt(0)) || ch.charCodeAt(0))).join('');
const kanjiReadings = new WeakMap(); // kanji data object -> Map(kanji -> Set of plain readings | null)

/**
 * The kana a kanji can stand for, voicing removed: its on, kun (the part before the dot) and name readings, plus the
 * form with a small っ for a reading that ends in つ く ち き (しっ責: 叱 is しつ). null = no data for this kanji.
 */
function readingsOf(store, ch) {
  const data = store.kanjiData;
  if (!data) return null;
  let m = kanjiReadings.get(data);
  if (!m) { m = new Map(); kanjiReadings.set(data, m); }
  if (m.has(ch)) return m.get(ch);
  const d = data[ch];
  let set = null;
  if (d) {
    set = new Set();
    for (const r of [...(d.on || []), ...(d.kun || []), ...(d.n || [])]) {
      let s = toHiragana(String(r)).replace(/-/g, '');
      const dot = s.indexOf('.');
      if (dot >= 0) s = s.slice(0, dot);
      if (!s) continue;
      set.add(plain(s));
      if (s.length >= 2 && 'つくちき'.includes(s[s.length - 1])) set.add(plain(s.slice(0, -1)) + 'っ');
    }
  }
  m.set(ch, set);
  return set;
}

/**
 * Every partly-kana word inside one run of text (a run = kana and kanji only, no separators).
 * chars: the characters of the run. Returns Map(start * 64 + length -> [{ id, key, via? }]): the records of `pack`
 * that have a written form K (key) and a reading such that chars[start, start + length) is K with part written in
 * kana, either as typed or after deinflection (via = rule names, as in deinflect()).
 *
 * How: for every kanji of the run, walk the keys that hold that kanji and lay each key over the text around it
 * (the kanji is the first one the text keeps; everything of the key before it must be kana in the text). Only keys
 * that fit by shape get their record read and their reading compared. An inflected word is found by its stem: the
 * key without its last one or two kana fits, and a deinflection of the text gives that stem plus the key's ending.
 */
export function mixedSpans(store, pack, chars) {
  const spans = new Map();
  const ks = store.keySpace(pack, 'k');
  const n = chars.length;
  if (!ks || n < MIXED_MIN_LEN) return spans;
  const T = new Uint16Array(n); // folded code unit, 0xffff for a character outside the basic plane
  const TK = new Uint8Array(n); // 1 = kana
  let anyKana = false, anyOther = false;
  for (let x = 0; x < n; x++) {
    const ch = chars[x];
    if (ch.length !== 1) { T[x] = 0xffff; anyOther = true; continue; }
    const c = ch.charCodeAt(0);
    if (isKana(c)) { TK[x] = 1; T[x] = foldCU(c); anyKana = true; } else { T[x] = c; anyOther = true; }
  }
  if (!anyKana || !anyOther) return spans;
  const str = ks.str;
  const deinflected = new Map(); // text piece -> deinflect() result
  const formsOf = (s) => { let d = deinflected.get(s); if (!d) { d = deinflect(s); deinflected.set(s, d); } return d; };
  let known = readings.get(ks);
  if (!known) { known = new Map(); readings.set(ks, known); }
  const hiraMemo = new Map(); // start * 64 + end -> the text piece in hiragana, as characters
  const hiraOf = (start, end) => {
    const k = start * 64 + end;
    let F = hiraMemo.get(k);
    if (!F) { F = hira(chars.slice(start, end).join('')); hiraMemo.set(k, F); }
    return F;
  };
  const add = (start, len, hit) => {
    const k = start * 64 + len;
    let list = spans.get(k);
    if (!list) { list = []; spans.set(k, list); }
    const old = list.find((h) => h.id === hit.id);
    if (!old) list.push(hit);
    else if (old.via && !hit.via) { old.via = undefined; old.key = hit.key; } // as typed beats deinflected
    else if (!old.via === !hit.via && Array.from(hit.key).length > Array.from(old.key).length) old.key = hit.key; // 気持ち before 気持
  };

  // the key being laid over the text: str[a, a + klen)
  let a = 0, klen = 0, lastKana = false;
  let starts = [], ends = [], stems = [];
  const kk = (x) => isKana(str.charCodeAt(a + x));
  /**
   * Can the key's character x stand for the m kana of the text from `from`? Checked against the kanji's own readings
   * (voicing ignored). Without kanji data, or for a character it does not list (々), the answer is yes.
   * Known limit (30.4): a word read as a whole (今日 = きょう) is not found when typed partly in kana.
   */
  const canRead = (x, from, m) => {
    const set = readingsOf(store, str.charAt(a + x));
    if (!set) return true;
    let s = '';
    for (let q = from; q < from + m; q++) s += String.fromCharCode(UNVOICE.get(T[q]) || T[q]);
    return set.has(s);
  };
  /** Left of the kept kanji: the key's characters before it, all as kana in the text. starts: [start, replaced]. */
  const left = (x, pos, replaced) => {
    if (x < 0) { starts.push(pos, replaced); return; }
    if (kk(x)) { if (pos > 0 && TK[pos - 1] && T[pos - 1] === foldCU(str.charCodeAt(a + x))) left(x - 1, pos - 1, replaced); return; }
    for (let m = 1; m <= MIXED_KANJI_KANA_MAX && pos - m >= 0 && TK[pos - m]; m++) {
      // SPEC 34.3 (mirror of 30.3): the key's FIRST kanji as one particle kana with text before it in the run
      // (駅で会った is never 駅 + 出会った; 車で来た never 車 + 出来た). At the start of the run it stays allowed (32.7).
      if (m === 1 && x === 0 && pos - 1 > 0 && LEAD_PARTICLE_CU.has(T[pos - 1])) continue;
      if (canRead(x, pos - m, m)) left(x - 1, pos - m, 1);
    }
  };
  /** Right of it. ends: [end, replaced] the whole key fits; stems: [end, replaced, x] the key up to x fits. */
  const right = (x, pos, replaced) => {
    if (x === klen) { ends.push(pos, replaced); return; }
    if (lastKana && (x === klen - 1 || (x === klen - 2 && kk(x)))) stems.push(pos, replaced, x);
    if (pos >= n) return;
    const u = str.charCodeAt(a + x);
    if (isKana(u)) { if (TK[pos] && T[pos] === foldCU(u)) right(x + 1, pos + 1, replaced); return; }
    if (!TK[pos] && T[pos] === u) right(x + 1, pos + 1, replaced);
    for (let m = 1; m <= MIXED_KANJI_KANA_MAX && pos + m <= n && TK[pos + m - 1]; m++) {
      // the key's last kanji as one particle kana (彼は, 首と): refused here, before any record is read (30.3)
      if (m === 1 && x === klen - 1 && END_PARTICLE_CU.has(T[pos])) continue;
      if (canRead(x, pos, m)) right(x + 1, pos + m, 1);
    }
  };

  for (let p = 0; p < n; p++) {
    if (TK[p] || T[p] === 0xffff) continue;
    const c = T[p];
    const before = p > 0 && TK[p - 1] === 1; // something of the key may stand left of the kanji
    for (const i of keysWith(ks, chars[p])) {
      a = ks.keyStart(i);
      klen = ks.keyLen(i);
      if (klen < 2 || klen > MIXED_MAX_LEN) continue;
      lastKana = kk(klen - 1);
      for (let t = 0; t < klen; t++) {
        if (str.charCodeAt(a + t) !== c || (t > 0 && !before)) continue;
        starts = [];
        left(t - 1, p, 0);
        if (!starts.length) continue;
        ends = [];
        stems = [];
        right(t + 1, p + 1, 0);
        if (!ends.length && !stems.length) continue;
        // by shape it fits: read the records and compare the readings
        let key = null, Kh = null, kFlag = null, recs = null;
        const load = () => {
          let e = known.get(i);
          if (!e) {
            const k = ks.key(i);
            const K = Array.from(k);
            const flags = K.map(kanaCh);
            e = {
              key: k, kFlag: flags, Kh: K.map((ch, x) => (flags[x] ? toHiragana(ch) : ch)),
              recs: Array.from(ks.idsOf(i), (id) => {
                const rec = store.getRecord(pack, id);
                const pos = [];
                for (const sense of rec.s || []) for (const q of sense.p || []) pos.push(q);
                // SPEC 34.17: only the readings JMdict allows with this written form (re_restr)
                return { id, pos, R: readingsFor(rec, k).map((r) => Array.from(toHiragana(r))) };
              }),
            };
            if (known.size >= MIXED_READINGS_MAX) known.delete(known.keys().next().value);
            known.set(i, e);
          }
          ({ key, Kh, kFlag, recs } = e);
        };
        for (let s = 0; s < starts.length; s += 2) {
          const start = starts[s], leftRep = starts[s + 1];
          for (let e = 0; e < ends.length; e += 2) {
            const end = ends[e];
            if (!(leftRep || ends[e + 1]) || end - start > MIXED_MAX_LEN) continue;
            if (!key) load();
            const F = hiraOf(start, end);
            for (const { id, R } of recs) if (R.some((r) => fits(Kh, kFlag, F, r))) add(start, end - start, { id, key });
          }
          for (let e = 0; e < stems.length; e += 3) {
            const stemEnd = stems[e];
            if (!(leftRep || stems[e + 1])) continue;
            // the base form as it would be typed: the stem as it stands in the text + the key's ending
            const target = chars.slice(start, stemEnd).join('') + str.slice(a + stems[e + 2], a + klen);
            let F = null;
            for (let tail = 0; tail <= MIXED_TAIL_MAX; tail++) {
              const end = stemEnd + tail;
              if (end > n || end - start > MIXED_MAX_LEN || (tail > 0 && !TK[end - 1])) break;
              for (const cand of formsOf(chars.slice(start, end).join(''))) {
                if (cand.form !== target) continue;
                if (!key) load();
                if (!F) F = hira(target);
                for (const { id, pos, R } of recs) {
                  if (!R.some((r) => fits(Kh, kFlag, F, r))) continue;
                  const ok = pos.some((q) => posBits(q) & cand.type);
                  if (ok) add(start, end - start, { id, key, via: cand.via.join(' + ') });
                }
              }
            }
          }
        }
      }
    }
  }
  return spans;
}

/** Note text of such a hit, e.g. "友だち is 友達 with part written in kana". */
export function mixedNote(typed, base) {
  return `${typed} is ${base} with part written in kana`;
}
