#!/usr/bin/env node
// CLI: node tools/query.mjs "jihso" [more queries] [--news] [--phase fast|full] [--top N] [--data DIR] [--json]
//      node tools/query.mjs --accept     runs the SPEC section 7 acceptance queries, prints pass/fail + top 3
//      node tools/query.mjs --bench      timings of phase fast/full for jisho, jihso, dictonary + peak memory
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackStore, PACKS } from '../app/search/packs.js';
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
for (const p of PACKS) {
  const t = performance.now();
  try { await store.loadPack(p); } catch (e) { console.error(`pack ${p} not loaded: ${e.message}`); }
  loadTimes[p] = Math.round(performance.now() - t);
  const tw = performance.now();
  store.warm(p); // fold index + letter masks, as the worker does after each pack
  loadTimes[p + ' indexes'] = Math.round(performance.now() - tw);
  sampleMem();
}
try { await store.loadKanji(); } catch { /* optional */ }
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

function accept() {
  let pass = 0;
  const rows = [];
  for (const [q, rk, check, want] of ACCEPT) {
    const res = search(store, q, { ranking: rk, phase: 'full' });
    let ok = false;
    try { ok = !!check(res); } catch { ok = false; }
    if (ok) pass++;
    const top3 = res.groups.map((g) => `${g.title}: ${g.results.slice(0, 3).map(head).join(', ')}`).join(' | ');
    rows.push({ q, ok, want, top3, dym: res.didYouMean ? didYouMeanText(res.didYouMean) : '' });
  }
  for (const r of rows) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.q}  (want: ${r.want})`);
    console.log(`      ${r.top3}${r.dym ? `\n      ${r.dym}` : ''}`);
  }
  console.log(`\n${pass}/${rows.length} pass`);
}

function bench() {
  for (const q of ['jisho', 'jihso', 'dictonary']) {
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
  console.log(`\ndata built ${v.built} (${v.jmdict}); load ${loadMs} ms ${JSON.stringify(loadTimes)}; records ${PACKS.map((p) => `${p} ${store.size(p)}`).join(', ')}`);
  console.log(`peak memory: rss ${(peakRss / 1048576).toFixed(0)} MB, heap+arrayBuffers ${(peakHeap / 1048576).toFixed(0)} MB; ` +
    `now heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB, arrayBuffers ${(process.memoryUsage().arrayBuffers / 1048576).toFixed(0)} MB`);
}
