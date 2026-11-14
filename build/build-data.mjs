#!/usr/bin/env node
// Data build entry (SPEC sections 2 and 3).
//   node build/build-data.mjs [--only words,names,kanji,wikt,sent,pitch]
//   node build/build-data.mjs --rehash      (only adds per-pack files + hash to version.json, SPEC 14.2)
// Downloads the sources, writes the packs into app/data/, writes app/data/version.json.
// Node stdlib only. Temporary files live in build/.cache/ and are deleted when their pack is written.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, OUT, log, mb } from './lib/util.mjs';
import { latestRelease, loadPriority, loadJiten, loadJlpt } from './lib/sources.mjs';
import { buildWords, buildNames, buildKanji, buildWikt } from './lib/packs.mjs';
import { buildSent } from './lib/sent.mjs';
import { buildPitch } from './lib/pitch.mjs';
import { addPackHashes } from './lib/packwriter.mjs';

const ALL = ['words', 'names', 'kanji', 'wikt', 'sent', 'pitch']; // pitch reads the words pack (SPEC 25)

function parseArgs(argv) {
  let only = ALL;
  if (argv.length === 1 && argv[0] === '--rehash') return { only: [], rehash: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') only = argv[++i].split(',');
    else if (a.startsWith('--only=')) only = a.slice(7).split(',');
    else throw new Error(`unknown argument ${a}`);
  }
  only = only.map((s) => s.trim()).filter(Boolean);
  for (const p of only) if (!ALL.includes(p)) throw new Error(`unknown pack ${p} (use ${ALL.join(',')})`);
  return { only };
}

function readVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, 'version.json'), 'utf8')); } catch { return { packs: {} }; }
}

function writeVersion(release, packs) {
  const v = readVersion();
  v.built = new Date().toISOString().slice(0, 10);
  v.jmdict = release.tag;
  v.packs = { ...(v.packs || {}), ...packs };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify(v, null, 1) + '\n');
}

/** SPEC 14.2 / 15: write "files", "hash" and "gz" of every pack into version.json (built is not touched). */
function writeHashes() {
  const v = readVersion();
  addPackHashes(OUT, v);
  fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify(v, null, 1) + '\n');
  log(`version.json hashes: ${Object.entries(v.packs || {}).map(([p, e]) => `${p} ${e.hash || 'MISSING'} gz ${e.gz}`).join(', ')}`);
}

async function main() {
  const { only, rehash } = parseArgs(process.argv.slice(2));
  if (rehash) { writeHashes(); return; } // node build/build-data.mjs --rehash: hashes for the data already in app/data
  const t0 = Date.now();
  // The canonical romaji used for space r is the app's own (app/search/romaji.js), so build and search agree.
  const romaji = await import(pathToFileURL(path.join(ROOT, 'app', 'search', 'romaji.js')).href);
  for (const f of ['kanaToRomaji', 'toHiragana']) if (typeof romaji[f] !== 'function') throw new Error(`app/search/romaji.js lacks ${f}()`);

  const release = await latestRelease();
  log(`jmdict-simplified release ${release.tag}`);
  const report = { release: release.tag, packs: {} };

  const jiten = only.some((p) => ['words', 'names', 'wikt'].includes(p)) ? await loadJiten(romaji.toHiragana) : null;
  report.jiten = jiten ? { rows: jiten.rows } : 'not available: ff = fn';

  if (only.includes('words')) {
    const [jlpt, priority] = [await loadJlpt(), await loadPriority()];
    const r = await buildWords({ release, romaji, jiten, jlpt, priority });
    writeVersion(release, { words: { n: r.n, bytes: r.bytes } });
    report.packs.words = r;
    report.jlpt = { rows: jlpt.rows, entries: jlpt.map.size, noSeq: jlpt.noSeq, repeats: jlpt.multi };
    log('JMdict records carrying misc tags:', JSON.stringify(r.miscCount));
  }
  if (only.includes('names')) {
    const r = await buildNames({ release, romaji, jiten });
    writeVersion(release, { names: { n: r.n, bytes: r.bytes } });
    report.packs.names = r;
  }
  if (only.includes('kanji')) {
    const r = await buildKanji({ release });
    writeVersion(release, { kanji: { n: r.n, bytes: r.bytes } });
    report.packs.kanji = r;
  }
  if (only.includes('wikt')) {
    const r = await buildWikt({ romaji, jiten });
    writeVersion(release, { wikt: { n: r.n, bytes: r.bytes } });
    report.packs.wikt = r;
  }
  if (only.includes('sent')) {
    // SPEC 13.1: missing tools or a failed URL skip this pack locally, and fail the build on CI.
    try {
      const r = await buildSent({ toHiragana: romaji.toHiragana });
      writeVersion(release, { sent: { n: r.n, bytes: r.bytes } });
      report.packs.sent = r;
    } catch (e) {
      if (process.env.CI) throw new Error(`sent pack failed on CI: ${e.message}`);
      log(`WARNING: sent pack SKIPPED (${e.message}). The other packs are unaffected.`);
      report.packs.sent = { skipped: e.message };
    }
  }
  if (only.includes('pitch')) {
    // SPEC 25: UniDic pitch accent, joined to the words pack in app/data. CI only (about 660 MB download).
    const r = await buildPitch({ toHiragana: romaji.toHiragana });
    writeVersion(release, { pitch: { n: r.n, bytes: r.bytes } });
    report.packs.pitch = r;
  }
  writeHashes();
  fs.mkdirSync(path.join(ROOT, 'build', '.cache'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'build', '.cache', 'last-build-report.json'), JSON.stringify(report, null, 1));
  let total = 0;
  for (const f of fs.readdirSync(OUT)) total += fs.statSync(path.join(OUT, f)).size;
  log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s; app/data holds ${mb(total)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
