// Pure HTML rendering for result cards (no DOM access), shared by main.js and the tests.
import { POS, MISC, FIELD, DIALECT, NAME_TYPE, SLANG_CODES, label } from './labels.js';
import { entryAddress, entryHash } from './search/entry.js';

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Text with the first `len` characters (or all when len = -1) wrapped in <mark>. */
export function markText(text, len) {
  const chars = Array.from(text || '');
  const n = len === -1 ? chars.length : len == null ? 0 : Math.min(len, chars.length);
  return (n ? `<mark>${esc(chars.slice(0, n).join(''))}</mark>` : '') + esc(chars.slice(n).join(''));
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

/** Numbered senses. opts.allExamples: every stored example under its sense (entry page); else only the first one. */
export function sensesHtml(rec, hit, isWikt, opts = {}) {
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
    if (opts.allExamples) ex = (s.x || []).map(exampleHtml).join('');
    else if (i === 0 && s.x && s.x.length) ex = exampleHtml(s.x[0]);
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
  const href = entryHash(entryAddress(hit.pack, rec));
  return `<article class="card" data-g="${gi}" data-r="${ri}" data-entry="${esc(href)}">` +
    `<div class="word">${reading ? `<div class="kana" lang="ja">${markText(reading, readMark)}</div>` : ''}` +
    `<div class="kanji" lang="ja"><a class="hw" href="${esc(href)}">${markText(head, headMark)}</a></div>` +
    `${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}</div>` +
    `<div class="body">${notes}${body}${moreEx}${forms}${link}</div></article>`;
}


/** One "Kanji in this word" block (SPEC 10.2 section 4); lines without data are omitted. */
export function kanjiBlockHtml(literal, k) {
  const row = (t, v) => (v === '' || v == null ? '' : `<dt>${t}</dt><dd>${v}</dd>`);
  const ja = (list) => (list && list.length ? `<span lang="ja">${esc(list.join('、'))}</span>` : '');
  k = k || {};
  return `<div class="kblock"><div class="big" lang="ja">${esc(literal)}</div><dl>` +
    row('Meanings', k.m && k.m.length ? esc(k.m.join(', ')) : '') +
    row('On readings', ja(k.on)) +
    row('Kun readings', ja(k.kun)) +
    row('Name readings', ja(k.n)) +
    row('Strokes', k.s != null ? esc(k.s) : '') +
    row('School grade', k.g != null ? esc(k.g <= 6 ? k.g : k.g <= 8 ? 'secondary school' : 'used in names') : '') +
    row('JLPT level (old four-level test)', k.j != null ? esc(k.j) : '') +
    '</dl></div>';
}

const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;

/** The entry page (SPEC 10.2). d = entryData() from search/entry.js. */
export function entryHtml(d) {
  const { rec, pack, head } = d;
  const isWikt = pack === 'wikt', isName = pack === 'names';
  const tags = [];
  if (rec.c) tags.push('<span class="tag">common</span>');
  if (rec.j) tags.push(`<span class="tag g">N${esc(rec.j)}</span>`);
  if (isWikt) tags.push(rec.src === 'wj' ? '<span class="tag g">Japanese definition</span>' : '<span class="tag g">Wiktionary</span>');
  if (!isWikt) {
    const seen = new Set();
    for (const s of rec.s || []) for (const m of s.m || []) {
      if (SLANG_CODES.has(m) && !seen.has(m)) { seen.add(m); tags.push(`<span class="tag s">${esc(label(MISC, m))}</span>`); }
    }
  }
  const reading = d.reading && d.reading !== head ? d.reading : '';
  let html = '<article class="entry">' +
    `<header class="entry-head">${reading ? `<div class="kana" lang="ja">${esc(reading)}</div>` : ''}` +
    `${d.romaji ? `<div class="romaji">${esc(d.romaji)}</div>` : ''}` +
    `<h2 class="entry-word" lang="ja">${esc(head)}</h2>` +
    `${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}</header>`;
  const sec = (title, body) => `<section class="entry-sec"><h3>${title}</h3>${body}</section>`;
  if (!isWikt) {
    const others = [...(rec.k || []), ...(rec.r || [])].filter((f) => f !== head && f !== reading);
    if (others.length) html += sec('Other forms', `<p lang="ja">${esc(others.join('、'))}</p>`);
  }
  if (isName) {
    if (rec.t && rec.t.length) html += sec('Name type', `<p>${esc(rec.t.map((t) => label(NAME_TYPE, t)).join(', '))}</p>`);
    html += sec('Translations', `<ol>${(rec.g || []).map((g) => `<li>${esc(g)}</li>`).join('')}</ol>`);
  } else {
    html += sec('Meanings', sensesHtml(rec, {}, isWikt, { allExamples: true }));
  }
  if (d.kanji.length) html += sec('Kanji in this word', d.kanji.map((b) => kanjiBlockHtml(b.literal, b.data)).join(''));
  if (d.startsWith.length) {
    html += sec(`Words that start with <span lang="ja">${esc(head)}</span>`, `<ul class="starts">${d.startsWith.map((x) =>
      `<li><a href="${esc(entryHash(x))}"><span lang="ja">${esc(x.head)}</span>${x.reading ? ` <span class="kana" lang="ja">${esc(x.reading)}</span>` : ''}</a>` +
      `${x.gloss ? ` <span class="info">${esc(x.gloss)}</span>` : ''}</li>`).join('')}</ul>`);
  }
  const links = [ext(`https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(head)}`, `Search Wikipedia for "${esc(head)}"`)];
  if (isWikt && rec.u) links.push(ext(rec.u, rec.src === 'wj' ? 'Open in Japanese Wiktionary' : 'Open in Wiktionary'));
  if (pack === 'words') links.push(ext(`https://jisho.org/search/${encodeURIComponent(head)}`, 'Look up on Jisho.org'));
  html += `<section class="entry-sec links"><h3>Links</h3><ul>${links.map((l) => `<li>${l}</li>`).join('')}</ul></section>`;
  return html + '</article>';
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
