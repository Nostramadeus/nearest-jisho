// UI (SPEC 5). Talks to worker.js; renders Look A cards.
import { esc, cardHtml, kanjiHtml, groupsHtml } from './render.js';
import { didYouMeanText } from './search/engine.js';

const $ = (id) => document.getElementById(id);
const qEl = $('q'), resultsEl = $('results'), dymEl = $('dym'), progressEl = $('progress');
const recentEl = $('recent'), wikiEl = $('wiki'), settingsEl = $('settings'), gearEl = $('gear');

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

const S = {
  query: '',
  seq: 0,
  ranking: store.get('nj-ranking', 'fiction') === 'news' ? 'news' : 'fiction',
  theme: 'auto',
  recent: store.get('nj-recent', []),
  groupLimits: {},
  loaded: {},
  lastResult: null,
};
try { const t = localStorage.getItem('nj-theme'); if (t === 'light' || t === 'dark') S.theme = t; } catch { /* default */ }
if (!Array.isArray(S.recent)) S.recent = [];

const DEFAULT_LIMIT = 50;
const NAMES_FIRST = 10;

// ---------- worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const PACK_LABEL = { words: 'words', names: 'names', wikt: 'Wiktionary' };

worker.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'version': $('built').textContent = m.built; break;
    case 'progress':
      progressEl.hidden = false;
      progressEl.textContent = `Loading dictionary: ${PACK_LABEL[m.pack] || m.pack} ${m.pct}%`;
      break;
    case 'loaded':
      S.loaded[m.pack] = true;
      if (S.query) runSearch(); // results gain this pack
      break;
    case 'packError':
      progressEl.hidden = false;
      progressEl.textContent = `Could not load the ${PACK_LABEL[m.pack] || m.pack} dictionary (${m.message}).`;
      break;
    case 'done':
      if (progressEl.textContent.startsWith('Loading')) progressEl.hidden = true;
      break;
    case 'error':
      progressEl.hidden = false;
      progressEl.textContent = m.message;
      break;
    case 'updateReady':
      $('built').textContent += ` (newer data ${m.built} downloaded, used from the next start)`;
      break;
    case 'result': onResult(m); break;
    case 'kanji': onKanji(m); break;
  }
};

let kanjiReq = 0;
const kanjiWaiters = new Map();
function askKanji(literal) {
  return new Promise((resolve) => {
    const id = ++kanjiReq;
    kanjiWaiters.set(id, resolve);
    worker.postMessage({ type: 'kanji', id, literal });
  });
}
function onKanji(m) {
  const f = kanjiWaiters.get(m.id);
  if (f) { kanjiWaiters.delete(m.id); f(m.data); }
}

// ---------- search flow ----------
let debounceT = 0, pushT = 0, recentT = 0, lastPushed = null;

function runSearch(phase) {
  S.seq++;
  worker.postMessage({
    type: 'search', seq: S.seq, query: S.query, ranking: S.ranking, limit: DEFAULT_LIMIT,
    groupLimits: { names: NAMES_FIRST, ...S.groupLimits }, recent: S.recent, phase,
  });
}

function setQuery(q, { push = false, focus = false } = {}) {
  S.query = q;
  if (qEl.value !== q) qEl.value = q;
  S.groupLimits = {};
  syncHash(push);
  if (focus) qEl.focus();
  if (!q.trim()) { renderEmpty(); return; }
  runSearch();
  armTimers();
}

function syncHash(push) {
  const hash = S.query ? `#q=${encodeURIComponent(S.query)}` : location.pathname + location.search;
  if (push) { history.pushState(null, '', hash); lastPushed = S.query; } else history.replaceState(null, '', hash);
}

function armTimers() {
  clearTimeout(pushT);
  clearTimeout(recentT);
  const q = S.query;
  pushT = setTimeout(() => { if (S.query === q && lastPushed !== q) { history.pushState(null, '', `#q=${encodeURIComponent(q)}`); lastPushed = q; } }, 1000);
  recentT = setTimeout(() => { if (S.query === q) addRecent(q); }, 2000);
}

qEl.addEventListener('input', () => {
  clearTimeout(debounceT);
  debounceT = setTimeout(() => setQuery(qEl.value), 60);
});
qEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(debounceT); setQuery(qEl.value); qEl.blur(); }
});

function readHash() {
  const m = /^#q=(.*)$/.exec(location.hash);
  let q = '';
  if (m) { try { q = decodeURIComponent(m[1]); } catch { q = m[1]; } }
  return q;
}
window.addEventListener('popstate', () => { const q = readHash(); if (q !== S.query) { lastPushed = q; setQuery(q); } });
window.addEventListener('hashchange', () => { const q = readHash(); if (q !== S.query) setQuery(q); });

