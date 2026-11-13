#!/usr/bin/env node
// CI (SPEC 14.1): reuse the published data instead of rebuilding it.
//   node tools/reuse-data.mjs [--base URL] [--out DIR]
// Reads <base>/version.json, downloads every file each pack lists into DIR (default app/data), checks each pack's
// hash, then writes the published version.json (adding "gz" when it lacks it; "built" and hashes unchanged).
// Exit 0 with one summary line; exit 1 with the reason (404, hash mismatch, no "files" list, ...).
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { packHash, packGz } from '../build/lib/packwriter.mjs';

const PACKS = ['words', 'names', 'wikt', 'sent', 'kanji'];

export async function reuseData({ base, out, fetchFn = fetch, log = () => {} }) {
  const vr = await fetchFn(new URL('version.json', base).href, { cache: 'no-store' });
  if (!vr.ok) throw new Error(`published version.json: HTTP ${vr.status}`);
  const text = await vr.text();
  const v = JSON.parse(text);
  if (!v.built || !v.packs) throw new Error('published version.json has no "built" or "packs"');
  for (const p of PACKS) {
    const e = v.packs[p];
    if (!e) throw new Error(`published version.json does not list pack ${p}`);
    if (!Array.isArray(e.files) || !e.files.length) throw new Error(`published version.json: pack ${p} has no "files" list`);
    if (!/^[0-9a-f]{16}$/.test(e.hash || '')) throw new Error(`published version.json: pack ${p} has no hash`);
  }
  fs.mkdirSync(out, { recursive: true });
  let bytes = 0;
  for (const p of PACKS) {
    const e = v.packs[p];
    for (const f of e.files) {
      if (f.includes('/') || f.includes('\\') || f.startsWith('.')) throw new Error(`bad file name ${f}`);
      const r = await fetchFn(new URL(f, base).href, { cache: 'no-store' });
      if (!r.ok || !r.body) throw new Error(`${f}: HTTP ${r.status}`);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(path.join(out, f)));
      bytes += fs.statSync(path.join(out, f)).size;
    }
    const h = packHash(out, e.files);
    if (h !== e.hash) throw new Error(`${p}: hash ${h} does not match the published ${e.hash}`);
    log(`${p}: ${e.files.length} files, hash ${h} ok`);
  }
  // SPEC 15: add "gz" when the published version.json lacks it; hash and built stay as published
  const missingGz = PACKS.filter((p) => !(Number.isInteger(v.packs[p].gz) && v.packs[p].gz > 0));
  for (const p of missingGz) v.packs[p].gz = packGz(out, v.packs[p].files);
  fs.writeFileSync(path.join(out, 'version.json'), missingGz.length ? JSON.stringify(v, null, 1) + '\n' : text);
  return { built: v.built, bytes, packs: PACKS.length, addedGz: missingGz };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const base = opt('--base', 'https://nostramadeus.github.io/nearest-jisho/data/');
  const out = path.resolve(opt('--out', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'data')));
  try {
    const r = await reuseData({ base, out, log: (m) => console.log(m) });
    console.log(`reused published data built ${r.built}: ${r.packs} packs, ${(r.bytes / 1048576).toFixed(1)} MB, all hashes match${r.addedGz.length ? `; added gz for ${r.addedGz.join(', ')}` : ''}`);
  } catch (e) {
    console.log(`reuse failed: ${e.message}`);
    process.exit(1);
  }
}
