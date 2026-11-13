# Nearest Jisho - Japanese Dictionary: SPEC

Offline Japanese-English dictionary with typo-tolerant ("near-miss") search and results as you type.
One static web app. The same files are wrapped into an Android .apk and Windows / Linux desktop apps by CI.
Public repo: `Nostramadeus/nearest-jisho`. Code licence MIT. Data licence CC BY-SA 4.0 (see section 9).

Decisions here are final. If something needed is not written here, a worker STOPS that part, writes the
question in its PROGRESS file, and continues with parts that do not depend on it.

## 1. Layout

```
nearest-jisho/
  app/                 static site, plain ES modules, NO bundler, NO framework, NO runtime dependencies
    index.html  style.css  main.js  sw.js  manifest.webmanifest  icons/
    search/            pure modules, run in browser Web Worker AND in node (no DOM, no fetch inside)
      romaji.js  fold.js  cost.js  deinflect.js  engine.js  packs.js
    worker.js          Web Worker shell: loads packs, calls engine, posts results
    data/              BUILD OUTPUT, gitignored (packs, section 3)
  build/               node scripts (stdlib only) that download sources and write app/data/
    build-data.mjs     entry: `node build/build-data.mjs [--only words,names,kanji,wikt]`
  tools/query.mjs      CLI: `node tools/query.mjs "jihso"` prints ranked results using app/data + engine
  test/                `node --test test/` (node built-in runner)
  design/look-demo.html   visual reference: Look A
  SPEC.md  README.md  LICENSE (MIT)  DATA-LICENSE.md  .gitignore
  BACKLOG.md AI-HANDOFF.md PROGRESS-*.md  -> gitignored, never pushed
```

Node 24, stdlib only for build and tests. No Python. No npm dependencies in `app/`.
Keep disk use low. Build scripts STREAM downloads (fetch -> gunzip/unzip stream ->
line parser) and never keep more than 600 MB of temporary files; temp goes in `build/.cache/` (gitignored) and
large raw files are deleted when their pack is written. Zip reading: use a small stdlib zip reader
(central directory + zlib inflateRaw) or download the `.tgz` variant and parse tar by hand.

## 2. Sources (all verified free; report in PROGRESS if a URL has moved)

