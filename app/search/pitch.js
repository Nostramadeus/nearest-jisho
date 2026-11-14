// Pitch accent (SPEC 25). Pure: no DOM, no fetch. Used by the app (entry page) and by build/lib/pitch.mjs.
import { toHiragana } from './romaji.js';

// Small kana join the mora before them; ー, っ and ん are morae of their own (they are not in this set).
const SMALL = new Set(Array.from('ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ'));

/** Split a kana string into morae: きょう -> [きょ, う]. */
export function morae(kana) {
  const out = [];
  for (const ch of Array.from(kana || '')) {
    if (SMALL.has(ch) && out.length) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/** "0,3" -> [0, 3]; anything that is not a whole number is dropped ("*" -> []). Duplicates removed, order kept. */
export function accentValues(v) {
  const out = [];
  for (const s of String(v == null ? '' : v).split(',')) {
    const t = s.trim();
    if (!/^\d+$/.test(t)) continue;
    const n = Number(t);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * High (true) / low (false) per mora for accent type n over `count` morae:
 * n=0 -> mora 1 low, the rest high; n=1 -> mora 1 high, the rest low; n>=2 -> mora 1 low, morae 2..n high, rest low.
 */
export function highs(n, count) {
  const out = [];
  for (let i = 1; i <= count; i++) out.push(n === 0 ? i > 1 : n === 1 ? i === 1 : i >= 2 && i <= n);
  return out;
}

/**
 * Key of a words record in the pitch pack: "<first kanji form>\t<first kana form in hiragana>", or the hiragana of
 * the first kana form for a record without a kanji form. '' when the record has no kana form.
 */
export function pitchKey(rec) {
  const r = rec && rec.r && rec.r[0];
  if (!r) return '';
  return rec.k && rec.k.length ? `${rec.k[0]}\t${toHiragana(r)}` : toHiragana(r);
}

/** Accent values that fit the kana: whole numbers from 0 to the mora count. */
export function fittingValues(kana, value) {
  const count = morae(kana).length;
  return count ? accentValues(value).filter((n) => n <= count) : [];
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * One pattern per value: the kana with a line over the high morae (class "hi", CSS border-top), "ꜜ" after the
 * accent-nucleus mora (mora n, for n >= 1), then "[n]" (class "pn", muted). Patterns are comma-separated.
 */
export function pitchHtml(kana, values) {
  const mo = morae(kana);
  return values.map((n) => {
    const hi = highs(n, mo.length);
    const body = mo.map((m, i) => `<span class="mo${hi[i] ? ' hi' : ''}">${esc(m)}</span>` +
      (n >= 1 && i + 1 === n ? '<span class="drop" aria-hidden="true">ꜜ</span>' : '')).join('');
    return `<span class="pat" lang="ja">${body}</span> <span class="pn">[${n}]</span>`;
  }).join(', ');
}
