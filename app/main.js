// UI (SPEC 5, 10, 11, 12). Talks to worker.js; renders Look A cards, the entry page and the Favorites view.
import { esc, groupsHtml, entryHtml, favoritesHtml } from './render.js';
import { createFavorites, favoritesText } from './favorites.js';
import { didYouMeanText } from './search/engine.js';
import { parseEntryHash, entryHash } from './search/entry.js';

const $ = (id) => document.getElementById(id);
const qEl = $('q'), resultsEl = $('results'), dymEl = $('dym'), progressEl = $('progress');
const recentEl = $('recent'), wikiEl = $('wiki'), settingsEl = $('settings'), gearEl = $('gear');
const searchViewEl = $('searchview'), entryEl = $('entry'), clearEl = $('clear');
const favViewEl = $('favview'), favBtnEl = $('favbtn');

// ---------- favorites (SPEC 11) ----------
const fav = createFavorites(() => localStorage);
if (!fav.available) document.documentElement.classList.add('no-fav'); // storage unavailable: no stars
const favKey = (f) => `${f.w}\t${f.r}\t${f.p}`;
function renderOpts() {
  const set = new Set(fav.list().map(favKey));
  return { fav: (w, r, p) => set.has(favKey({ w, r, p })) };
}

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
  view: 'search',  // 'search' | 'entry' | 'fav'
  favPushed: false, // Favorites was opened with the button in this session (so history.back() closes it)
  favRemoved: new Map(), // rows clicked off during this visit of the Favorites view (shown greyed): key -> item
  entry: null,     // { w, r, p } of the open entry page
  entryReq: 0,
};
try { const t = localStorage.getItem('nj-theme'); if (t === 'light' || t === 'dark') S.theme = t; } catch { /* default */ }
if (!Array.isArray(S.recent)) S.recent = [];

const DEFAULT_LIMIT = 50;
const NAMES_FIRST = 10;

// ---------- worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const PACK_LABEL = { words: 'words', names: 'names', wikt: 'Wiktionary', sent: 'sentences' };

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
      if (m.pack === 'sent') { if (S.view === 'entry' && S.entry) refreshEntry(); break; } // fills "Loading sentences…"
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
  if (S.view !== 'search') { push = true; showSearchView(); } // typing leaves the entry page / Favorites; Back returns
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
  const fromEntry = S.view !== 'search';
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
  if (location.hash === '#fav') { if (S.view !== 'fav') showFavorites(); return; }
  const wasEntry = S.view !== 'search';
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

function setView(v) {
  if (S.view === 'fav' && v !== 'fav') { S.favRemoved.clear(); S.favPushed = false; } // greyed rows go away when the view is left
  S.view = v;
  searchViewEl.hidden = v !== 'search';
  entryEl.hidden = v !== 'entry';
  favViewEl.hidden = v !== 'fav';
  if (v !== 'entry') { entryEl.innerHTML = ''; S.entry = null; }
  if (v !== 'fav') favViewEl.innerHTML = '';
  if (v === 'fav') favBtnEl.setAttribute('aria-current', 'page'); else favBtnEl.removeAttribute('aria-current');
  favBtnEl.setAttribute('aria-pressed', String(v === 'fav'));
  favBtnEl.title = v === 'fav' ? 'Close Favorites' : 'Favorites';
}

function showEntry(addr) {
  setView('entry');
  S.entry = addr;
  wikiEl.hidden = true;
  entryEl.innerHTML = '<p class="empty">Loading the entry.</p>';
  window.scrollTo(0, 0);
  S.entryReq++;
  worker.postMessage({ type: 'entry', id: S.entryReq, pack: addr.p, w: addr.w, r: addr.r, ranking: S.ranking });
}

/** Ask again for the open entry (same page, same scroll position), e.g. when the sentence pack arrives. */
function refreshEntry() {
  S.entryReq++;
  const a = S.entry;
  worker.postMessage({ type: 'entry', id: S.entryReq, pack: a.p, w: a.w, r: a.r, ranking: S.ranking });
}

function onEntry(m) {
  if (m.id !== S.entryReq || S.view !== 'entry') return;
  entryEl.innerHTML = m.data
    ? entryHtml(m.data, renderOpts())
    : `<p class="empty">This entry was not found in the current dictionary data.</p>`;
}

function showSearchView() {
  setView('search');
  renderWiki();
  // stars may have changed on the entry page or in Favorites: refresh the list's star states in place
  const o = renderOpts();
  for (const b of resultsEl.querySelectorAll('.star')) b.setAttribute('aria-pressed', String(o.fav(b.dataset.w, b.dataset.r, b.dataset.p)));
}

