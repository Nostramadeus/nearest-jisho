#!/usr/bin/env node
// Checks the packs in app/data against the SPEC section 3 layout.
//   node build/verify-data.mjs
// For each pack: offsets are monotonic and end at the .dat size, 5 sample records decode to JSON,
// meta length = 2*N, key spaces are sorted, ptr is CSR, ids are in range.
// Then: `jisho` (r), `辞書` (k), `dictionary` (e) must resolve to the 辞書 record in words.
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './lib/util.mjs';

let failures = 0;
const fail = (msg) => { failures++; console.log('FAIL', msg); };
const ok = (msg) => console.log('ok  ', msg);

function u32(file) {
  const b = fs.readFileSync(file);
  return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

function loadSpaces(pack) {
  const j = path.join(OUT, `${pack}.keys.json`);
  if (fs.existsSync(j)) {
    const o = JSON.parse(fs.readFileSync(j, 'utf8'));
    return Object.fromEntries(Object.entries(o).map(([s, v]) => [s, { keys: v.keys.split('\n'), ptr: v.ptr, ids: v.ids }]));
  }
  const out = {};
  for (const s of ['r', 'k', 'e']) {
    const t = path.join(OUT, `${pack}.${s}.txt`);
    if (!fs.existsSync(t)) continue;
    out[s] = { keys: fs.readFileSync(t, 'utf8').split('\n'), ptr: u32(path.join(OUT, `${pack}.${s}.ptr`)), ids: u32(path.join(OUT, `${pack}.${s}.ids`)) };
  }
  return out;
}

function openPack(pack) {
  const dat = fs.readFileSync(path.join(OUT, `${pack}.dat`));
  const off = u32(path.join(OUT, `${pack}.off`));
  const meta = u32(path.join(OUT, `${pack}.meta`));
  const n = off.length - 1;
  const rec = (i) => JSON.parse(dat.toString('utf8', off[i], off[i + 1]));
  return { dat, off, meta, n, rec, spaces: loadSpaces(pack) };
}

function lookup(P, space, key) {
  const sp = P.spaces[space];
  let lo = 0, hi = sp.keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = sp.keys[mid];
    if (k === key) return Array.from(sp.ids.slice(sp.ptr[mid], sp.ptr[mid + 1]));
    if (k < key) lo = mid + 1; else hi = mid - 1;
  }
  return [];
}

const expectSpaces = { words: ['r', 'k', 'e'], names: ['r', 'k'], wikt: ['r', 'k', 'e'] };
const opened = {};
for (const pack of ['words', 'names', 'wikt']) {
  if (!fs.existsSync(path.join(OUT, `${pack}.dat`))) { fail(`${pack}: missing`); continue; }
  const P = openPack(pack);
  opened[pack] = P;
  if (P.off[0] !== 0 || P.off[P.n] !== P.dat.length) fail(`${pack}: offsets do not span .dat`);
  let mono = true;
  for (let i = 0; i < P.n; i++) if (P.off[i + 1] <= P.off[i]) { mono = false; break; }
  mono ? ok(`${pack}: ${P.n} records, offsets monotonic`) : fail(`${pack}: offsets not increasing`);
  P.meta.length === 2 * P.n ? ok(`${pack}: meta has 2 values per record`) : fail(`${pack}: meta length ${P.meta.length}`);
  const sample = [0, 1, Math.floor(P.n / 3), Math.floor((2 * P.n) / 3), P.n - 1];
  for (const i of sample) {
    try {
      const r = P.rec(i);
      if (typeof r !== 'object' || !r) throw new Error('not an object');
      ok(`${pack}[${i}] ff=${P.meta[2 * i]} fn=${P.meta[2 * i + 1]} ${JSON.stringify(r).slice(0, 110)}`);
    } catch (e) { fail(`${pack}[${i}]: ${e.message}`); }
  }
  const spaces = Object.keys(P.spaces).sort().join();
  spaces === expectSpaces[pack].slice().sort().join() ? ok(`${pack}: key spaces ${spaces}`) : fail(`${pack}: key spaces ${spaces}`);
  for (const [s, sp] of Object.entries(P.spaces)) {
    let sorted = true;
    for (let i = 1; i < sp.keys.length; i++) if (!(sp.keys[i - 1] < sp.keys[i])) { sorted = false; break; }
    const maxId = s === 'e' ? P.n * 16 : P.n;
    let idsOk = sp.ptr.length === sp.keys.length + 1 && sp.ptr[0] === 0 && sp.ptr[sp.ptr.length - 1] === sp.ids.length;
    for (let i = 0; idsOk && i < sp.ids.length; i++) if (sp.ids[i] >= maxId) idsOk = false;
    sorted && idsOk ? ok(`${pack}.${s}: ${sp.keys.length} keys sorted, ${sp.ids.length} ids in range`) : fail(`${pack}.${s}: sorted=${sorted} ids=${idsOk}`);
  }
}

