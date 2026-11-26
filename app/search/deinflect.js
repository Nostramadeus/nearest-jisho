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
  V5ARU: 256, // kudasaru, nasaru ... (v5aru)
  ADJNA: 512,  // na-adjective (adj-na): stem suffixes -ge, -sa, -sou, -sugiru, -rashii (SPEC 32.6)
  N: 1024,     // noun: -ppoi, -rashii (SPEC 32.6)
};
const ALL = 0x7fffffff;
/** Noun tags for the noun + -ppoi / -rashii rules (SPEC 32.6). */
const NOUN_POS = new Set(['n', 'n-adv', 'n-t', 'n-pr', 'n-suf']);

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
  if (tag === 'adj-na') return T.ADJNA;
  if (NOUN_POS.has(tag)) return T.N;
  return 0;
}

const N = {
  polite: 'polite', politePast: 'polite past', politeNeg: 'polite negative', politePastNeg: 'polite past negative',
  politeVol: 'polite volitional', te: 'te-form', past: 'past', neg: 'negative', negPast: 'negative past',
  negTe: 'negative te-form', zu: 'classical negative (-zu)', negN: 'negative (-n)', nu: 'classical negative (-nu)', ba: 'conditional (-ba)', tara: 'conditional (-tara)',
  tari: 'listing (-tari)', potential: 'potential', passive: 'passive', potPass: 'potential or passive',
  causative: 'causative', causPass: 'causative-passive', vol: 'volitional', imp: 'imperative', tai: 'want (-tai)',
  taiNeg: 'negative want (-takunai)', taiPast: 'past want (-takatta)', prog: 'progressive (-te iru)',
  chau: 'completed (-chau)', sugiru: 'too much (-sugiru)', nasai: 'command (-nasai)', adv: 'adverb (-ku)',
  sa: 'noun (-sa)', sou: 'looks like (-sou)',
  adjStem: 'adjective stem', // SPEC 32.1: 悩まし = 悩ましい without its い
  kuNaru: 'become (-ku naru)', // SPEC 32.4: くちくなる = くちい + なる
  nagara: 'while (-nagara)', tsutsu: 'while (-tsutsu)', tagaru: 'wants (-tagaru)', // SPEC 32.8
};
/**
 * Stem suffixes (SPEC 32.6): each has its own label, and the note names the base word + the label
 * (うろんげ is 胡乱 + -ge: seeming, looking) instead of "the ... form of".
 */
export const STEM = {
  ge: '-ge: seeming, looking',
  sa: '-sa: the degree of it (noun)',
  sou: '-sou: looks like',
  sugiru: '-sugiru: too much',
  rashii: '-rashii: seems, typical of',
  mi: '-mi: the quality of it (noun)',
  garu: '-garu: shows signs of feeling',
  ppoi: '-ppoi: -ish, like',
};
const STEM_LABELS = new Set(Object.values(STEM));
export const isStemLabel = (name) => STEM_LABELS.has(name);

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
  r(stem + 'ながら', to, T.INIT, cout, N.nagara); // SPEC 32.8
  r(stem + 'つつ', to, T.INIT, cout, N.tsutsu);
  r(stem + 'たがる', to, T.V5, cout, N.tagaru);
  r(stem + 'そう', to, T.INIT, cout, N.sou);
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
r('ん', 'る', T.INIT, T.V1, N.negN); // SPEC 28.3: 食べん, 見ん
r('ぬ', 'る', T.INIT, T.V1, N.nu);
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
  r(a + 'ん', u, T.INIT, T.V5, N.negN); // SPEC 28.3: 覆さん, 知らん
  r(a + 'ぬ', u, T.INIT, T.V5, N.nu);
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
  r(ko + 'ん', base, T.INIT, T.VK, N.negN);
  r(ko + 'ぬ', base, T.INIT, T.VK, N.nu);
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
r('せん', 'する', T.INIT, T.VS, N.negN);
r('せぬ', 'する', T.INIT, T.VS, N.nu);
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
r('くなる', 'い', T.V5, T.ADJ, N.kuNaru); // SPEC 32.4: くちくなった
r('し', 'しい', T.INIT, T.ADJ, N.adjStem); // SPEC 32.1: 悩まし (needs a stem: see deinflect)
// SPEC 32.6: stem suffixes. i-adjective stem + げ / み / がる (さ, そう, すぎる above)
r('げ', 'い', T.INIT, T.ADJ, STEM.ge);
r('み', 'い', T.INIT, T.ADJ, STEM.mi);
r('がる', 'い', T.V5, T.ADJ, STEM.garu);
// na-adjective + げ / さ / そう / すぎる / らしい
r('げ', '', T.INIT, T.ADJNA, STEM.ge);
r('さ', '', T.INIT, T.ADJNA, STEM.sa);
r('そう', '', T.INIT, T.ADJNA, STEM.sou);
r('すぎる', '', T.V1, T.ADJNA, STEM.sugiru);
r('らしい', '', T.INIT | T.ADJ, T.ADJNA, STEM.rashii);
// noun + っぽい / らしい
r('っぽい', '', T.INIT | T.ADJ, T.N, STEM.ppoi);
r('らしい', '', T.INIT | T.ADJ, T.N, STEM.rashii);

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
        if (!stem && (to.length <= 1 || name === N.adjStem)) continue; // a bare ending is not a word
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

/**
 * Human note, e.g. "食べた is the past form of 食べる". via = rule names joined by " + ", base side first.
 * A stem suffix (SPEC 32.6) is named after the base: "うろんげ is 胡乱 + -ge: seeming, looking"; other rules of the
 * same chain follow in brackets ("寒がって is 寒い + -garu: shows signs of feeling (te-form)").
 */
export function viaNote(typed, base, via) {
  const parts = String(via).split(' + ');
  const stem = parts.filter(isStemLabel);
  if (!stem.length) return `${typed} is the ${via} form of ${base}`;
  const rest = parts.filter((x) => !isStemLabel(x));
  return `${typed} is ${base} + ${stem.join(' + ')}${rest.length ? ` (${rest.join(' + ')})` : ''}`;
}
