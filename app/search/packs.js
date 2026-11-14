// Pack reader (SPEC 3). The ONLY module that knows the data file layout.
// Pure: no fetch, no fs. The caller passes readFile(name, onBytes) -> Promise<ArrayBuffer|Uint8Array>
// (worker: fetch / Cache Storage; node: fs). readFile must reject when a file does not exist.

import { fold, hash32 } from './fold.js';
import { letterMask } from './cost.js';

export const PACKS = ['words', 'names', 'wikt']; // searchable packs
export const SENT = 'sent'; // Tatoeba sentence pack (SPEC 13): no .meta, key space "h" with forms
/** Load order (SPEC 13.4). "kanji" is kanji.json. */
export const LOAD_ORDER = ['words', 'kanji', 'wikt', 'sent', 'names'];
export const SPACES = { words: ['r', 'k', 'e'], names: ['r', 'k'], wikt: ['r', 'k', 'e'] };

/** Files of one pack in the default layout (used by the worker for progress and by the update downloader). */
export function packFiles(pack) {
  if (pack === SENT) return [`${pack}.dat`, `${pack}.off`, `${pack}.keys.json`];
  return [`${pack}.dat`, `${pack}.off`, `${pack}.meta`, `${pack}.keys.json`];
}
/** Files of the alternative binary key layout (SPEC 3, used when keys.json would exceed 60 MB). */
export function packFilesBinary(pack) {
  if (pack === SENT) return packFiles(pack); // the sentence pack has one layout only
  const out = [`${pack}.dat`, `${pack}.off`, `${pack}.meta`];
  for (const s of SPACES[pack]) out.push(`${pack}.${s}.txt`, `${pack}.${s}.ptr`, `${pack}.${s}.ids`);
  return out;
}
export const KANJI_FILE = 'kanji.json';
export const PITCH_FILE = 'pitch.json'; // pitch pack (SPEC 25): { source, url, license, a: { key: "accent values" } }
export const VERSION_FILE = 'version.json';

const td = new TextDecoder();

function u8(buf) {
  if (buf instanceof Uint8Array) return buf;
  return new Uint8Array(buf);
}
function u32(buf) {
  const b = u8(buf);
  if (b.byteOffset % 4 === 0) return new Uint32Array(b.buffer, b.byteOffset, b.byteLength >>> 2);
  return new Uint32Array(b.slice().buffer);
}

/**
 * One key space: sorted unique keys in ONE string separated by \n, plus typed arrays.
 * keys.get(i) -> string, keys.length; idsOf(i) -> Uint32Array view.
 */
export class KeySpace {
  constructor(str, ptr, ids) {
    this.str = str;
    // start offset of every key; off[K] = str.length + 1 (virtual)
    let count = str.length ? 1 : 0;
    for (let i = str.indexOf('\n'); i !== -1; i = str.indexOf('\n', i + 1)) count++;
    const off = new Uint32Array(count + 1);
    if (count) {
      let k = 0;
      off[k++] = 0;
      for (let i = str.indexOf('\n'); i !== -1; i = str.indexOf('\n', i + 1)) off[k++] = i + 1;
    }
    off[count] = str.length + 1;
    this.off = off;
    this.count = count;
    this.ptr = ptr instanceof Uint32Array ? ptr : Uint32Array.from(ptr);
    this.ids = ids instanceof Uint32Array ? ids : Uint32Array.from(ids);
    if (this.ptr.length !== this.count + 1) throw new Error(`key space: ptr length ${this.ptr.length} != keys ${this.count} + 1`);
    const self = this;
    this.keys = { get length() { return self.count; }, get: (i) => self.key(i) };
    this._fold = null;
    this._mask = null;
  }
  key(i) { return this.str.slice(this.off[i], this.off[i + 1] - 1); }
  keyStart(i) { return this.off[i]; }
  keyEnd(i) { return this.off[i + 1] - 1; }
  keyLen(i) { return this.off[i + 1] - 1 - this.off[i]; }
  idsOf(i) { return this.ids.subarray(this.ptr[i], this.ptr[i + 1]); }

