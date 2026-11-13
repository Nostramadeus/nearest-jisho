// Sentence pack `sent` from Tatoeba (SPEC section 13).
// bzip2 is not in the node standard library: the system `bzip2 -dc` runs as ONE child process at a time and
// its stdout is streamed. The .tar.bz2 is unpacked by the stdlib tar reader in util.mjs (no second tool).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { OUT, download, rmCache, tarExtractOne, lines, log, mb } from './util.mjs';

const URLS = {
  jpn: 'https://downloads.tatoeba.org/exports/per_language/jpn/jpn_sentences.tsv.bz2',
  eng: 'https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2',
  idx: 'https://downloads.tatoeba.org/exports/jpn_indices.tar.bz2',
};
const MAX_PER_KEY = 25;

/** Async line iterator over `bzip2 -dc file` (optionally through the tar reader). */
async function* bz2Lines(file, isTar) {
  const child = spawn('bzip2', ['-dc', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  const src = isTar ? child.stdout.pipe(tarExtractOne()) : child.stdout;
  try {
    for await (const line of lines(src)) yield line;
  } finally {
    const code = await exited;
    if (code !== 0) throw new Error(`bzip2 -dc ${path.basename(file)} exited ${code}: ${stderr.trim()}`);
  }
}

/** Check that `bzip2` can be spawned. */
async function haveBzip2() {
  return new Promise((resolve) => {
    const c = spawn('bzip2', ['--help'], { stdio: 'ignore', windowsHide: true });
    c.on('error', () => resolve(false));
    c.on('close', () => resolve(true));
  });
}

/**
 * One index token `headword(reading)[sense]{form}~` -> { head, reading, form, good }.
 * Every part after the headword is optional.
 */
export function parseToken(tok) {
  const m = /^([^([{~]+)(?:\(([^)]*)\))?(?:\[([^\]]*)\])?(?:\{([^}]*)\})?(~)?$/.exec(tok);
  if (!m) return null;
  return { head: m[1], reading: m[2] || '', form: m[4] || '', good: !!m[5] };
}

export async function buildSent({ toHiragana }) {
  if (!(await haveBzip2())) throw new Error('system tool `bzip2` not found');
  const t0 = Date.now();

  // 1. indices: per key the candidate tokens; remember which sentence ids are needed.
  const idxFile = await download(URLS.idx, 'jpn_indices.tar.bz2');
  const byKey = new Map(); // key -> Map(sid -> [good, form])
  const meaning = new Map(); // jpn sid -> eng sid
  let idxLines = 0, badTokens = 0, firstLine = null;
  for await (const line of bz2Lines(idxFile, true)) {
    if (!line) continue;
    if (firstLine === null) firstLine = line;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const sid = Number(parts[0]);
    const eid = Number(parts[1]);
    if (!sid || !eid) continue;
    idxLines++;
    meaning.set(sid, eid);
    for (const tok of parts[2].split(' ')) {
      if (!tok) continue;
      const t = parseToken(tok);
      if (!t) { badTokens++; continue; }
      const key = t.reading ? `${t.head}\t${toHiragana(t.reading)}` : t.head;
      let m = byKey.get(key);
      if (!m) { m = new Map(); byKey.set(key, m); }
      const form = t.form || t.head;
      const prev = m.get(sid);
      if (!prev) m.set(sid, [t.good, form]);
      else if (t.good && !prev[0]) m.set(sid, [true, form]); // a checked token wins for this sentence
    }
  }
  rmCache(idxFile);
  if (idxLines < 1000) throw new Error(`jpn_indices: only ${idxLines} lines (first line: ${firstLine})`);
  log(`  jpn_indices: ${idxLines} lines, ${byKey.size} keys, ${badTokens} unparsed tokens`);

  // 2. Japanese texts of indexed sentences; 3. English texts of their meaning ids.
  const readTexts = async (url, name, wanted) => {
    const file = await download(url, name);
    const out = new Map();
    let n = 0;
    for await (const line of bz2Lines(file, false)) {
      const a = line.indexOf('\t');
      const b = line.indexOf('\t', a + 1);
      if (a < 0 || b < 0) continue;
      n++;
      const id = Number(line.slice(0, a));
      if (wanted.has(id)) out.set(id, line.slice(b + 1));
    }
    rmCache(file);
    if (n < 1000) throw new Error(`${name}: only ${n} lines`);
    log(`  ${name}: ${n} lines, ${out.size} needed`);
    return out;
  };
  const jpn = await readTexts(URLS.jpn, 'jpn_sentences.tsv.bz2', meaning);
  const engWanted = new Set();
  for (const [sid, eid] of meaning) if (jpn.has(sid)) engWanted.add(eid);
  const eng = await readTexts(URLS.eng, 'eng_sentences.tsv.bz2', engWanted);
  const usable = (sid) => jpn.has(sid) && eng.has(meaning.get(sid));

  // 4. per key: up to 25 sentences in SPEC 13.2 order.
  const len = new Map();
  const jlen = (sid) => {
    let v = len.get(sid);
    if (v === undefined) { v = [...jpn.get(sid)].length; len.set(sid, v); }
    return v;
  };
  const keys = [...byKey.keys()].sort();
  const chosen = []; // per key: [[sid, form], ...]
  const keep = new Set();
  const finalKeys = [];
  for (const key of keys) {
    const cand = [];
    for (const [sid, [good, form]] of byKey.get(key)) if (usable(sid)) cand.push([sid, good, form]);
    if (!cand.length) continue;
    cand.sort((x, y) => {
      if (x[1] !== y[1]) return x[1] ? -1 : 1;
      const lx = jlen(x[0]), ly = jlen(y[0]);
      const sx = lx < 6, sy = ly < 6;
      if (sx !== sy) return sx ? 1 : -1;
      if (lx !== ly) return lx - ly;
      return x[0] - y[0];
    });
    const top = cand.slice(0, MAX_PER_KEY).map(([sid, , form]) => [sid, form]);
    for (const [sid] of top) keep.add(sid);
    finalKeys.push(key);
    chosen.push(top);
  }
  byKey.clear();

  // 5. records in ascending Tatoeba id order.
  const sids = [...keep].sort((a, b) => a - b);
  const recId = new Map(sids.map((s, i) => [s, i]));
  fs.mkdirSync(OUT, { recursive: true });
  const P = (ext) => path.join(OUT, `sent${ext}`);
  const offsets = new Uint32Array(sids.length + 1);
  const chunks = [];
  let pos = 0;
  sids.forEach((sid, i) => {
    const buf = Buffer.from(JSON.stringify([jpn.get(sid), eng.get(meaning.get(sid)), sid]), 'utf8');
    chunks.push(buf);
    pos += buf.length;
    offsets[i + 1] = pos;
  });
  fs.writeFileSync(P('.dat.tmp'), Buffer.concat(chunks));
  fs.renameSync(P('.dat.tmp'), P('.dat'));
  fs.writeFileSync(P('.off'), Buffer.from(offsets.buffer));

  const formIndex = new Map();
  const formList = [];
  const ptr = [0];
  const ids = [];
  const forms = [];
  for (const top of chosen) {
    for (const [sid, form] of top) {
      let fi = formIndex.get(form);
      if (fi === undefined) { fi = formList.length; formIndex.set(form, fi); formList.push(form); }
      ids.push(recId.get(sid));
      forms.push(fi);
    }
    ptr.push(ids.length);
  }
  const json = `{"h":{"keys":${JSON.stringify(finalKeys.join('\n'))},"ptr":[${ptr.join(',')}],"ids":[${ids.join(',')}],"forms":[${forms.join(',')}]},"formList":${JSON.stringify(formList)}}`;
  fs.writeFileSync(P('.keys.json'), json);

  const files = ['.dat', '.off', '.keys.json'].map(P);
  const bytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);
  const sizes = Object.fromEntries(files.map((f) => [path.basename(f), fs.statSync(f).size]));
  log(`sent: ${sids.length} sentences, ${finalKeys.length} keys, ${ids.length} key entries, ${formList.length} forms, ${mb(bytes)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return { n: sids.length, bytes, keys: finalKeys.length, entries: ids.length, forms: formList.length, sizes, idxLines, badTokens, firstLine };
}
