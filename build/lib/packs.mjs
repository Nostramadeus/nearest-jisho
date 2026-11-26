// Pack builders: words, names, kanji, wikt (SPEC sections 2 and 3).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { PackWriter, englishKeys } from './packwriter.mjs';
import { OUT, download, rmCache, jmdictSimplifiedRecords, fetchOk, lines, log, mb } from './util.mjs';

const UNKNOWN = 999999;
const nfkc = (s) => String(s).normalize('NFKC');
const uniq = (a) => [...new Set(a)];

const KANA_RE = /^[ぁ-ゟ゠-ヿー]+$/u;
const isKanaStr = (s) => KANA_RE.test(s);

/**
 * ff from jiten.moe (SPEC 2.2 with the 2026-11-13 rulings):
 * - (word, reading) pair match, readings compared in hiragana;
 * - else word-only match, using only jiten rows whose (word, reading) pair no OTHER words record has
 *   (`allPairs` = every (form, hiragana reading) pair of the words pack);
 * - a jiten row whose word is kana only applies only when `kanaRowsOk` (no kanji forms, or a sense has misc uk);
 * - else fn when known, else 999999.
 */
function fictionRank(jiten, words, readingsHira, kanaRowsOk, fn, allPairs) {
  if (!jiten) return fn;
  const usable = words.filter((w) => kanaRowsOk || !isKanaStr(w));
  let best = Infinity;
  for (const w of usable) for (const r of readingsHira) {
    const v = jiten.pair.get(w + '\t' + r);
    if (v !== undefined && v < best) best = v;
  }
  if (best === Infinity) {
    for (const w of usable) {
      for (const [r, rank] of jiten.byWord.get(w) || []) {
        if (rank < best && !allPairs.has(w + '\t' + r)) best = rank;
      }
    }
  }
  if (best !== Infinity) return best;
  return fn < UNKNOWN ? fn : UNKNOWN;
}

// ---------------------------------------------------------------- words

export const MISC_COUNT_TAGS = ['sl', 'net-sl', 'm-sl', 'vulg', 'col', 'on-mim'];

/**
 * SPEC 34.17: JMdict <re_restr> as { reading: [written forms] } for the shown readings (`shownR`) whose
 * appliesToKanji is a list (not "*"), keeping only shown written forms (`shownK`); null when no reading is restricted.
 * kana = jmdict-simplified kana objects ({ text, appliesToKanji }).
 */
export function restrictedReadings(kana, shownR, shownK) {
  let out = null;
  for (const x of kana || []) {
    const ak = x.appliesToKanji || ['*'];
    if (ak.includes('*') || !shownR.includes(x.text)) continue;
    const ks = ak.filter((f) => shownK.includes(f));
    if (!ks.length) continue;
    (out ||= {})[x.text] = ks;
  }
  return out;
}

