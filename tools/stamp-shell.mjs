#!/usr/bin/env node
// CI step (SPEC 12): stamp SHELL_VERSION and SHELL_BUILT in app/sw.js and write app/shell.json.
//   node tools/stamp-shell.mjs <version> <built epoch seconds> [--app DIR]
// Fails when either constant line is missing (or present more than once) or the SHELL list cannot be read.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function stamp(swSource, version, built) {
  const VERSION_RE = /^const SHELL_VERSION = '[^']*';$/gm;
  const BUILT_RE = /^const SHELL_BUILT = \d+;(.*)$/gm;
  const nv = (swSource.match(VERSION_RE) || []).length, nb = (swSource.match(BUILT_RE) || []).length;
  if (nv !== 1) throw new Error(`line "const SHELL_VERSION = '...';" found ${nv} times in sw.js (need exactly 1)`);
  if (nb !== 1) throw new Error(`line "const SHELL_BUILT = <number>;" found ${nb} times in sw.js (need exactly 1)`);
  if (!/^[\w.:-]+$/.test(version)) throw new Error(`bad version "${version}"`);
  if (!/^\d+$/.test(String(built))) throw new Error(`bad built "${built}"`);
  const out = swSource
    .replace(VERSION_RE, `const SHELL_VERSION = '${version}';`)
    .replace(BUILT_RE, (_, rest) => `const SHELL_BUILT = ${built};${rest}`);
  const m = /^const SHELL = \[([\s\S]*?)\];$/m.exec(out);
  if (!m) throw new Error('SHELL list not found in sw.js');
  const files = Array.from(m[1].matchAll(/'([^']+)'/g), (x) => x[1]);
  if (!files.length) throw new Error('SHELL list is empty');
  if (files.some((f) => /shell\.json$/.test(f))) throw new Error('shell.json must not be in the SHELL list');
  return { sw: out, shell: { built: Number(built), version, files } };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const ai = args.indexOf('--app');
  const appDir = ai >= 0 ? args[ai + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
  const [version, built] = args.filter((a, i) => a !== '--app' && args[i - 1] !== '--app');
  try {
    const swPath = join(appDir, 'sw.js');
    const { sw, shell } = stamp(readFileSync(swPath, 'utf8'), version, built);
    writeFileSync(swPath, sw);
    writeFileSync(join(appDir, 'shell.json'), JSON.stringify(shell, null, 1) + '\n');
    console.log(`stamped SHELL_VERSION=${version} SHELL_BUILT=${built}; shell.json lists ${shell.files.length} files`);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
