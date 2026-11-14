// Pack writer: the ONE place that writes the SPEC section 3 file layout.
// Usable from the build and from test helpers (fixture packs).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

const MAX_KEYS_JSON = 60 * 1024 * 1024; // SPEC 3: switch to binary layout above this size

export const STOP = new Set('a an the of to in on at for and or by with as is be it that from'.split(' '));

/** English keys of one gloss string (SPEC 3, space e). */
export function englishKeys(text) {
  const out = [];
  for (const w of String(text).toLowerCase().split(/[^\p{L}]+/u)) {
    if (w.length >= 2 && !STOP.has(w)) out.push(w);
  }
  return out;
}

export class PackWriter {
  /**
   * @param {string} dir   output directory (app/data)
   * @param {string} name  pack name (words, names, wikt)
   * @param {string[]} spaces key spaces, e.g. ['r','k','e']
   */
  constructor(dir, name, spaces) {
    this.dir = dir;
    this.name = name;
    this.spaces = spaces;
    fs.mkdirSync(dir, { recursive: true });
    this.tmpDat = path.join(dir, `${name}.dat.tmp`);
    this.fd = fs.openSync(this.tmpDat, 'w');
    this.offsets = [0];
    this.meta = [];
    this.pos = 0;
    this.maps = Object.fromEntries(spaces.map((s) => [s, new Map()]));
    this.pending = [];
    this.pendingBytes = 0;
  }

  get count() {
    return this.meta.length / 2;
  }

  /**
   * Add one record. keys = { r: [strings], k: [strings], e: [packedIds or [word, senseIndex]] }.
   * For space e give pairs [word, senseIndex]; the writer packs recordId*16+min(sense,15).
   * Returns the record id.
   */
  add(record, ff, fn, keys) {
    const id = this.count;
    const buf = Buffer.from(JSON.stringify(record), 'utf8');
    this.pending.push(buf);
    this.pendingBytes += buf.length;
    if (this.pendingBytes > 4 * 1024 * 1024) this.flush();
    this.pos += buf.length;
    this.offsets.push(this.pos);
    this.meta.push(ff >>> 0, fn >>> 0);
    for (const space of this.spaces) {
      const list = keys[space];
      if (!list) continue;
      const map = this.maps[space];
      for (const item of list) {
        let key, val;
        if (space === 'e') { key = item[0]; val = id * 16 + Math.min(item[1], 15); }
        else { key = item; val = id; }
        if (!key) continue;
        let arr = map.get(key);
        if (!arr) { arr = []; map.set(key, arr); }
        if (arr[arr.length - 1] !== val) arr.push(val); // ids arrive ascending; drop repeats
      }
    }
    return id;
  }

  /** Change the ff of an added record (before finish). */
  setFf(id, ff) {
    this.meta[id * 2] = ff >>> 0;
  }

  flush() {
    if (this.pending.length) {
      fs.writeSync(this.fd, Buffer.concat(this.pending));
      this.pending = [];
      this.pendingBytes = 0;
    }
  }

  /** Build one key space: sorted unique keys, CSR ptr, ids. */
  buildSpace(space) {
    const map = this.maps[space];
    const keys = [...map.keys()].sort(); // default sort = UTF-16 code unit order (SPEC 3)
    const ptr = new Uint32Array(keys.length + 1);
    let total = 0;
    for (let i = 0; i < keys.length; i++) total += map.get(keys[i]).length;
    const ids = new Uint32Array(total);
    let p = 0;
    for (let i = 0; i < keys.length; i++) {
      ptr[i] = p;
      for (const v of map.get(keys[i])) ids[p++] = v;
    }
    ptr[keys.length] = p;
    return { keys, ptr, ids };
  }

