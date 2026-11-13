// Weighted Damerau-Levenshtein, optimal string alignment (SPEC 4.5, revised by SPEC 18 / design/typo-study.md 2.1-2.8).
// All costs are integers in tenths (0.2 -> 2) so sums are exact.

export const COST = {
  DOUBLE: 3,      // insert/delete a letter equal to its left or right neighbour
  SOFT: 2,        // insert/delete u after o/u, o after o, ' or - anywhere
  SWAP: 5,        // swap two adjacent letters
  TOUCH: 5,       // substitute, keys touch on QWERTY
  OTHER: 10,      // any other edit (SPEC 18 ruling 10: the "one key between" 0.8 cost is removed)
  FIRST: 3,       // extra for substitute or delete at query position 0
  DIGRAPH: 4,     // study 2.1: h after s/c, y in a ky-type sound, t before s (either side)
  YOON_I: 5,      // study 2.1: i between a ky-type consonant and y (kiyou / kyou)
  DEVOICED: 5,    // study 2.7: whispered u / i the key has and the query lacks
  FATFINGER: 6,   // study 2.8: an extra query letter that touches its neighbour on QWERTY
};

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const XOFF = [0, 0.25, 0.75];
const POS = new Map();
ROWS.forEach((row, y) => { for (let i = 0; i < row.length; i++) POS.set(row.charCodeAt(i), [XOFF[y] + i, y]); });

// Touch table for a..z. Index (a-97)*26 + (b-97): 1 when the keys touch (distance < 1.3).
const TOUCHES = new Uint8Array(26 * 26);
for (let a = 0; a < 26; a++) for (let b = 0; b < 26; b++) {
  if (a === b) continue;
  const [ax, ay] = POS.get(97 + a), [bx, by] = POS.get(97 + b);
  if (Math.hypot(ax - bx, ay - by) < 1.3) TOUCHES[a * 26 + b] = 1;
}
const touches = (a, b) => {
  const x = a - 97, y = b - 97;
  return x >= 0 && x < 26 && y >= 0 && y < 26 && TOUCHES[x * 26 + y] === 1;
};

/** Substitution cost in tenths for two different characters: touch 5, any other 10 (keyboard off: 10). */
export function subCost(a, b, keyboard) {
  if (!keyboard) return COST.OTHER;
  return touches(a, b) ? COST.TOUCH : COST.OTHER;
}

/** Keyboard relation of two letters: 'touch' | 'far'. */
export function keyRelation(a, b) {
  return touches(a.charCodeAt(0), b.charCodeAt(0)) ? 'touch' : 'far';
}

/** Tier-3 budget in tenths by canonical query length (SPEC 4.4). 0 = no tier 3. */
export function budget(len) {
  if (len <= 3) return 0;
  if (len <= 5) return 10;
  if (len <= 8) return 15;
  return 20;
}

const APOS = 39, HYPHEN = 45, U = 117, O = 111, H = 104, Y = 121, T = 116, S = 115, C = 99, I = 105;
const YOON_CONS = new Set('kgnhbpmr'.split('').map((c) => c.charCodeAt(0)));
const AUO = new Set('auo'.split('').map((c) => c.charCodeAt(0)));
const VOICELESS_NEXT = new Set('ksthpcf'.split('').map((c) => c.charCodeAt(0)));
const U_PREV = new Set('skfp'.split('').map((c) => c.charCodeAt(0)));
const I_PREV = new Set('hk'.split('').map((c) => c.charCodeAt(0)));

/**
 * Cost and kind of inserting/deleting str[idx] (range start..end), without the position-0 extra.
 * side: 'query' (the query has the letter, the key lacks it) or 'key' (the key has it, the query lacks it).
 * o: { soft, romaji (study rules 2.1 / 2.7 / 2.8 on), keyboard }.
 * Kinds: soft, digraph, yoon, devoiced, double, fatfinger, other.
 */
const KINDS = ['soft', 'digraph', 'yoon', 'devoiced', 'double', 'fatfinger', 'other'];
const K_SOFT = 0, K_DIGRAPH = 1000, K_YOON = 2000, K_DEVOICED = 3000, K_DOUBLE = 4000, K_FAT = 5000, K_OTHER = 6000;
export function indelKind(str, start, end, idx, side, o) {
  const code = indelCode(str, start, end, idx, side, o);
  return [code % 1000, KINDS[Math.floor(code / 1000)]];
}
function indelCode(str, start, end, idx, side, o) {
  const c = str.charCodeAt(idx);
  const prev = idx > start ? str.charCodeAt(idx - 1) : -1;
  const next = idx + 1 < end ? str.charCodeAt(idx + 1) : -1;
  if (o.soft) {
    if (c === APOS || c === HYPHEN) return K_SOFT + COST.SOFT;
    if (c === U && (prev === O || prev === U)) return K_SOFT + COST.SOFT;
    if (c === O && prev === O) return K_SOFT + COST.SOFT;
  }
  if (o.romaji) {
    if (c === H && (prev === S || prev === C)) return K_DIGRAPH + COST.DIGRAPH;
    if (c === Y && YOON_CONS.has(prev) && AUO.has(next)) return K_DIGRAPH + COST.DIGRAPH;
    if (c === T && next === S && prev !== T) return K_DIGRAPH + COST.DIGRAPH;
    if (c === I && YOON_CONS.has(prev) && next === Y) return K_YOON + COST.YOON_I;
    if (side === 'key') {
      if (c === U && U_PREV.has(prev) && (next === -1 || VOICELESS_NEXT.has(next))) return K_DEVOICED + COST.DEVOICED;
      if (c === I && I_PREV.has(prev) && VOICELESS_NEXT.has(next)) return K_DEVOICED + COST.DEVOICED;
    }
  }
  if (c === prev || c === next) return K_DOUBLE + COST.DOUBLE;
  if (o.romaji && o.keyboard && side === 'query' && ((prev !== -1 && touches(c, prev)) || (next !== -1 && touches(c, next)))) {
    return K_FAT + COST.FATFINGER;
  }
  return K_OTHER + COST.OTHER;
}