// ---------- Favorites view (SPEC 11) ----------
function openFavorites() {
  // The Favorites button is a toggle: a second click returns to where the user was.
  if (S.view === 'fav') { closeFavorites(); return; }
  if (S.view === 'search') history.replaceState({ scroll: window.scrollY }, '', location.href);
  history.pushState({ view: 'fav' }, '', '#fav');
  S.favPushed = true;
  showFavorites();
}
function closeFavorites() {
  if (S.favPushed) { history.back(); return; } // opened with the button: Back restores the previous view and scroll
  // opened by a direct visit to #fav: there is nothing to go back to, show the search view
  showSearchView();
  history.replaceState(null, '', S.query ? `#q=${encodeURIComponent(S.query)}` : emptyAddress());
  if (!S.query.trim()) renderEmpty();
}
function showFavorites() {
  setView('fav');
  wikiEl.hidden = true;
  renderFavorites();
  window.scrollTo(0, 0);
}
function renderFavorites() {
  // rows clicked off during this visit stay in the list (greyed) at their old place
  const list = fav.list();
  for (const [k, f] of S.favRemoved) if (!list.some((x) => favKey(x) === k)) list.push(f);
  list.sort((a, b) => (b.t || 0) - (a.t || 0));
  favViewEl.innerHTML = favoritesHtml(list, new Set(S.favRemoved.keys()));
}
favBtnEl.addEventListener('click', openFavorites);

function onStar(btn) {
  const item = { w: btn.dataset.w, r: btn.dataset.r, p: btn.dataset.p, g: btn.dataset.g };
  const key = favKey(item);
  if (S.view === 'fav') {
    const li = btn.closest('li');
    const t = li ? Number(li.dataset.t) || undefined : undefined;
    if (S.favRemoved.has(key)) { fav.add({ ...item, t }); S.favRemoved.delete(key); } // undo: back at its old place
    else { fav.remove(item.w, item.r, item.p); S.favRemoved.set(key, { ...item, t }); }
    renderFavorites();
    return;
  }
  const on = fav.toggle(item);
  btn.setAttribute('aria-pressed', String(on));
}

async function copyFavorites(btn) {
  const list = fav.list();
  const text = favoritesText(list);
  let ok = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch { ok = false; }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
  }
  const out = btn.parentElement.querySelector('.copied');
  if (out) out.textContent = ok ? `Copied ${list.length} lines` : 'Could not copy: the clipboard is blocked.';
}

favViewEl.addEventListener('click', (e) => {
  const star = e.target.closest('button.star');
  if (star) { onStar(star); return; }
  const copy = e.target.closest('button[data-act="copy-favorites"]');
  if (copy) { copyFavorites(copy); return; }
  const a = e.target.closest('a[href^="#w="]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  openEntry(parseEntryHash(a.getAttribute('href')));
});

entryEl.addEventListener('click', (e) => {
  const star = e.target.closest('button.star');
  if (star) { onStar(star); return; }
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
    resultsEl.innerHTML = groupsHtml(r.groups, renderOpts());
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
  const star = e.target.closest('button.star');
  if (star) { onStar(star); return; } // the star never opens the entry page
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

// ---------- app version and offline cache lines (SPEC 12) ----------
function showShellInfo() {
  const av = $('appversion'), oc = $('offline');
  const none = () => { oc.textContent = 'not available'; av.textContent = 'not available (no offline cache)'; };
  const sw = navigator.serviceWorker;
  if (!sw) { none(); return; }
  const ask = () => {
    const c = sw.controller;
    if (!c) { none(); return; }
    oc.textContent = 'active';
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => {
      const m = e.data || {};
      av.textContent = `${m.active} (${m.remoteBuilt ? 'updated online' : 'built in'})`;
    };
    c.postMessage({ type: 'shell-info' }, [ch.port2]);
  };
  if (sw.controller) { ask(); return; }
  // first visit: the service worker takes control right after it activates (clients.claim)
  let done = false;
  const finish = () => { if (!done) { done = true; ask(); } };
  sw.addEventListener('controllerchange', finish);
  setTimeout(finish, 3000);
}

// ---------- start ----------
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline cache unavailable */ });
}
if (document.readyState === 'complete') showShellInfo(); else window.addEventListener('load', showShellInfo);
const initialEntry = parseEntryHash(location.hash);
if (initialEntry) { renderEmpty(); showEntry(initialEntry); } // shows the loading line until the pack is in
else if (location.hash === '#fav') { renderEmpty(); showFavorites(); }
else {
  const initial = readHash();
  if (initial) { lastPushed = initial; setQuery(initial); } else renderEmpty();
}
qEl.focus();