export async function buildWords({ release, romaji, jiten, jlpt, priority }) {
  const file = await download(release.url('jmdict-examples-eng'), 'jmdict-examples-eng.json.tgz');
  const w = new PackWriter(OUT, 'words', ['r', 'k', 'e']);
  const miscCount = Object.fromEntries(MISC_COUNT_TAGS.map((t) => [t, 0]));
  let header = null, examples = 0, withFf = 0, withFn = 0, withJ = 0, hiddenForms = 0;
  let withRp = 0, withRr = 0;
  const searchOnly = (x) => (x.tags || []).some((t) => t === 'sK' || t === 'sk');
  const forRank = []; // per record: [forms, hiragana readings, kanaRowsOk, fn]; ff is computed after all pairs are known
  const allPairs = new Set();
  for await (const item of jmdictSimplifiedRecords(file, 'words')) {
    if (item.header) { header = item.header; continue; }
    const e = item;
    // SPEC 24: search-only forms (JMdict tags sK / sk, e.g. 地団駄をふむ) stay in the search keys and the rank data
    // (kAll / rAll) but are not shown: rec.k / rec.r hold the forms to show, rec.h the hidden ones
    const kAll = e.kanji.map((x) => x.text);
    const rAll = e.kana.map((x) => x.text);
    const k = e.kanji.filter((x) => !searchOnly(x)).map((x) => x.text);
    let r = e.kana.filter((x) => !searchOnly(x)).map((x) => x.text);
    if (!r.length) r = rAll;
    const hid = uniq([...kAll, ...rAll]).filter((f) => !k.includes(f) && !r.includes(f));
    const rec = {};
    if (k.length) rec.k = k;
    if (r.length) rec.r = r;
    if (hid.length) { rec.h = hid; hiddenForms += hid.length; }
    // SPEC 34.17: JMdict <re_restr>: a shown reading that goes only with some written forms -> rec.rr[reading] = those
    const rr = restrictedReadings(e.kana, r, k);
    if (rr) { rec.rr = rr; withRr++; }
    if (e.kanji.some((x) => x.common) || e.kana.some((x) => x.common)) rec.c = 1;
    const seq = Number(e.id);
    // SPEC 27.2: indexes of the shown kana forms that carry a JMdict reading priority tag (re_pri)
    const rePri = priority.rePri && priority.rePri.get(seq);
    if (rePri && rec.r) {
      const rp = rec.r.map((f, i) => (rePri.has(f) ? i : -1)).filter((i) => i >= 0);
      if (rp.length) { rec.rp = rp; withRp++; }
    }
    const j = jlpt.map.get(seq);
    if (j) { rec.j = j; withJ++; }
    const senses = [];
    const eKeys = [];
    const seen = new Set();
    e.sense.forEach((s, si) => {
      const o = {};
      if (s.partOfSpeech.length) o.p = s.partOfSpeech;
      const g = s.gloss.filter((x) => !x.lang || x.lang === 'eng').map((x) => x.text);
      if (g.length) o.g = g;
      if (s.misc.length) o.m = s.misc;
      if (s.field.length) o.f = s.field;
      if (s.dialect.length) o.d = s.dialect;
      if (s.info.length) o.i = s.info.join('; ');
      const x = [];
      for (const ex of s.examples || []) {
        if (x.length >= 2) break;
        const ja = ex.sentences.find((t) => t.lang === 'jpn');
        const en = ex.sentences.find((t) => t.lang === 'eng');
        if (ja && en) x.push([ja.text, en.text]);
      }
      if (x.length) { o.x = x; examples += x.length; }
      senses.push(o);
      for (const gl of g) for (const word of englishKeys(gl)) {
        const key = word + '\u0000' + si;
        if (!seen.has(key)) { seen.add(key); eKeys.push([word, si]); }
      }
      for (const t of s.misc) if (t in miscCount) seen.add('misc:' + t);
    });
    for (const t of MISC_COUNT_TAGS) if (seen.has('misc:' + t)) miscCount[t]++;
    rec.s = senses;
    const fn = priority.get(seq) ?? UNKNOWN;
    if (fn < UNKNOWN) withFn++;
    const forms = uniq([...kAll, ...rAll]);
    const readingsHira = uniq(rAll.map((x) => romaji.toHiragana(x)));
    for (const f of forms) for (const rh of readingsHira) allPairs.add(f + '\t' + rh);
    const kanaRowsOk = kAll.length === 0 || e.sense.some((s) => s.misc.includes('uk'));
    forRank.push([forms, readingsHira, kanaRowsOk, fn]);
    w.add(rec, UNKNOWN, fn, {
      r: uniq(rAll.map((x) => romaji.kanaToRomaji(x)).filter(Boolean)),
      k: uniq([...kAll, ...rAll].map(nfkc)),
      e: eKeys,
    });
  }
  forRank.forEach(([forms, readingsHira, kanaRowsOk, fn], id) => {
    const ff = fictionRank(jiten, forms, readingsHira, kanaRowsOk, fn, allPairs);
    if (ff < UNKNOWN) withFf++;
    w.setFf(id, ff);
  });
  const res = w.finish();
  rmCache(file);
  log(`words: ${res.n} records, ${mb(res.bytes)} (${res.layout}); examples ${examples}; fn known ${withFn}; ff known ${withFf}; jlpt ${withJ}; search-only forms hidden ${hiddenForms}; readings with re_pri in ${withRp} records; restricted readings (re_restr) in ${withRr} records`);
  return { ...res, dictDate: header?.dictDate, miscCount, examples, withFn, withFf, withJ };
}

// ---------------------------------------------------------------- names