const options = (opts = {}) => ({
  keyboard: opts.keyboard !== false, soft: opts.soft !== false, first: opts.first !== false, romaji: opts.romaji !== false,
});

/**
 * Prepare a query for repeated distance() calls.
 * opts: { keyboard, soft (u/o/'/- row), first (position-0 extra), romaji (study rules; off for English) }
 */
export function prepareQuery(q, opts = {}) {
  const o = options(opts);
  const n = q.length;
  const codes = new Int32Array(n);
  const del = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    codes[i] = q.charCodeAt(i);
    del[i] = (indelCode(q, 0, n, i, 'query', o) % 1000) + (i === 0 && o.first ? COST.FIRST : 0);
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
  for (let j = 0; j < m; j++) ins[j] = indelCode(str, ks, ke, ks + j, 'key', P) % 1000;
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
 * Full alignment with traceback. Returns { cost, ops: [{ op: 'sub'|'del'|'ins'|'swap', cost, kind, i, j }] }
 * 'del' = the query has a letter the key lacks; 'ins' = the key has a letter the query lacks.
 */
export function explain(q, key, opts = {}) {
  const P = prepareQuery(q, opts);
  const n = q.length, m = key.length;
  const ins = new Int32Array(m), insK = [], delK = [];
  for (let j = 0; j < m; j++) { const [c, k] = indelKind(key, 0, m, j, 'key', P); ins[j] = c; insK.push(k); }
  for (let i = 0; i < n; i++) delK.push(indelKind(q, 0, n, i, 'query', P)[1]);
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
        ops.push({ op: 'swap', cost: COST.SWAP, kind: 'swap', i: i - 2, j: j - 2 }); i -= 2; j -= 2; continue;
      }
      if (qc !== kc && D[i - 1][j - 1] + s === here) {
        const base = subCost(qc, kc, P.keyboard);
        ops.push({ op: 'sub', cost: s, kind: base === COST.TOUCH ? 'touch' : 'other', i: i - 1, j: j - 1, base }); i--; j--; continue;
      }
    }
    if (i > 0 && D[i - 1][j] + P.del[i - 1] === here) { ops.push({ op: 'del', cost: P.del[i - 1], kind: delK[i - 1], i: i - 1, j }); i--; continue; }
    if (j > 0 && D[i][j - 1] + ins[j - 1] === here) { ops.push({ op: 'ins', cost: ins[j - 1], kind: insK[j - 1], i, j: j - 1 }); j--; continue; }
    break; // should not happen
  }
  ops.reverse();
  return { cost: D[n][m], ops };
}

/** Reason label of one edit (SPEC 4.4 labels plus study 2.1, 2.7). */
export function opLabel(o) {
  switch (o.op) {
    case 'swap': return 'letters swapped';
    case 'sub': return o.kind === 'touch' ? 'neighbouring key' : 'one letter different';
    case 'del':
      if (o.kind === 'soft' || o.kind === 'double') return 'long vowel / double letter';
      if (o.kind === 'digraph') return 'h or y extra';
      if (o.kind === 'yoon') return 'small ゃゅょ';
      return 'one extra letter';
    case 'ins':
      if (o.kind === 'soft' || o.kind === 'double') return 'long vowel / double letter';
      if (o.kind === 'digraph') return 'h or y missing';
      if (o.kind === 'yoon') return 'small ゃゅょ';
      if (o.kind === 'devoiced') return 'silent u / i missing';
      return 'one letter missing';
  }
  return 'one letter different';
}

/**
 * Reason label for a near match. With several edits, the most costly edit names the reason (first one on a tie).
 */
export function reasonFor(q, key, opts = {}) {
  const { ops } = explain(q, key, opts);
  if (!ops.length) return 'long vowel / double letter';
  let pick = ops[0];
  for (const o of ops) if (o.cost > pick.cost) pick = o;
  return opLabel(pick);
}

/**
 * P table of the score S = cost + P(rank) (SPEC 18, design/typo-study.md 1.1): 6 per factor 10 of rank from rank
 * 1000; P_LIMITS[i] is the highest rank with P = i; above the last limit P = 18.
 */
export const P_LIMITS = [1211, 1778, 2610, 3831, 5623, 8254, 12115, 17783, 26102, 38312, 56234, 82540, 121153, 177828,
  261016, 383119, 562341, 825404];
export function pRank(rank) {
  for (let i = 0; i < P_LIMITS.length; i++) if (rank <= P_LIMITS[i]) return i;
  return 18;
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
