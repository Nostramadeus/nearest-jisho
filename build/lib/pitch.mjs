// Pitch pack `pitch` from UniDic cwj (SPEC 25). Runs on CI only (the zip is about 660 MB).
// `unzip` is not in the node standard library: the system `unzip` runs as ONE child process at a time and its
// stdout is streamed (the dictionary file is never written to disk unpacked).
// UniDic is used under the BSD 3-clause option of its GPL 2.0 / LGPL 2.1 / BSD licence; the BSD text from the zip
// is stored in pitch.json ("license").
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { OUT, download, rmCache, lines, log, mb } from './util.mjs';
import { pitchKey, fittingValues, accentValues, readingsByPriority } from '../../app/search/pitch.js';

export const UNIDIC = {
  name: 'unidic-cwj-202512',
  url: 'https://clrd.ninjal.ac.jp/unidic_archive/2512/unidic-cwj-202512.zip',
};
// UniDic feature fields (after surface,left,right,cost in lex.csv; the whole string in sys.dic):
// pos1..4 cType cForm lForm lemma orth(8) pron orthBase pronBase goshu iType iForm fType fForm iConType fConType
// type kana(20) kanaBase form formBase aType(24) aConType aModType lid lemma_id
const F = { orth: 8, kana: 20, aType: 24 };

