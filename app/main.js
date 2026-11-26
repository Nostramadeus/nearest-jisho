// UI (SPEC 5, 10, 11, 12). Talks to worker.js; renders Look A cards, the entry page and the Favorites view.
import { esc, groupsHtml, groupCardsHtml, textGroupHtml, entryHtml, favoritesHtml, updateBarHtml, suggestionBarHtml, scrollTargetY } from './render.js';
import { createFavorites, favoritesText, addMissedTo, missedText, MISSED_KEY } from './favorites.js';
import {
  WIFI_UNKNOWN_NOTE, wifiNoteShown, loadUpdateChoice, shouldShowOffer, checkResultText, UPDATE_DONE_TEXT, UPDATE_FAILED_TEXT,
} from './datasets.js';
import { parseEntryHash, entryHash } from './search/entry.js';

const $ = (id) => document.getElementById(id);
const qEl = $('q'), resultsEl = $('results'), dymEl = $('dym'), progressEl = $('progress');
const recentEl = $('recent'), wikiEl = $('wiki'), settingsEl = $('settings'), gearEl = $('gear');
const searchViewEl = $('searchview'), entryEl = $('entry'), clearEl = $('clear');
const favViewEl = $('favview'), favBtnEl = $('favbtn');

// ---------- favorites (SPEC 11) ----------
const fav = createFavorites(() => localStorage);
if (!fav.available) document.documentElement.classList.add('no-fav'); // storage unavailable: no stars
const favKey = (f) => `${f.w}\t${f.r}\t${f.p}${f.n > 0 ? `\t${f.n}` : ''}`; // SPEC 34.12: n
function renderOpts() {
  const set = new Set(fav.list().map(favKey));
  return { fav: (w, r, p, n = 0) => set.has(favKey({ w, r, p, n })) };
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
  // SPEC 32.10 scroll rule: shownQuery = the query of the result list on screen (a new one starts at the top);
  // restore = { q, y } a list reached by Back whose scroll position comes back when its results arrive;
  // moreAt = { id, n } "Show more" was pressed: the first new card of that group goes to the top of the view.
  shownQuery: null,
  restore: null,
  moreAt: null,
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
// History model (SPEC 23, ruling 2026-11-14): one history step per screen state worth returning to, so the Android
// Back button always goes one state back and leaves the app only from the first screen.
// settled: the current history entry is such a state (the first screen, a query that stayed 1 second or was confirmed,
//   an entry page, Favorites / Settings). The next query change PUSHES a new entry. While it is false, query changes
//   REPLACE the current entry, so typing does not add one step per letter.
// below: the query of the search entry under the current unsettled one (null = not a search entry / unknown).
// twin: the current entry repeats the query of the entry below it; Back takes one more step (see route).
let debounceT = 0, settleT = 0, recentT = 0, settled = true, below = null, twin = false;

function runSearch(phase) {
  S.seq++;
  worker.postMessage({
    type: 'search', seq: S.seq, query: S.query, ranking: S.ranking, limit: DEFAULT_LIMIT,
    groupLimits: { names: NAMES_FIRST, ...S.groupLimits }, recent: S.recent, phase, keepBrackets: !S.ignoreBrackets,
    textAll: !!S.textAll, // SPEC 34.13
  });
}

/** Show query q (input, results, recent list). Does not touch the history. */
function applyQuery(q, focus) {
  S.query = q;
  if (qEl.value !== q) qEl.value = q;
  S.groupLimits = {};
  S.textAll = false; S.textMore = false; // SPEC 34.13: a new query lists its first 60 words
  clearTimeout(settleT);
  clearTimeout(recentT);
  if (focus) qEl.focus();
  if (!q.trim()) { renderEmpty(); return; }
  runSearch();
  recentT = setTimeout(() => { if (S.query === q) addRecent(q); }, 2000);
}

function emptyAddress() { return location.pathname + location.search; }

/**
 * SPEC 33: the ONE way a new visible state gets its history step. The state being left keeps its scroll position
 * (Back returns to it, SPEC 32.10); then the new state is pushed. Every path that opens a view uses it: a committed
 * query, an entry page, Favorites / Settings, links inside the list, the entry page or Favorites.
 */
function pushStep(url, state = null) {
  const i = stepIndex();
  history.replaceState({ ...(history.state || {}), scroll: window.scrollY, i }, '', location.href);
  history.pushState({ ...(state || {}), i: i + 1 }, '', url); // SPEC 34.19: the page counts its own steps
}
/** SPEC 34.19: index of the current history entry among the page's own steps (0 = the first one). */
function stepIndex() {
  const st = history.state;
  return st && typeof st.i === 'number' ? st.i : 0;
}
/** history.replaceState that keeps the step index of the entry it replaces (SPEC 34.19). */
function replaceStep(state, url) {
  history.replaceState({ ...(state || {}), i: stepIndex() }, '', url);
}
/** Scroll position stored in the current history entry (SPEC 32.10, 33), or null. */
function storedScroll(ev) {
  const st = history.state || (ev && ev.state) || null;
  return st && typeof st.scroll === 'number' ? st.scroll : null;
}

/** Write S.query to the history: a new entry when the current one is settled (or push is forced), else in place. */
function writeQuery(prev, forcePush) {
  const url = S.query ? `#q=${encodeURIComponent(S.query)}` : emptyAddress();
  if (settled || forcePush) {
    pushStep(url); // SPEC 33 (the scroll position of the state it leaves is kept, SPEC 32.10)
    below = S.view === 'search' && forcePush !== 'view' ? prev : null;
    twin = false;
  } else {
    replaceStep(null, url);
    twin = below !== null && S.query === below;
  }
  settled = false;
}

/** push: a confirmed query (suggestion chip, recent search): its own history step, Back returns to the typed text. */
function setQuery(q, { push = false, focus = false } = {}) {
  const leaving = S.view !== 'search'; // typing leaves the entry page / Favorites / Settings; Back returns there
  if (leaving) showSearchView();
  const prev = S.query;
  applyQuery(q, focus);
  if (leaving || q !== prev) writeQuery(prev, leaving ? 'view' : push && !!prev.trim());
  if (!q.trim()) return;
  if (push) settled = true;
  else settleT = setTimeout(() => { if (S.view === 'search' && S.query === q) settled = true; }, 1000);
}

qEl.addEventListener('input', () => {
  clearTimeout(debounceT);
  debounceT = setTimeout(() => setQuery(qEl.value), 60);
});
qEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(debounceT); setQuery(qEl.value); if (S.query.trim()) settled = true; qEl.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); clearSearch(); }
});

