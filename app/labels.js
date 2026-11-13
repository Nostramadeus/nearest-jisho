// JMdict / JMnedict short codes -> labels in full English words (SPEC 3: app holds the code -> label table).

export const POS = {
  'adj-f': 'Noun or verb acting before a noun', 'adj-i': 'I-adjective', 'adj-ix': 'I-adjective (yoi/ii class)',
  'adj-kari': 'Kari adjective (archaic)', 'adj-ku': 'Ku adjective (archaic)', 'adj-na': 'Na-adjective',
  'adj-nari': 'Nari adjective (archaic)', 'adj-no': 'No-adjective', 'adj-pn': 'Pre-noun adjectival',
  'adj-shiku': 'Shiku adjective (archaic)', 'adj-t': 'Taru adjective', adv: 'Adverb', 'adv-to': 'Adverb taking "to"',
  aux: 'Auxiliary', 'aux-adj': 'Auxiliary adjective', 'aux-v': 'Auxiliary verb', conj: 'Conjunction', cop: 'Copula',
  ctr: 'Counter', exp: 'Expression', int: 'Interjection', n: 'Noun', 'n-adv': 'Adverbial noun', 'n-pr': 'Proper noun',
  'n-pref': 'Noun used as a prefix', 'n-suf': 'Noun used as a suffix', 'n-t': 'Temporal noun', num: 'Numeric',
  pn: 'Pronoun', pref: 'Prefix', prt: 'Particle', suf: 'Suffix', unc: 'Unclassified', 'v-unspec': 'Verb (type not specified)',
  v1: 'Ichidan verb', 'v1-s': 'Ichidan verb (kureru class)', v5aru: 'Godan verb (aru class)', v5b: 'Godan verb (bu ending)',
  v5g: 'Godan verb (gu ending)', v5k: 'Godan verb (ku ending)', 'v5k-s': 'Godan verb (iku / yuku class)',
  v5m: 'Godan verb (mu ending)', v5n: 'Godan verb (nu ending)', v5r: 'Godan verb (ru ending)',
  'v5r-i': 'Godan verb (ru ending, irregular)', v5s: 'Godan verb (su ending)', v5t: 'Godan verb (tsu ending)',
  v5u: 'Godan verb (u ending)', 'v5u-s': 'Godan verb (u ending, special class)', v5uru: 'Godan verb (uru, old form of eru)',
  vi: 'Intransitive verb', vk: 'Kuru verb (special class)', vn: 'Irregular nu verb', vr: 'Irregular ru verb',
  vs: 'Suru verb', 'vs-c': 'Su verb (older form of suru)', 'vs-i': 'Suru verb (included)', 'vs-s': 'Suru verb (special class)',
  vt: 'Transitive verb', vz: 'Ichidan verb (zuru form)',
};

export const MISC = {
  abbr: 'abbreviation', arch: 'archaic', char: 'character', chn: "children's language", col: 'colloquial',
  company: 'company name', creat: 'creature', dated: 'dated term', dei: 'deity', derog: 'derogatory', doc: 'document',
  euph: 'euphemistic', ev: 'event', fam: 'familiar language', fem: 'female language', fict: 'fiction',
  form: 'formal or literary', given: 'given name', group: 'group', hist: 'historical term', hon: 'honorific language',
  hum: 'humble language', id: 'idiomatic expression', joc: 'jocular', leg: 'legend', 'm-sl': 'manga slang',
  male: 'male language', myth: 'mythology', 'net-sl': 'Internet slang', obj: 'object', obs: 'obsolete',
  'on-mim': 'onomatopoeic or mimetic', organization: 'organization name', oth: 'other', person: 'person',
  place: 'place name', poet: 'poetic', pol: 'polite language', product: 'product name', proverb: 'proverb',
  quote: 'quotation', rare: 'rare', relig: 'religion', sens: 'sensitive', serv: 'service', ship: 'ship name',
  sl: 'slang', station: 'railway station', surname: 'surname', uk: 'usually written in kana', unclass: 'unclassified name',
  vulg: 'vulgar', work: 'work of art or literature', X: 'rude or X-rated', yoji: 'four-character idiom',
};

