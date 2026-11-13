// Pure HTML rendering for result cards (no DOM access), shared by main.js and the tests.
import { POS, MISC, FIELD, DIALECT, NAME_TYPE, SLANG_CODES, label } from './labels.js';

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const KANJI_CHAR = /[㐀-䶿一-鿿豈-﫿々\u{20000}-\u{3134f}]/u;

/** Text with the first `len` characters (or all when len = -1) wrapped in <mark>; kanji become buttons if asked. */
export function markText(text, len, kanjiButtons) {
  const chars = Array.from(text || '');
  const n = len === -1 ? chars.length : len == null ? 0 : Math.min(len, chars.length);
  const piece = (cs) => cs.map((c) => (kanjiButtons && KANJI_CHAR.test(c)
    ? `<button type="button" class="kj" data-kanji="${esc(c)}" aria-label="Kanji ${esc(c)}">${esc(c)}</button>` : esc(c))).join('');
  return (n ? `<mark>${piece(chars.slice(0, n))}</mark>` : '') + piece(chars.slice(n));
}

/** Gloss text with each matched English token marked (whole word, or word prefix for the last token). */
export function markTokens(text, tokens) {
  if (!tokens || !tokens.length) return esc(text);
  const lower = text.toLowerCase();
  const isL = (c) => /\p{L}/u.test(c || '');
  const spans = [];
  for (let i = 0; i < text.length; i++) {
    if (i > 0 && isL(text[i - 1])) continue;
    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t];
      if (!lower.startsWith(tok, i)) continue;
      const after = text[i + tok.length];
      if (isL(after) && t !== tokens.length - 1) continue; // only the last token matches as a prefix
      spans.push([i, i + tok.length]);
      i += tok.length - 1;
      break;
    }
  }
  let out = '', pos = 0;
  for (const [a, b] of spans) { out += esc(text.slice(pos, a)) + `<mark>${esc(text.slice(a, b))}</mark>`; pos = b; }
  return out + esc(text.slice(pos));
}

export function headParts(rec, hl) {
  const kf = rec.k || [], rf = rec.r || [];
  let head = kf[0] || rf[0] || '', reading = kf.length ? (rf[0] || '') : '', headMark = null, readMark = null;
  if (hl && hl.space === 'k') {
    if (kf.includes(hl.form)) { head = hl.form; headMark = -1; }
    else if (rf.includes(hl.form)) { if (kf.length) { reading = hl.form; readMark = -1; } else { head = hl.form; headMark = -1; } }
  } else if (hl && hl.space === 'r' && hl.form) {
    if (kf.length) { reading = hl.form; readMark = hl.len; } else { head = hl.form; headMark = hl.len; }
  }
  if (reading === head) reading = '';
  return { head, reading, headMark, readMark };
}

export function sensesHtml(rec, hit, isWikt) {
  const tokens = hit.hl && hit.hl.space === 'e' ? hit.hl.tokens : null;
  const ja = isWikt && rec.src === 'wj';
  let prevPos = '';
  const items = (rec.s || []).map((s, i) => {
    const pos = (s.p || []).map((p) => (isWikt ? p : label(POS, p))).join(' · ');
    const posLine = pos && pos !== prevPos ? `<div class="pos">${esc(pos)}</div>` : '';
    prevPos = pos || prevPos;
    const gl = (s.g || []).map((g) => markTokens(g, tokens)).join('; ');
    const tags = (s.m || []).map((m) => {
      const code = isWikt ? null : m;
      const text = isWikt ? m : label(MISC, m);
      const cls = code && SLANG_CODES.has(code) ? 'tag s' : (isWikt && /slang|vulgar|internet|derogatory|俗語|スラング|卑語|隠語|若者言葉|ネット/i.test(m) ? 'tag s' : 'tag g');
      return ` <span class="${cls}">${esc(text)}</span>`;
    }).join('');
    const extra = [...(s.f || []).map((f) => label(FIELD, f)), ...(s.d || []).map((d) => label(DIALECT, d))];
    const extraHtml = extra.length ? ` <span class="info">(${esc(extra.join(', '))})</span>` : '';
    const info = s.i ? ` <span class="info">${esc(s.i)}</span>` : '';
    let ex = '';
    if (i === 0 && s.x && s.x.length) ex = exampleHtml(s.x[0]);
    return `<li>${posLine}<span${ja ? ' lang="ja"' : ''}>${gl}</span>${tags}${extraHtml}${info}${ex}</li>`;
  });
  return `<ol>${items.join('')}</ol>`;
}

export function exampleHtml(pair) {
  return `<div class="ex"><span class="ja" lang="ja">${esc(pair[0])}</span><span class="en">${esc(pair[1])}</span></div>`;
}