// ---------- clear button (SPEC 10.1) ----------
function clearSearch() {
  clearTimeout(debounceT);
  setQuery('', { focus: true });
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
  const wasTwin = twin;
  settled = true; below = null; twin = false; // every entry reached by Back / Forward or a link is a state of its own
  clearTimeout(settleT);
  const e = parseEntryHash(location.hash);
  const y0 = storedScroll(ev); // SPEC 33: every state comes back with its scroll position
  if (e) {
    if (S.view !== 'entry' || !S.entry || entryHash(S.entry) !== entryHash(e)) { showEntry(e); S.entryRestore = y0; }
    return;
  }
  if (location.hash === '#fav') { if (S.view !== 'fav') { showFavorites(); if (y0 !== null) window.scrollTo(0, y0); } return; }
  if (location.hash === '#settings') { if (S.view !== 'settings') { showSettings(); if (y0 !== null) window.scrollTo(0, y0); } return; }
  const wasEntry = S.view !== 'search';
  const q = readHash();
  // Back from an entry that repeated the query of the step below it: nothing would change on screen, go one more step
  if (wasTwin && !wasEntry && q === S.query) { history.back(); return; }
  if (wasEntry) showSearchView();
  if (q !== S.query) {
    // SPEC 32.10: a list reached by Back comes back at its old scroll position once its results are in
    S.restore = y0 !== null && q.trim() ? { q, y: y0 } : null;
    applyQuery(q);
    if (!q.trim()) window.scrollTo(0, y0 === null ? 0 : y0); // the start screen has no results to wait for
    return;
  }
  if (wasEntry) {
    if (!q.trim()) renderEmpty();
    window.scrollTo(0, y0 === null ? 0 : y0); // same query, same list, same scroll position
  }
}
window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);