if (opened.words) {
  const P = opened.words;
  const target = (ids) => ids.map((i) => [i, P.rec(i)]).filter(([, r]) => (r.k || []).includes('辞書'));
  const r = target(lookup(P, 'r', 'jisho'));
  const k = target(lookup(P, 'k', '辞書'));
  const ePacked = lookup(P, 'e', 'dictionary');
  const e = target([...new Set(ePacked.map((x) => Math.floor(x / 16)))]);
  r.length ? ok(`r "jisho" -> record ${r[0][0]} ${JSON.stringify(r[0][1].k)}`) : fail('r "jisho" does not reach 辞書');
  k.length ? ok(`k "辞書" -> record ${k[0][0]}`) : fail('k "辞書" does not reach 辞書');
  const sense = e.length ? ePacked.find((x) => Math.floor(x / 16) === e[0][0]) % 16 : -1;
  e.length ? ok(`e "dictionary" -> record ${e[0][0]} sense ${sense}: ${JSON.stringify(e[0][1].s[sense].g)}`) : fail('e "dictionary" does not reach 辞書');
}

// sentence pack (SPEC 13.3): records are [ja, en, tatoebaId]; key space h with parallel forms.
if (fs.existsSync(path.join(OUT, 'sent.dat'))) {
  const dat = fs.readFileSync(path.join(OUT, 'sent.dat'));
  const off = u32(path.join(OUT, 'sent.off'));
  const n = off.length - 1;
  const rec = (i) => JSON.parse(dat.toString('utf8', off[i], off[i + 1]));
  let mono = off[0] === 0 && off[n] === dat.length;
  for (let i = 0; mono && i < n; i++) if (off[i + 1] <= off[i]) mono = false;
  mono ? ok(`sent: ${n} records, offsets monotonic and span .dat`) : fail('sent: bad offsets');
  for (const i of [0, 1, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]) {
    try {
      const r = rec(i);
      if (!Array.isArray(r) || r.length !== 3 || typeof r[0] !== 'string' || typeof r[1] !== 'string' || !Number.isInteger(r[2])) throw new Error('not [ja, en, id]');
      ok(`sent[${i}] ${JSON.stringify(r).slice(0, 110)}`);
    } catch (e) { fail(`sent[${i}]: ${e.message}`); }
  }
  const o = JSON.parse(fs.readFileSync(path.join(OUT, 'sent.keys.json'), 'utf8'));
  const h = o.h;
  const keys = h.keys.split('\n');
  let sorted = true;
  for (let i = 1; i < keys.length; i++) if (!(keys[i - 1] < keys[i])) { sorted = false; break; }
  let good = h.ptr.length === keys.length + 1 && h.ptr[0] === 0 && h.ptr[h.ptr.length - 1] === h.ids.length && h.forms.length === h.ids.length;
  for (let i = 0; good && i < h.ids.length; i++) if (h.ids[i] >= n || h.forms[i] >= o.formList.length) good = false;
  for (let i = 0; good && i < keys.length; i++) if (h.ptr[i + 1] - h.ptr[i] > 25 || h.ptr[i + 1] <= h.ptr[i]) good = false;
  sorted && good ? ok(`sent.h: ${keys.length} keys sorted, ${h.ids.length} ids and forms in range, 1..25 per key`) : fail(`sent.h: sorted=${sorted} ranges=${good}`);
  const hits = ['辞書', '辞書\tじしょ'].map((k) => { const i = keys.indexOf(k); return i < 0 ? 0 : h.ptr[i + 1] - h.ptr[i]; });
  hits[0] + hits[1] > 0 ? ok(`sent: 辞書 has ${hits[0]} sentences, 辞書<TAB>じしょ has ${hits[1]}`) : fail('sent: no sentence for 辞書');
} else {
  fail('sent: missing');
}

for (const f of ['kanji.json', 'version.json']) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    if (f === 'kanji.json') ok(`kanji.json: ${Object.keys(o).length} characters; 辞 = ${JSON.stringify(o['辞'])}`);
    else ok(`version.json: ${JSON.stringify(o)}`);
  } catch (e) { fail(`${f}: ${e.message}`); }
}

console.log(failures ? `${failures} FAILURES` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
