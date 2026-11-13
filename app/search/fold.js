// Fold key (SPEC 4.2): remove ' and -, ou -> o, uu -> u, then collapse runs of the same letter.
export function fold(romaji) {
  const s = romaji.replace(/['-]/g, '').replace(/ou/g, 'o').replace(/uu/g, 'u');
  let out = '';
  for (let i = 0; i < s.length; i++) if (i === 0 || s[i] !== s[i - 1]) out += s[i];
  return out;
}

/** 32-bit FNV-1a hash of a string (used for the fold index buckets). */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