// ---------- entry page (SPEC 10.2) ----------
function openEntry(addr) {
  if (!addr) return;
  pushStep(entryHash(addr), { view: 'entry' }); // SPEC 33: from the list, another entry, Favorites
  settled = true; below = null; twin = false;
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
  S.entryRestore = null;
  setView('entry');
  S.entry = addr;
  wikiEl.hidden = true;
  entryEl.innerHTML = '<p class="empty">Loading the entry.</p>';
  window.scrollTo(0, 0);
  S.entryReq++;
  worker.postMessage({ type: 'entry', id: S.entryReq, pack: addr.p, w: addr.w, r: addr.r, n: addr.n || 0, ranking: S.ranking });
}

/** Ask again for the open entry (same page, same scroll position), e.g. when the sentence pack arrives. */
function refreshEntry() {
  S.entryReq++;
  const a = S.entry;
  worker.postMessage({ type: 'entry', id: S.entryReq, pack: a.p, w: a.w, r: a.r, n: a.n || 0, ranking: S.ranking });
}

function onEntry(m) {
  if (m.id !== S.entryReq || S.view !== 'entry') return;
  entryEl.innerHTML = m.data
    ? entryHtml(m.data, renderOpts())
    : `<p class="empty">This entry was not found in the current dictionary data.</p>`;
  showSayButtons();
  // SPEC 33: an entry page reached by Back comes back at its old scroll position
  if (S.entryRestore !== null && S.entryRestore !== undefined) { window.scrollTo(0, S.entryRestore); S.entryRestore = null; }
}

function showSearchView() {
  setView('search');
  renderWiki();
  // stars may have changed on the entry page or in Favorites: refresh the list's star states in place
  const o = renderOpts();
  for (const b of resultsEl.querySelectorAll('.star')) b.setAttribute('aria-pressed', String(o.fav(b.dataset.w, b.dataset.r, b.dataset.p, Number(b.dataset.n) || 0)));
}

// ---------- Favorites and Settings views (SPEC 11, 16.1) ----------
const SHOW = { fav: () => showFavorites(), settings: () => showSettings() };
/**
 * Star and gear buttons. In view v: close. In the other button view: switch with replaceState (no new history
 * step, so one Back still returns to where the user was before). In search or entry: pushState, then show v.
 */
function togglePanel(v) {
  if (S.view === v) { closePanel(); return; }
  settled = true; below = null; twin = false;
  if (PANELS.includes(S.view)) {
    replaceStep({ view: v }, `#${v}`);
    SHOW[v]();
    return;
  }
  pushStep(`#${v}`, { view: v }); // SPEC 33
  S.panelPushed = true;
  SHOW[v]();
}
function closePanel() {
  if (S.panelPushed) { history.back(); return; } // reached by a push: Back restores the previous view and scroll
  // reached by a direct visit: there is nothing to go back to, show the search view
  showSearchView();
  replaceStep(null, S.query ? `#q=${encodeURIComponent(S.query)}` : emptyAddress());
  settled = true; below = null; twin = false;
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
  const item = { w: btn.dataset.w, r: btn.dataset.r, p: btn.dataset.p, g: btn.dataset.g, h: btn.dataset.h };
  if (Number(btn.dataset.n) > 0) item.n = Number(btn.dataset.n); // SPEC 34.12
  const key = favKey(item);
  if (S.view === 'fav') {
    const li = btn.closest('li');
    const t = li ? Number(li.dataset.t) || undefined : undefined;
    if (S.favRemoved.has(key)) { fav.add({ ...item, t }); S.favRemoved.delete(key); } // undo: back at its old place
    else { fav.remove(item.w, item.r, item.p, item.n || 0); S.favRemoved.set(key, { ...item, t }); }
    renderFavorites();
    return;
  }
  const on = fav.toggle(item);
  btn.setAttribute('aria-pressed', String(on));
}

