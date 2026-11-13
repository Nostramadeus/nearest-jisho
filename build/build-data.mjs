#!/usr/bin/env node
// Data build entry (SPEC sections 2 and 3).
//   node build/build-data.mjs [--only words,names,kanji,wikt]
// Downloads the sources, writes the packs into app/data/, writes app/data/version.json.
// Node stdlib only. Temporary files live in build/.cache/ and are deleted when their pack is written.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, OUT, log, mb } from './lib/util.mjs';
import { latestRelease, loadPriority, loadJiten, loadJlpt } from './lib/sources.mjs';
import { buildWords, buildNames, buildKanji, buildWikt } from './lib/packs.mjs';

const ALL = ['words', 'names', 'kanji', 'wikt'];

function parseArgs(argv) {
  let only = ALL;
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

async function main() {
  const { only } = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  // The canonical romaji used for space r is the app's own (app/search/romaji.js), so build and search agree.
  const romaji = await import(pathToFileURL(path.join(ROOT, 'app', 'search', 'romaji.js')).href);
  for (const f of ['kanaToRomaji', 'toHiragana']) if (typeof romaji[f] !== 'function') throw new Error(`app/search/romaji.js lacks ${f}()`);

  const release = await latestRelease();
  log(`jmdict-simplified release ${release.tag}`);
  const report = { release: release.tag, packs: {} };

  const jiten = only.some((p) => p !== 'kanji') ? await loadJiten(romaji.toHiragana) : null;
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