export async function buildNames({ release, romaji, jiten }) {
  const file = await download(release.url('jmnedict-all'), 'jmnedict-all.json.tgz');
  const w = new PackWriter(OUT, 'names', ['r', 'k']);
  let withFf = 0;
  for await (const item of jmdictSimplifiedRecords(file, 'words')) {
    if (item.header) continue;
    const e = item;
    const k = e.kanji.map((x) => x.text);
    const r = e.kana.map((x) => x.text);
    const t = [];
    const g = [];
    for (const tr of e.translation) {
      for (const ty of tr.type || []) t.push(ty);
      for (const x of tr.translation || []) if (!x.lang || x.lang === 'eng') g.push(x.text);
    }
    const rec = {};
    if (k.length) rec.k = k;
    if (r.length) rec.r = r;
    if (t.length) rec.t = uniq(t);
    if (g.length) rec.g = uniq(g);
    // ruling 2026-11-13: ff = jiten rank when a row matches a (kanji form, reading) pair exactly; fn = 999999
    let ff = UNKNOWN;
    if (jiten) for (const kf of k) for (const rd of r) {
      const v = jiten.exact.get(kf + '\t' + rd);
      if (v !== undefined && v < ff) ff = v;
    }
    if (ff < UNKNOWN) withFf++;
    w.add(rec, ff, UNKNOWN, {
      r: uniq(r.map((x) => romaji.kanaToRomaji(x)).filter(Boolean)),
      k: uniq([...k, ...r].map(nfkc)),
    });
  }
  const res = w.finish();
  rmCache(file);
  log(`names: ${res.n} records, ${mb(res.bytes)} (${res.layout}); ff known ${withFf}`);
  return { ...res, withFf };
}

// ---------------------------------------------------------------- kanji

export async function buildKanji({ release }) {
  const file = await download(release.url('kanjidic2-en'), 'kanjidic2-en.json.tgz');
  const out = {};
  let n = 0;
  for await (const item of jmdictSimplifiedRecords(file, 'characters')) {
    if (item.header) continue;
    const c = item;
    const o = {};
    const m = [], on = [], kun = [];
    for (const grp of c.readingMeaning?.groups || []) {
      for (const x of grp.meanings || []) if (x.lang === 'en') m.push(x.value);
      for (const x of grp.readings || []) {
        if (x.type === 'ja_on') on.push(x.value);
        else if (x.type === 'ja_kun') kun.push(x.value);
      }
    }
    const nanori = c.readingMeaning?.nanori || [];
    if (m.length) o.m = m;
    if (on.length) o.on = on;
    if (kun.length) o.kun = kun;
    if (nanori.length) o.n = nanori;
    const misc = c.misc || {};
    if (misc.strokeCounts?.length) o.s = misc.strokeCounts[0];
    if (misc.grade != null) o.g = misc.grade;
    if (misc.jlptLevel != null) o.j = misc.jlptLevel;
    if (misc.frequency != null) o.f = misc.frequency;
    out[c.literal] = o;
    n++;
  }
  const dest = path.join(OUT, 'kanji.json');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out));
  rmCache(file);
  const bytes = fs.statSync(dest).size;
  log(`kanji: ${n} characters, ${mb(bytes)}`);
  return { n, bytes, files: ['kanji.json'] };
}

// ---------------------------------------------------------------- wikt

const EN_LABEL_RE = /slang|internet|fandom|colloquial|vulgar|derogatory|dialect|onomatopoei|men's speech|women's speech|childish|gyaru/i;
// SPEC 2.1 + ruling 2026-11-13: bare ネット replaced by ネットスラング / ネット用語
const JA_LABEL_RE = /俗語|スラング|卑語|隠語|若者言葉|2ちゃんねる|ネットスラング|ネット用語/;
const EN_DROP_POS = new Set(['romanization', 'character', 'soft-redirect']);
const STRUCT_TAGS = new Set(['alt-of', 'form-of', 'no-gloss']);
const JA_READING_TAGS = new Set(['go-on', 'kan-on', 'to-on', 'kan-yo-on', 'kun', 'ko-kun', 'on', 'nanori']);