export const FIELD = {
  agric: 'agriculture', anat: 'anatomy', archeol: 'archaeology', archit: 'architecture', art: 'art',
  astron: 'astronomy', audvid: 'audiovisual', aviat: 'aviation', baseb: 'baseball', biochem: 'biochemistry',
  biol: 'biology', bot: 'botany', boxing: 'boxing', Buddh: 'Buddhism', bus: 'business', cards: 'card games',
  chem: 'chemistry', chmyth: 'Chinese mythology', Christn: 'Christianity', civeng: 'civil engineering',
  cloth: 'clothing', comp: 'computing', cryst: 'crystallography', dent: 'dentistry', ecol: 'ecology',
  econ: 'economics', elec: 'electrical engineering', electr: 'electronics', embryo: 'embryology',
  engr: 'engineering', ent: 'entomology', figskt: 'figure skating', film: 'film', finc: 'finance', fish: 'fishing',
  food: 'food and cooking', gardn: 'gardening', genet: 'genetics', geogr: 'geography', geol: 'geology',
  geom: 'geometry', go: 'go (board game)', golf: 'golf', gramm: 'grammar', grmyth: 'Greek mythology',
  hanaf: 'hanafuda', horse: 'horse racing', internet: 'Internet', jpmyth: 'Japanese mythology', kabuki: 'kabuki',
  law: 'law', ling: 'linguistics', logic: 'logic', MA: 'martial arts', mahj: 'mahjong', manga: 'manga',
  math: 'mathematics', mech: 'mechanical engineering', med: 'medicine', met: 'meteorology', mil: 'military',
  min: 'mineralogy', mining: 'mining', motor: 'motorsport', music: 'music', noh: 'noh', ornith: 'ornithology',
  paleo: 'paleontology', pathol: 'pathology', pharm: 'pharmacology', phil: 'philosophy', photo: 'photography',
  physics: 'physics', physiol: 'physiology', politics: 'politics', print: 'printing', prowres: 'professional wrestling',
  psy: 'psychiatry', psyanal: 'psychoanalysis', psych: 'psychology', rail: 'railway', rommyth: 'Roman mythology',
  Shinto: 'Shinto', shogi: 'shogi', ski: 'skiing', sports: 'sports', stat: 'statistics', stockm: 'stock market',
  sumo: 'sumo', surg: 'surgery', telec: 'telecommunications', tradem: 'trademark', tv: 'television',
  vet: 'veterinary', vidg: 'video games', zool: 'zoology',
};

export const DIALECT = {
  bra: 'Brazilian', hob: 'Hokkaido dialect', ksb: 'Kansai dialect', ktb: 'Kanto dialect', kyb: 'Kyoto dialect',
  kyu: 'Kyushu dialect', nab: 'Nagano dialect', osb: 'Osaka dialect', rkb: 'Ryukyu dialect', thb: 'Tohoku dialect',
  tsb: 'Tosa dialect', tsug: 'Tsugaru dialect',
};

export const NAME_TYPE = {
  surname: 'surname', place: 'place', unclass: 'unclassified', company: 'company', product: 'product', work: 'work',
  masc: 'male given name', fem: 'female given name', person: 'person', given: 'given name', station: 'railway station',
  organization: 'organization', ok: 'old or irregular kana', char: 'character', creat: 'creature', dei: 'deity',
  doc: 'document', ev: 'event', fict: 'fiction', group: 'group', leg: 'legend', myth: 'mythology', obj: 'object',
  oth: 'other', relig: 'religion', serv: 'service', ship: 'ship',
};

/** Misc codes that are shown as highlighted (slang-type) tags. */
export const SLANG_CODES = new Set(['sl', 'net-sl', 'm-sl', 'vulg', 'col', 'derog', 'X', 'joc']);

export const label = (table, code) => table[code] || code;