// ---------- recent ----------
function addRecent(q) {
  q = q.trim();
  if (!q) return;
  S.recent = [q, ...S.recent.filter((x) => x !== q)].slice(0, 30);
  store.set('nj-recent', S.recent);
}
function renderRecent() {
  if (!S.recent.length) {
    recentEl.innerHTML = '<p class="empty">Type a word in English, Japanese or romaji. Typos are fine.</p>';
  } else {
    recentEl.innerHTML = `<h2>Recent <button type="button" data-act="clear-recent">Clear recent searches</button></h2><ul>${
      S.recent.map((q) => `<li><button type="button" data-recent="${esc(q)}" lang="ja">${esc(q)}</button></li>`).join('')}</ul>`;
  }
  recentEl.hidden = false;
}
recentEl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'clear-recent') { S.recent = []; store.set('nj-recent', []); renderRecent(); return; }
  if (b.dataset.recent !== undefined) setQuery(b.dataset.recent, { push: true, focus: true });
});

// ---------- settings ----------
function applyTheme() {
  if (S.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = S.theme;
}
gearEl.addEventListener('click', () => {
  const open = settingsEl.hidden;
  settingsEl.hidden = !open;
  gearEl.setAttribute('aria-expanded', String(open));
});
for (const r of document.querySelectorAll('input[name="ranking"]')) {
  r.checked = r.value === S.ranking;
  r.addEventListener('change', () => { S.ranking = r.value; store.set('nj-ranking', S.ranking); if (S.query) runSearch(); });
}
for (const r of document.querySelectorAll('input[name="theme"]')) {
  r.checked = r.value === S.theme;
  r.addEventListener('change', () => {
    S.theme = r.value;
    try { if (S.theme === 'auto') localStorage.removeItem('nj-theme'); else localStorage.setItem('nj-theme', S.theme); } catch { /* blocked */ }
    applyTheme();
  });
}
applyTheme();

function onResult(m) {
  if (m.seq !== S.seq || m.query !== S.query) return; // an older query
  if (!S.query.trim()) return;
  if (!m.result) {
    resultsEl.innerHTML = '<p class="empty">The dictionary is still loading. Results appear as soon as the words are in.</p>';
    dymEl.hidden = true;
    renderWiki();
    return;
  }
  S.lastResult = m.result;
  recentEl.hidden = true;
  const r = m.result;
  if (r.didYouMean) {
    const d = r.didYouMean;
    dymEl.innerHTML = esc(didYouMeanText(d)).replace(esc(`Nearest: ${d.key}`),
      `Nearest: <button type="button" data-dym="${esc(d.query)}">${esc(d.key)}</button>`);
    dymEl.hidden = false;
  } else dymEl.hidden = true;
  if (!r.groups.length) {
    const still = !m.loaded.names || !m.loaded.wikt;
    resultsEl.innerHTML = m.phase === 'fast' ? resultsEl.innerHTML
      : `<p class="empty">No results for "${esc(S.query)}".${still ? ' Some dictionaries are still loading.' : ''}</p>`;
  } else {
    resultsEl.innerHTML = groupsHtml(r.groups);
  }
  renderWiki();
}

function renderWiki() {
  const q = S.query.trim();
  if (!q) { wikiEl.hidden = true; return; }
  wikiEl.innerHTML = `<a href="https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}" target="_blank" rel="noopener">Search Wikipedia for "${esc(q)}"</a>`;
  wikiEl.hidden = false;
}

function renderEmpty() {
  S.seq++; // drop answers still in flight
  resultsEl.innerHTML = '';
  dymEl.hidden = true;
  wikiEl.hidden = true;
  renderRecent();
}

dymEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-dym]');
  if (b) setQuery(b.dataset.dym, { push: true, focus: true });
});

resultsEl.addEventListener('click', async (e) => {
  const more = e.target.closest('button[data-more]');
  if (more) {
    const id = more.dataset.more;
    const cur = S.groupLimits[id] || (id === 'names' ? NAMES_FIRST : DEFAULT_LIMIT);
    S.groupLimits[id] = cur + 50;
    runSearch('full');
    return;
  }
  const card = e.target.closest('.card');
  if (card && S.query.trim()) addRecent(S.query); // a tap counts as a finished search
  const tog = e.target.closest('button[data-act="examples"]');
  if (tog) {
    const box = tog.nextElementSibling;
    box.hidden = !box.hidden;
    tog.setAttribute('aria-expanded', String(!box.hidden));
    return;
  }
  const close = e.target.closest('button[data-act="close-kanji"]');
  if (close) { close.closest('.kpanel').remove(); return; }
  const kj = e.target.closest('button[data-kanji]');
  if (kj && card) {
    const literal = kj.dataset.kanji;
    const old = card.querySelector('.kpanel');
    if (old && old.dataset.literal === literal) { old.remove(); return; }
    if (old) old.remove();
    const data = await askKanji(literal);
    const panel = document.createElement('div');
    panel.className = 'kpanel';
    panel.dataset.literal = literal;
    panel.innerHTML = kanjiHtml(literal, data);
    card.appendChild(panel);
  }
});

// ---------- start ----------
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline cache unavailable */ });
}
const initial = readHash();
if (initial) { lastPushed = initial; setQuery(initial); } else renderEmpty();
qEl.focus();