const catNames = (cats) => (cats || []).map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean);
const senseLabels = (s) => [...(s.tags || []), ...(s.raw_tags || []), ...catNames(s.categories)];
const displayLabels = (s) => uniq([...(s.tags || []), ...(s.raw_tags || [])].filter((t) => !STRUCT_TAGS.has(t)));

function urlPart(headword) {
  return headword.replace(/ /g, '_').replace(/[%#?]/g, (c) => encodeURIComponent(c));
}

function rubyReading(form, ruby) {
  if (!ruby || !ruby.length) return null;
  let out = '', i = 0;
  for (const [base, rt] of ruby) {
    const j = form.indexOf(base, i);
    if (j < 0 || !rt) return null;
    out += form.slice(i, j) + rt;
    i = j + base.length;
  }
  out += form.slice(i);
  return isKanaStr(out) ? out : null;
}

function enReadings(e) {
  const r = [];
  if (isKanaStr(e.word)) r.push(e.word);
  for (const f of e.forms || []) {
    const tags = f.tags || [];
    if (tags.includes('canonical')) {
      const rr = rubyReading(f.form, f.ruby);
      if (rr) r.push(rr);
      else if (isKanaStr(f.form)) r.push(f.form);
    } else if ((tags.includes('hiragana') || tags.includes('katakana')) && isKanaStr(f.form)) {
      r.push(f.form);
    }
  }
  return uniq(r);
}

function jaReadings(e) {
  const r = [];
  if (isKanaStr(e.word)) r.push(e.word);
  for (const f of e.forms || []) {
    const tags = f.tags || [];
    if (!tags.includes('transliteration')) continue;
    if (tags.some((t) => JA_READING_TAGS.has(t))) continue;
    if (isKanaStr(f.form)) r.push(f.form);
  }
  return uniq(r);
}

/** Stream a JSONL URL (optionally gzip file) through fn(entry); restarts on network failure. */
async function streamJsonl(url, gz, onStart, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      onStart();
      const res = await fetchOk(url);
      let src = Readable.fromWeb(res.body);
      if (gz) src = src.pipe(zlib.createGunzip());
      let n = 0, bad = 0;
      for await (const line of lines(src)) {
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { bad++; continue; }
        n++;
        fn(e);
      }
      return { n, bad };
    } catch (err) {
      if (attempt >= 2) throw err;
      log(`  stream failed (${err.message}); restarting`);
    }
  }
}

/** All JMdict kanji/kana forms, read back from the words pack (space k). */
export function jmdictForms() {
  const j = path.join(OUT, 'words.keys.json');
  if (fs.existsSync(j)) return new Set(JSON.parse(fs.readFileSync(j, 'utf8')).k.keys.split('\n'));
  const t = path.join(OUT, 'words.k.txt');
  if (fs.existsSync(t)) return new Set(fs.readFileSync(t, 'utf8').split('\n'));
  throw new Error('wikt needs the words pack (build words first)');
}

/**
 * SPEC 34.8: every (written form, reading) pair of the words pack, read back from words.dat / words.off:
 * Set of "<NFKC form>\t<hiragana reading>" over k, r and the hidden forms h; kana forms of r and h are the readings.
 */
export function jmdictPairs(toHiragana, dir = OUT) {
  const dat = fs.readFileSync(path.join(dir, 'words.dat'));
  const offBuf = fs.readFileSync(path.join(dir, 'words.off'));
  const off = new Uint32Array(offBuf.buffer, offBuf.byteOffset, offBuf.byteLength / 4);
  const td = new TextDecoder();
  const pairs = new Set();
  for (let i = 0; i + 1 < off.length; i++) {
    const rec = JSON.parse(td.decode(dat.subarray(off[i], off[i + 1])));
    const all = [...(rec.k || []), ...(rec.r || []), ...(rec.h || [])];
    const readings = all.filter(isKanaStr).map((x) => toHiragana(nfkc(x)));
    for (const f of all) for (const r of readings) pairs.add(nfkc(f) + '\t' + r);
  }
  return pairs;
}

/** SPEC 34.8: Japanese Wiktionary labels kept with the wide rule: dialect and colloquial words. */
export const JA_WIDE_LABEL_RE = /方言|口語/;

