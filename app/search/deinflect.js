// Deinflection (SPEC 4.8): inflected form -> base-form candidates, up to 2 chained rules.
// A candidate is only a hit when a words-pack record has that form AND a POS matching `type` (see posBits).

export const T = {
  INIT: 1,     // the typed word itself (any rule may apply)
  V1: 2,       // ichidan verb (also forms that conjugate like one: -rareru, -saseru, -te iru ...)
  V5: 4,       // godan verb (v5*)
  VK: 8,       // kuru
  VS: 16,      // suru (vs-i, vs-s)
  VZ: 32,      // zuru
  ADJ: 64,     // i-adjective (also -tai, -nai forms)
  V5KS: 128,   // iku / yuku (v5k-s)
  V5ARU: 256,  // kudasaru, nasaru ... (v5aru)
};
const ALL = 0x7fffffff;

/** POS tag -> type bits. */
export function posBits(tag) {
  if (tag === 'v1' || tag === 'v1-s') return T.V1;
  if (tag === 'v5k-s') return T.V5 | T.V5KS;
  if (tag === 'v5aru') return T.V5 | T.V5ARU;
  if (tag.startsWith('v5')) return T.V5;
  if (tag === 'vk') return T.VK;
  if (tag === 'vs-i' || tag === 'vs-s') return T.VS;
  if (tag === 'vz') return T.VZ;
  if (tag === 'adj-i' || tag === 'adj-ix') return T.ADJ;
  return 0;
}

const N = {
  polite: 'polite', politePast: 'polite past', politeNeg: 'polite negative', politePastNeg: 'polite past negative',
  politeVol: 'polite volitional', te: 'te-form', past: 'past', neg: 'negative', negPast: 'negative past',
  negTe: 'negative te-form', zu: 'classical negative (-zu)', ba: 'conditional (-ba)', tara: 'conditional (-tara)',
  tari: 'listing (-tari)', potential: 'potential', passive: 'passive', potPass: 'potential or passive',
  causative: 'causative', causPass: 'causative-passive', vol: 'volitional', imp: 'imperative', tai: 'want (-tai)',
  taiNeg: 'negative want (-takunai)', taiPast: 'past want (-takatta)', prog: 'progressive (-te iru)',
  chau: 'completed (-chau)', sugiru: 'too much (-sugiru)', nasai: 'command (-nasai)', adv: 'adverb (-ku)',
  sa: 'noun (-sa)', sou: 'looks like (-sou)',
};

const RULES = []; // [from, to, cin, cout, name]
function r(from, to, cin, cout, name) { RULES.push([from, to, cin, cout, name]); }

// Forms built on the masu stem (i-stem), shared by every verb class.
function stemForms(stem, to, cout) {
  r(stem + 'ます', to, T.INIT, cout, N.polite);
  r(stem + 'ました', to, T.INIT, cout, N.politePast);
  r(stem + 'ません', to, T.INIT, cout, N.politeNeg);
  r(stem + 'ませんでした', to, T.INIT, cout, N.politePastNeg);
  r(stem + 'ましょう', to, T.INIT, cout, N.politeVol);
  r(stem + 'たい', to, T.INIT | T.ADJ, cout, N.tai);
  r(stem + 'たくない', to, T.INIT | T.ADJ, cout, N.taiNeg);
  r(stem + 'たかった', to, T.INIT, cout, N.taiPast);
  r(stem + 'すぎる', to, T.V1, cout, N.sugiru);
  r(stem + 'なさい', to, T.INIT, cout, N.nasai);
}
// Forms built on the te-form / ta-form.
function teForms(te, ta, to, cout) {
  r(te, to, T.INIT, cout, N.te);
  r(ta, to, T.INIT, cout, N.past);
  r(ta + 'ら', to, T.INIT, cout, N.tara);
  r(ta + 'り', to, T.INIT, cout, N.tari);
  r(te + 'いる', to, T.V1, cout, N.prog);
  r(te + 'る', to, T.V1, cout, N.prog);
  const chau = te.endsWith('で') ? te.slice(0, -1) + 'じゃう' : te.slice(0, -1) + 'ちゃう';
  r(chau, to, T.V5, cout, N.chau);
}
// Forms built on the negative stem (a-stem).
function negForms(a, to, cout) {
  r(a + 'ない', to, T.INIT | T.ADJ, cout, N.neg);
  r(a + 'なかった', to, T.INIT, cout, N.negPast);
  r(a + 'なくて', to, T.INIT, cout, N.negTe);
}

