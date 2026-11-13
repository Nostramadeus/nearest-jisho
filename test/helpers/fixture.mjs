// Hand-made fixture packs in the SPEC section 3 layout, written to a temp folder.
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kanaToRomaji } from '../../app/search/romaji.js';
import { PackStore } from '../../app/search/packs.js';

const STOP = new Set('a an the of to in on at for and or by with as is be it that from'.split(' '));

function u32File(arr) { return Buffer.from(new Uint32Array(arr).buffer); }

function csr(map) {
  const keys = Array.from(map.keys()).sort(); // code-unit order
  const ptr = [0], ids = [];
  for (const k of keys) { const s = Array.from(map.get(k)).sort((a, b) => a - b); ids.push(...s); ptr.push(ids.length); }
  return { keys, ptr, ids };
}

/**
 * Write one pack. records: plain objects; meta: [[ff, fn], ...]. layout: 'json' (keys.json) or 'binary'.
 */
export function writePack(dir, name, records, meta, layout = 'json') {
  const enc = new TextEncoder();
  const parts = records.map((r) => enc.encode(JSON.stringify(r)));
  const off = [0];
  for (const p of parts) off.push(off[off.length - 1] + p.length);
  writeFileSync(join(dir, `${name}.dat`), Buffer.concat(parts.map((p) => Buffer.from(p))));
  writeFileSync(join(dir, `${name}.off`), u32File(off));
  writeFileSync(join(dir, `${name}.meta`), u32File(meta.flat()));
  const sp = { r: new Map(), k: new Map(), e: new Map() };
  const add = (m, k, id) => { if (!k) return; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(id); };
  records.forEach((rec, id) => {
    for (const f of rec.r || []) add(sp.r, kanaToRomaji(f), id);
    for (const f of [...(rec.k || []), ...(rec.r || [])]) add(sp.k, f.normalize('NFKC'), id);
    if (name === 'names' || rec.src === 'wj') return;
    (rec.s || []).forEach((s, si) => {
      for (const g of s.g || []) {
        for (const w of g.toLowerCase().split(/[^\p{L}]+/u)) {
          if (w.length >= 2 && !STOP.has(w)) add(sp.e, w, id * 16 + Math.min(si, 15));
        }
      }
    });
  });
  const spaces = name === 'names' ? ['r', 'k'] : ['r', 'k', 'e'];
  if (layout === 'json') {
    const obj = {};
    for (const s of spaces) { const c = csr(sp[s]); obj[s] = { keys: c.keys.join('\n'), ptr: c.ptr, ids: c.ids }; }
    writeFileSync(join(dir, `${name}.keys.json`), JSON.stringify(obj));
  } else {
    for (const s of spaces) {
      const c = csr(sp[s]);
      writeFileSync(join(dir, `${name}.${s}.txt`), c.keys.join('\n'));
      writeFileSync(join(dir, `${name}.${s}.ptr`), u32File(c.ptr));
      writeFileSync(join(dir, `${name}.${s}.ids`), u32File(c.ids));
    }
  }
}

const N = (p, g, extra = {}) => ({ p, g, ...extra });