| Pack | Source | Notes |
|---|---|---|
| words | scriptin/jmdict-simplified latest GitHub release, asset `jmdict-examples-eng-*.json.tgz` | 219k entries, English glosses, Tatoeba example sentences attached to senses |
| names | same release, `jmnedict-all-*.json.tgz` | 743k names |
| kanji | same release, `kanjidic2-en-*.json.tgz` | keep: literal, meanings (en), on/kun readings, nanori, stroke count, grade, jlpt, freq. Drop every other field (SKIP codes, dictionary refs, pinyin, Korean) |
| wikt-en | kaikki.org English Wiktionary, Japanese entries JSONL (https://kaikki.org/dictionary/Japanese/) | filter, section 2.1 |
| wikt-ja | https://kaikki.org/dictionary/downloads/ja/ja-extract.jsonl.gz | filter, section 2.1 |
| freq | jiten.moe frequency list, GLOBAL list, from https://jiten.moe/other (CSV preferred) | rank per word -> `ff` (fiction/media rank) |
| jlpt | github.com/stephenmk/yomitan-jlpt-vocab | N5..N1 tag per JMdict entry |

Not in v1 (board ideas): KanjiVG stroke order, Wikipedia titles, pitch accent, SudachiDict, WordNet, Wikidata.

### 2.1 Wiktionary filter
- wikt-en: keep an entry (lang Japanese) when EITHER (a) any sense carries a tag/label/category matching
  (case-insensitive) `slang`, `internet`, `fandom`, `colloquial`, `vulgar`, `derogatory`, `dialect`, `onomatopoei`,
  `men's speech`, `women's speech`, `childish`, `gyaru`, OR (b) neither its headword nor its kana reading exists
  as any JMdict kanji/kana form. Drop senses that are only "form of" / inflection / romanization stubs, and
  entries whose part of speech is `romanization`, `character`, `soft-redirect`. Keep per entry: headword, kana
  readings, POS, up to 6 senses (glosses + labels), page URL `https://en.wiktionary.org/wiki/<headword>#Japanese`.
- wikt-ja: keep lang 日本語 entries where any sense has a tag/category containing `俗語`, `スラング`, `卑語`,
  `隠語`, `若者言葉`, `2ちゃんねる`, `ネット`. Glosses stay Japanese. URL `https://ja.wiktionary.org/wiki/<headword>`.
- Both go into ONE pack `wikt` with a `src` field: `"we"` or `"wj"`.
- If a kaikki URL is gone: build the other packs, skip that source, write it in PROGRESS. Never scrape another site.

### 2.2 Commonness ranks (lower = more common; 999999 = unknown)
- `fn` (news rank, from JMdict priority tags on any kanji/kana form of the entry):
  `nfXX` -> XX*500; else any of news1/ichi1/spec1/gai1 -> 15000; else news2/ichi2/spec2/gai2 -> 35000; else 999999.
- `ff` (fiction rank): jiten.moe global rank matched by (word, reading); if only word matches, use it; else
  `ff = fn` when fn < 999999, else 999999. If the jiten.moe file cannot be fetched or parsed: `ff = fn` for all, note in PROGRESS.
- `c` (common flag): jmdict-simplified `common` true on any form.
- Rulings 2026-11-13 (coordinator, after the first build):
  - A jiten.moe row whose word is written in kana only applies to a record only when the record has NO kanji forms
    or one of its senses has misc `uk`. (Stops 爾 getting the rank of おれ.)
  - The "only the word matches" fallback is used only when no OTHER words-pack record has that written form together
    with the jiten.moe row's reading. (Stops 和気/かき getting the rank of 和気/わき.)
  - Priority tags come from EDRDG `JMdict_e.gz` (jmdict-simplified lacks them). If EDRDG is unreachable the build fails; nothing is deployed.
  - JLPT on two lists: keep the easiest level. Entry-level Wiktionary labels count like sense labels. "Alternative form of" senses are kept.
  - wikt-ja label list: replace `ネット` with `ネットスラング` and `ネット用語` (the bare word matched the internet topic category).
  - English keys and the app's query tokenizer both split on any non-letter using Unicode letters (`\p{L}`), so `café` is one token.
- names pack: `ff` = jiten.moe rank when a row matches a (kanji form, reading) pair of the record exactly, else 999999; `fn = 999999`.
- (superseded line, kept for history) names pack originally: `ff = fn = 999999`. wikt pack: use jiten.moe rank by headword when present, else 999999.

## 3. Pack format (contract between build/ and app/search/packs.js)

Every pack `<p>` (words, names, wikt) is 5 files in `app/data/`:

| File | Content |
|---|---|
| `<p>.dat` | UTF-8. All records concatenated; each record is one compact JSON object, no newline needed |
| `<p>.off` | Uint32Array little-endian, length N+1: byte offset of record i in `.dat` (last = total length) |
| `<p>.meta` | Uint32Array LE, 2 values per record: `ff`, `fn`. Then a Uint8Array section is NOT used; flags live in the record |
| `<p>.keys.json` | `{ "r": {...}, "k": {...}, "e": {...} }` three key spaces, each `{ "keys": "<sorted unique keys joined by \n>", "ptr": [CSR offsets, length K+1], "ids": [record ids] }` |
| (kanji only) `kanji.json` | one object keyed by literal: `{ "m": [meanings], "on": [], "kun": [], "n": [nanori], "s": strokes, "g": grade, "j": jlpt, "f": freq }` (empty/null fields omitted; `n` added by the data lane 2026-11-13 because section 2 keeps nanori) |

Key spaces:
- `r` = reading keys: canonical romaji (section 4.1) of every kana form. Sorted by plain code-unit order.
- `k` = written-form keys: every kanji form and every kana form as written (NFKC; katakana kept as is).
- `e` = English keys: lowercase gloss words (split on non-letters, length >= 2, minus the stop list
  `a an the of to in on at for and or by with as is be it that from`). ids for `e` are packed as
  `recordId * 16 + min(senseIndex, 15)`. Names pack has NO `e` space (key spaces `r` and `k` only). wikt-ja records are not indexed in `e`.

If `.keys.json` for a pack would exceed 60 MB, the build may switch `ptr`/`ids` to separate binary Uint32 files
(`<p>.<space>.ptr`, `<p>.<space>.ids`) and keep only the `keys` strings in separate `.txt` files. Whatever is chosen
is written into this section by the data lane so the app lane reads the same thing. `app/search/packs.js` is the
ONLY module that knows the file layout; it exposes: `getRecord(pack,id)`, `meta(pack,id)`, `keySpace(pack,space)`
-> `{ keys: string[], idsOf(i): number[] }`, and `kanji(literal)`.

Record shapes (short field names, omit empty fields):
- words: `{ "k":[kanji forms], "r":[kana forms], "c":1, "j":5, "s":[ { "p":[pos tags], "g":[glosses], "m":[misc tags e.g. "sl","net-sl","m-sl","vulg","col","on-mim","uk","arch","derog"], "f":[field tags], "d":[dialect tags], "i":"sense info", "x":[ ["Japanese sentence","English sentence"] ] } ] }`
  Max 2 example pairs per sense. POS/misc tags stay as JMdict short codes; `app/` holds the code -> label table.
- names: `{ "k":[], "r":[], "t":[name type codes], "g":[translations] }`
- wikt: `{ "src":"we"|"wj", "k":[headword], "r":[kana], "u":"page url", "s":[ { "p":[pos], "g":[glosses], "m":[labels] } ] }`

`app/data/version.json`: `{ "built": "YYYY-MM-DD" (UTC), "jmdict": "<release tag>", "packs": { "words": {"n": count, "bytes": total}, ... } }`.

## 4. Search engine (`app/search/engine.js`)

`search(query, opts) -> { groups: [ { id, title, note, results:[ { pack, id, tier, cost, via } ] } ], didYouMean }`.
`opts = { ranking: "fiction"|"news", limit: 50, recent: [strings], phase: "fast"|"full" }`.
Phase "fast" = tiers 0-2 only (must return in under 30 ms on desktop for the words pack). Phase "full" adds tier 3.
The worker posts the fast result first, then the full result; a newer query cancels older work.

### 4.1 Canonical romaji (`romaji.js`)
- `kanaToRomaji(kana)`: katakana -> hiragana first. Hepburn base: し shi, ち chi, つ tsu, ふ fu, じ/ぢ ji, ず/づ zu,
  を o, しゃ sha, ちゃ cha, じゃ ja, きゃ kya ... ; ん -> `n` (before a vowel or y: `n'`); っ -> doubles the next
  consonant (っち -> `tchi` is NOT used: write `cchi`); long vowels stay as written kana (おう -> `ou`, おお -> `oo`);
  ー -> repeats the previous vowel. Small ぁぃぅぇぉ combos (ふぁ fa, てぃ ti, うぃ wi, ヴ vu ...) supported.
- `romajiToKana(text)`: standard wapuro input rules, accepts Hepburn, Kunrei and common variants
  (si/shi, ti/chi, tu/tsu, hu/fu, zi/ji, sya/sha, tya/cha, zya/jya/ja, nn/n', xtu/ltu, `-` -> ー).
  Returns `{ kana, clean }` where `clean` is false if any Latin letter is left unconverted.
- `canon(query)`: lowercase, NFKC; if query has kana -> `kanaToRomaji`; if Latin -> `romajiToKana` then
  `kanaToRomaji` when clean, else the raw letters after variant rewrite (si->shi, ti->chi, tu->tsu, hu->fu, zi->ji,
  sy->sh, ty->ch, zy->j) with non-letters removed.

### 4.2 Fold key (`fold.js`)
`fold(romaji)`: remove `'` and `-`; `ou`->`o`; `uu`->`u`; then collapse every run of the same letter to one letter.
Examples: shoujo -> shojo, gakkou -> gako, konnichiwa -> konichiwa, ookii -> oki. Each pack builds a
Map fold(key) -> key indexes for space `r` at load time (lazily, in the worker).

### 4.3 Query kinds
- Has kanji -> KANJI query. Only kana -> KANA query. Only Latin letters/spaces/apostrophe/hyphen -> LATIN query.
  Mixed kanji+kana is a KANJI query.
- LATIN runs BOTH a Japanese-reading search (on `canon(query)`, spaces removed) and an English search.
  Group order: English group first when the query (as typed, single token or phrase) has at least one tier-0
  English hit AND the romaji reading search has no tier-0 hit; if both have tier-0 hits, the group whose best
  result has the lower rank (per `opts.ranking`) goes first; otherwise Japanese group first.
  Group titles: "Japanese words", "English meanings", "Names", "Slang and Wiktionary".
- Pack order inside the Japanese side: words results, then wikt results (separate group), then names (separate group,
  max 10 shown before "show more"). Names run tiers 0-2 always; tier 3 for names only when words+wikt returned
  fewer than 5 results in total.

### 4.4 Tiers (Japanese reading search, space `r`)
| Tier | Rule | Shown as |
|---|---|---|
| 0 exact | key === canon(query). For KANA queries, records whose kana form equals the typed kana sort before records that only match after romaji conversion | normal |
| 1 fold | fold(key) === fold(canon(query)), key !== canon | normal, small note "long vowel / double letter" (cost 0.2) |
| 2 prefix | key starts with canon(query), query length >= 2. Binary search on sorted keys. Max 200 candidates taken in rank order | normal |
| 3 near | weighted distance (4.5) <= budget(len) | under a "Did you mean" line |

Tier 3 runs only in phase "full" and only when (tier 0 + tier 1 count == 0) OR (query length >= 5 AND tier 0+1+2 count < 5).
Budget by `len = canon(query).length`: len <= 3 -> no tier 3; 4-5 -> 1.0; 6-8 -> 1.5; >= 9 -> 2.0.
Tier-3 candidate pruning, in this order: key length within len-2..len+2; 26-bit letter mask per key
(precomputed Uint32Array), reject when popcount(maskQ XOR maskK) > 4; then the bounded distance with early exit.
`didYouMean` = the tier-3 key with the best (cost, rank) when tiers 0+1 are empty; UI shows
`No exact match for "<typed>". Nearest: <key> (<reason>)` where reason is one of: "letters swapped",
"neighbouring key", "one letter different", "one letter missing", "one extra letter", "long vowel / double letter".

### 4.5 Weighted distance (`cost.js`) - Damerau-Levenshtein, optimal string alignment, these costs
| Edit | Cost |
|---|---|
| Insert or delete a letter equal to its left or right neighbour (doubled letter) | 0.3 |
| Insert or delete `u` directly after `o` or `u`; `o` after `o`; `'` or `-` anywhere | 0.2 |
| Swap two adjacent letters | 0.5 |
| Substitute, the two keys TOUCH on QWERTY | 0.5 |
| Substitute, exactly one key lies between them on QWERTY (grid distance 2) | 0.8 |
| Any other substitute, any other insert or delete | 1.0 |

QWERTY grid: rows `qwertyuiop`, `asdfghjkl`, `zxcvbnm` with x offsets 0, 0.25, 0.75 and y = row index.
Euclidean distance d between key centres: d < 1.3 -> "touch"; 1.3 <= d < 2.3 -> "one between"; else far.
(k-j touch; k-m touch; k-n one between; k-a far.)
For KANA queries the keyboard table is OFF (every substitute costs 1.0); the other rows still apply.
The first letter of the query: a substitute or delete at position 0 costs +0.3 extra.

### 4.6 Ordering inside a group
Sort key, ascending: (tier, costBucket, rank, keyLength, recordId), where
`rank = ff` if opts.ranking == "fiction" else `fn`; costBucket = round(cost * 2) / 2 for tier 3, 0 otherwise.
Tier 2: common-flag records before others, then rank, then shorter key.
Rulings 2026-11-13 (coordinator, after the first acceptance run; they override the sort key above where they differ):
- Tier 3 sorts by EXACT cost, then rank (no cost bucket). `jihso`: jisho costs 0.5, jishou 0.7, so 辞書 is first.
- Tier 3, LATIN queries: the distance is computed for BOTH `canon(query)` and the raw typed letters (lowercase a-z only);
  the lower cost wins. (`tensia`: canon is `tenshia`, which hid the swap; raw `tensia` -> `tensai` costs 0.5, so 天才 is first.)
- LATIN queries only: tiers 0 and 1 are merged into one block ordered by class, then rank:
  class 1 = tier 0 and common flag; class 2 = tier 1 and common flag; class 3 = tier 0 not common; class 4 = tier 1 not common.
  (`gakko`: 学校 is tier 1 common, がっこ is tier 0 not common, so 学校 is first.) KANA and KANJI queries keep tier 0 strictly before tier 1.
Tie-break before recordId: a record whose kanji/kana form or query is in `opts.recent` goes first.
A record is listed once, at its best tier.

### 4.7 KANJI queries (space `k`)
Tier 0 exact key; tier 2 prefix; then "contains" (substring scan over the keys string, query length >= 2, max 100)
as tier 3 with cost 1 and no "did you mean" line. Then deinflection (4.8). No fuzzy. KANA queries also check
space `k` tier 0 (katakana words) in addition to space `r`.

### 4.8 Deinflection (`deinflect.js`)
For KANA and KANJI queries (and LATIN queries converted cleanly to kana): produce base-form candidates with a
standard rule table, then keep a candidate only if a words-pack record has that form AND a matching POS
(v1, v5*, vk, vs-i/vs-s, adj-i, v5r-i, v5k-s, vz). Rules to cover: masu-stem forms (ます ました ません ませんでした
ましょう), て/で, た/だ, ない なかった なくて ず, ば-conditional, たら, たり, potential, passive, causative,
causative-passive, volitional, imperative, たい たくない たかった, ている/てる/ていた/てた, ちゃう/じゃう/ちゃった,
すぎる, なさい, adjective く くて かった くない くなかった ければ さ そう. Up to 2 chained rules (e.g. 食べさせられた).
Deinflected hits are tier 0 with `via: "<form name>"`, shown with the note `食べた is the past form of 食べる`,
and sorted after true tier-0 hits.

### 4.9 English search (space `e`)
Tokens = query lowercased, split on non-letters, stop words removed (unless that empties the query).
A record matches when one sense contains ALL tokens (use the packed sense index). Per matching sense compute class:
A = some gloss, after removing parenthesised text and a leading "to ", equals the whole query; B = some gloss
starts with the query followed by a non-letter; C = all tokens present. Tier 0 = A or B, tier 2 = C, and the last
token is also matched as a PREFIX (as-you-type) -> tier 2. Order: (tier, class, senseIndex, rank, recordId).
Fuzzy (phase "full"): for each token with zero exact hits and length >= 4, find vocabulary keys within the 4.5
distance (QWERTY table on, budget from 4.4, the `u` and position-0 rules off), take the 3 best by (cost, number of
ids desc), search again with each -> tier 3, and set didYouMean to the corrected query.

## 5. UI (Look A everywhere; reference `design/look-demo.html`)

- One page. Search box on top, focused on load, never needs a click. Results render on every keystroke
  (debounce 60 ms). `#q=<query>` in the URL is kept in sync (replaceState while typing, pushState after 1 s idle).
- Result card: reading small above, headword large (font stack with Japanese fonts, `lang="ja"`), tags
  (`common`, `N5`..`N1`, slang/vulgar/etc. labels in full words), numbered senses with POS line, other forms line,
  first example pair of the first sense shown inline, a "more examples" toggle for the rest.
  Wiktionary cards carry a "Wiktionary" tag and a link to the page; Japanese-definition cards a "Japanese definition" tag.
- Tapping a kanji in a headword opens an inline panel under the card: meanings, on/kun readings, strokes, grade, JLPT.
- Empty search box: shows "Recent" (last 30 queries that stayed 2 s or were followed by a tap; localStorage; a clear button).
- Settings (gear, inline panel): ranking "Fiction and media (jiten.moe)" default / "Newspapers (JMdict)";
  theme auto / light / dark. Stored in localStorage (wrapped in try/catch).
- Footer on every screen, always visible at page bottom: `Data: JMdict, JMnedict, KANJIDIC2 © EDRDG (CC BY-SA 4.0) ·
  Wiktionary · jiten.moe · Tatoeba · About and licences` (links). When a query is present, a line above it:
  `Search Wikipedia for "<query>"` -> `https://ja.wikipedia.org/w/index.php?search=<query>` (new tab).
- First load: a progress line "Loading dictionary: words 42%". Search works as soon as the words pack is in;
  names and wikt load after it in the background. Loading never blocks typing.
- 50 results per group, then a "show more" button (adds 50).
- Match highlight (added 2026-11-13 after the Takoboto review): the part that matched is wrapped in `<mark>`
  (accent colour, no background): the kana reading for reading matches (whole reading for tier 0/1, the typed
  prefix length for tier 2, whole reading for tier 3), the headword for space-`k` matches, and each matched
  English token inside the glosses for English matches. Deinflected hits show the note line from 4.8.
- Phone layout: no top bar. The search box is `position: sticky; top: 0` and is the only fixed element, so results
  get the whole space above the keyboard. The settings gear sits inside the search row.
- Performance over looks: no animation, no web fonts, no images except icons. Light and dark via CSS variables.
- All labels in full English words. No abbreviations in the UI.

## 6. Data loading and updates (`worker.js`, `sw.js`)

- `DATA_BASE` = `./data/` (same origin, also inside the packaged apps).
- Web: `sw.js` caches the app shell and every data file in Cache Storage; later visits and offline use read the
  cache. No re-download on page open.
- Update check (web and packaged apps): on start, if online, fetch
  `https://nostramadeus.github.io/nearest-jisho/data/version.json` (no-cache). If `built` is newer than the data in
  use, download the new pack files into Cache Storage in the background and use them from the NEXT start.
  A failed or partial download changes nothing. The settings panel shows `Dictionary data: <built date>`.
- The worker picks, per start, the newest complete data set among: bundled `./data/`, Cache Storage.

## 7. Tests (`node --test test/`)
- romaji round trips; fold examples from 4.2; every row of the 4.5 cost table; budget boundaries.
- Engine tests on a hand-made fixture pack (about 30 records, built by a test helper through the SAME writer code
  the build uses, or the same file layout).
- Acceptance queries, run by `tools/query.mjs` against the real packs (data lane and app lane both report them):
  `jihso` -> 辞書 first, did-you-mean "jisho", reason "letters swapped" · `shojo` -> 少女 or 処女 in top 3 with 少女 present
  · `gakko` -> 学校 first · `konichiwa` -> こんにちは / 今日は first · `kaki` -> only exact/prefix, NO did-you-mean line
  · `たべた` -> 食べる with past-form note · `食べさせられた` -> 食べる · `dictonary` -> English, corrected to "dictionary", 辞書 in top 3
  · `hate` -> both groups present · `ore` -> 俺 first under fiction ranking · `てめえ` -> 手前 / てめえ entry
  · `kusa` -> 草 with a slang sense (JMdict or Wiktionary) visible · `tanaka` -> 田中 in Names.

## 8. Packaging (later lane; nothing here is built locally)
Built on GitHub Actions only (`.github/workflows/build.yml`); the details are in `packaging/PLAN.md`. The data build
deploys the web app to GitHub Pages; Capacitor wraps it into a signed Android .apk; Tauri 2 wraps it into a Windows
setup .exe (NSIS, WebView2 bootstrapper) and a Linux .AppImage; the three files go into a GitHub Release, on demand
and by a monthly schedule that also commits a `DATA-VERSION` bump so the schedule is not auto-disabled.

## 9. Public-repo rules (every worker)
- Never commit or push; the coordinator does it. Never put a real name, e-mail, home path (`C:\Users\...`),
  city, country or time zone in any file under `app/`, `build/`, `tools/`, `test/`, README, LICENSE, DATA-LICENSE.
  Dates in files are UTC.
- `DATA-LICENSE.md` lists every source with licence, link and required credit (EDRDG wording:
  "This site uses the JMdict/EDICT and KANJIDIC dictionary files. These files are the property of the Electronic
  Dictionary Research and Development Group, and are used in conformance with the Group's licence."), Wiktionary
  (CC BY-SA 4.0, links to pages), jiten.moe (CC BY-SA 4.0), Tatoeba (CC BY 2.0 FR), JLPT lists
  (stephenmk/yomitan-jlpt-vocab, CC BY-SA 4.0; "JLPT data is sourced from Jonathan Waller's JLPT Resources page
  under the terms of the Creative Commons BY license.").

## 10. Clear button and entry page (added 2026-11-13 after the first real use)

### 10.1 Clear button
- The search row has its own `<button type="button" aria-label="Clear search">` with an X icon. It is ALWAYS visible
  (also when the box is empty and when the box is not focused). Hit area 44x44 CSS px, icon 22 px, placed inside the
  right end of the search box. The browser's native clear control is hidden (`input[type=search]` -> use `type="text"`
  with `inputmode="search"`, or hide `::-webkit-search-cancel-button`).
- Click: empties the box, puts the caret in the box (focus), clears `#q`, shows the Recent list. If an entry page is
  open it returns to the (empty) search view. Pressing Escape in the box does the same.

### 10.2 Entry page
- Clicking a result card anywhere except on a link, a button or the "more examples" toggle opens the entry page for
  that record. The card shows `cursor: pointer`; the headword is a real `<a>` so keyboard and middle-click work.
  The inline kanji panel on result cards is REMOVED (kanji details now live on the entry page).
- Address: `#w=<first written form or first kana form>&r=<first kana form>&p=<pack>` (URL-encoded). It is resolved by
  an exact lookup in key space `k` of that pack (space `r` via canonical romaji when the record has no kanji form),
  then the record whose kana forms include `r`; if several match, the lowest record id. No record ids in addresses
  (ids change on every data build). Opening an entry uses `history.pushState`; the browser Back button (and the
  Android back gesture, and Alt+Left) returns to the result list with the same query and the same scroll position.
  A direct visit to an entry address works after the pack has loaded (show the loading line until then).
- The search box stays on top of the entry page. Typing in it leaves the entry page and shows results as usual.
- Entry page content, top to bottom, all visible without further clicks:
  1. Reading (kana) and under it the romaji from `kanaToRomaji`; headword very large; tags (common, JLPT, labels).
  2. "Other forms": every other kanji and kana form.
  3. "Meanings": every sense, numbered, with part of speech, field / dialect / misc labels in full words, the sense
     note, and EVERY stored example pair of that sense under it (Japanese line, English line).
  4. "Kanji in this word": one block per distinct kanji of the headword, in order: the character large, meanings,
     On readings, Kun readings, Name readings, strokes, school grade, JLPT level (omit a line that has no data).
  5. "Words that start with <headword>": up to 20 records from the words pack whose written form starts with the
     headword (tier-2 prefix rule on space `k`, the record itself excluded), ordered by the usual rank; each is a
     link to its own entry page and shows reading + first gloss. Omitted when there are none. For names and for
     records without a kanji form this section is omitted.
  6. Links: `Search Wikipedia for "<headword>"`; for Wiktionary records the page link; for words records
     `Look up on Jisho.org` -> `https://jisho.org/search/<headword>`. All open in a new tab / the system browser.
  7. The footer credits as on every screen.
- Names records: sections 1, 2, a "Name type" line with the type labels in full words, the translations, 4, 6.
- Wiktionary records: sections 1, 3 (glosses and labels), 4, 6, with the "Wiktionary" or "Japanese definition" tag.
- Worker API: add messages `entry { pack, w, r }` -> the full record + its kanji blocks + the section-5 list, and keep
  search untouched. No ranking rule changes.

## 11. Favorites (added 2026-11-13)

- A star button (`<button aria-pressed>`, hit area 44x44 CSS px, outline star = off, filled star = on) sits at the
  top right of every result card and next to the headword on the entry page. One click toggles. It never opens the
  entry page.
- Storage: localStorage key `nj.favorites`, a JSON array of `{ w, r, p, g, t }`: the entry-address fields `w`, `r`,
  `p` from section 10.2, `g` = the first gloss (or first translation) at the time of starring, `t` = epoch
  milliseconds. Identity = (`w`, `r`, `p`). All access wrapped in try/catch; when storage is unavailable the star
  buttons are hidden.
- A star button in the search row, left of the settings gear (same size as the gear, label "Favorites"), opens the
  Favorites view at `#fav` (pushState; Back returns). The view lists favorites newest first as compact rows:
  headword (link to the entry page), reading, the stored gloss, and a filled star that removes the row (the row stays
  visible, greyed, with the star outlined, until the view is left, so a wrong click can be undone by clicking again).
  Header line: `Favorites (N)` and one button `Copy list`, which writes tab-separated lines `word<TAB>reading<TAB>gloss`
  to the clipboard (`navigator.clipboard.writeText`, fallback: a selected `<textarea>`), then shows "Copied N lines".
- Empty state text: `No favorites yet. Click the star on a word to keep it here.`
- The search box stays on top; typing leaves the Favorites view. Favorites never change ranking.
- The settings panel gets one line: `Favorites and recent searches are stored on this device only.`

## 12. App code updates inside the installed apps (added 2026-11-13)

Problem: the installed apps (Android, Windows, Linux) bundle the app files, so a code fix needed a reinstall.
Data already updates by itself (section 6). This section does the same for the app files. All logic lives in
`sw.js`, so even a broken page version can be replaced by the next one.

- CI (`data` job, after stamping): write `app/shell.json` = `{ "built": <epoch seconds of the build, UTC>,
  "version": "<the stamped SHELL_VERSION>", "files": [ every path in the service worker's SHELL list ] }` and stamp a
  second constant in `sw.js`, `SHELL_BUILT = <the same epoch seconds>`. In the repo both constants keep placeholder
  values (`SHELL_BUILT = 0`); the stamping step fails if either line is missing. `shell.json` is deployed with Pages
  and is NOT in the SHELL list.
- Applies only when `self.location.hostname` is `localhost` or `127.0.0.1` (the installed apps). On any other host
  (the website) this section is inactive and the normal service-worker update flow is used.
- Check: on the service worker's `activate` and on every navigation request, at most once per 6 hours (timestamp kept
  in a small Cache Storage entry), fetch `https://nostramadeus.github.io/nearest-jisho/shell.json` with `no-store`.
  If `built` is greater than both `SHELL_BUILT` and the `built` of the newest complete remote shell already stored:
  download every listed file from `https://nostramadeus.github.io/nearest-jisho/<path>` (`no-store`) into a new cache
  `nj-remote-shell-<built>`; only when ALL files answered 200, write a marker entry `__complete__` into it and delete
  older `nj-remote-shell-*` caches. Any failure deletes the partial cache and changes nothing. The check never
  delays a response (`event.waitUntil`, not awaited by the fetch handler).
- Serving: for a shell request, if a complete `nj-remote-shell-<built>` exists with `built` > `SHELL_BUILT`, answer
  from it (match by path relative to the scope); if that file is missing there, fall back to the bundled shell cache,
  then the network. Data requests are untouched. A new shell is therefore used from the NEXT start of the app.
- `sw.js` answers a `postMessage({ type: "shell-info" })` with `{ bundled: SHELL_VERSION, bundledBuilt: SHELL_BUILT,
  active: <version string in use>, remoteBuilt: <built or 0> }`. The settings panel shows two lines:
  `App version: <active> (built in | updated online)` and `Offline cache: active` or `Offline cache: not available`
  (when `navigator.serviceWorker` is missing or has no controller after load).
- `sw.js` must call `self.skipWaiting()` on install and `clients.claim()` on activate (keep if already there).
- Limit, stated in README: changes to the native wrapper itself (Capacitor / Tauri versions, permissions, icons)
  still need a reinstall. Everything in `app/` updates by itself.

## 13. Sentence pack from Tatoeba (added 2026-11-13)

Goal: the entry page shows up to 25 real sentences that use the word, like the phrases tab of other dictionary apps.

### 13.1 Sources (Tatoeba exports, text is CC BY 2.0 FR, part CC0)
- `https://downloads.tatoeba.org/exports/per_language/jpn/jpn_sentences.tsv.bz2` (id, lang, text)
- `https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2` (id, lang, text)
- `https://downloads.tatoeba.org/exports/jpn_indices.tar.bz2` (sentence id, meaning id = the paired English
  sentence id, index text). Index text = space-separated tokens `headword(reading)[sense]{form}~`; every part after
  the headword is optional; `{form}` is the word as it appears in the sentence; `~` marks a checked good example.
- bzip2 is not in the node standard library: the build spawns the system `bzip2 -dc` (and `tar` for the .tar.bz2)
  as ONE child process at a time and streams its stdout. If the tools are missing or a URL fails, the build skips
  this pack with a clear warning locally, and FAILS on CI (`process.env.CI`).

### 13.2 Selection
- A sentence is usable when its Japanese text and its English text (by meaning id) both exist.
- Index keys: for every token of a usable sentence, key `headword` when the token has no reading, and key
  `headword<TAB>reading` when it has one (reading in hiragana).
- Per key keep at most 25 sentences, ordered by: tokens marked `~` first; then Japanese text length ascending, but
  sentences shorter than 6 characters go last; then sentence id. Sentences kept by no key are dropped from the pack.

### 13.3 Pack `sent` (files in `app/data/`, listed in `version.json` like the other packs)
- `sent.dat` + `sent.off`: records are compact JSON arrays `["Japanese text","English text",tatoebaId]`.
- `sent.keys.json`: `{ "h": { "keys": "<sorted unique keys joined by \n>", "ptr": [...], "ids": [...], "forms": [...] },
  "formList": [strings] }`. `ids` are record ids in the 13.2 order; `forms` is parallel to `ids` and indexes
  `formList` (the `{form}` of that token, or the headword when the token has none). No `.meta` file.
- `build/verify-data.mjs` checks the pack (offsets, sorted keys, id ranges, 5 samples decode, and that the key `辞書`
  or `辞書<TAB>じしょ` has at least one sentence).

### 13.4 App
- Load order becomes: words, kanji, wikt, sent, names. A missing or failed `sent` pack never blocks anything.
- Lookup for a words or wikt record: the union, in this order, of keys `k<TAB>r` and `k` for every kanji form `k` and
  kana form `r` of the record; for a record with no kanji form, or with a sense marked `uk`, also the keys `r` for
  every kana form. Duplicates removed, order kept, max 25. Sentences whose Japanese text equals an example already
  shown under a meaning are left out. Names records get no sentences.
- Entry page: new section between "Meanings" and "Kanji in this word", title `Sentences with this word (N)`:
  each item = the Japanese line with the stored form wrapped in `<mark>` (first occurrence; no mark when not found),
  the English line, and a small link `Tatoeba #<id>` -> `https://tatoeba.org/sentences/show/<id>` (new tab / system
  browser). All shown without a click. While the pack is still loading the section says `Loading sentences…` and
  fills in when the pack arrives; when the word has none the section is omitted.
- The update check (section 6) treats `sent` like every other pack.
- `DATA-LICENSE.md` and `app/about.html`: Tatoeba entry updated: "Example sentences from the Tatoeba project
  (https://tatoeba.org), CC BY 2.0 FR; each sentence links to its Tatoeba page, which names its authors."