/** Split one CSV line (MeCab style: fields with a comma are in double quotes, "" is a quote). */
export function csvFields(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function unzipStream(zip, entry) {
  const child = spawn('unzip', ['-p', zip, entry], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { stdout: child.stdout, done: async () => { const c = await exited; if (c !== 0) throw new Error(`unzip -p ${entry} exited ${c}: ${stderr.trim()}`); } };
}

/** Feature strings of a compiled MeCab dictionary (sys.dic): header 72 bytes, double array, tokens, features. */
export async function* sysDicFeatures(stream) {
  let head = Buffer.alloc(0), skip = -1, left = 0, part = Buffer.alloc(0);
  for await (let chunk of stream) {
    if (skip < 0) {
      head = Buffer.concat([head, chunk]);
      if (head.length < 72) continue;
      const dsize = head.readUInt32LE(24), tsize = head.readUInt32LE(28), fsize = head.readUInt32LE(32);
      const charset = head.toString('latin1', 40, 72).replace(/\0.*$/s, '');
      log(`  sys.dic: lexsize ${head.readUInt32LE(12)}, dsize ${dsize}, tsize ${tsize}, fsize ${fsize}, charset ${charset}`);
      if (!/utf-?8/i.test(charset)) throw new Error(`sys.dic charset ${charset} is not UTF-8`);
      skip = dsize + tsize; left = fsize;
      chunk = head.subarray(72);
    }
    if (skip > 0) { const n = Math.min(skip, chunk.length); skip -= n; chunk = chunk.subarray(n); }
    if (!chunk.length || left <= 0) continue;
    if (chunk.length > left) chunk = chunk.subarray(0, left);
    left -= chunk.length;
    let buf = part.length ? Buffer.concat([part, chunk]) : chunk, start = 0;
    for (let i = buf.indexOf(0); i !== -1; i = buf.indexOf(0, start)) {
      if (i > start) yield buf.toString('utf8', start, i);
      start = i + 1;
    }
    part = Buffer.from(buf.subarray(start));
  }
}

/** Read words.dat / words.off from app/data and call fn(record) for every record. */
function eachWord(fn) {
  const dat = fs.readFileSync(path.join(OUT, 'words.dat'));
  const offB = fs.readFileSync(path.join(OUT, 'words.off'));
  const off = new Uint32Array(offB.buffer, offB.byteOffset, offB.byteLength / 4);
  for (let i = 0; i + 1 < off.length; i++) fn(JSON.parse(dat.toString('utf8', off[i], off[i + 1])));
}

export async function buildPitch({ toHiragana }) {
  if (!fs.existsSync(path.join(OUT, 'words.dat'))) throw new Error('pitch needs the words pack in app/data (build words first)');
  const t0 = Date.now();

  // 1. What the words pack asks for. Kanji records: the pairs (each kanji form, first kana form); kana-only
  //    records: the first kana form. All kana in hiragana.
  const wantPair = new Set(), wantKana = new Set();
  let records = 0;
  eachWord((rec) => {
    records++;
    const r = readingsByPriority(rec)[0];
    if (!r) return;
    if (rec.k && rec.k.length) for (const k of rec.k) wantPair.add(`${k}\t${toHiragana(r)}`);
    else wantKana.add(toHiragana(r));
  });
  log(`  words: ${records} records, ${wantPair.size} (kanji, kana) pairs and ${wantKana.size} kana-only forms wanted`);

  // 2. UniDic: per (orth, kana) the accent values of every row with that pair.
  const zip = await download(UNIDIC.url, `${UNIDIC.name}.zip`);
  const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 1 << 24 }).split('\n').map((s) => s.trim()).filter(Boolean);
  log(`  zip entries: ${entries.join(', ')}`);
  const bsd = entries.find((e) => /bsd/i.test(path.basename(e)) && !e.endsWith('/'));
  if (!bsd) throw new Error('no BSD licence file in the UniDic zip');
  const license = execFileSync('unzip', ['-p', zip, bsd], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();
  log(`  licence file ${bsd}: ${license.split('\n').slice(0, 3).join(' | ')}`);
  const lex = entries.find((e) => path.basename(e) === 'lex.csv');
  const sys = entries.find((e) => path.basename(e) === 'sys.dic');
  if (!lex && !sys) throw new Error('UniDic zip has neither lex.csv nor sys.dic');

  const pairVals = new Map();   // "orth\thira" -> values in first-seen order (wanted pairs only)
  const kanaSets = new Map();   // hira -> Map(orth -> values) (wanted kana only)
  let rows = 0, withAccent = 0, shown = 0, proper = 0;
  const WATCH = new Set(['橋\tはし', '箸\tはし', '端\tはし']); // logged rows: the CI check words (SPEC 25.3)
  const add = (f) => {
    rows++;
    if (f.length <= F.aType) return;
    if (shown < 3) { shown++; log(`  sample features: ${f.slice(0, 27).join(',')}`); }
    const orth = f[F.orth], hira = toHiragana(f[F.kana]);
    const pk = `${orth}\t${hira}`;
    if (WATCH.has(pk)) log(`  row ${pk.replace('\t', '/')}: ${f.slice(0, 8).join(',')} aType ${f[F.aType]}`);
    // SPEC 25.2: proper nouns (surnames, place names) are not the JMdict words; their accent is not borrowed
    if (f[1] === '固有名詞') { proper++; return; }
    const vals = accentValues(f[F.aType]);
    if (!vals.length) return;
    withAccent++;
    if (wantPair.has(pk)) {
      const cur = pairVals.get(pk) || [];
      for (const v of vals) if (!cur.includes(v)) cur.push(v);
      pairVals.set(pk, cur);
    }
    if (wantKana.has(hira)) {
      let m = kanaSets.get(hira);
      if (!m) { m = new Map(); kanaSets.set(hira, m); }
      const cur = m.get(orth) || [];
      for (const v of vals) if (!cur.includes(v)) cur.push(v);
      m.set(orth, cur);
    }
  };
  const src = lex || sys;
  log(`  reading ${src}`);
  const u = unzipStream(zip, src);
  if (lex) { for await (const line of lines(u.stdout)) if (line) add(csvFields(line).slice(4)); }
  else { for await (const s of sysDicFeatures(u.stdout)) add(csvFields(s)); }
  await u.done();
  rmCache(zip);
  if (rows < 100000) throw new Error(`UniDic: only ${rows} rows read from ${src}`);
  log(`  UniDic: ${rows} rows, ${proper} proper-noun rows skipped, ${withAccent} with an accent type, ${pairVals.size} wanted pairs found`);

  // 3. Join (SPEC 25): exact (kanji form, kana form) of a record: the first kanji form that has the pair wins.
  //    Kana-only records: only when every UniDic entry of that kana has the same accent set. Never guessed.
  const out = {};
  let kanjiHits = 0, kanaHits = 0, kanaAmbiguous = 0, dropped = 0;
  eachWord((rec) => {
    const key = pitchKey(rec);
    if (!key || key in out) return;
    const r = readingsByPriority(rec)[0];
    let vals = null;
    if (rec.k && rec.k.length) {
      for (const k of rec.k) { const v = pairVals.get(`${k}\t${toHiragana(r)}`); if (v) { vals = v; break; } }
      if (vals) kanjiHits++;
    } else {
      const m = kanaSets.get(toHiragana(r));
      if (m) {
        const sets = new Set([...m.values()].map((v) => v.slice().sort((a, b) => a - b).join(',')));
        if (sets.size === 1) { vals = m.values().next().value; kanaHits++; } else kanaAmbiguous++;
      }
    }
    if (!vals) return;
    const fit = fittingValues(r, vals.join(','));
    if (!fit.length) { dropped++; return; }
    out[key] = fit.join(',');
  });
  const keys = Object.keys(out).sort();
  const a = {};
  for (const k of keys) a[k] = out[k];
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'pitch.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ source: UNIDIC.name, url: UNIDIC.url, license, a }));
  fs.renameSync(file + '.tmp', file);
  const bytes = fs.statSync(file).size;
  log(`pitch: ${keys.length} keys (kanji pairs ${kanjiHits}, kana-only ${kanaHits}, kana-only with several accent sets ${kanaAmbiguous}, values not fitting the kana ${dropped}), ${mb(bytes)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return { n: keys.length, bytes, kanjiHits, kanaHits, kanaAmbiguous, dropped, rows, source: UNIDIC.name };
}