/**
 * SPEC 2.1 / 34.8: is a Wiktionary entry kept? `slang`: it has a slang-type label; `labelled`: (ja) a 方言 / 口語 label.
 * Old rule (wide = false): English entries are kept when slang or "missing" (neither the headword nor any of its
 * readings is a JMdict form); Japanese entries only when slang.
 * Wide rule (SPEC 34.8, build flag --wikt-wide): kept when slang, labelled, or when JMdict has no record with the same
 * written form AND the same reading (an entry without readings: the same written form). A homophone alone no longer
 * drops a word (魔導師 is kept although JMdict has まどうし for 魔道士).
 */
export function wiktKeep({ src, hw, readings, slang, labelled }, { forms, pairs, toHiragana }, wide) {
  if (slang) return true;
  if (!wide) return src === 'we' && !forms.has(nfkc(hw)) && !readings.some((x) => forms.has(nfkc(x)));
  if (labelled) return true;
  if (!readings.length) return !forms.has(nfkc(hw));
  return !readings.some((x) => pairs.has(nfkc(hw) + '\t' + toHiragana(nfkc(x))));
}

export async function buildWikt({ romaji, jiten, wide = false }) {
  const forms = jmdictForms();
  // SPEC 34.8: the wide rule needs the JMdict form + reading pairs; they are also read when the flag is off, so the
  // build log reports how many records the wide rule would add
  const pairs = jmdictPairs(romaji.toHiragana);
  const keepCtx = { forms, pairs, toHiragana: romaji.toHiragana };
  const wideExtra = { we: 0, wj: 0 };
  const recs = []; // [record, rank, keys]
  const stats = { we: { lines: 0, kept: 0, bySlang: 0, byMissing: 0, available: false }, wj: { lines: 0, kept: 0, available: false } };
  const rankOf = (hw) => (jiten && jiten.word.has(hw) ? jiten.word.get(hw) : UNKNOWN);

  // ---- English Wiktionary (kaikki), Japanese entries
  const enUrl = 'https://kaikki.org/dictionary/Japanese/kaikki.org-dictionary-Japanese.jsonl';
  let enRecs = [];
  try {
    log(`wikt-en ${enUrl}`);
    const r = await streamJsonl(enUrl, false, () => { enRecs = []; }, (e) => {
      if (e.lang !== 'Japanese' && e.lang_code !== 'ja') return;
      if (EN_DROP_POS.has(e.pos)) return;
      const entryCats = catNames(e.categories);
      const senses = e.senses || [];
      const slang = senses.some((s) => senseLabels(s).some((t) => EN_LABEL_RE.test(t))) || entryCats.some((t) => EN_LABEL_RE.test(t));
      const hw = nfkc(e.word);
      const readings = enReadings(e);
      const entry = { src: 'we', hw, readings, slang, labelled: false };
      const keepOld = wiktKeep(entry, keepCtx, false);
      const keepWide = wiktKeep(entry, keepCtx, true);
      if (keepWide && !keepOld) wideExtra.we++;
      if (!(wide ? keepWide : keepOld)) return;
      const kept = [];
      for (const s of senses) {
        const tags = s.tags || [];
        if (s.form_of || tags.includes('form-of') || tags.includes('romanization')) continue;
        const g = (s.glosses || []).filter(Boolean);
        if (!g.length) continue;
        const o = { p: [e.pos] };
        o.g = g;
        const m = displayLabels(s);
        if (m.length) o.m = m;
        kept.push(o);
        if (kept.length >= 6) break;
      }
      if (!kept.length) return;
      const rec = { src: 'we', k: [e.word] };
      if (readings.length) rec.r = readings;
      rec.u = `https://en.wiktionary.org/wiki/${urlPart(e.word)}#Japanese`;
      rec.s = kept;
      const eKeys = [];
      kept.forEach((s, si) => {
        const seen = new Set();
        for (const gl of s.g) for (const wd of englishKeys(gl)) if (!seen.has(wd)) { seen.add(wd); eKeys.push([wd, si]); }
      });
      enRecs.push([rec, rankOf(e.word), { r: uniq(readings.map((x) => romaji.kanaToRomaji(x)).filter(Boolean)), k: uniq([e.word, ...readings].map(nfkc)), e: eKeys }, slang]);
    });
    stats.we.lines = r.n;
    stats.we.available = true;
  } catch (err) {
    log(`  wikt-en SKIPPED: ${err.message}`);
    stats.we.error = err.message;
    enRecs = [];
  }
  for (const x of enRecs) { if (x[3]) stats.we.bySlang++; else stats.we.byMissing++; recs.push(x); }
  stats.we.kept = enRecs.length;
  enRecs = null;

  // ---- Japanese Wiktionary (kaikki ja extract)
  const jaUrl = 'https://kaikki.org/dictionary/downloads/ja/ja-extract.jsonl.gz';
  let jaRecs = [];
  try {
    log(`wikt-ja ${jaUrl}`);
    const r = await streamJsonl(jaUrl, true, () => { jaRecs = []; }, (e) => {
      if (e.lang !== '日本語') return;
      const entryCats = catNames(e.categories);
      const senses = e.senses || [];
      const slang = senses.some((s) => senseLabels(s).some((t) => JA_LABEL_RE.test(t))) || entryCats.some((t) => JA_LABEL_RE.test(t));
      // SPEC 34.8: dialect / colloquial label of the entry or a sense (kept with the wide rule, shown as a tag)
      const wideLabel = (labels) => { for (const t of labels) { const m = JA_WIDE_LABEL_RE.exec(t); if (m) return m[0]; } return null; };
      const entryLabel = wideLabel(entryCats);
      const labelled = !!entryLabel || senses.some((s) => wideLabel(senseLabels(s)));
      const readings = jaReadings(e);
      const entry = { src: 'wj', hw: nfkc(e.word), readings, slang, labelled };
      const keepOld = wiktKeep(entry, keepCtx, false);
      const keepWide = wiktKeep(entry, keepCtx, true);
      if (keepWide && !keepOld) wideExtra.wj++;
      if (!(wide ? keepWide : keepOld)) return;
      const kept = [];
      for (const s of senses) {
        const g = (s.glosses || []).filter(Boolean);
        if (!g.length) continue;
        const o = {};
        if (e.pos) o.p = [e.pos];
        o.g = g;
        const m = displayLabels(s);
        const tag = wide && !slang ? (wideLabel(senseLabels(s)) || entryLabel) : null;
        if (tag && !m.some((x) => x.includes(tag))) m.push(tag); // the label shows as a tag on the card
        if (m.length) o.m = m;
        kept.push(o);
      }
      if (!kept.length) return;
      const rec = { src: 'wj', k: [e.word] };
      if (readings.length) rec.r = readings;
      rec.u = `https://ja.wiktionary.org/wiki/${urlPart(e.word)}`;
      rec.s = kept;
      jaRecs.push([rec, rankOf(e.word), { r: uniq(readings.map((x) => romaji.kanaToRomaji(x)).filter(Boolean)), k: uniq([e.word, ...readings].map(nfkc)) }]);
    });
    stats.wj.lines = r.n;
    stats.wj.available = true;
  } catch (err) {
    log(`  wikt-ja SKIPPED: ${err.message}`);
    stats.wj.error = err.message;
    jaRecs = [];
  }
  stats.wj.kept = jaRecs.length;
  for (const x of jaRecs) recs.push(x);
  jaRecs = null;

  const w = new PackWriter(OUT, 'wikt', ['r', 'k', 'e']);
  for (const [rec, rank, keys] of recs) w.add(rec, rank, rank, keys);
  const res = w.finish();
  log(`wikt: ${res.n} records (we ${stats.we.kept}: slang ${stats.we.bySlang}, not in JMdict ${stats.we.byMissing}; wj ${stats.wj.kept}), ${mb(res.bytes)} (${res.layout})`);
  // SPEC 34.8: size estimate of the wide rule (records it keeps that the old rule drops)
  const extra = wideExtra.we + wideExtra.wj;
  log(`wikt wide rule (--wikt-wide, ${wide ? 'ON' : 'off'}): ${wide ? 'added' : 'would add'} ${extra} records (we ${wideExtra.we}, wj ${wideExtra.wj}) = ${res.n ? Math.round((extra / (wide ? res.n - extra : res.n)) * 100) : 0}% of the ${wide ? 'old' : 'current'} pack`);
  stats.wide = { on: wide, ...wideExtra };
  return { ...res, wiktStats: stats };
}
