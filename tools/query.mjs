#!/usr/bin/env node
// CLI: node tools/query.mjs "jihso" [more queries] [--news] [--phase fast|full] [--top N] [--data DIR] [--json]
//      node tools/query.mjs --accept     runs the SPEC section 7 acceptance queries, prints pass/fail + top 3
//      node tools/query.mjs --bench      timings of phase fast/full for jisho, jihso, dictonary + peak memory
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackStore, PACKS, LOAD_ORDER, SENT } from '../app/search/packs.js';
import { search, didYouMeanText } from '../app/search/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const optNames = new Set(['--phase', '--top', '--data']);
const queries = args.filter((a, i) => !a.startsWith('--') && !optNames.has(args[i - 1]));
const dataDir = resolve(opt('--data', join(here, '..', 'app', 'data')));
const ranking = flag('--news') ? 'news' : 'fiction';
const top = Number(opt('--top', 10));

let peakRss = 0, peakHeap = 0;
function sampleMem() {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed + m.arrayBuffers);
}
const memTimer = setInterval(sampleMem, 20);

const readFile = async (name, onBytes) => {
  const buf = readFileSync(join(dataDir, name));
  if (onBytes) onBytes(buf.length);
  sampleMem();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

const store = new PackStore(readFile);
const t0 = performance.now();
try {
  await store.loadVersion();
} catch {
  console.error(`No data at ${dataDir} (version.json missing). Build it first: node build/build-data.mjs`);
  process.exit(2);
}
const loadTimes = {};
for (const p of LOAD_ORDER) { // same order as the worker (SPEC 13.4)
  const t = performance.now();
  if (p === 'kanji') { try { await store.loadKanji(); } catch { /* optional */ } loadTimes.kanji = Math.round(performance.now() - t); continue; }
  if (p === SENT) {
    if (store.version.packs && store.version.packs[SENT]) { try { await store.loadSent(); } catch (e) { console.error(`pack sent not loaded: ${e.message}`); } }
    loadTimes[p] = Math.round(performance.now() - t);
    sampleMem();
    continue;
  }
  try { await store.loadPack(p); } catch (e) { console.error(`pack ${p} not loaded: ${e.message}`); }
  loadTimes[p] = Math.round(performance.now() - t);
  const tw = performance.now();
  store.warm(p); // fold index + letter masks, as the worker does after each pack
  loadTimes[p + ' indexes'] = Math.round(performance.now() - tw);
  sampleMem();
}
const loadMs = Math.round(performance.now() - t0);

const head = (h) => { const r = store.getRecord(h.pack, h.id); return (r.k && r.k[0]) || (r.r && r.r[0]) || '?'; };
function line(h) {
  const r = store.getRecord(h.pack, h.id);
  const word = (r.k && r.k[0]) || r.r[0];
  const reading = r.k && r.k.length && r.r ? `【${r.r[0]}】` : '';
  const gloss = r.s ? (r.s[h.sense || 0] || r.s[0]).g.slice(0, 3).join('; ') : (r.g || []).slice(0, 3).join('; ');
  const tags = [`t${h.tier}`];
  if (h.tier === 3 && h.cost) tags.push(`cost ${h.cost}`);
  if (h.via) tags.push(`via ${h.via}`);
  const m = store.meta(h.pack, h.id);
  tags.push(`ff ${m.ff} fn ${m.fn}`);
  return `${word}${reading}  ${gloss}  [${tags.join(', ')}]${h.note ? `  -- ${h.note}` : ''}`;
}

function time(q, phase, n = 5) {
  search(store, q, { ranking, phase }); // warm-up (lazy indexes)
  const ts = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); search(store, q, { ranking, phase }); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}

function show(q) {
  const t = performance.now();
  const res = search(store, q, { ranking, phase: opt('--phase', 'full'), limit: top });
  const ms = (performance.now() - t).toFixed(1);
  if (flag('--json')) { console.log(JSON.stringify(res)); return; }
  console.log(`\n== ${q}  (${res.kind}, canon "${res.canon}", ${ms} ms, ranking ${ranking})`);
  if (res.didYouMean) console.log(`   ${didYouMeanText(res.didYouMean)}`);
  for (const g of res.groups) {
    if (g.id === 'text') { // SPEC 17: the split line, then one row per segment: text -> headword (reading)
      console.log(`  [${g.title}] ${g.wordCount} words; ${(g.notes || []).join(' ')}`);
      console.log(`   split: ${g.segments.map((x) => (x.kind === 'word' ? `[${x.text}]` : x.kind === 'unknown' ? `?${x.text}?` : x.text)).join('')}`);
      for (const x of g.segments) {
        if (x.kind !== 'word') continue;
        const h = g.results[x.item];
        const r = store.getRecord(h.pack, h.id);
        const hw = (r.k && r.k[0]) || (r.r && r.r[0]);
        const extra = [h.pack !== 'words' ? h.pack : '', h.fn ? 'function word' : '', h.via ? `via ${h.via}` : '', h.others ? `${h.others} other entries` : ''].filter(Boolean).join(', ');
        console.log(`   ${x.text} -> ${hw} (${(r.r || [])[0] || ''})${extra ? `  [${extra}]` : ''}`);
      }
      continue;
    }
    console.log(`  [${g.title}] ${g.total} results`);
    g.results.slice(0, top).forEach((h, i) => console.log(`   ${String(i + 1).padStart(2)}. ${line(h)}`));
  }
}