export function cardHtml(hit, gi, ri) {
  const rec = hit.rec;
  const isWikt = hit.pack === 'wikt';
  const isName = hit.pack === 'names';
  const { head, reading, headMark, readMark } = headParts(rec, hit.hl);
  const tags = [];
  if (rec.c) tags.push('<span class="tag">common</span>');
  if (rec.j) tags.push(`<span class="tag g">N${esc(rec.j)}</span>`);
  if (isWikt) tags.push(rec.src === 'wj' ? '<span class="tag g">Japanese definition</span>' : '<span class="tag g">Wiktionary</span>');
  if (isName) for (const t of rec.t || []) tags.push(`<span class="tag g">${esc(label(NAME_TYPE, t))}</span>`);
  const notes = hit.note ? `<div class="note">${esc(hit.note)}</div>` : '';
  let body;
  if (isName) {
    body = `<ol><li>${(rec.g || []).map(esc).join('; ')}</li></ol>`;
  } else {
    body = sensesHtml(rec, hit, isWikt);
  }
  // examples beyond the first one of the first sense
  const rest = [];
  (rec.s || []).forEach((s, si) => (s.x || []).forEach((x, xi) => { if (!(si === 0 && xi === 0)) rest.push([si, x]); }));
  const moreEx = rest.length
    ? `<button type="button" class="toggle" data-act="examples" aria-expanded="false">More examples (${rest.length})</button>` +
      `<div class="moreex" hidden>${rest.map(([si, x]) => `<div class="ex"><span class="info">Meaning ${si + 1}</span>${exampleHtml(x).slice(16, -6)}</div>`).join('')}</div>`
    : '';
  const otherK = (rec.k || []).filter((f) => f !== head);
  const otherR = (rec.r || []).filter((f) => f !== reading && f !== head);
  const forms = otherK.length || otherR.length
    ? `<div class="forms">Other forms: <span lang="ja">${esc([...otherK, ...otherR].join('、'))}</span></div>` : '';
  const link = isWikt && rec.u
    ? `<div class="link"><a href="${esc(rec.u)}" target="_blank" rel="noopener">Open in Wiktionary</a></div>` : '';
  return `<article class="card" data-g="${gi}" data-r="${ri}">` +
    `<div class="word">${reading ? `<div class="kana" lang="ja">${markText(reading, readMark, false)}</div>` : ''}` +
    `<div class="kanji" lang="ja">${markText(head, headMark, true)}</div>` +
    `${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}</div>` +
    `<div class="body">${notes}${body}${moreEx}${forms}${link}</div></article>`;
}


export function kanjiHtml(literal, k) {
  const close = '<button type="button" class="close" data-act="close-kanji">Close</button>';
  if (!k) return `${close}<div class="big" lang="ja">${esc(literal)}</div><p class="dim">No kanji information available.</p>`;
  const row = (t, v) => (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) ? '' : `<dt>${t}</dt><dd>${v}</dd>`);
  return `${close}<div class="big" lang="ja">${esc(literal)}</div><dl>` +
    row('Meanings', esc((k.m || []).join(', '))) +
    row('On readings', k.on && k.on.length ? `<span lang="ja">${esc(k.on.join('、'))}</span>` : '') +
    row('Kun readings', k.kun && k.kun.length ? `<span lang="ja">${esc(k.kun.join('、'))}</span>` : '') +
    row('Name readings', k.n && k.n.length ? `<span lang="ja">${esc(k.n.join('、'))}</span>` : '') +
    row('Strokes', k.s != null ? esc(k.s) : '') +
    row('School grade', k.g != null ? esc(k.g <= 6 ? k.g : k.g <= 8 ? 'secondary school' : 'name use') : '') +
    row('JLPT level (old four-level test)', k.j != null ? esc(k.j) : '') +
    row('Newspaper frequency rank', k.f != null ? esc(k.f) : '') +
    '</dl>';
}


/** All groups of one search result as HTML (SPEC 4.4 "Did you mean" line before tier-3 near results). */
export function groupsHtml(groups) {
  return groups.map((g, gi) => {
    let html = `<section class="group" data-group="${esc(g.id)}"><h2>${esc(g.title)} <span class="count">${g.total}</span></h2>`;
    let nearShown = false;
    g.results.forEach((h, ri) => {
      if (h.tier === 3 && h.via !== 'contains' && !nearShown) {
        html += '<div class="near">Did you mean</div>';
        nearShown = true;
      }
      html += cardHtml(h, gi, ri);
    });
    if (g.total > g.results.length) html += `<button type="button" class="more" data-more="${esc(g.id)}">Show more</button>`;
    return html + '</section>';
  }).join('');
}