async function copyFavorites(btn) {
  const list = fav.list();
  const ok = await copyText(favoritesText(list));
  const out = btn.parentElement.querySelector('.copied');
  if (out) out.textContent = ok ? `Copied ${list.length} lines` : 'Could not copy: the clipboard is blocked.';
}

/** Clipboard write with the textarea fallback; true when it worked. */
async function copyText(text) {
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
  return ok;
}

/**
 * SPEC 33: a link to another state inside a view (#w= entry, #q= search) takes the same history step as every other
 * way of opening a view. Returns true when it handled the click.
 */
function followLink(e) {
  const a = e.target.closest('a[href^="#w="], a[href^="#q="]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return false;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (href.startsWith('#w=')) { if (S.query.trim() && S.view === 'search') addRecent(S.query); openEntry(parseEntryHash(href)); return true; }
  let q = href.slice(3);
  try { q = decodeURIComponent(q); } catch { /* keep raw */ }
  setQuery(q, { push: true });
  return true;
}

favViewEl.addEventListener('click', (e) => {
  const star = e.target.closest('button.star');
  if (star) { onStar(star); return; }
  const copy = e.target.closest('button[data-act="copy-favorites"]');
  if (copy) { copyFavorites(copy); return; }
  followLink(e);
});

/** SPEC 28.1: copy button; the icon turns into a check mark (or a cross when the clipboard is blocked) for 1.5 s. */
async function onCopy(btn) {
  const ok = await copyText(btn.dataset.copy || '');
  btn.classList.remove('ok', 'no');
  btn.classList.add(ok ? 'ok' : 'no');
  setTimeout(() => btn.classList.remove('ok', 'no'), 1500);
}

entryEl.addEventListener('click', (e) => {
  const star = e.target.closest('button.star');
  if (star) { onStar(star); return; }
  const cp = e.target.closest('button.cp');
  if (cp) { onCopy(cp); return; }
  const say = e.target.closest('button.say');
  if (say) { if (tts.speak) tts.speak(say.dataset.say); return; }
  followLink(e);
});

// ---------- recent ----------
function addRecent(q) {
  q = q.trim();
  if (!q) return;
  if (S.lastEmpty === q) addMissed(q); // SPEC 27.3: a finished search that found nothing
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
  if (b.dataset.recent !== undefined) setQuery(b.dataset.recent, { push: true }); // SPEC 34.18: no focus, no keyboard
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

// "Ignore brackets and the text inside them" (SPEC 31), default on; the worker leaves them out of the query
S.ignoreBrackets = store.get('nj-ignore-brackets', true) !== false;
{
  const box = $('ignorebrackets');
  if (box) {
    box.checked = S.ignoreBrackets;
    box.addEventListener('change', () => {
      S.ignoreBrackets = box.checked;
      store.set('nj-ignore-brackets', S.ignoreBrackets);
      if (S.query) runSearch();
    });
  }
}

// "Romaji on result cards" (SPEC 26.1), default on; a class on <html> hides the line, no re-render needed
S.cardRomaji = store.get('nj-card-romaji', true) !== false;
function applyCardRomaji() { document.documentElement.classList.toggle('no-card-romaji', !S.cardRomaji); }
{
  const box = $('cardromaji');
  if (box) {
    box.checked = S.cardRomaji;
    box.addEventListener('change', () => { S.cardRomaji = box.checked; store.set('nj-card-romaji', S.cardRomaji); applyCardRomaji(); });
  }
}
applyCardRomaji();

// ---------- searches with no results (SPEC 27.3): device only, never sent ----------
function missedList() { const v = store.get(MISSED_KEY, []); return Array.isArray(v) ? v : []; }
function addMissed(q) {
  const list = missedList();
  if (list[0] && list[0].q === q) return;
  store.set(MISSED_KEY, addMissedTo(list, q, new Date().toISOString().slice(0, 10)));
  renderMissed();
}
function renderMissed() {
  const ul = $('missedlist');
  if (!ul) return;
  const list = missedList();
  ul.innerHTML = list.length ? list.map((x) => `<li><span class="dim">${esc(x.d)}</span> <span lang="ja">${esc(x.q)}</span></li>`).join('')
    : '<li class="dim">None yet.</li>';
}
{
  const copyBtn = $('missedcopy'), clearBtn = $('missedclear'), msg = $('missedmsg');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const list = missedList();
    const ok = await copyText(missedText(list));
    if (msg) msg.textContent = ok ? `Copied ${list.length} lines` : 'Could not copy: the clipboard is blocked.';
  });
  if (clearBtn) clearBtn.addEventListener('click', () => { store.set(MISSED_KEY, []); renderMissed(); if (msg) msg.textContent = 'Cleared.'; });
}
renderMissed();