// [record, ff, fn]
export const WORDS = [
  [{ k: ['辞書'], r: ['じしょ'], c: 1, j: 5, s: [N(['n'], ['dictionary', 'lexicon'], { x: [['辞書を引く。', 'I look it up in the dictionary.']] }), N(['n'], ['(original) letter of resignation'], { m: ['arch'] })] }, 500, 1000],
  [{ k: ['辞書形'], r: ['じしょけい'], s: [N(['n'], ['dictionary form (of a verb)'], { f: ['gramm'] })] }, 30000, 999999],
  [{ k: ['地所'], r: ['じしょ'], c: 1, s: [N(['n'], ['estate', 'plot of land'])] }, 20000, 15000],
  [{ k: ['自署'], r: ['じしょ'], s: [N(['n', 'vs'], ["one's own signature"])] }, 999999, 999999],
  [{ k: ['学校'], r: ['がっこう'], c: 1, j: 5, s: [N(['n'], ['school'])] }, 300, 500],
  [{ k: ['少女'], r: ['しょうじょ'], c: 1, s: [N(['n'], ['girl', 'young woman'])] }, 800, 5000],
  [{ k: ['処女'], r: ['しょじょ'], c: 1, s: [N(['n'], ['virgin'])] }, 4000, 9000],
  [{ k: ['症状'], r: ['しょうじょう'], c: 1, s: [N(['n'], ['symptoms', 'condition'])] }, 6000, 1500],
  [{ k: ['今日は'], r: ['こんにちは', 'こんちは'], c: 1, s: [N(['int'], ['hello', 'good day'])] }, 200, 15000],
  [{ k: ['食べる'], r: ['たべる'], c: 1, j: 5, s: [N(['v1', 'vt'], ['to eat'])] }, 100, 2000],
  [{ k: ['柿'], r: ['かき'], c: 1, s: [N(['n'], ['kaki', 'persimmon'])] }, 9000, 20000],
  [{ k: ['牡蠣'], r: ['かき'], s: [N(['n'], ['oyster'])] }, 12000, 30000],
  [{ k: ['下記'], r: ['かき'], c: 1, s: [N(['n'], ['the following'])] }, 14000, 3000],
  [{ k: ['書く'], r: ['かく'], c: 1, s: [N(['v5k', 'vt'], ['to write'])] }, 150, 800],
  [{ k: ['俺'], r: ['おれ'], c: 1, s: [N(['pn'], ['I', 'me'], { m: ['male'] })] }, 50, 9000],
  [{ k: ['折れ'], r: ['おれ'], s: [N(['n'], ['broken piece'])] }, 50000, 7000],
  [{ k: ['手前'], r: ['てまえ', 'てめえ'], c: 1, s: [N(['n'], ['before one']), N(['pn'], ['you'], { m: ['derog'] })] }, 2000, 2500],
  [{ k: ['草'], r: ['くさ'], c: 1, s: [N(['n'], ['grass']), N(['n'], ['lol', 'LOL'], { m: ['net-sl'] })] }, 1500, 6000],
  [{ k: ['憎む'], r: ['にくむ'], c: 1, s: [N(['v5m', 'vt'], ['to hate', 'to detest'])] }, 2500, 12000],
  [{ k: ['果て'], r: ['はて'], c: 1, s: [N(['n'], ['the end', 'limit'])] }, 3000, 9500],
  [{ k: ['憎しみ'], r: ['にくしみ'], c: 1, s: [N(['n'], ['hatred', 'hate'])] }, 5000, 15000],
  [{ k: ['字典'], r: ['じてん'], s: [N(['n'], ['dictionary'])] }, 40000, 35000],
  [{ k: ['行く'], r: ['いく', 'ゆく'], c: 1, s: [N(['v5k-s', 'vi'], ['to go'])] }, 80, 600],
  [{ k: ['来る'], r: ['くる'], c: 1, s: [N(['vk', 'vi'], ['to come'])] }, 90, 700],
  [{ r: ['する'], c: 1, s: [N(['vs-i'], ['to do'])] }, 10, 100],
  [{ k: ['高い'], r: ['たかい'], c: 1, s: [N(['adj-i'], ['high', 'tall', 'expensive'])] }, 400, 1200],
  [{ r: ['ラーメン'], c: 1, s: [N(['n'], ['ramen'])] }, 2500, 25000],
  [{ r: ['カキ'], s: [N(['n'], ['kaki (fruit)'])] }, 999999, 999999],
  [{ k: ['事象'], r: ['じしょう'], s: [N(['n'], ['event', 'phenomenon'])] }, 8000, 8000],
  [{ k: ['学校教育'], r: ['がっこうきょういく'], s: [N(['n'], ['school education'])] }, 20000, 20000],
  [{ k: ['時刻'], r: ['じこく'], c: 1, s: [N(['n'], ['time', 'hour'])] }, 1000, 1000],
  [{ k: ['字書'], r: ['じしょ'], c: 1, s: [N(['n'], ['character dictionary'])] }, 20000, 999999],
  [{ r: ['がっこ'], s: [N(['n'], ['tsukemono', 'Japanese pickled vegetables'], { d: ['thb'] })] }, 600, 999999],
];

export const NAMES = [
  [{ k: ['田中'], r: ['たなか'], t: ['surname'], g: ['Tanaka'] }, 999999, 999999],
  [{ k: ['中田'], r: ['なかた'], t: ['surname'], g: ['Nakata'] }, 999999, 999999],
  [{ k: ['辞書'], r: ['じしょ'], t: ['place'], g: ['Jisho'] }, 999999, 999999],
];

export const WIKT = [
  [{ src: 'we', k: ['草'], r: ['くさ'], u: 'https://en.wiktionary.org/wiki/草#Japanese', s: [{ p: ['noun'], g: ['lol (internet slang)'], m: ['Internet slang'] }] }, 1500, 999999],
  [{ src: 'wj', k: ['ググる'], r: ['ググる'], u: 'https://ja.wiktionary.org/wiki/ググる', s: [{ p: ['動詞'], g: ['グーグルで検索する'], m: ['俗語'] }] }, 999999, 999999],
];

export const KANJI = {
  '辞': { m: ['resign', 'word', 'term'], on: ['ジ'], kun: ['や.める'], s: 13, g: 4, j: 3, f: 640 },
  '書': { m: ['write'], on: ['ショ'], kun: ['か.く'], s: 10, g: 2, j: 4, f: 169 },
};

/** Write all fixture packs into a fresh temp folder. Returns { dir, cleanup }. */
export function makeFixture(layout = 'json') {
  const dir = mkdtempSync(join(tmpdir(), 'nj-fixture-'));
  const pack = (name, rows) => writePack(dir, name, rows.map((r) => r[0]), rows.map((r) => [r[1], r[2]]), layout);
  pack('words', WORDS);
  pack('names', NAMES);
  pack('wikt', WIKT);
  writeFileSync(join(dir, 'kanji.json'), JSON.stringify(KANJI));
  const bytes = (files) => files.reduce((a, f) => { try { return a + readFileSync(join(dir, f)).length; } catch { return a; } }, 0);
  const packs = {};
  for (const [name, rows] of [['words', WORDS], ['names', NAMES], ['wikt', WIKT]]) {
    const files = [`${name}.dat`, `${name}.off`, `${name}.meta`, `${name}.keys.json`,
      ...['r', 'k', 'e'].flatMap((s) => [`${name}.${s}.txt`, `${name}.${s}.ptr`, `${name}.${s}.ids`])];
    packs[name] = { n: rows.length, bytes: bytes(files) };
  }
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ built: '2026-11-13', jmdict: 'fixture', packs }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** node readFile adapter for PackStore. */
export function fsReader(dir) {
  return async (name, onBytes) => {
    const buf = readFileSync(join(dir, name));
    if (onBytes) onBytes(buf.length);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  };
}

export async function loadFixtureStore(layout = 'json') {
  const fx = makeFixture(layout);
  const store = new PackStore(fsReader(fx.dir));
  await store.loadVersion();
  for (const p of ['words', 'names', 'wikt']) await store.loadPack(p);
  await store.loadKanji();
  return { store, ...fx };
}