// SPEC section 7 acceptance queries
const SLANG = new Set(['sl', 'net-sl', 'm-sl', 'col', 'vulg']);
const firstResult = (res) => res.groups[0]?.results[0];
const groupOf = (res, id) => res.groups.find((g) => g.id === id);
const ACCEPT = [
  ['jihso', 'fiction', (r) => head(firstResult(r)) === '辞書' && r.didYouMean?.key === 'jisho' && r.didYouMean?.reason === 'letters swapped',
    '辞書 first, did-you-mean "jisho", reason "letters swapped"'],
  ['tensia', 'fiction', (r) => head(firstResult(r)) === '天才' && r.didYouMean?.key === 'tensai',
    '天才 first, did-you-mean "tensai"'],
  ['shojo', 'fiction', (r) => { const t = r.groups[0].results.slice(0, 3).map(head); return t.includes('少女'); },
    '少女 or 処女 in top 3 with 少女 present'],
  ['gakko', 'fiction', (r) => head(firstResult(r)) === '学校', '学校 first'],
  ['konichiwa', 'fiction', (r) => { const h = firstResult(r); const rec = h && store.getRecord(h.pack, h.id); return !!rec && ((rec.k || []).includes('今日は') || (rec.r || []).includes('こんにちは')); },
    'こんにちは / 今日は first'],
  ['kaki', 'fiction', (r) => !r.didYouMean && r.groups.every((g) => g.id === 'en' || g.results.every((h) => h.tier <= 2)),
    'only exact/prefix, no did-you-mean line'],
  ['たべた', 'fiction', (r) => { const h = firstResult(r); return head(h) === '食べる' && /past form/.test(h.note || ''); }, '食べる with past-form note'],
  ['食べさせられた', 'fiction', (r) => head(firstResult(r)) === '食べる', '食べる'],
  ['dictonary', 'fiction', (r) => r.groups[0]?.id === 'en' && r.didYouMean?.query === 'dictionary' && groupOf(r, 'en').results.slice(0, 3).map(head).includes('辞書'),
    'English, corrected to "dictionary", 辞書 in top 3'],
  ['hate', 'fiction', (r) => !!groupOf(r, 'en') && !!groupOf(r, 'words'), 'both groups present'],
  ['ore', 'fiction', (r) => head(firstResult(r)) === '俺', '俺 first under fiction ranking'],
  ['てめえ', 'fiction', (r) => { const h = firstResult(r); const rec = store.getRecord(h.pack, h.id); return (rec.k || []).includes('手前') || (rec.r || []).includes('てめえ'); },
    '手前 / てめえ entry'],
  ['kusa', 'fiction', (r) => {
    const w = groupOf(r, 'words');
    const kusaW = w && w.results.slice(0, 5).find((h) => head(h) === '草');
    const recW = kusaW && store.getRecord('words', kusaW.id);
    const slangW = recW && (recW.s || []).some((s) => (s.m || []).some((m) => SLANG.has(m)));
    const wk = groupOf(r, 'wikt');
    const kusaWk = wk && wk.results.slice(0, 5).some((h) => head(h) === '草');
    return !!(slangW || kusaWk);
  }, '草 with a slang sense (JMdict or Wiktionary) visible'],
  ['tanaka', 'fiction', (r) => !!groupOf(r, 'names')?.results.some((h) => head(h) === '田中'), '田中 in Names'],
];