  /** Compare key i with string s (code-unit order) without allocating. */
  cmp(i, s) {
    const a = this.off[i], b = this.off[i + 1] - 1, str = this.str;
    const n = Math.min(b - a, s.length);
    for (let j = 0; j < n; j++) {
      const d = str.charCodeAt(a + j) - s.charCodeAt(j);
      if (d) return d;
    }
    return (b - a) - s.length;
  }
  /** First index with key >= s. */
  lowerBound(s) {
    let lo = 0, hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cmp(mid, s) < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  /** Index of exact key or -1. */
  find(s) {
    const i = this.lowerBound(s);
    return i < this.count && this.cmp(i, s) === 0 ? i : -1;
  }
  /** [lo, hi) range of keys starting with prefix p. */
  prefixRange(p) {
    const lo = this.lowerBound(p);
    // upper bound: first key that does not start with p
    let a = lo, b = this.count;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (this.startsWith(mid, p)) a = mid + 1; else b = mid;
    }
    return [lo, a];
  }
  startsWith(i, p) {
    const a = this.off[i], len = this.off[i + 1] - 1 - a;
    if (len < p.length) return false;
    for (let j = 0; j < p.length; j++) if (this.str.charCodeAt(a + j) !== p.charCodeAt(j)) return false;
    return true;
  }
  /** Key index containing string position pos. */
  indexAt(pos) {
    let lo = 0, hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.off[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Fold index (SPEC 4.2): hash buckets in CSR form, built lazily. Returns key indexes whose fold equals fold(s). */
  foldLookup(f) {
    if (!this._fold) this._buildFold();
    const { mask, bptr, bidx } = this._fold;
    const h = hash32(f) & mask;
    const out = [];
    for (let p = bptr[h]; p < bptr[h + 1]; p++) {
      const i = bidx[p];
      if (fold(this.key(i)) === f) out.push(i);
    }
    return out;
  }
  _buildFold() {
    const K = this.count;
    let size = 1;
    while (size < K) size <<= 1;
    const mask = size - 1;
    const hashes = new Uint32Array(K);
    const bptr = new Uint32Array(size + 1);
    for (let i = 0; i < K; i++) {
      const h = hash32(fold(this.key(i))) & mask;
      hashes[i] = h;
      bptr[h + 1]++;
    }
    for (let h = 0; h < size; h++) bptr[h + 1] += bptr[h];
    const fill = bptr.slice(0, size);
    const bidx = new Uint32Array(K);
    for (let i = 0; i < K; i++) bidx[fill[hashes[i]]++] = i;
    this._fold = { mask, bptr, bidx };
  }

  /** 26-bit letter masks per key (for tier-3 pruning), built lazily. */
  masks() {
    if (!this._mask) {
      const m = new Uint32Array(this.count);
      for (let i = 0; i < this.count; i++) m[i] = letterMask(this.str, this.off[i], this.off[i + 1] - 1);
      this._mask = m;
    }
    return this._mask;
  }
}

class Pack {
  constructor(name) {
    this.name = name;
    this.dat = null; this.off = null; this.meta = null; this.spaces = {};
    this.n = 0;
    this.cache = new Map();
    this.common = null; // lazily filled: 0 unknown, 1 not common, 2 common
  }
  record(id) {
    let rec = this.cache.get(id);
    if (rec) return rec;
    rec = JSON.parse(td.decode(this.dat.subarray(this.off[id], this.off[id + 1])));
    if (this.cache.size > 4000) this.cache.clear();
    this.cache.set(id, rec);
    return rec;
  }
}

export class PackStore {
  /** @param readFile (name, onBytes?) => Promise<ArrayBuffer|Uint8Array> */
  constructor(readFile) {
    this.readFile = readFile;
    this.packs = {};
    this.kanjiData = null;
    this.pitchData = null;
    this.version = null;
  }

  async loadVersion() {
    const buf = await this.readFile(VERSION_FILE);
    this.version = JSON.parse(td.decode(u8(buf)));
    return this.version;
  }

  /**
   * Load one pack. onProgress(fraction 0..1) is called while bytes arrive when the total is known
   * (from version.json packs[name].bytes).
   */
  async loadPack(name, onProgress) {
    const total = this.version?.packs?.[name]?.bytes || 0;
    let got = 0;
    const onBytes = (n) => { got += n; if (onProgress && total) onProgress(Math.min(1, got / total)); };
    const p = new Pack(name);
    const dat = this.readFile(`${name}.dat`, onBytes);
    const off = this.readFile(`${name}.off`, onBytes);
    const meta = this.readFile(`${name}.meta`, onBytes);
    for (const pr of [dat, off, meta]) pr.catch(() => {}); // rejections are re-thrown at the awaits below
    let keysJson = null;
    try {
      keysJson = await this.readFile(`${name}.keys.json`, onBytes);
    } catch {
      keysJson = null;
    }
    if (keysJson) {
      const obj = JSON.parse(td.decode(u8(keysJson)));
      keysJson = null;
      for (const s of SPACES[name]) {
        if (obj[s]) p.spaces[s] = new KeySpace(obj[s].keys, obj[s].ptr, obj[s].ids);
        obj[s] = null;
      }
    } else {
      for (const s of SPACES[name]) {
        const [txt, ptr, ids] = await Promise.all([
          this.readFile(`${name}.${s}.txt`, onBytes),
          this.readFile(`${name}.${s}.ptr`, onBytes),
          this.readFile(`${name}.${s}.ids`, onBytes),
        ]);
        p.spaces[s] = new KeySpace(td.decode(u8(txt)), u32(ptr), u32(ids));
      }
    }
    p.dat = u8(await dat);
    p.off = u32(await off);
    p.meta = u32(await meta);
    p.n = p.off.length - 1;
    p.common = new Uint8Array(p.n);
    this.packs[name] = p;
    if (onProgress) onProgress(1);
    return p;
  }

  /** Build the lazy indexes of a pack (fold index, letter masks) ahead of the first query. */
  warm(pack) {
    const p = this.packs[pack];
    if (!p) return;
    const r = p.spaces.r;
    if (r) { r.foldLookup(''); r.masks(); }
    if (p.spaces.e) p.spaces.e.masks();
  }

  has(pack) { return pack === SENT ? !!this.sent : !!this.packs[pack]; }
  size(pack) { return pack === SENT ? (this.sent ? this.sent.n : 0) : this.packs[pack]?.n || 0; }
  getRecord(pack, id) { return this.packs[pack].record(id); }
  meta(pack, id) { const m = this.packs[pack].meta; return { ff: m[id * 2], fn: m[id * 2 + 1] }; }
  /** rank per SPEC 4.6: ff for "fiction", fn for "news". */
  rank(pack, id, ranking) { return this.packs[pack].meta[id * 2 + (ranking === 'news' ? 1 : 0)]; }
  keySpace(pack, space) { return this.packs[pack]?.spaces[space] || null; }
  /** Common flag of a record, cached. */
  isCommon(pack, id) {
    const p = this.packs[pack];
    let c = p.common[id];
    if (!c) { c = p.record(id).c ? 2 : 1; p.common[id] = c; }
    return c === 2;
  }

  /**
   * Load the sentence pack (SPEC 13.3): sent.dat + sent.off (records ["Japanese", "English", tatoebaId]) and
   * sent.keys.json { h: { keys, ptr, ids, forms }, formList }.
   */
  async loadSent(onProgress) {
    const total = this.version?.packs?.[SENT]?.bytes || 0;
    let got = 0;
    const onBytes = (n) => { got += n; if (onProgress && total) onProgress(Math.min(1, got / total)); };
    const [dat, off, keys] = await Promise.all([
      this.readFile(`${SENT}.dat`, onBytes), this.readFile(`${SENT}.off`, onBytes), this.readFile(`${SENT}.keys.json`, onBytes),
    ]);
    const obj = JSON.parse(td.decode(u8(keys)));
    const h = obj.h;
    const space = new KeySpace(h.keys, h.ptr, h.ids);
    const forms = h.forms instanceof Uint32Array ? h.forms : Uint32Array.from(h.forms || []);
    if (forms.length !== space.ids.length) throw new Error(`sent: forms length ${forms.length} != ids ${space.ids.length}`);
    const offs = u32(off);
    this.sent = { dat: u8(dat), off: offs, n: offs.length - 1, space, forms, formList: obj.formList || [], cache: new Map() };
    if (onProgress) onProgress(1);
    return this.sent;
  }

  /** Sentences stored under one key: [{ id, form }] in pack order (empty when the key does not exist). */
  sentencesOf(key) {
    const S = this.sent;
    if (!S) return [];
    const i = S.space.find(key);
    if (i < 0) return [];
    const out = [];
    for (let p = S.space.ptr[i]; p < S.space.ptr[i + 1]; p++) out.push({ id: S.space.ids[p], form: S.formList[S.forms[p]] || '' });
    return out;
  }

  /** One sentence record: ["Japanese text", "English text", tatoebaId]. */
  sentence(id) {
    const S = this.sent;
    let rec = S.cache.get(id);
    if (rec) return rec;
    rec = JSON.parse(td.decode(S.dat.subarray(S.off[id], S.off[id + 1])));
    if (S.cache.size > 2000) S.cache.clear();
    S.cache.set(id, rec);
    return rec;
  }

  async loadKanji() {
    const buf = await this.readFile(KANJI_FILE);
    this.kanjiData = JSON.parse(td.decode(u8(buf)));
    return this.kanjiData;
  }
  kanji(literal) { return this.kanjiData ? this.kanjiData[literal] || null : null; }

  /** Pitch pack (SPEC 25), loaded when the first entry page opens. */
  async loadPitch() {
    const buf = await this.readFile(PITCH_FILE);
    this.pitchData = JSON.parse(td.decode(u8(buf))).a || {};
    return this.pitchData;
  }
  /** Accent value string ("2", "0,3") of a pitch key (search/pitch.js pitchKey), '' when there is none. */
  pitch(key) { return this.pitchData && key ? this.pitchData[key] || '' : ''; }
}