// ---------- read the reading aloud (SPEC 26.2) ----------
// Android app: native TTS plugin (@capacitor-community/text-to-speech); web and desktop: speechSynthesis with the
// first voice whose lang starts with "ja". No Japanese voice -> the button stays hidden. Kana only, never kanji.
const tts = { speak: null };
function capTts() {
  const C = window.Capacitor;
  if (!C) return null;
  const native = (typeof C.isNativePlatform === 'function' && C.isNativePlatform()) ||
    (typeof C.getPlatform === 'function' && C.getPlatform() !== 'web');
  if (!native) return null;
  if (typeof C.isPluginAvailable === 'function' && !C.isPluginAvailable('TextToSpeech')) return null;
  const P = C.Plugins && C.Plugins.TextToSpeech;
  if (!(P && typeof P.speak === 'function') && typeof C.nativePromise !== 'function') return null;
  return (method, opts) => (P && typeof P[method] === 'function' ? P[method](opts) : C.nativePromise('TextToSpeech', method, opts));
}
async function findVoice() {
  const cap = capTts();
  if (cap) {
    try {
      const r = await cap('isLanguageSupported', { lang: 'ja-JP' });
      if (r && r.supported) return (text) => { Promise.resolve(cap('speak', { text, lang: 'ja-JP', rate: 0.9 })).catch(() => {}); };
    } catch { /* no Japanese voice */ }
    return null;
  }
  const ss = window.speechSynthesis;
  if (!ss || typeof SpeechSynthesisUtterance === 'undefined') return null;
  const pick = () => ss.getVoices().find((v) => /^ja/i.test(v.lang || ''));
  let voice = pick();
  if (!voice) {
    await new Promise((res) => {
      if (typeof ss.addEventListener === 'function') ss.addEventListener('voiceschanged', res, { once: true });
      setTimeout(res, 3000);
    });
    voice = pick();
  }
  if (!voice) return null;
  return (text) => {
    ss.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice; u.lang = voice.lang; u.rate = 0.9;
    ss.speak(u);
  };
}
function showSayButtons() {
  if (!tts.speak) return;
  for (const b of entryEl.querySelectorAll('button.say')) b.hidden = false;
}
findVoice().then((f) => { tts.speak = f; showSayButtons(); }).catch(() => {});

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
// ---------- app-code update check on demand (installed apps only; works with every service worker version) ----------
// The service worker checks for newer app files on a page navigation, at most once per its own time limit.
// This button removes that time stamp and makes one small navigation in a hidden frame, then reports what arrived.
const IS_APP = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
async function newestDownloadedShell() {
  let best = null;
  for (const name of await caches.keys()) {
    if (!name.startsWith('nj-remote-shell-')) continue;
    const hit = await (await caches.open(name)).match(new URL('__complete__', document.baseURI).href);
    if (!hit) continue;
    const info = await hit.json().catch(() => null);
    if (info && (!best || info.built > best.built)) best = info;
  }
  return best;
}
if (IS_APP && 'caches' in window && 'serviceWorker' in navigator) {
  $('appcheckrow').hidden = false;
  const shellInfo = () => new Promise((resolve) => {
    const c = navigator.serviceWorker.controller;
    if (!c) { resolve(null); return; }
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 3000);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data || null); };
    c.postMessage({ type: 'shell-info' }, [ch.port2]);
  });
  let appCheckBusy = false;
  $('appchecknow').addEventListener('click', async () => {
    // Every path ends in a final sentence within about 75 seconds; the line never stays on "Checking".
    if (appCheckBusy) return;
    appCheckBusy = true;
    const out = $('appcheckresult');
    out.hidden = false;
    const started = Date.now();
    const secs = () => Math.round((Date.now() - started) / 1000);
    try {
      if (!navigator.serviceWorker.controller) { out.textContent = 'Offline cache is not available, so the app cannot update itself.'; return; }
      out.textContent = 'Checking for a newer app version.';
      // 1. ask the website which version is current (fails fast when offline)
      let remote = null;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        const r = await fetch('https://nostramadeus.github.io/nearest-jisho/shell.json', { cache: 'no-store', signal: ctl.signal });
        clearTimeout(timer);
        if (r.ok) remote = await r.json();
      } catch { /* handled below */ }
      if (!remote || !remote.built) { out.textContent = 'Could not reach the update server. Check the internet connection and try again.'; return; }
      // 2. compare with what this app has
      const info = await shellInfo();
      const before = await newestDownloadedShell();
      const have = Math.max(info ? Number(info.bundledBuilt) || 0 : 0, before ? Number(before.built) || 0 : 0);
      if (Number(remote.built) <= have) {
        out.textContent = before && info && Number(before.built) > (Number(info.remoteBuilt) || 0) && Number(before.built) > (Number(info.bundledBuilt) || 0)
          ? `The newest app version (${before.version}) is already downloaded. Close the app fully and open it again to use it.`
          : 'The app is up to date.';
        return;
      }
      // 3. let the service worker download it, and show the seconds while waiting
      await (await caches.open('nj-shell-meta')).delete(new URL('__last_check__', document.baseURI).href);
      const fr = document.createElement('iframe');
      fr.hidden = true;
      fr.src = './about.html?check=' + Date.now();
      document.body.appendChild(fr);
      let got = null;
      while (secs() < 60) {
        out.textContent = `Downloading app version ${remote.version} (${secs()} seconds).`;
        await new Promise((r) => setTimeout(r, 2000));
        const now = await newestDownloadedShell();
        if (now && Number(now.built) >= Number(remote.built)) { got = now; break; }
      }
      fr.remove();
      out.textContent = got
        ? `A newer app version was downloaded (${got.version}). Close the app fully and open it again to use it.`
        : 'The download did not finish within 60 seconds. The connection may be slow. It may still finish in the background; press the button again in a minute.';
    } catch {
      out.textContent = 'The check could not run. Nothing was changed.';
    } finally {
      appCheckBusy = false;
    }
  });
}

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
  // SPEC 21.2: the yellow bar with suggestion chips
  const bar = suggestionBarHtml(r);
  dymEl.innerHTML = bar;
  dymEl.hidden = !bar;
  if (m.phase === 'full') S.lastEmpty = !r.groups.length && m.loaded.names && m.loaded.wikt ? S.query.trim() : null;
  if (S.lastEmpty && S.recent[0] === S.lastEmpty) addMissed(S.lastEmpty); // settled before its result came
  if (!r.groups.length) {
    const still = !m.loaded.names || !m.loaded.wikt;
    resultsEl.innerHTML = m.phase === 'fast' ? resultsEl.innerHTML
      : `<p class="empty">No results for "${esc(S.query)}".${still ? ' Some dictionaries are still loading.' : ''}</p>`;
  } else if (!appendMore(r, m.phase)) {
    resultsEl.innerHTML = groupsHtml(r.groups, renderOpts());
  }
  renderWiki();
  placeList(m.phase);
}