// SPEC 18: the rows of design/typo-study.md section 3 with a stated "after" (position = in "Japanese words",
// English group for rows 41-45), and the SPEC 19.1 splits.
const rowsOf = (r, id = 'words') => (groupOf(r, id) || { results: [] }).results;
const isForm = (h, f) => { const rec = store.getRecord(h.pack, h.id); return (rec.k || []).includes(f) || (rec.r || []).includes(f); };
const posOf = (r, f, id = 'words') => rowsOf(r, id).findIndex((h) => isForm(h, f));
const firstIs = (f, id = 'words') => (r) => posOf(r, f, id) === 0;
const commonRec = (f) => { const k = store.keySpace('words', 'k'); const i = k.find(f); return i >= 0 && Array.from(k.idsOf(i)).some((id) => store.isCommon('words', id)); };
const splitIs = (parts) => (r) => {
  const g = groupOf(r, 'text');
  return !!g && g.segments.filter((x) => x.kind === 'word').map((x) => x.text).join(' / ') === parts.join(' / ');
};
const STUDY = [
  ['naiso', (r) => posOf(r, '内緒') === 0 && posOf(r, '内装') === 1, '#1 内緒 1st, 内装 2nd'],
  ['naisho', firstIs('内緒'), '#2 内緒 1st'],
  ['kaisa', firstIs('会社'), '#3 会社 1st'],
  ['densa', (r) => { const i = posOf(r, '電車'); return i >= 0 && i <= 1; }, '#4 電車 in the top 2'],
  ['tosokan', (r) => firstIs('図書館')(r) && rowsOf(r)[0].cost === 0.4, '#5 図書館 1st at cost 0.4'],
  ['isso', (r) => firstIs('いっそ')(r) && posOf(r, '一緒') < 0, '#6 いっそ 1st, 一緒 not offered'],
  ['soji', firstIs('掃除'), '#7 掃除 1st'],
  ['sensee', firstIs('先生'), '#8 先生 1st'],
  ['eega', firstIs('映画'), '#9 映画 1st'],
  ['seki', (r) => {
    const rows = rowsOf(r); const i = posOf(r, '世紀');
    const lastCommonT0 = rows.reduce((m, h, k) => (h.tier === 0 && !h.via && store.isCommon(h.pack, h.id) ? k : m), -1);
    return firstIs('席')(r) && i > lastCommonT0;
  }, '#10 席 1st, 世紀 below the common exact rows'],
  ['jitsuwa', (r) => (commonRec('実話') ? posOf(r, '実は') <= 1 && posOf(r, '実は') >= 0 : posOf(r, '実は') === 0), '#11 実は 1st (2nd if 実話 is common)'],
  ['matawa', firstIs('又は'), '#12 又は 1st'],
  ['konnichiwa', firstIs('今日は'), '#13 今日は 1st'],
  ['shimbun', (r) => firstIs('新聞')(r) && rowsOf(r)[0].tier === 0 && !r.didYouMean, '#14 新聞 1st as exact, no line'],
  ['sempai', (r) => firstIs('先輩')(r) && rowsOf(r)[0].tier === 0 && !r.didYouMean, '#15 先輩 1st as exact'],
  ['ohsaka', firstIs('大阪'), '#16 大阪 1st'],
  ['ohkii', firstIs('大きい'), '#17 大きい 1st'],
  ['kalaoke', firstIs('カラオケ'), '#18 カラオケ 1st'],
  ['aligatou', (r) => firstIs('有難う')(r) && rowsOf(r)[0].tier === 0, '#19 有難う 1st, exact'],
  ['taksan', firstIs('沢山'), '#20 沢山 1st'],
  ['yoroshku', firstIs('宜しく'), '#21 宜しく 1st'],
  ['gozaimas', firstIs('御座います'), '#22 御座います 1st'],
  ['jihso', firstIs('辞書'), '#23 辞書 1st'],
  ['kawiai', firstIs('可愛い'), '#24 可愛い 1st'],
  ['nrko', firstIs('猫'), '#25 猫 1st'],
  ['arigto', (r) => posOf(r, 'ありがと') === 0 && posOf(r, '有難う') === 1, '#26 ありがと 1st, 有難う 2nd'],
  ['nekjo', firstIs('猫'), '#27 猫 1st'],
  ['watasjhi', firstIs('私'), '#28 私 1st'],
  ['kakik', (r) => firstIs('書き込む')(r) && !rowsOf(r).some((h) => isForm(h, '活気') && h.promoted), '#29 書き込む 1st, 活気 not promoted'],
  ['kakki', (r) => firstIs('活気')(r) && !rowsOf(r).some((h) => h.tier === 3), '#30 活気 1st, gate closed'],
  ['shiko', firstIs('思考'), '#31 思考 1st'],
  ['gakko', (r) => posOf(r, '学校') === 0 && posOf(r, 'がっこ') === 1, '#32 学校 1st, がっこ 2nd'],
  ['byoin', firstIs('病院'), '#33 病院 1st'],
  ['tokitoki', firstIs('時々'), '#34 時々 1st'],
  ['makisushi', firstIs('巻き寿司'), '#35 巻き寿司 1st'],
  ['ないしよ', firstIs('内緒'), '#36 内緒 1st'],
  ['がつこう', firstIs('学校'), '#37 学校 1st'],
  ['たへもの', firstIs('食べ物'), '#38 食べ物 1st'],
  ['たくえ', (r) => { const near = rowsOf(r).filter((h) => h.tier === 3 && !h.promoted); return near.length > 0 && isForm(near[0], '机'); }, '#39 机 = first near row'],
  ['さごと', firstIs('仕事'), '#40 仕事 1st'],
  ['seperate', (r) => firstIs('離す', 'en')(r) && r.didYouMean?.query === 'separate', '#41 corrected, 離す 1st'],
  ['recieve', (r) => firstIs('受ける', 'en')(r) && r.didYouMean?.query === 'receive', '#42 corrected, 受ける 1st'],
  ['apples', (r) => posOf(r, '林檎', 'en') >= 0, '#43 林檎 listed'],
  ['cats', firstIs('猫', 'en'), '#44 猫 1st (English)'],
  ['running', (r) => { const h = rowsOf(r, 'en')[0]; return !!h && h.tier === 0 && !(h.note || '').includes('plural'); }, '#45 own exact hits first'],
  ['sense', firstIs('先生'), '#47 先生 1st'],
  ['keiki', (r) => {
    const rows = rowsOf(r); const i = posOf(r, 'ケーキ'); const firstT2 = rows.findIndex((h) => h.tier === 2);
    return firstIs('景気')(r) && i > 0 && (firstT2 < 0 || i < firstT2);
  }, '#48 景気 1st, ケーキ in the top block'],
  ['dewa', firstIs('では'), '#49 では 1st'],
  ['rokou', firstIs('旅行'), '#50 旅行 1st'],
  ['hirakana', firstIs('平仮名'), '#51 平仮名 1st'],
  ['biyoin', (r) => posOf(r, '美容院') === 0 && posOf(r, '病院') > 0, '#52 美容院 1st, 病院 after'],
  ['kaki', (r) => !rowsOf(r).some((h) => h.tier === 3) && !rowsOf(r).some((h) => isForm(h, 'かぎ') || isForm(h, 'かに')), '#53 exact rows only, no kagi / kani'],
  ['きよう', (r) => firstIs('器用')(r) && (commonRec('器用') ? posOf(r, '今日') < 0 : true), '#54 器用 1st, 今日 only if the gate opens'],
  ['きょうはいいてんきですね', splitIs(['きょう', 'は', 'いい', 'てんき', 'です', 'ね']), '19.1 きょう / は / いい / てんき / です / ね'],
  ['彼方の空まで', splitIs(['彼方', 'の', '空', 'まで']), '19.1 彼方 / の / 空 / まで'],
  ['食べさせられた子供たち', splitIs(['食べさせられた', '子供たち']), '19.1 食べさせられた / 子供たち'],
  ['国際宇宙ステーション計画', splitIs(['国際宇宙ステーション', '計画']), '19.1 国際宇宙ステーション / 計画'],
];
for (const [q, check, want] of STUDY) ACCEPT.push([q, 'fiction', check, want]);

