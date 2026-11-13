// Weighted Damerau-Levenshtein, optimal string alignment (SPEC 4.5).
// All costs are integers in tenths (0.2 -> 2) so sums are exact.

export const COST = {
  DOUBLE: 3,      // insert/delete a letter equal to its left or right neighbour
  SOFT: 2,        // insert/delete u after o/u, o after o, ' or - anywhere
  SWAP: 5,        // swap two adjacent letters
  TOUCH: 5,       // substitute, keys touch on QWERTY
  ONE_BETWEEN: 8, // substitute, one key between
  OTHER: 10,      // any other edit
  FIRST: 3,       // extra for substitute or delete at query position 0
};

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const XOFF = [0, 0.25, 0.75];
const POS = new Map();
ROWS.forEach((row, y) => { for (let i = 0; i < row.length; i++) POS.set(row.charCodeAt(i), [XOFF[y] + i, y]); });

// Substitution cost table for a..z (keyboard on). Index (a-97)*26 + (b-97).
const KB = new Uint8Array(26 * 26);
for (let a = 0; a < 26; a++) for (let b = 0; b < 26; b++) {
  if (a === b) { KB[a * 26 + b] = 0; continue; }
  const [ax, ay] = POS.get(97 + a), [bx, by] = POS.get(97 + b);
  const d = Math.hypot(ax - bx, ay - by);
  KB[a * 26 + b] = d < 1.3 ? COST.TOUCH : d < 2.3 ? COST.ONE_BETWEEN : COST.OTHER;
}

/** Substitution cost in tenths for two different characters. */
export function subCost(a, b, keyboard) {
  if (!keyboard) return COST.OTHER;
  const x = a - 97, y = b - 97;
  if (x < 0 || x > 25 || y < 0 || y > 25) return COST.OTHER;
  return KB[x * 26 + y];
}

/** Keyboard relation of two letters: 'touch' | 'one-between' | 'far'. */
export function keyRelation(a, b) {
  const c = subCost(a.charCodeAt(0), b.charCodeAt(0), true);
  return c === COST.TOUCH ? 'touch' : c === COST.ONE_BETWEEN ? 'one-between' : 'far';
}

/** Tier-3 budget in tenths by canonical query length (SPEC 4.4). 0 = no tier 3. */
export function budget(len) {
  if (len <= 3) return 0;
  if (len <= 5) return 10;
  if (len <= 8) return 15;
  return 20;
}

const APOS = 39, HYPHEN = 45, U = 117, O = 111;

// Cost of inserting/deleting str[idx] (range start..end), without the position-0 extra.
function indelCost(str, start, end, idx, soft) {
  const c = str.charCodeAt(idx);
  const prev = idx > start ? str.charCodeAt(idx - 1) : -1;
  const next = idx + 1 < end ? str.charCodeAt(idx + 1) : -1;
  if (soft) {
    if (c === APOS || c === HYPHEN) return COST.SOFT;
    if (c === U && (prev === O || prev === U)) return COST.SOFT;
    if (c === O && prev === O) return COST.SOFT;
  }
  if (c === prev || c === next) return COST.DOUBLE;
  return COST.OTHER;
}

/**
 * Prepare a query for repeated distance() calls.
 * opts: { keyboard: bool, soft: bool (u/o/'/- row), first: bool (position-0 extra) }
 */
export function prepareQuery(q, opts = {}) {
  const o = { keyboard: opts.keyboard !== false, soft: opts.soft !== false, first: opts.first !== false };
  const n = q.length;
  const codes = new Int32Array(n);
  const del = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    codes[i] = q.charCodeAt(i);
    del[i] = indelCost(q, 0, n, i, o.soft) + (i === 0 && o.first ? COST.FIRST : 0);
  }
  return { q, n, codes, del, ...o };
}

let rowA = new Int32Array(64), rowB = new Int32Array(64), rowC = new Int32Array(64), insBuf = new Int32Array(64);
function ensure(m) {
  if (rowA.length > m + 1) return;
  const size = (m + 2) * 2;
  rowA = new Int32Array(size); rowB = new Int32Array(size); rowC = new Int32Array(size); insBuf = new Int32Array(size);
}

const INF = 0x3fffffff;
export { INF };

/**
 * Bounded weighted OSA distance between prepared query P and key str[ks..ke).
 * Returns cost in tenths, or INF when it exceeds max (tenths).
 */