/**
 * SPEC 34.18: the answer to "Show more" adds the new cards of that group below the ones on the page (no re-render, so
 * an opened "More examples" stays open). SPEC 34.13: the answer to "Show more words" replaces only the text group.
 * Returns false when the page has no such group (then the caller renders the whole list).
 */
function appendMore(r, phase) {
  if (phase !== 'full' || S.query !== S.shownQuery) return false;
  if (S.textMore) {
    S.textMore = false;
    const gi = r.groups.findIndex((g) => g.id === 'text');
    const sec = gi >= 0 && resultsEl.querySelector('section[data-group="text"]');
    if (!sec) return false;
    sec.outerHTML = textGroupHtml(r.groups[gi], gi, renderOpts());
    return true;
  }
  if (!S.moreAt) return false;
  const gi = r.groups.findIndex((g) => g.id === S.moreAt.id);
  const sec = gi >= 0 && resultsEl.querySelector(`section[data-group="${S.moreAt.id}"]`);
  if (!sec) return false;
  const btn = sec.querySelector('button[data-more]');
  if (btn) btn.remove();
  sec.insertAdjacentHTML('beforeend', groupCardsHtml(r.groups[gi], gi, S.moreAt.n, renderOpts()));
  return true;
}

/**
 * SPEC 32.10, where the list stands after a result arrives: a list reached by Back at its old position; a new query
 * at the top; the same query (a pack arrived, the fast result followed by the full one) where it was; after
 * "Show more" the first new card of that group at the top of the view.
 */