  /** Finish: write .dat, .off, .meta, key files. Returns { n, bytes, files, layout }. */
  finish() {
    const n = this.count;
    this.flush();
    fs.closeSync(this.fd);
    const P = (ext) => path.join(this.dir, `${this.name}${ext}`);
    fs.renameSync(this.tmpDat, P('.dat'));
    fs.writeFileSync(P('.off'), u32le(Uint32Array.from(this.offsets)));
    fs.writeFileSync(P('.meta'), u32le(Uint32Array.from(this.meta)));
    this.offsets = this.meta = null;

    const built = {};
    let jsonSize = 2;
    for (const s of this.spaces) {
      built[s] = this.buildSpace(s);
      this.maps[s] = null;
      const b = built[s];
      // estimate JSON size: keys string + numbers with commas
      jsonSize += Buffer.byteLength(b.keys.join('\n')) + 40 + numJsonLen(b.ptr) + numJsonLen(b.ids);
    }
    const files = ['.dat', '.off', '.meta'].map(P);
    let layout;
    // remove files of the other layout so a pack never carries both
    for (const s of ['r', 'k', 'e']) for (const ext of [`.${s}.txt`, `.${s}.ptr`, `.${s}.ids`]) fs.rmSync(P(ext), { force: true });
    fs.rmSync(P('.keys.json'), { force: true });
    if (jsonSize <= MAX_KEYS_JSON) {
      layout = 'json';
      const parts = this.spaces.map((s) => {
        const b = built[s];
        return `${JSON.stringify(s)}:{"keys":${JSON.stringify(b.keys.join('\n'))},"ptr":[${Array.prototype.join.call(b.ptr, ',')}],"ids":[${Array.prototype.join.call(b.ids, ',')}]}`;
      });
      fs.writeFileSync(P('.keys.json'), '{' + parts.join(',') + '}');
      files.push(P('.keys.json'));
    } else {
      layout = 'binary';
      for (const s of this.spaces) {
        const b = built[s];
        fs.writeFileSync(P(`.${s}.txt`), b.keys.join('\n'));
        fs.writeFileSync(P(`.${s}.ptr`), u32le(b.ptr));
        fs.writeFileSync(P(`.${s}.ids`), u32le(b.ids));
        files.push(P(`.${s}.txt`), P(`.${s}.ptr`), P(`.${s}.ids`));
      }
    }
    const bytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);
    const stats = Object.fromEntries(this.spaces.map((s) => [s, { keys: built[s].keys.length, ids: built[s].ids.length }]));
    return { n, bytes, files: files.map((f) => path.basename(f)), layout, stats };
  }
}

function numJsonLen(arr) {
  let n = 0;
  for (let i = 0; i < arr.length; i++) n += String(arr[i]).length + 1;
  return n;
}

function u32le(u32) {
  // Uint32Array is little-endian on every platform node runs on; assert anyway.
  if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) throw new Error('big-endian host not supported');
  return Buffer.from(u32.buffer, u32.byteOffset, u32.byteLength);
}

// ---- SPEC 14.2: per-pack file lists and hashes in version.json ----

/** Files of one pack as they exist in `dir`, in a fixed order (the order the hash is computed over). */
export function packFileList(dir, pack) {
  if (pack === 'kanji') return ['kanji.json'];
  if (pack === 'pitch') return ['pitch.json'];
  if (pack === 'sent') return ['sent.dat', 'sent.off', 'sent.keys.json'];
  const json = [`${pack}.dat`, `${pack}.off`, `${pack}.meta`, `${pack}.keys.json`];
  if (fs.existsSync(path.join(dir, `${pack}.keys.json`))) return json;
  const out = [`${pack}.dat`, `${pack}.off`, `${pack}.meta`];
  for (const s of ['r', 'k', 'e']) {
    if (fs.existsSync(path.join(dir, `${pack}.${s}.txt`))) out.push(`${pack}.${s}.txt`, `${pack}.${s}.ptr`, `${pack}.${s}.ids`);
  }
  return out;
}

/** First 16 hex digits of sha256 over the files' bytes, in the listed order (streamed, 1 MB at a time). */
export function packHash(dir, files) {
  const h = createHash('sha256');
  const buf = Buffer.alloc(1 << 20);
  for (const f of files) {
    const fd = fs.openSync(path.join(dir, f), 'r');
    try {
      for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
    } finally { fs.closeSync(fd); }
  }
  return h.digest('hex').slice(0, 16);
}

/** SPEC 15: sum of the gzip sizes (zlib level 6) of the pack's files, in bytes (the download size estimate). */
export function packGz(dir, files) {
  let sum = 0;
  for (const f of files) sum += zlib.gzipSync(fs.readFileSync(path.join(dir, f)), { level: 6 }).length;
  return sum;
}

/** Add "files", "hash" and "gz" to every pack entry of a version.json object whose files exist in `dir`. */
export function addPackHashes(dir, version) {
  for (const [pack, entry] of Object.entries(version.packs || {})) {
    const files = packFileList(dir, pack);
    if (!files.every((f) => fs.existsSync(path.join(dir, f)))) continue;
    entry.files = files;
    entry.hash = packHash(dir, files);
    entry.gz = packGz(dir, files);
  }
  return version;
}