export function distance(P, str, ks = 0, ke = str.length, max = INF) {
  const n = P.n, m = ke - ks;
  ensure(m);
  const ins = insBuf;
  for (let j = 0; j < m; j++) ins[j] = indelCost(str, ks, ke, ks + j, P.soft);
  let prev2 = rowA, prev = rowB, cur = rowC;
  prev[0] = 0;
  for (let j = 1; j <= m; j++) prev[j] = prev[j - 1] + ins[j - 1];
  let prevMin = 0;
  const codes = P.codes, del = P.del, kb = P.keyboard, firstExtra = P.first ? COST.FIRST : 0;
  for (let i = 1; i <= n; i++) {
    const qc = codes[i - 1];
    const dc = del[i - 1];
    cur[0] = prev[0] + dc;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const kc = str.charCodeAt(ks + j - 1);
      let best = prev[j] + dc;
      const b = cur[j - 1] + ins[j - 1];
      if (b < best) best = b;
      const s = qc === kc ? 0 : subCost(qc, kc, kb) + (i === 1 ? firstExtra : 0);
      const c = prev[j - 1] + s;
      if (c < best) best = c;
      if (i > 1 && j > 1 && qc !== codes[i - 2] && qc === str.charCodeAt(ks + j - 2) && codes[i - 2] === kc) {
        const t = prev2[j - 2] + COST.SWAP;
        if (t < best) best = t;
      }
      cur[j] = best;
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > max && prevMin + COST.SWAP > max) return INF;
    prevMin = rowMin;
    const t = prev2; prev2 = prev; prev = cur; cur = t;
  }
  const d = prev[m];
  return d > max ? INF : d;
}

/**
 * Full alignment with traceback. Returns { cost, ops: [{ op: 'sub'|'del'|'ins'|'swap', cost, i, j }] }
 * 'del' = the query has a letter the key lacks; 'ins' = the key has a letter the query lacks.
 */
export function explain(q, key, opts = {}) {
  const P = prepareQuery(q, opts);
  const n = q.length, m = key.length;
  const ins = new Int32Array(m);
  for (let j = 0; j < m; j++) ins[j] = indelCost(key, 0, m, j, P.soft);
  const D = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let j = 1; j <= m; j++) D[0][j] = D[0][j - 1] + ins[j - 1];
  for (let i = 1; i <= n; i++) {
    D[i][0] = D[i - 1][0] + P.del[i - 1];
    for (let j = 1; j <= m; j++) {
      const qc = q.charCodeAt(i - 1), kc = key.charCodeAt(j - 1);
      let best = D[i - 1][j] + P.del[i - 1];
      best = Math.min(best, D[i][j - 1] + ins[j - 1]);
      const s = qc === kc ? 0 : subCost(qc, kc, P.keyboard) + (i === 1 && P.first ? COST.FIRST : 0);
      best = Math.min(best, D[i - 1][j - 1] + s);
      if (i > 1 && j > 1 && qc !== q.charCodeAt(i - 2) && qc === key.charCodeAt(j - 2) && q.charCodeAt(i - 2) === kc) {
        best = Math.min(best, D[i - 2][j - 2] + COST.SWAP);
      }
      D[i][j] = best;
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const here = D[i][j];
    if (i > 0 && j > 0) {
      const qc = q.charCodeAt(i - 1), kc = key.charCodeAt(j - 1);
      if (qc === kc && D[i - 1][j - 1] === here) { i--; j--; continue; }
      const s = qc === kc ? 0 : subCost(qc, kc, P.keyboard) + (i === 1 && P.first ? COST.FIRST : 0);
      if (i > 1 && j > 1 && qc !== q.charCodeAt(i - 2) && qc === key.charCodeAt(j - 2) && q.charCodeAt(i - 2) === kc
          && D[i - 2][j - 2] + COST.SWAP === here) {
        ops.push({ op: 'swap', cost: COST.SWAP, i: i - 2, j: j - 2 }); i -= 2; j -= 2; continue;
      }
      if (qc !== kc && D[i - 1][j - 1] + s === here) {
        ops.push({ op: 'sub', cost: s, i: i - 1, j: j - 1, base: subCost(qc, kc, P.keyboard) }); i--; j--; continue;
      }
    }
    if (i > 0 && D[i - 1][j] + P.del[i - 1] === here) { ops.push({ op: 'del', cost: P.del[i - 1], i: i - 1, j }); i--; continue; }
    if (j > 0 && D[i][j - 1] + ins[j - 1] === here) { ops.push({ op: 'ins', cost: ins[j - 1], i, j: j - 1 }); j--; continue; }
    break; // should not happen
  }
  ops.reverse();
  return { cost: D[n][m], ops };
}

/**
 * Reason label for a did-you-mean line (SPEC 4.4). With several edits, the most costly edit names the reason
 * (first one on a tie).
 */
export function reasonFor(q, key, opts = {}) {
  const { ops } = explain(q, key, opts);
  if (!ops.length) return 'long vowel / double letter';
  let pick = ops[0];
  for (const o of ops) if (o.cost > pick.cost) pick = o;
  switch (pick.op) {
    case 'swap': return 'letters swapped';
    case 'sub': return pick.base === COST.TOUCH ? 'neighbouring key' : 'one letter different';
    case 'del': return pick.cost - (pick.i === 0 && opts.first !== false ? COST.FIRST : 0) < COST.OTHER
      ? 'long vowel / double letter' : 'one extra letter';
    case 'ins': return pick.cost < COST.OTHER ? 'long vowel / double letter' : 'one letter missing';
  }
  return 'one letter different';
}

/** 26-bit letter mask of str[ks..ke). */
export function letterMask(str, ks = 0, ke = str.length) {
  let m = 0;
  for (let i = ks; i < ke; i++) {
    const c = str.charCodeAt(i) - 97;
    if (c >= 0 && c < 26) m |= 1 << c;
  }
  return m >>> 0;
}

export function popcount(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