function placeList(phase) {
  if (S.restore && S.restore.q === S.query) {
    window.scrollTo(0, S.restore.y);
    if (phase === 'full') S.restore = null;
  } else if (S.query !== S.shownQuery) {
    S.restore = null;
    window.scrollTo(0, 0);
  } else if (S.moreAt && phase === 'full') {
    const sec = resultsEl.querySelector(`section[data-group="${S.moreAt.id}"]`);
    const card = sec && sec.querySelector(`.card[data-r="${S.moreAt.n}"]`);
    if (card) scrollToTop(card);
  }
  if (phase === 'full') S.moreAt = null;
  S.shownQuery = S.query;
}

/** SPEC 32.10: scroll so that the top (header) of `el` stands right below the sticky search row. */
function scrollToTop(el) {
  if (!el || !el.getBoundingClientRect) return;
  const y = Math.max(0, Math.round(window.scrollY + el.getBoundingClientRect().top - stickyBottom() - 8));
  window.scrollTo(0, y);
}

/** Bottom edge (viewport px) of everything stuck to the top right now: the search row and any sticky / fixed bar. */
function stickyBottom() {
  let bottom = 0;
  const gcs = window.getComputedStyle ? (el) => window.getComputedStyle(el) : () => null;
  for (const el of [document.querySelector('.search'), $('updatebar'), dymEl, progressEl]) {
    if (!el || el.hidden || !el.getBoundingClientRect) continue;
    const cs = gcs(el);
    if (!cs || (cs.position !== 'sticky' && cs.position !== 'fixed')) continue;
    const r = el.getBoundingClientRect();
    if (r.top <= 1) bottom = Math.max(bottom, r.bottom); // stuck at the top of the viewport
  }
  return bottom;
}

/** Scroll so that `el` is fully visible below the sticky area; no scroll when it already is. Returns the new y or null. */
function revealBelowSticky(el) {
  const r = el.getBoundingClientRect();
  const y = scrollTargetY({ scrollY: window.scrollY, top: r.top, bottom: r.bottom, sticky: stickyBottom(), viewport: window.innerHeight });
  if (y !== null) window.scrollTo(0, y);
  return y;
}

function renderWiki() {
  const q = S.query.trim();
  if (!q || S.view !== 'search') { wikiEl.hidden = true; return; } // the entry page has its own Wikipedia link
  wikiEl.innerHTML = `<a href="https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}" target="_blank" rel="noopener">Search Wikipedia for "${esc(q)}"</a>`;
  wikiEl.hidden = false;
}

function renderEmpty() {
  S.seq++; // drop answers still in flight
  S.shownQuery = ''; S.restore = null; S.moreAt = null;
  resultsEl.innerHTML = '';
  dymEl.hidden = true;
  wikiEl.hidden = true;
  renderRecent();
}

dymEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-q]');
  if (b) setQuery(b.dataset.q, { push: true }); // one history step: Back returns to the typed query; SPEC 34.18: no focus
});

