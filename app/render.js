// Pure HTML rendering for result cards (no DOM access), shared by main.js and the tests.
import { POS, MISC, FIELD, DIALECT, NAME_TYPE, SLANG_CODES, label } from './labels.js';
import { entryAddress, entryHash, usuallyKana } from './search/entry.js';
import { firstGloss } from './favorites.js';

const STAR_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>';

/**
 * Favorite star (SPEC 11): aria-pressed true = filled star. data-* carry the entry address and the first gloss.
 * opts.fav(w, r, p) -> bool tells the current state.
 */
export function starHtml(addr, gloss, on, extraClass = '', shown = '') {
  return `<button type="button" class="star${extraClass ? ' ' + extraClass : ''}" aria-pressed="${on ? 'true' : 'false'}" aria-label="Favorite"` +
    ` data-w="${esc(addr.w)}" data-r="${esc(addr.r)}" data-p="${esc(addr.p)}" data-g="${esc(gloss || '')}"` +
    `${shown && shown !== addr.w ? ` data-h="${esc(shown)}"` : ''}>${STAR_SVG}</button>`;
}
const isFav = (opts, a) => !!(opts && opts.fav && opts.fav(a.w, a.r, a.p));

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

/**
 * Headword, reading line and marks of a card. SPEC 19.2: a record whose first sense is uk shows its kana form as the
 * headword (kanji forms go to "Other forms"), except when the typed query / segment equals one of its forms (hl k).
 */
