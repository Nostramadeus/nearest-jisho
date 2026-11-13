// Fake page for app/main.js in node: elements by id, history with Back, a fake worker over the fixture packs.
// Each makePage() loads a fresh instance of main.js.
import { search } from '../../app/search/engine.js';
import { findEntry, entryData } from '../../app/search/entry.js';

// elements that index.html starts with the hidden attribute
const HIDDEN_AT_START = new Set(['updatebar', 'progress', 'settings', 'dym', 'recent', 'entry', 'favview', 'wiki', 'wifinote', 'checkresult']);

// Timers of a page are cancelled when the next page is made, so a 1 s / 2 s timer of an earlier main.js instance
// never acts on a later page (every instance uses the same global history object name).
const realSetTimeout = globalThis.setTimeout;
let current = null;

class El {
  constructor(id) {
    Object.assign(this, { id, hidden: HIDDEN_AT_START.has(id), innerHTML: '', textContent: '', value: '', title: '', checked: false });
    this.dataset = {}; this.attrs = {}; this.listeners = {}; this.style = {}; this.focusCount = 0;
  }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  focus() { this.focusCount++; }
  blur() {}
  select() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  appendChild() {}
  removeChild() {}
  fire(type, ev = {}) { for (const f of this.listeners[type] || []) f({ target: this, button: 0, preventDefault() {}, ...ev }); }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Load app/main.js on a fake page at `hash`. store = fixture PackStore (for the fake worker's answers). */
export async function makePage(store, hash = '') {
  if (current) current.dispose();
  const timers = new Set();
  globalThis.setTimeout = (f, ms, ...a) => { const id = realSetTimeout(f, ms, ...a); timers.add(id); return id; };
  const els = {};
  const winListeners = {};
  const entries = [{ url: hash || '/', state: null }];
  let idx = 0;
  let scrollY = 0;
  const posted = [];
  const page = { els, posted, worker: null, dispose() { for (const id of timers) clearTimeout(id); } };
  current = page;
  const fireWin = (type, ev) => { for (const f of winListeners[type] || []) f(ev); };
  const norm = (u) => (String(u).includes('#') ? String(u).slice(String(u).indexOf('#')) : '/');

  globalThis.document = {
    getElementById: (id) => (els[id] ||= new El(id)),
    querySelectorAll: () => [],
    createElement: () => new El(''),
    body: new El('body'),
    documentElement: { dataset: {}, classList: { add() {}, remove() {} } },
    readyState: 'complete',
    execCommand: () => true,
  };
  const ls = new Map();
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  globalThis.location = {
    get hash() { const u = entries[idx].url; return u.startsWith('#') ? u : ''; },
    get href() { return 'https://localhost/' + (entries[idx].url.startsWith('#') ? entries[idx].url : ''); },
    pathname: '/', search: '', protocol: 'https:', hostname: 'localhost',
  };
  globalThis.history = {
    get state() { return entries[idx].state; },
    get length() { return entries.length; },
    pushState(state, t, url) { entries.splice(idx + 1); entries.push({ url: norm(url), state }); idx++; },
    replaceState(state, t, url) { entries[idx] = { url: norm(url), state }; },
    back() { // like a browser: popstate (and hashchange) arrive a moment later
      if (idx === 0) { page.leftApp = true; return; }
      const from = entries[idx].url;
      idx--;
      setTimeout(() => { fireWin('popstate', { state: entries[idx].state }); if (from !== entries[idx].url) fireWin('hashchange', {}); }, 0);
    },
  };
  globalThis.window = {
    addEventListener: (t, f) => { (winListeners[t] ||= []).push(f); },
    get scrollY() { return scrollY; },
    scrollTo: (x, y) => { scrollY = y; },
    getSelection: () => '',
  };
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  globalThis.Worker = class {
    constructor() { page.worker = this; }
    postMessage(m) {
      posted.push(m);
      setTimeout(() => {
        if (m.type === 'search') {
          for (const phase of ['fast', 'full']) {
            const r = search(store, m.query, { ...m, phase });
            for (const g of r.groups) for (const h of g.results) h.rec = store.getRecord(h.pack, h.id);
            this.onmessage({ data: { type: 'result', seq: m.seq, phase, query: m.query, result: r, loaded: { words: true, names: true, wikt: true } } });
          }
        } else if (m.type === 'entry') {
          const id = findEntry(store, m.pack, m.w, m.r);
          this.onmessage({ data: { type: 'entry', id: m.id, data: id < 0 ? null : entryData(store, m.pack, id) } });
        }
      }, 0);
    }
  };
  await import(`../../app/main.js?page=${Math.random()}`);
  await tick(20);
  // accessors must stay live (Object.assign would copy their values once)
  Object.defineProperties(page, {
    url: { get: () => entries[idx].url },
    historyLength: { get: () => entries.length },
    index: { get: () => idx },
    scrollY: { get: () => scrollY, set: (v) => { scrollY = v; } },
  });
  Object.assign(page, {
    click: async (id) => { els[id].fire('click'); await tick(10); },
    back: async () => { globalThis.history.back(); await tick(10); },
    type: async (text) => { els.q.value = text; els.q.fire('input'); await tick(120); },
    fromWorker: async (data) => { page.worker.onmessage({ data }); await tick(5); },
    view() {
      const shown = ['searchview', 'entry', 'favview', 'settings'].filter((id) => els[id] && !els[id].hidden);
      return shown.length === 1 ? shown[0] : shown.join('+');
    },
    pressed() {
      return { fav: els.favbtn.getAttribute('aria-pressed'), gear: els.gear.getAttribute('aria-pressed'), favTitle: els.favbtn.title, gearTitle: els.gear.title };
    },
  });
  return page;
}
