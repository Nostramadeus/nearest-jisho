// Canonical romaji (SPEC 4.1). Pure module: runs in a browser worker and in node.

const BASE = {
  'あ':'a','い':'i','う':'u','え':'e','お':'o',
  'か':'ka','き':'ki','く':'ku','け':'ke','こ':'ko',
  'が':'ga','ぎ':'gi','ぐ':'gu','げ':'ge','ご':'go',
  'さ':'sa','し':'shi','す':'su','せ':'se','そ':'so',
  'ざ':'za','じ':'ji','ず':'zu','ぜ':'ze','ぞ':'zo',
  'た':'ta','ち':'chi','つ':'tsu','て':'te','と':'to',
  'だ':'da','ぢ':'ji','づ':'zu','で':'de','ど':'do',
  'な':'na','に':'ni','ぬ':'nu','ね':'ne','の':'no',
  'は':'ha','ひ':'hi','ふ':'fu','へ':'he','ほ':'ho',
  'ば':'ba','び':'bi','ぶ':'bu','べ':'be','ぼ':'bo',
  'ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po',
  'ま':'ma','み':'mi','む':'mu','め':'me','も':'mo',
  'や':'ya','ゆ':'yu','よ':'yo',
  'ら':'ra','り':'ri','る':'ru','れ':'re','ろ':'ro',
  'わ':'wa','ゐ':'i','ゑ':'e','を':'o','ん':'n','ゔ':'vu',
  'ぁ':'a','ぃ':'i','ぅ':'u','ぇ':'e','ぉ':'o','ゃ':'ya','ゅ':'yu','ょ':'yo','ゎ':'wa','ゕ':'ka','ゖ':'ke',
  // katakana-only letters with no hiragana twin (U+30F7..U+30FA)
  'ヷ':'va','ヸ':'vi','ヹ':'ve','ヺ':'vo',
};

// Two-kana combinations with a small vowel (SPEC 4.1: ふぁ fa, てぃ ti, うぃ wi ...)
const COMBO = {
  'ふぁ':'fa','ふぃ':'fi','ふぇ':'fe','ふぉ':'fo','ふゅ':'fyu',
  'てぃ':'ti','でぃ':'di','とぅ':'tu','どぅ':'du','てゅ':'tyu','でゅ':'dyu',
  'うぃ':'wi','うぇ':'we','うぉ':'wo',
  'ゔぁ':'va','ゔぃ':'vi','ゔぇ':'ve','ゔぉ':'vo','ゔゅ':'vyu',
  'しぇ':'she','じぇ':'je','ちぇ':'che','ぢぇ':'je',
  'つぁ':'tsa','つぃ':'tsi','つぇ':'tse','つぉ':'tso',
  'いぇ':'ye','きぇ':'kye','ぎぇ':'gye','にぇ':'nye','ひぇ':'hye','びぇ':'bye','ぴぇ':'pye','みぇ':'mye','りぇ':'rye',
  'くぁ':'kwa','くぃ':'kwi','くぇ':'kwe','くぉ':'kwo','ぐぁ':'gwa',
  'すぃ':'si','ずぃ':'zi',
};

const SMALL_Y = { 'ゃ':'a', 'ゅ':'u', 'ょ':'o' };
const VOWELS = 'aiueo';

/** Katakana to hiragana (U+30A1..U+30F6). Other characters unchanged. */
export function toHiragana(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x30a1 && c <= 0x30f6) out += String.fromCodePoint(c - 0x60);
    else if (c === 0x30fd) out += 'ゝ';
    else if (c === 0x30fe) out += 'ゞ';
    else out += ch;
  }
  return out;
}

export function isKana(c) {
  // hiragana, katakana (incl. prolonged sound mark), halfwidth katakana
  return (c >= 0x3041 && c <= 0x309f) || (c >= 0x30a0 && c <= 0x30ff) || (c >= 0xff66 && c <= 0xff9d);
}

export function hasKana(s) {
  for (const ch of s) if (isKana(ch.codePointAt(0))) return true;
  return false;
}

