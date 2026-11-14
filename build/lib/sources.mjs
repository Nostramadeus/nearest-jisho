// Small side sources: jmdict-simplified release lookup, JMdict priority tags, jiten.moe ranks, JLPT levels.
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { fetchOk, fetchJson, lines, log } from './util.mjs';

const REPO = 'scriptin/jmdict-simplified';

/** Latest jmdict-simplified release: { tag, url(prefix) } with url(prefix) -> .json.tgz asset URL. */
export async function latestRelease() {
  let tag, assets = [];
  try {
    const j = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    tag = j.tag_name;
    assets = j.assets.map((a) => ({ name: a.name, url: a.browser_download_url }));
  } catch (e) {
    // API rate limit or outage: read the tag from the /releases/latest redirect.
    log(`GitHub API failed (${e.message}); using the releases/latest redirect`);
    const res = await fetchOk(`https://github.com/${REPO}/releases/latest`);
    tag = decodeURIComponent(res.url.split('/tag/')[1] || '');
    if (!tag) throw new Error('cannot resolve jmdict-simplified release tag');
  }
  const version = tag.split('+')[0];
  const url = (prefix) => {
    const want = `${prefix}-${tag}.json.tgz`;
    const a = assets.find((x) => x.name === want) || assets.find((x) => x.name.startsWith(prefix + '-') && x.name.endsWith('.json.tgz'));
    if (a) return a.url;
    return `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(want)}`;
  };
  return { tag, version, url };
}

/**
 * JMdict priority tags -> fn rank per entry sequence number (SPEC 2.2).
 * jmdict-simplified keeps only a `common` flag, so the tags are read from the EDRDG JMdict_e.gz XML.
 * Returns Map(seq -> fn) holding only entries with a rank < 999999.
 */
export async function loadPriority() {
  // The EDRDG web server times out now and then: 5 tries with 20 s pauses, then one try at the FTP mirror over http.
  const primary = 'https://www.edrdg.org/pub/Nihongo/JMdict_e.gz';
  const fallback = 'http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz';
  for (let attempt = 0; ; attempt++) {
    const url = attempt < 5 ? primary : fallback;
    log(`priority tags from ${url}`);
    try {
      const res = await fetchOk(url);
      const src = Readable.fromWeb(res.body).pipe(zlib.createGunzip());
      const out = new Map();
      const rePri = new Map(); // SPEC 27.2: seq -> Set of kana forms (reb) that carry a re_pri tag
      out.rePri = rePri;
      let seq = null, nf = Infinity, p1 = false, p2 = false, entries = 0, reb = null;
      for await (const line of lines(src)) {
        let m;
        if ((m = /<ent_seq>(\d+)<\/ent_seq>/.exec(line))) { seq = Number(m[1]); nf = Infinity; p1 = p2 = false; reb = null; continue; }
        if ((m = /<reb>([^<]+)<\/reb>/.exec(line))) { reb = m[1]; continue; }
        if ((m = /<re_pri>[^<]+<\/re_pri>/.exec(line)) && reb !== null && seq !== null) {
          let set = rePri.get(seq);
          if (!set) rePri.set(seq, (set = new Set()));
          set.add(reb);
        }
        if ((m = /<(?:ke|re)_pri>([^<]+)<\/(?:ke|re)_pri>/.exec(line))) {
          const t = m[1];
          if (/^nf\d\d$/.test(t)) nf = Math.min(nf, Number(t.slice(2)));
          else if (/^(news1|ichi1|spec1|gai1)$/.test(t)) p1 = true;
          else if (/^(news2|ichi2|spec2|gai2)$/.test(t)) p2 = true;
          continue;
        }
        if (line.includes('</entry>')) {
          entries++;
          const fn = nf !== Infinity ? nf * 500 : p1 ? 15000 : p2 ? 35000 : 999999;
          if (fn < 999999 && seq !== null) out.set(seq, fn);
          seq = null;
        }
      }
      if (entries < 100000) throw new Error(`JMdict_e: only ${entries} entries parsed`);
      log(`  ${entries} entries, ${out.size} with priority tags, ${rePri.size} with a reading priority tag (re_pri)`);
      return out;
    } catch (e) {
      if (attempt >= 5) throw e;
      log(`  retry (${e.message})`);
      await new Promise((r) => setTimeout(r, 20000));
    }
  }
}