// Ichidan
stemForms('', 'る', T.V1);
teForms('て', 'た', 'る', T.V1);
negForms('', 'る', T.V1);
r('ず', 'る', T.INIT, T.V1, N.zu);
r('れば', 'る', T.INIT, T.V1, N.ba);
r('られる', 'る', T.V1, T.V1, N.potPass);
r('れる', 'る', T.V1, T.V1, N.potential);
r('させる', 'る', T.V1, T.V1, N.causative);
r('させられる', 'る', T.V1, T.V1, N.causPass);
r('よう', 'る', T.INIT, T.V1, N.vol);
r('ろ', 'る', T.INIT, T.V1, N.imp);
r('よ', 'る', T.INIT, T.V1, N.imp);

// Godan: [u, i, a, e, o, te, ta]
const GODAN = [
  ['う', 'い', 'わ', 'え', 'お', 'って', 'った'],
  ['く', 'き', 'か', 'け', 'こ', 'いて', 'いた'],
  ['ぐ', 'ぎ', 'が', 'げ', 'ご', 'いで', 'いだ'],
  ['す', 'し', 'さ', 'せ', 'そ', 'して', 'した'],
  ['つ', 'ち', 'た', 'て', 'と', 'って', 'った'],
  ['ぬ', 'に', 'な', 'ね', 'の', 'んで', 'んだ'],
  ['ぶ', 'び', 'ば', 'べ', 'ぼ', 'んで', 'んだ'],
  ['む', 'み', 'ま', 'め', 'も', 'んで', 'んだ'],
  ['る', 'り', 'ら', 'れ', 'ろ', 'って', 'った'],
];
for (const [u, i, a, e, o, te, ta] of GODAN) {
  stemForms(i, u, T.V5);
  teForms(te, ta, u, T.V5);
  negForms(a, u, T.V5);
  r(a + 'ず', u, T.INIT, T.V5, N.zu);
  r(e + 'ば', u, T.INIT, T.V5, N.ba);
  r(e + 'る', u, T.V1, T.V5, N.potential);
  r(a + 'れる', u, T.V1, T.V5, N.passive);
  r(a + 'せる', u, T.V1, T.V5, N.causative);
  r(a + 'せられる', u, T.V1, T.V5, N.causPass);
  if (u !== 'す') r(a + 'される', u, T.V1, T.V5, N.causPass);
  r(o + 'う', u, T.INIT, T.V5, N.vol);
  r(e, u, T.INIT, T.V5, N.imp);
}
// iku / yuku: itte, itta
teForms('って', 'った', 'く', T.V5KS);
// kudasaru, nasaru, irassharu, gozaru, ossharu: i-stem and imperative in -i
stemForms('い', 'る', T.V5ARU);
r('い', 'る', T.INIT, T.V5ARU, N.imp);

// kuru (kana and kanji)
for (const [ki, ko, ku, base] of [['き', 'こ', 'く', 'くる'], ['来', '来', '来', '来る']]) {
  stemForms(ki, base, T.VK);
  teForms(ki + 'て', ki + 'た', base, T.VK);
  negForms(ko, base, T.VK);
  r(ko + 'ず', base, T.INIT, T.VK, N.zu);
  r(ku + 'れば', base, T.INIT, T.VK, N.ba);
  r(ko + 'られる', base, T.V1, T.VK, N.potPass);
  r(ko + 'れる', base, T.V1, T.VK, N.potential);
  r(ko + 'させる', base, T.V1, T.VK, N.causative);
  r(ko + 'させられる', base, T.V1, T.VK, N.causPass);
  r(ko + 'よう', base, T.INIT, T.VK, N.vol);
  r(ko + 'い', base, T.INIT, T.VK, N.imp);
}