function accept() {
  let pass = 0;
  const rows = [];
  for (const [q, rk, check, want] of ACCEPT) {
    const res = search(store, q, { ranking: rk, phase: 'full' });
    let ok = false;
    try { ok = !!check(res); } catch { ok = false; }
    if (ok) pass++;
    const n = flag('--top5') ? 5 : 3;
    const top3 = res.groups.map((g) => `${g.title}: ${g.results.slice(0, n).map(head).join(', ')}`).join(' | ');
    rows.push({ q, ok, want, top3, dym: res.didYouMean ? didYouMeanText(res.didYouMean) : '' });
  }
  for (const r of rows) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.q}  (want: ${r.want})`);
    console.log(`      ${r.top3}${r.dym ? `\n      ${r.dym}` : ''}`);
  }
  console.log(`\n${pass}/${rows.length} pass`);
}

function bench() {
  for (const q of ['jisho', 'jihso', 'dictonary', 'naiso', 'kaisa', 'ないしよ']) {
    console.log(`${q.padEnd(10)} fast ${time(q, 'fast').toFixed(1)} ms   full ${time(q, 'full').toFixed(1)} ms`);
  }
}

if (flag('--accept')) accept();
if (flag('--bench')) bench();
for (const q of queries) show(q);
sampleMem();
clearInterval(memTimer);
if (flag('--accept') || flag('--bench') || flag('--mem')) {
  const v = store.version || {};
  console.log(`\ndata built ${v.built} (${v.jmdict}); load ${loadMs} ms ${JSON.stringify(loadTimes)}; records ${[...PACKS, SENT].map((p) => `${p} ${store.size(p)}`).join(', ')}`);
  console.log(`peak memory: rss ${(peakRss / 1048576).toFixed(0)} MB, heap+arrayBuffers ${(peakHeap / 1048576).toFixed(0)} MB; ` +
    `now heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB, arrayBuffers ${(process.memoryUsage().arrayBuffers / 1048576).toFixed(0)} MB`);
}