/**
 * jiten.moe GLOBAL frequency list (CSV: Word,Form,Rank). Returns { pair, word } maps or null when it cannot
 * be fetched/parsed (SPEC 2.2: then ff = fn). pair key = word + '\t' + hiragana(reading).
 */
export async function loadJiten(toHiragana) {
  const url = 'https://api.jiten.moe/api/frequency-list/download?downloadType=csv';
  log(`jiten.moe global list ${url}`);
  try {
    const res = await fetchOk(url);
    const pair = new Map();
    const exact = new Map(); // word + '\t' + reading as written in the CSV (names pack: exact match)
    const word = new Map();
    const byWord = new Map(); // word -> [[hiragana reading, rank], ...]
    let first = true, rows = 0;
    for await (const line of lines(Readable.fromWeb(res.body))) {
      if (first) {
        first = false;
        if (!/^﻿?Word,Form,Rank/i.test(line)) throw new Error(`unexpected CSV header: ${line.slice(0, 60)}`);
        continue;
      }
      if (!line) continue;
      const parts = line.split(',');
      if (parts.length < 3) continue;
      const rank = Number(parts[parts.length - 1]);
      const form = parts[parts.length - 2];
      const w = parts.slice(0, -2).join(',');
      if (!Number.isFinite(rank) || !w) continue;
      rows++;
      const hira = toHiragana(form);
      const pk = w + '\t' + hira;
      if (!(pair.get(pk) <= rank)) pair.set(pk, rank);
      const ek = w + '\t' + form;
      if (!(exact.get(ek) <= rank)) exact.set(ek, rank);
      if (!(word.get(w) <= rank)) word.set(w, rank);
      let list = byWord.get(w);
      if (!list) { list = []; byWord.set(w, list); }
      list.push([hira, rank]);
    }
    if (rows < 10000) throw new Error(`only ${rows} rows`);
    log(`  ${rows} rows, ${word.size} distinct words`);
    return { pair, exact, word, byWord, rows };
  } catch (e) {
    log(`  jiten.moe list NOT available (${e.message}); ff = fn for all records`);
    return null;
  }
}

/**
 * JLPT level per JMdict sequence number from stephenmk/yomitan-jlpt-vocab original_data/n1..n5.csv.
 * A sequence listed at several levels keeps the easiest level (highest N number); see PROGRESS-data.md.
 */
export async function loadJlpt() {
  const map = new Map();
  let rows = 0, noSeq = 0, multi = 0;
  for (const n of [5, 4, 3, 2, 1]) {
    const url = `https://raw.githubusercontent.com/stephenmk/yomitan-jlpt-vocab/main/original_data/n${n}.csv`;
    const text = await (await fetchOk(url)).text();
    const ls = text.split(/\r?\n/);
    if (!/^jmdict_seq,/.test(ls[0])) throw new Error(`JLPT n${n}.csv: unexpected header ${ls[0]}`);
    for (const l of ls.slice(1)) {
      if (!l) continue;
      rows++;
      const seq = Number(l.split(',')[0]);
      if (!seq) { noSeq++; continue; }
      if (map.has(seq)) { multi++; continue; } // already set at an easier level (loop goes N5 -> N1)
      map.set(seq, n);
    }
  }
  log(`JLPT: ${rows} rows, ${map.size} entries, ${noSeq} rows without JMdict id, ${multi} repeats at a harder level`);
  return { map, rows, noSeq, multi };
}