/** Kana -> canonical romaji (SPEC 4.1). Non-kana: ASCII letters/digits/apostrophe kept lowercased, others dropped. */
export function kanaToRomaji(kana) {
  const s = Array.from(toHiragana(kana.normalize('NFKC').toLowerCase()));
  const syl = []; // romaji per syllable, in order
  // First pass: split into syllables.
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (next !== undefined && COMBO[ch + next]) { syl.push(COMBO[ch + next]); i++; continue; }
    if (next !== undefined && SMALL_Y[next] && BASE[ch] && BASE[ch].endsWith('i') && BASE[ch].length >= 2) {
      const stem = BASE[ch].slice(0, -1);
      const v = SMALL_Y[next];
      syl.push(/(sh|ch|j)$/.test(stem) ? stem + v : stem + 'y' + v);
      i++; continue;
    }
    if (ch === 'っ') { syl.push('\u0001'); continue; }        // marker: double next consonant
    if (ch === 'ー') { syl.push('\u0002'); continue; }        // marker: repeat previous vowel
    if (ch === 'ゝ' || ch === 'ゞ') { syl.push('\u0003'); continue; } // marker: repeat previous syllable
    if (ch === 'ん') { syl.push('\u0004'); continue; }        // marker: n / n'
    if (BASE[ch] !== undefined) { syl.push(BASE[ch]); continue; }
    if (/[a-z0-9']/.test(ch)) { syl.push(ch); continue; }
    // anything else (kanji, punctuation, middle dot, spaces) is dropped
  }
  // Second pass: resolve markers.
  let out = '';
  let prevSyl = '';
  for (let i = 0; i < syl.length; i++) {
    let r = syl[i];
    if (r === '\u0003') r = prevSyl;
    if (r === '\u0001') {
      const nx = nextReal(syl, i + 1);
      if (nx && !VOWELS.includes(nx[0]) && /[a-z]/.test(nx[0]) && nx[0] !== 'n') out += nx[0] === 'c' ? 'c' : nx[0];
      continue;
    }
    if (r === '\u0002') {
      if (/[aiueo]$/.test(out)) out += out[out.length - 1];
      continue;
    }
    if (r === '\u0004') {
      const nx = nextReal(syl, i + 1);
      out += (nx && (VOWELS.includes(nx[0]) || nx[0] === 'y')) ? "n'" : 'n';
      prevSyl = 'n';
      continue;
    }
    out += r;
    prevSyl = r;
  }
  return out;
}

function nextReal(syl, j) {
  for (; j < syl.length; j++) {
    const r = syl[j];
    if (r === '\u0001' || r === '\u0003') continue;
    if (r === '\u0002') return '';
    if (r === '\u0004') return 'n';
    return r;
  }
  return '';
}

// ---- romaji -> kana (wapuro input) ----

const R2K = {};
function add(r, k) { if (!(r in R2K)) R2K[r] = k; }
(function buildR2K() {
  const v = ['a', 'i', 'u', 'e', 'o'];
  const rows = {
    '': 'あいうえお', k: 'かきくけこ', g: 'がぎぐげご', s: 'さしすせそ', z: 'ざじずぜぞ', t: 'たちつてと', d: 'だぢづでど',
    n: 'なにぬねの', h: 'はひふへほ', b: 'ばびぶべぼ', p: 'ぱぴぷぺぽ', m: 'まみむめも', r: 'らりるれろ',
  };
  for (const [c, ks] of Object.entries(rows)) v.forEach((x, i) => add(c + x, ks[i]));
  const yrows = { k: 'き', g: 'ぎ', n: 'に', h: 'ひ', b: 'び', p: 'ぴ', m: 'み', r: 'り' };
  for (const [c, k] of Object.entries(yrows)) {
    add(c + 'ya', k + 'ゃ'); add(c + 'yu', k + 'ゅ'); add(c + 'yo', k + 'ょ'); add(c + 'ye', k + 'ぇ'); add(c + 'yi', k + 'ぃ');
  }
  // sh / ch / j and their Kunrei / variant spellings
  const fam = [
    [['sh', 'sy'], 'し'], [['ch', 'ty', 'cy'], 'ち'], [['j', 'jy', 'zy'], 'じ'], [['dy'], 'ぢ'],
  ];
  for (const [prefixes, k] of fam) for (const p of prefixes) {
    add(p + 'a', k + 'ゃ'); add(p + 'u', k + 'ゅ'); add(p + 'o', k + 'ょ'); add(p + 'e', k + 'ぇ');
  }
  Object.assign(R2K, {
    shi: 'し', chi: 'ち', tsu: 'つ', fu: 'ふ', ji: 'じ', jyi: 'じぃ', ti: 'ち', tu: 'つ', hu: 'ふ', si: 'し', zi: 'じ',
    di: 'ぢ', du: 'づ', dzu: 'づ',
    ya: 'や', yu: 'ゆ', yo: 'よ', ye: 'いぇ',
    wa: 'わ', wi: 'うぃ', we: 'うぇ', wo: 'を', wyi: 'ゐ', wye: 'ゑ',
    fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ', fyu: 'ふゅ', fya: 'ふゃ', fyo: 'ふょ',
    va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ', vyu: 'ゔゅ',
    tsa: 'つぁ', tsi: 'つぃ', tse: 'つぇ', tso: 'つぉ',
    thi: 'てぃ', thu: 'てゅ', dhi: 'でぃ', dhu: 'でゅ', twu: 'とぅ', dwu: 'どぅ',
    kwa: 'くぁ', kwi: 'くぃ', kwe: 'くぇ', kwo: 'くぉ', gwa: 'ぐぁ', qa: 'くぁ', qi: 'くぃ', qe: 'くぇ', qo: 'くぉ',
    ca: 'か', cu: 'く', co: 'こ', ci: 'し', ce: 'せ',
    nn: 'ん', "n'": 'ん',
  });
  // small kana: x prefix only; l + vowel is the r-row (SPEC 18 ruling 4, typo study 2.6); ltu / ltsu stay っ
  const small = { a: 'ぁ', i: 'ぃ', u: 'ぅ', e: 'ぇ', o: 'ぉ', ya: 'ゃ', yu: 'ゅ', yo: 'ょ', wa: 'ゎ', tu: 'っ', tsu: 'っ', ka: 'ゕ', ke: 'ゖ' };
  for (const [r, k] of Object.entries(small)) R2K['x' + r] = k;
  R2K.ltu = 'っ'; R2K.ltsu = 'っ';
  for (const r of Object.keys(R2K)) if (/^r(y?[aiueo])$/.test(r)) R2K['l' + r.slice(1)] = R2K[r];
})();

const MACRON = { 'ā': 'aa', 'ī': 'ii', 'ū': 'uu', 'ē': 'ee', 'ō': 'ou', 'â': 'aa', 'î': 'ii', 'û': 'uu', 'ê': 'ee', 'ô': 'ou' };

function prepLatin(text) {
  let t = text.toLowerCase();
  t = t.replace(/[āīūēōâîûêô]/g, (m) => MACRON[m]);
  return latinRewrite(t.normalize('NFKC'));
}

/**
 * Old-style Hepburn spellings (typo study 2.5): m before b / p -> n (shimbun, sempai); with 4 or more letters,
 * oh -> ou and uh -> uu when the next character is not a vowel or y (ohsaka, ohkii). Also used on the raw letters.
 */
export function latinRewrite(t) {
  let out = t.replace(/m(?=[bp])/g, 'n');
  if ((out.match(/[a-z]/g) || []).length >= 4) out = out.replace(/([ou])h(?![aiueoy])/g, (m, v) => (v === 'o' ? 'ou' : 'uu'));
  return out;
}

/** Wapuro romaji -> hiragana. Returns { kana, clean }; clean=false when a Latin letter stays unconverted. */
export function romajiToKana(text) {
  const t = prepLatin(text);
  let out = '';
  let clean = true;
  let i = 0;
  const isLetter = (c) => c >= 'a' && c <= 'z';
  while (i < t.length) {
    const c = t[i];
    if (c === '-') { out += 'ー'; i++; continue; }
    if (!isLetter(c)) { out += c; i++; continue; }
    // n handling
    if (c === 'n') {
      const n1 = t[i + 1];
      if (n1 === "'") { out += 'ん'; i += 2; continue; }
      if (n1 === 'n') {
        const n2 = t[i + 2];
        if (n2 !== undefined && ('aiueo'.includes(n2) || n2 === 'y')) { out += 'ん'; i += 1; continue; } // konnichiwa
        out += 'ん'; i += 2; continue;
      }
      if (n1 === undefined || !isLetter(n1) || (!'aiueoy'.includes(n1))) { out += 'ん'; i++; continue; }
    }
    // small tsu: doubled consonant (not n), or t before ch
    const n1 = t[i + 1];
    if (n1 === c && !'aiueon'.includes(c)) { out += 'っ'; i++; continue; }
    if (c === 't' && n1 === 'c' && t[i + 2] === 'h') { out += 'っ'; i++; continue; }
    // longest match, up to 4 letters
    let done = false;
    for (let len = 4; len >= 1; len--) {
      const piece = t.slice(i, i + len);
      if (piece.length === len && R2K[piece] !== undefined) { out += R2K[piece]; i += len; done = true; break; }
    }
    if (!done) { out += c; clean = false; i++; }
  }
  return { kana: out, clean };
}

const VARIANT = { si: 'shi', ti: 'chi', tu: 'tsu', hu: 'fu', zi: 'ji', sy: 'sh', ty: 'ch', zy: 'j' };

/** Variant rewrite on raw Latin letters (used when romajiToKana is not clean). */
export function variantRewrite(letters) {
  return letters.replace(/[^a-z]/g, '').replace(/(?<![sc])hu|si|ti|tu|zi|sy|ty|zy/g, (m) => VARIANT[m]);
}

/** Canonical romaji of a query (SPEC 4.1). */
export function canon(query) {
  const q = prepLatin(String(query)).trim();
  if (hasKana(q)) return kanaToRomaji(q);
  const noSpace = q.replace(/\s+/g, '');
  const { kana, clean } = romajiToKana(noSpace);
  if (clean) return kanaToRomaji(kana);
  return variantRewrite(noSpace);
}
