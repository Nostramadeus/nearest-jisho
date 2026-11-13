// UI (SPEC 5, 10, 11, 12). Talks to worker.js; renders Look A cards, the entry page and the Favorites view.
import { esc, groupsHtml, entryHtml, favoritesHtml, updateBarHtml } from './render.js';
import { createFavorites, favoritesText } from './favorites.js';
import {
  WIFI_UNKNOWN_NOTE, wifiNoteShown, loadUpdateChoice, shouldShowOffer, checkResultText, UPDATE_DONE_TEXT, UPDATE_FAILED_TEXT,
} from './datasets.js';
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
  view: 'search',  // 'search' | 'entry' | 'fav' | 'settings'
  // Favorites or Settings was reached by a push from this session (so history.back() closes it). SPEC 11, 16.1
  panelPushed: false,
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
      if (!/downloaded/.test($('built').textContent)) $('built').textContent += ` (updates downloaded: ${(m.packs || []).map((p) => PACK_LABEL[p] || p).join(', ')}; used from the next start)`;
      break;
    case 'result': onResult(m); break;
    case 'updateOffer': onUpdateOffer(m); break;
    case 'downloadProgress': showBar({ kind: 'progress', pack: m.pack, pct: m.pct }); break;
    case 'downloadDone': showBar(m.ok ? { kind: 'done', text: UPDATE_DONE_TEXT } : { kind: 'failed', text: UPDATE_FAILED_TEXT }); break;
    case 'checkResult': onCheckResult(m); break;
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
  if (location.hash === '#settings') { if (S.view !== 'settings') showSettings(); return; }
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

const PANELS = ['fav', 'settings']; // the two button views; at most one is active (SPEC 16.1)
function setView(v) {
  if (S.view === 'fav' && v !== 'fav') S.favRemoved.clear(); // greyed rows go away when the view is left
  if (PANELS.includes(S.view) && !PANELS.includes(v)) S.panelPushed = false;
  S.view = v;
  searchViewEl.hidden = v !== 'search';
  entryEl.hidden = v !== 'entry';
  favViewEl.hidden = v !== 'fav';
  settingsEl.hidden = v !== 'settings';
  gearEl.setAttribute('aria-pressed', String(v === 'settings'));
  gearEl.title = v === 'settings' ? 'Close Settings' : 'Settings';
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

// ---------- Favorites and Settings views (SPEC 11, 16.1) ----------
const SHOW = { fav: () => showFavorites(), settings: () => showSettings() };
/**
 * Star and gear buttons. In view v: close. In the other button view: switch with replaceState (no new history
 * step, so one Back still returns to where the user was before). In search or entry: pushState, then show v.
 */
function togglePanel(v) {
  if (S.view === v) { closePanel(); return; }
  if (PANELS.includes(S.view)) {
    history.replaceState({ view: v }, '', `#${v}`);
    SHOW[v]();
    return;
  }
  if (S.view === 'search') history.replaceState({ scroll: window.scrollY }, '', location.href);
  history.pushState({ view: v }, '', `#${v}`);
  S.panelPushed = true;
  SHOW[v]();
}
function closePanel() {
  if (S.panelPushed) { history.back(); return; } // reached by a push: Back restores the previous view and scroll
  // reached by a direct visit: there is nothing to go back to, show the search view
  showSearchView();
  history.replaceState(null, '', S.query ? `#q=${encodeURIComponent(S.query)}` : emptyAddress());
  if (!S.query.trim()) renderEmpty();
}
function openFavorites() { togglePanel('fav'); }
function showSettings() {
  setView('settings');
  wikiEl.hidden = true;
  window.scrollTo(0, 0);
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
gearEl.addEventListener('click', () => togglePanel('settings'));
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

// "Download dictionary updates" (SPEC 14.3, 15); does not limit app-code updates (sw.js)
// Default "Ask each time"; a stored always / wifi / never from before is kept.
S.updates = loadUpdateChoice(store.get('nj-updates', null));
function connectionType() {
  try { return (navigator.connection && navigator.connection.type) || undefined; } catch { return undefined; }
}
function applyUpdateChoice() {
  const note = $('wifinote');
  note.textContent = WIFI_UNKNOWN_NOTE;
  note.hidden = !wifiNoteShown(S.updates, connectionType());
  worker.postMessage({ type: 'settings', updates: S.updates, connectionType: connectionType() });
}
function setUpdateChoice(v) {
  S.updates = v;
  store.set('nj-updates', v);
  for (const r of document.querySelectorAll('input[name="updates"]')) r.checked = r.value === v;
  applyUpdateChoice();
}
for (const r of document.querySelectorAll('input[name="updates"]')) {
  r.checked = r.value === S.updates;
  r.addEventListener('change', () => setUpdateChoice(r.value));
}
applyUpdateChoice();

// ---------- update bar (SPEC 15) ----------
const barEl = $('updatebar'), checkResultEl = $('checkresult');
const DISMISSED_KEY = 'nj-updates-not-now';
let offerSignature = '';
let offerPacks = [];
function showBar(state) {
  barEl.innerHTML = updateBarHtml(state);
  barEl.hidden = false; // shown without moving focus
}
function hideBar() { barEl.hidden = true; barEl.innerHTML = ''; }
function onUpdateOffer(m) {
  if (!shouldShowOffer(m.signature, store.get(DISMISSED_KEY, ''), m.manual)) return;
  offerSignature = m.signature;
  offerPacks = m.packs || [];
  showBar({ kind: 'offer', text: m.text });
}
barEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-update]');
  if (!b) return;
  switch (b.dataset.update) {
    case 'download': case 'retry':
      showBar({ kind: 'progress', pack: offerPacks[0] || 'words', pct: 0 });
      worker.postMessage({ type: 'download' });
      break;
    case 'cancel': worker.postMessage({ type: 'cancelDownload' }); break;
    case 'notnow': store.set(DISMISSED_KEY, offerSignature); hideBar(); break; // this exact update is not offered again
    case 'never': setUpdateChoice('never'); hideBar(); break;
    case 'close': hideBar(); break;
  }
});
$('checknow').addEventListener('click', () => {
  checkResultEl.hidden = false;
  checkResultEl.textContent = 'Checking.';
  worker.postMessage({ type: 'checkNow' });
});
function onCheckResult(m) {
  const t = checkResultText(m.status);
  checkResultEl.textContent = t;
  checkResultEl.hidden = !t;
}

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
else if (location.hash === '#settings') { renderEmpty(); showSettings(); }
else {
  const initial = readHash();
  if (initial) { lastPushed = initial; setQuery(initial); } else renderEmpty();
}
qEl.focus();
