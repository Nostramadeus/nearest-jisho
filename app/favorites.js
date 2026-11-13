// Favorites (SPEC 11). localStorage key "nj.favorites": JSON array of { w, r, p, g, t }.
// Identity = (w, r, p). Every storage access is wrapped in try/catch.

export const FAV_KEY = 'nj.favorites';

const same = (a, b) => a.w === b.w && a.r === b.r && a.p === b.p;

/** First gloss (words, Wiktionary) or first translation (names) of a record. */
export function firstGloss(rec) {
  if (rec && rec.s && rec.s[0] && rec.s[0].g && rec.s[0].g.length) return rec.s[0].g[0];
  if (rec && rec.g && rec.g.length) return rec.g[0];
  return '';
}

/**
 * @param storage a localStorage-like object, or a function returning one (may throw: storage blocked)
 * @param now clock in epoch milliseconds (tests pass their own)
 */
export function createFavorites(storage, now = () => Date.now()) {
  let ls = null;
  try { ls = typeof storage === 'function' ? storage() : storage; } catch { ls = null; }
  let available = false;
  try {
    if (ls) {
      const probe = '__nj_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      available = true;
    }
  } catch { available = false; }

  function read() {
    if (!available) return [];
    try {
      const v = JSON.parse(ls.getItem(FAV_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => x && typeof x.w === 'string' && typeof x.p === 'string') : [];
    } catch { return []; }
  }
  function write(list) {
    if (!available) return false;
    try { ls.setItem(FAV_KEY, JSON.stringify(list)); return true; } catch { return false; }
  }

  return {
    get available() { return available; },
    /** Newest first. */
    list() { return read().sort((a, b) => (b.t || 0) - (a.t || 0)); },
    has(w, r, p) { return read().some((x) => same(x, { w, r, p })); },
    /** Adds (or keeps) a favorite. `t` may be given to restore a removed row at its old place. */
    add({ w, r, p, g = '', t }) {
      const list = read();
      if (list.some((x) => same(x, { w, r, p }))) return true;
      list.push({ w, r, p, g, t: typeof t === 'number' ? t : now() });
      return write(list);
    },
    remove(w, r, p) {
      const list = read();
      const next = list.filter((x) => !same(x, { w, r, p }));
      return next.length === list.length ? true : write(next);
    },
    /** Returns the new state (true = favorite). */
    toggle(item) {
      if (this.has(item.w, item.r, item.p)) { this.remove(item.w, item.r, item.p); return false; }
      this.add(item);
      return true;
    },
  };
}

/** "Copy list" text: one line per favorite, word<TAB>reading<TAB>gloss. */
export function favoritesText(list) {
  const clean = (s) => String(s || '').replace(/[\t\r\n]+/g, ' ');
  return list.map((f) => `${clean(f.w)}\t${clean(f.r)}\t${clean(f.g)}`).join('\n');
}