export function headParts(rec, hl) {
  const kf = rec.k || [], rf = rec.r || [];
  const uk = usuallyKana(rec);
  const kanaHead = !kf.length || uk;
  let head = kanaHead ? (rf[0] || kf[0] || '') : kf[0], reading = kanaHead ? '' : (rf[0] || ''), headMark = null, readMark = null;
  if (hl && hl.space === 'k') {
    if (kf.includes(hl.form)) { head = hl.form; headMark = -1; reading = rf[0] || ''; }
    else if (rf.includes(hl.form)) {
      if (kanaHead) { head = hl.form; headMark = -1; } else { reading = hl.form; readMark = -1; }
    }
  } else if (hl && hl.space === 'r' && hl.form) {
    if (kanaHead) { head = hl.form; headMark = hl.len; } else { reading = hl.form; readMark = hl.len; }
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

export function cardHtml(hit, gi, ri, opts = {}) {
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
  const addr = entryAddress(hit.pack, rec);
  const href = entryHash(addr);
  return `<article class="card" data-g="${gi}" data-r="${ri}" data-entry="${esc(href)}">` +
    starHtml(addr, firstGloss(rec), isFav(opts, addr), '', head) +
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

export const SENT_LOADING = 'Loading sentences…';

/** Japanese text with the first occurrence of form wrapped in <mark> (no mark when absent). */
export function markForm(text, form) {
  const i = form ? text.indexOf(form) : -1;
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + `<mark>${esc(form)}</mark>` + esc(text.slice(i + form.length));
}

/** One Tatoeba sentence (SPEC 13.4). */
export function sentenceHtml(s) {
  return `<li class="sent"><span class="ja" lang="ja">${markForm(s.ja, s.form)}</span>` +
    `<span class="en">${esc(s.en)}</span>` +
    `<a class="tatoeba" href="https://tatoeba.org/sentences/show/${encodeURIComponent(s.id)}" target="_blank" rel="noopener">Tatoeba #${esc(s.id)}</a></li>`;
}

/** The entry page (SPEC 10.2). d = entryData() from search/entry.js. */
export function entryHtml(d, opts = {}) {
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
    `<div class="entry-title"><h2 class="entry-word" lang="ja">${esc(head)}</h2>` +
    `${starHtml(entryAddress(pack, rec), firstGloss(rec), isFav(opts, entryAddress(pack, rec)), 'entry-star', head)}</div>` +
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
  if (d.sentences === null) html += sec('Sentences with this word', `<p class="dim">${SENT_LOADING}</p>`);
  else if (d.sentences && d.sentences.length) {
    html += sec(`Sentences with this word (${d.sentences.length})`, `<ol class="sents">${d.sentences.map(sentenceHtml).join('')}</ol>`);
  }
  if (d.kanji.length) html += sec('Kanji in this word', d.kanji.map((b) => kanjiBlockHtml(b.literal, b.data)).join(''));
  const wordRows = (list) => `<ul class="starts">${list.map((x) =>
    `<li><a href="${esc(entryHash(x))}"><span lang="ja">${esc(x.head)}</span>${x.reading ? ` <span class="kana" lang="ja">${esc(x.reading)}</span>` : ''}</a>` +
    `${x.gloss ? ` <span class="info">${esc(x.gloss)}</span>` : ''}</li>`).join('')}</ul>`;
  const base = d.written || head;
  if (d.startsWith.length) html += sec(`Words that start with <span lang="ja">${esc(base)}</span>`, wordRows(d.startsWith));
  if (d.endsWith && d.endsWith.length) html += sec(`Words that end with <span lang="ja">${esc(base)}</span>`, wordRows(d.endsWith));
  const links = [ext(`https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(head)}`, `Search Wikipedia for "${esc(head)}"`)];
  if (isWikt && rec.u) links.push(ext(rec.u, rec.src === 'wj' ? 'Open in Japanese Wiktionary' : 'Open in Wiktionary'));
  if (pack === 'words') links.push(ext(`https://jisho.org/search/${encodeURIComponent(head)}`, 'Look up on Jisho.org'));
  html += `<section class="entry-sec links"><h3>Links</h3><ul>${links.map((l) => `<li>${l}</li>`).join('')}</ul></section>`;
  return html + '</article>';
}

/** All groups of one search result as HTML (SPEC 4.4 "Did you mean" line before tier-3 near results). */
export function groupsHtml(groups, opts = {}) {
  return groups.map((g, gi) => {
    if (g.id === 'text') return textGroupHtml(g, gi, opts);
    let html = `<section class="group" data-group="${esc(g.id)}"><h2>${esc(g.title)} <span class="count">${g.total}</span></h2>`;
    let nearShown = false;
    g.results.forEach((h, ri) => {
      if (h.tier === 3 && h.via !== 'contains' && !nearShown) {
        html += '<div class="near">Did you mean</div>';
        nearShown = true;
      }
      html += cardHtml(h, gi, ri, opts);
    });
    if (g.total > g.results.length) html += `<button type="button" class="more" data-more="${esc(g.id)}">Show more</button>`;
    return html + '</section>';
  }).join('');
}

export const FAV_EMPTY = 'No favorites yet. Click the star on a word to keep it here.';

/**
 * Favorites view (SPEC 11). list: favorites newest first. removed: Set of "w	r	p" keys clicked off during this
 * visit; those rows stay, greyed, with an outlined star, so a second click restores them.
 */
export function favoritesHtml(list, removed = new Set()) {
  const key = (f) => `${f.w}	${f.r}	${f.p}`;
  const active = list.filter((f) => !removed.has(key(f))).length;
  let html = `<div class="fav-head"><h2>Favorites (${active})</h2>` +
    `<button type="button" class="copy" data-act="copy-favorites"${active ? '' : ' disabled'}>Copy list</button>` +
    '<span class="copied" role="status"></span></div>';
  if (!list.length) return html + `<p class="empty">${esc(FAV_EMPTY)}</p>`;
  html += '<ul class="favs">';
  for (const f of list) {
    const off = removed.has(key(f));
    html += `<li class="fav${off ? ' removed' : ''}" data-t="${esc(f.t || 0)}">` +
      `<a href="${esc(entryHash(f))}" lang="ja" class="fav-word">${esc(f.h || f.w)}</a>` +
      `${f.r && f.r !== (f.h || f.w) ? ` <span class="kana" lang="ja">${esc(f.r)}</span>` : ''}` +
      `${f.g ? ` <span class="info">${esc(f.g)}</span>` : ''}` +
      starHtml(f, f.g, !off, 'fav-star', f.h) + '</li>';
  }
  return html + '</ul>';
}

const PACK_WORDS = { words: 'words', names: 'names', wikt: 'Wiktionary', sent: 'sentences', kanji: 'kanji' };

/**
 * The update bar under the search row (SPEC 15). state:
 * { kind: 'offer', text } | { kind: 'progress', pack, pct } | { kind: 'done', text } | { kind: 'failed', text }
 */
export function updateBarHtml(state) {
  const btn = (act, label) => `<button type="button" data-update="${act}">${label}</button>`;
  switch (state.kind) {
    case 'offer':
      return `<span class="msg">${esc(state.text)}</span>${btn('download', 'Download')}${btn('notnow', 'Not now')}${btn('never', 'Never ask')}`;
    case 'progress':
      return `<span class="msg">Downloading dictionary data: ${esc(PACK_WORDS[state.pack] || state.pack)} ${esc(state.pct)}%</span>${btn('cancel', 'Cancel')}`;
    case 'done':
      return `<span class="msg">${esc(state.text)}</span>${btn('close', 'Close')}`;
    case 'failed':
      return `<span class="msg">${esc(state.text)}</span>${btn('retry', 'Try again')}${btn('close', 'Close')}`;
  }
  return '';
}

/**
 * "Words in this text" (SPEC 17.4): line 1 = the text with a chip per word (unknown runs dim, separators kept),
 * then one item per distinct record in text order: a compact row for function words, else the normal card plus
 * the deinflection note and "N other entries for <segment>".
 */
export function textGroupHtml(g, gi, opts = {}) {
  const words = g.wordCount || g.results.length;
  let html = `<section class="group textgroup" data-group="text"><h2>${esc(g.title)} <span class="count">${words}</span></h2>`;
  html += '<p class="textline" lang="ja">' + (g.segments || []).map((x) => {
    if (x.kind === 'word') return `<button type="button" class="chip" data-item="${x.item}">${esc(x.text)}</button>`;
    if (x.kind === 'unknown') return `<span class="unk">${esc(x.text)}</span>`;
    return esc(x.text); // separators, and text after the first 60 words
  }).join('') + '</p>';
  for (const n of g.notes || (g.note ? [g.note] : [])) html += `<p class="textnote">${esc(n)}</p>`;
  g.results.forEach((h, i) => {
    html += `<div class="titem" id="t-${i}">`;
    if (h.fn) html += functionRowHtml(h);
    else {
      html += cardHtml(h, gi, i, opts);
      if (h.others > 0) {
        html += `<p class="others"><a href="#q=${encodeURIComponent(h.segment)}">${h.others} other entr${h.others === 1 ? 'y' : 'ies'} for <span lang="ja">${esc(h.segment)}</span></a></p>`;
      }
    }
    html += '</div>';
  });
  return html + '</section>';
}

/** Compact row for a function word: segment, reading, part of speech in full words, first gloss; links to the entry. */
export function functionRowHtml(h) {
  const rec = h.rec;
  const reading = (rec.r || [])[0] || '';
  const pos = ((rec.s && rec.s[0] && rec.s[0].p) || []).map((x) => label(POS, x)).join(' · ');
  const gloss = rec.s && rec.s[0] && rec.s[0].g ? rec.s[0].g[0] : '';
  const href = entryHash(entryAddress(h.pack, rec));
  return `<a class="fnrow" href="${esc(href)}"><span class="seg" lang="ja">${esc(h.segment)}</span>` +
    `${reading && reading !== h.segment ? ` <span class="kana" lang="ja">${esc(reading)}</span>` : ''}` +
    `${pos ? ` <span class="pos">${esc(pos)}</span>` : ''}${gloss ? ` <span class="info">${esc(gloss)}</span>` : ''}</a>`;
}