// suru
stemForms('し', 'する', T.VS);
teForms('して', 'した', 'する', T.VS);
negForms('し', 'する', T.VS);
r('せず', 'する', T.INIT, T.VS, N.zu);
r('すれば', 'する', T.INIT, T.VS, N.ba);
r('される', 'する', T.V1, T.VS, N.passive);
r('させる', 'する', T.V1, T.VS, N.causative);
r('させられる', 'する', T.V1, T.VS, N.causPass);
r('しよう', 'する', T.INIT, T.VS, N.vol);
r('しろ', 'する', T.INIT, T.VS, N.imp);
r('せよ', 'する', T.INIT, T.VS, N.imp);

// zuru
stemForms('じ', 'ずる', T.VZ);
teForms('じて', 'じた', 'ずる', T.VZ);
negForms('じ', 'ずる', T.VZ);
r('ずれば', 'ずる', T.INIT, T.VZ, N.ba);
r('じられる', 'ずる', T.V1, T.VZ, N.potPass);
r('じさせる', 'ずる', T.V1, T.VZ, N.causative);
r('じよう', 'ずる', T.INIT, T.VZ, N.vol);
r('じろ', 'ずる', T.INIT, T.VZ, N.imp);

// i-adjectives
r('く', 'い', T.INIT, T.ADJ, N.adv);
r('くて', 'い', T.INIT, T.ADJ, N.te);
r('かった', 'い', T.INIT, T.ADJ, N.past);
r('くない', 'い', T.INIT | T.ADJ, T.ADJ, N.neg);
r('くなかった', 'い', T.INIT, T.ADJ, N.negPast);
r('ければ', 'い', T.INIT, T.ADJ, N.ba);
r('さ', 'い', T.INIT, T.ADJ, N.sa);
r('そう', 'い', T.INIT, T.ADJ, N.sou);
r('すぎる', 'い', T.V1, T.ADJ, N.sugiru);

// index rules by the last character of `from`
const BY_LAST = new Map();
for (const rule of RULES) {
  const last = rule[0].slice(-1);
  if (!BY_LAST.has(last)) BY_LAST.set(last, []);
  BY_LAST.get(last).push(rule);
}

export const RULE_COUNT = RULES.length;

/**
 * Base-form candidates of `word` (hiragana or kanji+kana).
 * Returns [{ form, type, via: [rule names, base first] }], at most 2 chained rules, original word excluded.
 */
export function deinflect(word, maxDepth = 2) {
  const out = [];
  const seen = new Map(); // form -> type bits already produced
  let frontier = [{ form: word, type: ALL, via: [] }];
  for (let depth = 0; depth < maxDepth; depth++) {
    const next = [];
    for (const cand of frontier) {
      const rules = BY_LAST.get(cand.form.slice(-1));
      if (!rules) continue;
      for (const [from, to, cin, cout, name] of rules) {
        if (!(cand.type & cin)) continue;
        if (!cand.form.endsWith(from)) continue;
        const stem = cand.form.slice(0, cand.form.length - from.length);
        const form = stem + to;
        if (!stem && to.length <= 1) continue; // a bare ending is not a word
        if (form === word) continue;
        const prevType = seen.get(form) || 0;
        if ((prevType & cout) === cout) continue;
        seen.set(form, prevType | cout);
        const item = { form, type: cout, via: [name, ...cand.via] };
        out.push(item);
        next.push(item);
      }
    }
    frontier = next;
  }
  return out;
}

/** Human note, e.g. "食べた is the past form of 食べる". */
export function viaNote(typed, base, via) {
  return `${typed} is the ${via} form of ${base}`;
}
