// UI (SPEC 5 and 10). Talks to worker.js; renders Look A cards and the entry page.
import { esc, groupsHtml, entryHtml } from './render.js';
import { didYouMeanText } from './search/engine.js';
import { parseEntryHash, entryHash } from './search/entry.js';

const $ = (id) => document.getElementById(id);
const qEl = $('q'), resultsEl = $('results'), dymEl = $('dym'), progressEl = $('progress');
const recentEl = $('recent'), wikiEl = $('wiki'), settingsEl = $('settings'), gearEl = $('gear');
const searchViewEl = $('searchview'), entryEl = $('entry'), clearEl = $('clear');

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
  view: 'search',  // 'search' | 'entry'
  entry: null,     // { w, r, p } of the open entry page
  entryReq: 0,
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
    case 'entry': onEntry(m); break;
  }
};

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
  if (S.view === 'entry') { push = true; showSearchView(); } // typing leaves the entry page; Back returns to it
  S.query = q;
  if (qEl.value !== q) qEl.value = q;
  S.groupLimits = {};
  syncHash(push);
  if (focus) qEl.focus();
  if (!q.trim()) { renderEmpty(); return; }
  runSearch();
  armTimers();
}

function emptyAddress() { return location.pathname + location.search; }

function syncHash(push) {
  const hash = S.query ? `#q=${encodeURIComponent(S.query)}` : emptyAddress();
  if (push) { history.pushState(null, '', hash); lastPushed = S.query; } else history.replaceState(null, '', hash);
}

function armTimers() {
  clearTimeout(pushT);
  clearTimeout(recentT);
  const q = S.query;
  pushT = setTimeout(() => {
    if (S.view === 'search' && S.query === q && lastPushed !== q) { history.pushState(null, '', `#q=${encodeURIComponent(q)}`); lastPushed = q; }
  }, 1000);
  recentT = setTimeout(() => { if (S.query === q) addRecent(q); }, 2000);
}

qEl.addEventListener('input', () => {
  clearTimeout(debounceT);
  debounceT = setTimeout(() => setQuery(qEl.value), 60);
});
qEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(debounceT); setQuery(qEl.value); qEl.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); clearSearch(); }
});

// ---------- clear button (SPEC 10.1) ----------
function clearSearch() {
  clearTimeout(debounceT);
  clearTimeout(pushT);
  clearTimeout(recentT);
  const fromEntry = S.view === 'entry';
  if (fromEntry) showSearchView();
  S.query = '';
  qEl.value = '';
  if (fromEntry) history.pushState(null, '', emptyAddress()); else history.replaceState(null, '', emptyAddress());
  lastPushed = '';
  renderEmpty();
  qEl.focus();
}
clearEl.addEventListener('click', clearSearch);

// ---------- routing: #q=..., #w=..&r=..&p=.. ----------
function readHash() {
  const m = /^#q=(.*)$/.exec(location.hash);
  let q = '';
  if (m) { try { q = decodeURIComponent(m[1]); } catch { q = m[1]; } }
  return q;
}

function route(ev) {
  const e = parseEntryHash(location.hash);
  if (e) {
    if (S.view !== 'entry' || !S.entry || entryHash(S.entry) !== entryHash(e)) showEntry(e);
    return;
  }
  const wasEntry = S.view === 'entry';
  const q = readHash();
  if (wasEntry) showSearchView();
  if (q !== S.query) { lastPushed = q; setQuery(q); return; }
  if (wasEntry) {
    if (!q.trim()) renderEmpty();
    const y = ev && ev.state && typeof ev.state.scroll === 'number' ? ev.state.scroll : 0;
    window.scrollTo(0, y); // same query, same list, same scroll position
  }
}
window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);

// ---------- entry page (SPEC 10.2) ----------
function openEntry(addr) {
  if (!addr) return;
  if (S.view === 'search') {
    // remember where the list was, so Back returns to the same scroll position
    history.replaceState({ scroll: window.scrollY }, '', location.href);
  }
  history.pushState({ view: 'entry' }, '', entryHash(addr));
  showEntry(addr);
}

function showEntry(addr) {
  S.view = 'entry';
  S.entry = addr;
  searchViewEl.hidden = true;
  wikiEl.hidden = true;
  entryEl.hidden = false;
  entryEl.innerHTML = '<p class="empty">Loading the entry.</p>';
  window.scrollTo(0, 0);
  S.entryReq++;
  worker.postMessage({ type: 'entry', id: S.entryReq, pack: addr.p, w: addr.w, r: addr.r, ranking: S.ranking });
}

function onEntry(m) {
  if (m.id !== S.entryReq || S.view !== 'entry') return;
  entryEl.innerHTML = m.data
    ? entryHtml(m.data)
    : `<p class="empty">This entry was not found in the current dictionary data.</p>`;
}

function showSearchView() {
  S.view = 'search';
  S.entry = null;
  entryEl.hidden = true;
  entryEl.innerHTML = '';
  searchViewEl.hidden = false;
  renderWiki();
}

entryEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#w="]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  openEntry(parseEntryHash(a.getAttribute('href')));
});

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

// ---------- results ----------
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
  if (!q || S.view !== 'search') { wikiEl.hidden = true; return; } // the entry page has its own Wikipedia link
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

resultsEl.addEventListener('click', (e) => {
  const more = e.target.closest('button[data-more]');
  if (more) {
    const id = more.dataset.more;
    const cur = S.groupLimits[id] || (id === 'names' ? NAMES_FIRST : DEFAULT_LIMIT);
    S.groupLimits[id] = cur + 50;
    runSearch('full');
    return;
  }
  const card = e.target.closest('.card');
  if (!card) return;
  if (S.query.trim()) addRecent(S.query); // a tap counts as a finished search
  const tog = e.target.closest('button[data-act="examples"]');
  if (tog) {
    const box = tog.nextElementSibling;
    box.hidden = !box.hidden;
    tog.setAttribute('aria-expanded', String(!box.hidden));
    return;
  }
  if (e.target.closest('button')) return;
  const a = e.target.closest('a');
  if (a && !a.classList.contains('hw')) return; // other links keep their own target
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return; // new tab / window: browser default
  if (!a && window.getSelection && String(window.getSelection()).length) return; // selecting text is not a tap
  e.preventDefault();
  openEntry(parseEntryHash(card.dataset.entry));
});

// ---------- start ----------
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline cache unavailable */ });
}
const initialEntry = parseEntryHash(location.hash);
if (initialEntry) { renderEmpty(); showEntry(initialEntry); } // shows the loading line until the pack is in
else {
  const initial = readHash();
  if (initial) { lastPushed = initial; setQuery(initial); } else renderEmpty();
}
qEl.focus();