resultsEl.addEventListener('click', (e) => {
  const textMore = e.target.closest('button[data-textmore]');
  if (textMore) { // SPEC 34.13: every word of the pasted text
    S.textAll = true; S.textMore = true;
    runSearch('full');
    return;
  }
  const more = e.target.closest('button[data-more]');
  if (more) {
    const id = more.dataset.more;
    const cur = S.groupLimits[id] || (id === 'names' ? NAMES_FIRST : DEFAULT_LIMIT);
    S.groupLimits[id] = cur + 50;
    S.moreAt = { id, n: cur }; // SPEC 32.10: the first new card goes to the top of the view
    runSearch('full');
    return;
  }
  const star = e.target.closest('button.star');
  if (star) { onStar(star); return; } // the star never opens the entry page
  const cp = e.target.closest('button.cp');
  if (cp) { onCopy(cp); return; } // SPEC 28.1
  // SPEC 17.4: a chip scrolls to its segment's item and flashes its border once
  const chip = e.target.closest('button.chip');
  if (chip) {
    const item = resultsEl.querySelector(`#t-${chip.dataset.item}`);
    if (item) {
      revealBelowSticky(item); // the whole item, headword included, ends below the sticky search row
      item.classList.add('flash');
      setTimeout(() => item.classList.remove('flash'), 600);
    }
    return;
  }
  // SPEC 33: "N other entries for X", a kanji row (#q=) and a function-word row (#w=): one history step each
  if (e.target.closest('a[href^="#q="], a.fnrow')) { followLink(e); return; }
  const card = e.target.closest('.card');
  if (!card) return;
  if (S.query.trim()) addRecent(S.query); // a tap counts as a finished search
  const tog = e.target.closest('button[data-act="examples"]');
  if (tog) {
    const box = tog.nextElementSibling;
    box.hidden = !box.hidden;
    tog.setAttribute('aria-expanded', String(!box.hidden));
    if (!box.hidden) scrollToTop(card); // SPEC 32.10: the opened card's header at the top of the view
    return;
  }
  if (e.target.closest('button')) return;
  if (e.target.closest('a')) return; // links keep their own target
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
  if (window.getSelection && String(window.getSelection()).length) return; // selecting text is not a tap
  e.preventDefault();
  openEntry(parseEntryHash(card.dataset.entry));
});
// SPEC 28.1: the headword is plain text (selectable), no longer a link; Enter on it still opens the entry
resultsEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.classList || !e.target.classList.contains('hw')) return;
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  if (S.query.trim()) addRecent(S.query);
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
// SPEC 33: a first visit straight to a word, a search or a panel gets the start screen below it, so Back never leaves
// the app before the start screen.
if (location.hash && history.length === 1) {
  const h = location.hash;
  history.replaceState({ i: 0 }, '', emptyAddress());
  history.pushState({ i: 1 }, '', h);
}
// SPEC 33: Android app (Capacitor): the back gesture goes one history step back; it leaves the app only from the empty
// start screen. Needs the @capacitor/app plugin (packaging/android/package.json); without it the gesture closes the app.
// SPEC 34.19: whether there is a step to go back to comes from the page's own step index (history.state.i), never
// from the WebView's canGoBack(): Chromium skips entries pushed without a user gesture there, so canGoBack() can be
// false (and the app would close) while the page still has steps.
function nativeBack(exitApp) {
  if (stepIndex() > 0) { history.back(); return; }
  if (S.view !== 'search' || S.query.trim()) { // the first step is not the start screen: show it
    replaceStep(null, emptyAddress());
    route();
    return;
  }
  exitApp();
}
{
  const C = window.Capacitor;
  const App = C && C.Plugins && C.Plugins.App;
  if (App && typeof App.addListener === 'function') {
    App.addListener('backButton', () => nativeBack(() => { Promise.resolve(App.exitApp()).catch(() => {}); }));
  }
}
const initialEntry = parseEntryHash(location.hash);
if (initialEntry) { renderEmpty(); showEntry(initialEntry); } // shows the loading line until the pack is in
else if (location.hash === '#fav') { renderEmpty(); showFavorites(); }
else if (location.hash === '#settings') { renderEmpty(); showSettings(); }
else {
  const initial = readHash();
  if (initial) applyQuery(initial); else renderEmpty();
}
qEl.focus();
