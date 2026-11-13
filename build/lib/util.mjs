// Shared helpers for the data build. Node stdlib only; runs on Windows and Linux.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE = path.join(ROOT, 'build', '.cache');
export const OUT = path.join(ROOT, 'app', 'data');

const UA = 'nearest-jisho-data-build';

export function log(...a) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}Z]`, ...a);
}

/** GET with retries; returns a Response with ok status. */
export async function fetchOk(url, { retries = 3, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow' });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status === 404 || res.status === 410) break;
    } catch (e) {
      lastErr = e;
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw lastErr;
}

export async function fetchJson(url, opts) {
  const headers = {};
  if (url.startsWith('https://api.github.com/') && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetchOk(url, { ...opts, headers });
  return res.json();
}

/** Stream a URL to a file in the cache (atomic rename). Skips when the file already exists. */
export async function download(url, name) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    log(`cached ${name} (${mb(fs.statSync(dest).size)})`);
    return dest;
  }
  const tmp = dest + '.part';
  log(`download ${url}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchOk(url);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
      log(`  -> ${name} ${mb(fs.statSync(dest).size)}`);
      return dest;
    } catch (e) {
      log(`  download failed (${e.message}), attempt ${attempt + 1}`);
      if (attempt === 2) throw e;
    }
  }
}

/** Delete a file, only inside build/.cache. */
export function rmCache(file) {
  const rel = path.relative(CACHE, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refusing to delete outside cache: ${file}`);
  fs.rmSync(file, { force: true });
}

export function mb(n) {
  return (n / 1048576).toFixed(1) + ' MB';
}

/**
 * Transform that reads a tar stream and passes through the bytes of the first regular file
 * (or the first whose name matches `want`). Other entries are skipped.
 */
export function tarExtractOne(want = () => true) {
  let buf = Buffer.alloc(0);
  let state = 'header';
  let remaining = 0;
  let pad = 0;
  let emit = false;
  let found = false;
  let longName = null;
  let collectLong = false;
  let longBuf = [];
  return new Transform({
    transform(chunk, _enc, cb) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (true) {
        if (state === 'header') {
          if (buf.length < 512) break;
          const h = buf.subarray(0, 512);
          buf = buf.subarray(512);
          if (h.every((b) => b === 0)) { state = 'end'; continue; }
          let name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
          const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/s, '');
          if (prefix) name = prefix + '/' + name;
          if (longName) { name = longName; longName = null; }
          const sizeField = h.subarray(124, 136);
          let size;
          if (sizeField[0] & 0x80) { size = 0; for (let i = 1; i < 12; i++) size = size * 256 + sizeField[i]; }
          else size = parseInt(sizeField.toString('ascii').replace(/[\0 ]/g, '') || '0', 8);
          const type = String.fromCharCode(h[156] || 48);
          remaining = size;
          pad = (512 - (size % 512)) % 512;
          collectLong = type === 'L';
          emit = !found && (type === '0' || type === '\0') && want(name);
          if (emit) found = true;
          state = 'data';
          continue;
        }
        if (state === 'data') {
          if (remaining === 0) { state = 'pad'; if (collectLong) { longName = Buffer.concat(longBuf).toString('utf8').replace(/\0.*$/s, ''); longBuf = []; } continue; }
          if (buf.length === 0) break;
          const n = Math.min(remaining, buf.length);
          const piece = buf.subarray(0, n);
          if (emit) this.push(Buffer.from(piece));
          else if (collectLong) longBuf.push(Buffer.from(piece));
          buf = buf.subarray(n);
          remaining -= n;
          continue;
        }
        if (state === 'pad') {
          if (buf.length < pad) break;
          buf = buf.subarray(pad);
          pad = 0;
          state = 'header';
          continue;
        }
        if (state === 'end') { buf = Buffer.alloc(0); break; }
      }
      cb();
    },
  });
}

/** Async line iterator over a readable stream. */
export function lines(stream) {
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

/**
 * Iterate the records of a jmdict-simplified .json.tgz. The file writes one record per line inside the
 * top-level array named `arrayName` ("words" or "characters"). Yields { header } once (parsed scalar
 * fields before the array), then each record object.
 */
export async function* jmdictSimplifiedRecords(tgzPath, arrayName) {
  const src = fs.createReadStream(tgzPath).pipe(zlib.createGunzip()).pipe(tarExtractOne((n) => n.endsWith('.json')));
  let inArray = false;
  const header = {};
  let n = 0;
  for await (const raw of lines(src)) {
    const line = raw.trim();
    if (!inArray) {
      const m = /^"([A-Za-z]+)":\s*("(?:[^"\\]|\\.)*"|true|false|\d+)\s*,?$/.exec(line);
      if (m) header[m[1]] = JSON.parse(m[2]);
      if (line.startsWith(`"${arrayName}"`)) {
        inArray = true;
        yield { header };
      }
      continue;
    }
    if (line.startsWith('{')) {
      const body = line.endsWith(',') ? line.slice(0, -1) : line;
      let rec;
      try {
        rec = JSON.parse(body);
      } catch (e) {
        // the last record carries the array's closing bracket on the same line
        if (!/\]\s*\}?$/.test(body)) throw e;
        rec = JSON.parse(body.replace(/\]\s*\}?$/, ''));
      }
      yield rec;
      n++;
    }
  }
  if (!inArray || n < 100) throw new Error(`${path.basename(tgzPath)}: expected one record per line in "${arrayName}", got ${n}`);
}
