# Typo study: which mistakes the search should forgive, and at what price

Date 2026-11-13 (UTC). Model: claude-fable-5-2. Plan only: no code and no SPEC file was edited.
Read: SPEC.md 4.1 to 4.9 with rulings, `app/search/cost.js`, `fold.js`, `romaji.js`, `engine.js` (tiers, tier 3, ordering).
Real searches: 45, in 4 runs of `node F:\Projects\nearest-jisho\tools\query.mjs` (one process at a time, fiction ranking).

All costs below are in TENTHS, like `cost.js` (5 = 0.5). "ff" is the fiction rank, "fn" the news rank (lower = more common).

---

## 0. The finding in one page

`naiso` did not fail because one cost was wrong. It failed because of three structure rules. No cost change can fix it alone.

| # | Rule today | What it did to `naiso` |
|---|---|---|
| 1 | Tier 3 (near matches) runs only when tiers 0+1 are empty, or len >= 5 and tiers 0+1+2 have < 5 hits (SPEC 4.4) | 5 rare `naisou` words matched at tier 1, so the near search never ran. 内緒 was not in the list at all (checked: top 12 has no 内緒). |
| 2 | Order is tier first, then rank. A rare word with a cheap mistake always beats a common word with a slightly dearer mistake | 内層 (ff 182068), 内争, 内奏, 内挿 all sit above anything from tier 3 |
| 3 | A missing `h` in `sh` costs 10, the same as any random missing letter | `naisho` would cost 10, level with every other 1-letter neighbour |

The same three rules explain other searches I ran: `kaisa` (会社 absent, two rare exact words block it), `densa` (電車 absent, rare prefix words fill the list), `jitsuwa` (実は under 実話), `arigto` (雷魚 above 有難う), `taksan` (沢山 is 6th).

The principle that replaces case-by-case fixes: **the best guess is the word where (price of the mistake) + (rarity of the word) is lowest.** Both parts go into ONE number. Today they are compared one after the other, so rarity only breaks ties.

Second principle: **a mistake is cheap to forgive when the typed text cannot be a real word, and dangerous when it can.** `taksan` has `ks`, which no Japanese word has, so nothing competes. `kaki` is a word, so `kagi` and `kani` must stay out. The gate in section 2.1 uses exactly this.

Third principle, for attribution: **every row that is not an exact match shows a short reason label** (the mistake kind). No silent reordering.

---

## 1. The shared machinery (three rules every kind below uses)

### 1.1 Score S (replaces "cost first, then rank")

`S = cost + P(rank)`, integers in tenths. `rank` = ff or fn per `opts.ranking`.

P is a lookup table (no floating log, so every device gives the same order). P = 6 per factor 10 of rank, starting at rank 1000:

| rank <= | 1211 | 1778 | 2610 | 3831 | 5623 | 8254 | 12115 | 17783 | 26102 | 38312 | 56234 | 82540 | 121153 | 177828 | 261016 | 383119 | 562341 | 825404 | above |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 |

Cost per hit type:

| Hit | cost |
|---|---|
| Tier 0 exact | 0 |
| Deinflected hit (SPEC 4.8) | 1 |
| Tier 1 fold (long vowel / double letter) | 2 (as today) |
| Spelling-variant hit (section 2.3, 2.4) | its own cost; +2 more when it also needed the fold |
| Tier 3 near hit | the edit cost from `cost.js` (lower of canon form and raw form, as today) |

Tie-break after S: lower cost, then lower rank, then shorter key, then `opts.recent`, then pack, then id.

Why slope 6: with real ranks from the data, `naiso` gives 内緒 S = 4 + P(2844) = 7 and 内装 S = 2 + P(9974) = 8, while `shiko` keeps 思考 (2 + P(2462) = 4) above a 1-key neighbour of a top-1000 word (5 + 0 = 5). A slope under 4 loses the first, a slope over 7 loses the second.

### 1.2 Gate: when near matches are searched at all (replaces the first half of the SPEC 4.4 condition)

Tier 3 and the kana variants (2.9) run in phase "full" when:
- there is NO tier-0 hit with the common flag in words + wikt (deinflected hits do not count), OR
- the old second condition holds (len >= 5 AND tiers 0+1+2 have < 5 hits).

Budgets by length stay as they are (len <= 3: none; 4-5: 10; 6-8: 15; >= 9: 20). Names keep their own rule.

Meaning in plain words: if what was typed is itself a common word, trust it. If it is not a word, or only a rare word, look for what was meant.

### 1.3 Promotion: cheap slips of common words may enter the top block

A tier-3 hit is PROMOTED when all hold:
- its cost <= 5,
- `cost + P(min(ff, fn)) <= 9` (so a cost-5 slip needs a rank <= 5623 on either list, a cost-4 slip <= 8254),
- it is among the 3 best such hits (by S, then cost, then rank).

Promoted hits keep `tier: 3` and their reason label, but sort inside the top block.

### 1.4 Order of a Japanese group (replaces the class ruling in SPEC 4.6; the three ruling examples still pass)

LATIN queries:
1. Tier-0 hits with the common flag, by rank (unchanged).
2. Everything else in the top block (tier-0 not common, deinflected, tier 1, spelling variants, promoted slips) by S.
3. Tier 2 prefix (unchanged order).
4. Remaining tier 3 by S (not by exact cost first). `didYouMean` = best S.

KANA queries: tier 0 strictly first as today; then tier 1 + variants + promoted by S; then 3 and 4 as above.

Check of the three rulings with real ranks: `gakko` 学校 S 2, がっこ S 9, 画工 S 14 (same order as today). `jihso` 辞書 S 11, 地所 S 16 (same). `tensia` keeps the raw-letters rule, untouched.

Cost of the gate change: the near scan now also runs when only rare exact or fold hits exist. The scan took 15 to 60 ms per query in my runs on desktop node, in phase "full" only. The fast phase is not touched.

---

## 2. Mistake kinds

Frequency judgements (high / medium / low) rest on: how typing errors split in general (one-edit errors are the large majority; neighbour-key hits, dropped letters, extra letters and swaps are the four big groups; on touch screens neighbour hits dominate), on how romaji is built, and on the owner's four reported misses. They are NOT measured on real searches of this app. Open question 8 offers a way to measure.

### 2.1 Dropped or added letter inside a two-letter sound: `sh`, `ch`, `ts`, `ky`-type (THE TRIGGER)

- Who and why: (a) finger skips the second letter; (b) the typist thinks in rows ("s + vowel"), common for anyone who also types `si`/`syo`; (c) a learner is unsure whether the sound is そ or しょ, ろ or りょ. Three sources add up, so this is more frequent than a random dropped letter.
- Examples: `naiso` -> naisho 内緒; `kaisa` -> kaisha 会社; `densa` -> densha 電車; also `tosokan` -> toshokan, `rokou` -> ryokou, `sukue` -> tsukue.
- Frequency: high. Basis: the trigger case; `sh ch ts ky gy ny hy by py my ry` occur in a large share of words; three independent sources.
- Risk: medium. Many pairs are both real (isso / issho, kaku / kyaku, suki / tsuki). The gate (1.2) removes the risk when the typed word is a common word.
- Rule (edit cost, `cost.js`, new constant `DIGRAPH: 4`). In `indelCost`, for the string it is called on (query or key, both sides), return 4 when the letter at `idx` is:
  - `h` and the letter before it is `s` or `c`;
  - `y` and the letter before it is one of `k g n h b p m r` and the letter after it is `a`, `u` or `o`;
  - `t` and the letter after it is `s` and the letter before it is not `t`.
  Checked before the doubled-letter test. The position-0 extra still applies.
  Second constant `YOON_I: 5`: letter is `i`, letter before is one of `k g n h b p m r`, letter after is `y` (`biyoin` / `byoin`, `kiyou` / `kyou`).
- Label: "h or y missing" / "h or y extra" (YOON_I: "small ゃゅょ").
- Interaction: cost 4 makes the hit promotable (1.3). Without 1.2 to 1.4 this rule changes nothing for `naiso`.
- Helps (run): `naiso` (内緒 absent -> 1st), `kaisa` (会社 absent -> 1st), `densa` (電車 absent -> top 2 with 電話), `tosokan` (1st at cost 10 -> 1st at cost 4).
- Looked for harm (run): `isso`: いっそ is exact and common, gate closed, 一緒 is not offered. Correct by design. `soji`: 掃除 stays 1st (S 3); `shoji` words can now appear below it. `shiko`: see 2.14.

### 2.2 Long vowel dropped or added: `ou`, `uu`, `oo` (exists)

- Who: everyone who learned names like Tokyo, judo. Habit, not slip. Examples: `gakko` -> gakkou; `byoin` -> byouin; `shiko` -> shikou.
- Frequency: high (owner's `gakko`; standard English spelling drops these).
- Risk: medium, already accepted (koko / koukou).
- Rule: keep fold and cost 2. Only change: order by S (1.4).
- Run: `gakko`, `byoin`, `shiko`, `soji` all put the common long-vowel word first today and after.

### 2.3 `ei` / `ee` / `e`

- Who: anyone typing by ear. せんせい is said "sensee". Katakana ー after e is `ee` in the keys (ケーキ = keeki), but ear and habit give `ei` or `e`.
- Examples: `sensee` -> sensei 先生; `eega` -> eiga 映画; `sense` -> sensei; `keiki` <-> keeki ケーキ.
- Frequency: medium to high for by-ear typists.
- Risk: medium: seki / seiki, meshi / meishi are both real. Same class of risk as 2.2.
- Rule (spelling-variant lookup, phase "fast", no new index). On `c = canon(query)`, make variants, ONE change each, left to right, at most 6 variants:
  - each `ee` -> `ei`;
  - each `ei` -> `ee`;
  - each `e` that is not next to another `e` and not followed by `i` -> `ei`.
  For each variant `v`: `ks.find(v)` and `ks.foldLookup(fold(v))`. New hits get tier 1, cost 3 (5 when reached through the fold), label "ei / ee".
- Helps (run): `sensee` (先生 is 4th, under three センセー... prefix words -> 1st, S 3); `eega` (映画 absent from top 7 -> 1st).
- Looked for harm (run): `seki`: the six common exact せき words stay on top (group 1 of 1.4); 世紀 joins below them at cost 3. Acceptable.

### 2.4 Particle は typed as `wa`

- Who: everyone. Hepburn writes the particle as `wa`; the key is built from kana, so 実は is `jitsuha`.
- Examples: `jitsuwa` -> 実は; `matawa` -> 又は; `dewa` -> では.
- Frequency: high for the 30 or so very common words that end in the particle.
- Risk: low with the part-of-speech filter below.
- Rule (spelling-variant lookup, phase "fast"): for each `wa` in `c` not preceded by `k` or `g`, rightmost first, at most 3: variant with `ha`. Look up exact and fold. Keep a record only if one of its senses has POS `exp`, `conj`, `adv`, `prt` or `int`. Tier 1, cost 2, label "は typed as wa".
- NOT forgiven: へ typed as `e`. Few entries, and `e` / `he` swaps hit many real words.
- Helps (run): `jitsuwa` (実は is 2nd under 実話 -> 1st: S 2 vs 9, as long as 実話 has no common flag; with the flag it is 2nd); `matawa` (又は is 4th -> 1st, S 7).
- No change (run): `konnichiwa` already works because the dictionary lists こんにちわ.

### 2.5 Old-style Hepburn spellings: `m` before b/p, `oh`

- Who: people copying from books, signs, passports. Examples: `shimbun` -> shinbun; `sempai` -> senpai; `ohsaka` -> oosaka; `ohkii` -> ookii.
- Frequency: medium. Risk: almost none: `mb`, `mp` and `h` + consonant never occur in the keys.
- Rule (canonical form, in `prepLatin`, and the same on the raw form used by tier 3):
  - `m` directly before `b` or `p` -> `n`;
  - only when the query has >= 4 letters: `oh` -> `ou` and `uh` -> `uu` when the next character is not `a i u e o y` (end of text counts).
- Result is an ordinary tier 0 / tier 1 hit. No label needed for `m`; for `oh` the existing fold label.
- Helps (run): `shimbun`, `sempai` (found today, but as a near match under a "No exact match" line -> plain exact hit); `ohsaka` (大阪 is 3rd, お釈迦 1st -> 1st); `ohkii` (大きい absent from top 5 -> 1st).
- Harm looked for: `sempai` today also lists 洗牌 and 狭い as near hits; after the rewrite they disappear. No harm found.

### 2.6 `l` typed for `r`

- Who: English-ear learners, and speakers of languages where r and l merge or differ from Japanese. Examples: `kalaoke` -> karaoke; `aligatou` -> arigatou; `lamen` -> raamen.
- Frequency: low to medium. Risk: low for Japanese (no key contains `l`).
- What is wrong today: `la li lu le lo` are read as small kana (ぁぃぅぇぉ), so `kalaoke` becomes `kaaoke` and the nearest word is 苔 (koke).
- Rule (canonical form, `romaji.js`): `l` + vowel = the r-row, `ly` = `ry`. Keep `ltu` and `ltsu` for っ. Small kana stay on the `x` prefix only. Hits carry the label "l read as r".
- Helps (run): `kalaoke` (カラオケ is 7th -> 1st); `aligatou` (1st today as near match, cost 10 -> exact).
- Harm: someone who types `la` to get ぁ loses that. An English word starting with `l` can now also hit a Japanese reading (`lemon` -> レモン, which is welcome; `lie` -> names read りえ). The English-first group rule of SPEC 4.3 still decides the order.

### 2.7 Whispered vowel dropped (`u` and `i` between voiceless sounds)

- Who: by-ear learners. です sounds like "des", たくさん like "taksan".
- Examples: `taksan` -> takusan; `yoroshku` -> yoroshiku; `ski` -> suki; `gozaimas` -> gozaimasu.
- Frequency: medium. Risk: low: the typed text has a consonant pair that no Japanese word has, so nothing real competes.
- Rule (edit cost, new constant `DEVOICED: 5`, KEY side only: the key has the letter, the query lacks it). In the key:
  - `u` whose previous letter is `s`, `k`, `f` or `p`, and whose next letter is one of `k s t h p c f` or the end of the key;
  - `i` whose previous letter is `h` or `k`, and whose next letter is one of `k s t h p c f`.
- Label: "silent u / i missing".
- Helps (run): `taksan` (沢山 is 6th under 退散, 耐酸, 単産, 炭酸, 単3 -> 1st, S 5, promoted); `yoroshku` (宜しく is 2nd under 宜しゅう -> 1st).
- No change (run): `gozaimas` already works through the prefix tier.
- Harm looked for: in `taksan`, 退散 (taisan, neighbour key) also costs 5; S puts it 2nd (10). Fine.

### 2.8 Finger slips on QWERTY: swap, neighbour key, dropped letter, extra letter (mostly exists)

- Who: everyone; phone QWERTY more than PC. Examples: `jihso` -> jisho; `kawiai` -> kawaii; `nrko` -> neko; `arigto` -> arigato; `nekjo` -> neko.
- Frequency: high. Risk: high for short words, which is why length budgets and the gate exist.
- Rules:
  - Swap 5, neighbour key 5, any other 10, first-letter extra 3: KEEP.
  - New `FATFINGER: 6`, QUERY side only: the query has a letter the key lacks, and that letter touches (QWERTY "touch") the query letter before it or after it and is not equal to it. Two keys hit with one finger.
  - Order by S (1.4) instead of exact cost first.
- Run: `jihso`, `kawiai`, `nrko`, `watasjhi` are 1st today and stay 1st. `arigto`: today ありがと, 雷魚, 有難う -> ありがと (S 10), 有難う (S 12), 雷魚 far below (S 23). `nekjo`: today 根っこ 1st, 猫 2nd -> 猫 1st (6 + 1 = 7 vs 5 + 6 = 11).
- Harm looked for (run): `kakik` (typing towards kakikomi): 活気 is one swap away. 5 + P(min(8542, 6000)) = 10 > 9, so it is NOT promoted and the prefix list stays clean. This search is why the promotion limit is 9 and not 10.

### 2.9 Kana typed on the 12-key flick keyboard: forgotten ゛゜小 key, wrong flick direction

- Who: phone users. The mark key (dakuten, handakuten, small) is a separate tap, so it is the easiest thing to miss. A flick that is too short gives the centre kana (the あ-column one); a crooked flick gives a neighbour direction.
- Examples: `ないしよ` -> ないしょ; `がつこう` -> がっこう; `たへもの` -> たべもの (mark key). `たくえ` -> つくえ; `さごと` -> しごと (flick direction).
- Frequency: high for the mark key, medium for direction. Basis: mechanics of the keyboard; not measured.
- What is wrong today: kana queries are compared as Hepburn letters. One kana slip costs between 10 and 20+ depending on spelling luck (さ -> し is `sa` -> `shi`, two edits; ょ -> よ is two edits). SPEC 4.5 turns the QWERTY table off for kana and puts nothing in its place.
- Rule (new, "one-kana variants", phase "full", under the gate 1.2). For KANA queries of 2 to 12 kana, build variants by changing exactly ONE kana:
  - V1 mark key, cost 4, query >= 2 kana: か<->が and all other plain/dakuten pairs; は<->ば, は<->ぱ, ば<->ぱ (same for ひふへほ); つ<->っ, や<->ゃ, ゆ<->ゅ, よ<->ょ.
  - V2 flick direction, cost 7, query >= 3 kana: replace the kana by each other kana on the same key, keeping its mark. Keys: あいうえお / かきくけこ / さしすせそ / たちつてと / なにぬねの / はひふへほ / まみむめも / やゆよ / らりるれろ / わをんー.
  - Each variant -> `kanaToRomaji` -> `ks.find` and `ks.foldLookup` (+2 through the fold). Hits are tier 3 with that cost; V1 hits can be promoted (1.3). The normal edit distance still runs; the lower cost wins.
  - Also for LATIN queries that convert cleanly to kana and have canon length >= 5: V1 dakuten pairs only, never on the first kana, cost 6, label "voiced / unvoiced". This covers not knowing whether a compound voices (ときとき / ときどき, ひらかな / ひらがな).
- Labels: "゛゜ or small kana", "flick direction".
- NOT forgiven: a hit on the neighbouring 12-key button (か for さ). The buttons are large, the slip is rarer, and it would double the variants. It keeps the plain cost.
- Helps (run): `ないしよ` (内緒 absent; nearest today is 内視鏡 -> 1st, S 7); `がつこう` (学校 absent -> 1st); `たへもの` (食べ物 2nd under 建物 -> 1st, 6 vs 12); `さごと` (仕事 absent, nearest today サポート -> 1st); `たくえ` (机 absent -> first row of the near section, after the 3 卓越 prefix rows; cost 7 is not promotable).
- Harm: かき vs かぎ: both exact and common, gate closed. V2 on a 3-kana query can list several real words; they stay in the near section under S.

### 2.10 Voicing by ear on QWERTY (k/g, t/d, s/z, h/b/p)

- Who: learners unsure whether a compound voices; speakers whose first language lacks the contrast.
- Examples: `tokitoki` -> tokidoki; `makisushi` -> makizushi; `hirakana` -> hiragana.
- Frequency: medium. Risk: high at the start of short words (kin / gin, tai / dai).
- Rule: no letter-level rule. Use the Latin part of 2.9 (cost 6, not first kana, canon length >= 5).
- Run: `tokitoki` and `makisushi` are already 1st today, by luck of the keyboard (t-d cost 8, s-z cost 5). k/g and h/p have no such luck; `hirakana` was not run.

### 2.11 English spelling (SPEC 4.9)

- Who: everyone. Examples: `seperate`, `recieve`, `dictonary`.
- Frequency: medium. Risk: low (long words, sparse neighbours).
- Rule: keep. Run: `seperate` and `recieve` both give the right correction first.

### 2.12 English plural and -ing / -ed forms

- Who: everyone typing English as it comes to mind. Examples: `apples` -> 林檎; `cats` -> 猫; `walked` -> 歩く.
- Frequency: medium. Risk: low.
- What happens today (run): `apples` returns 3 rows, none is りんご. `cats` puts キャッツ, 犬猿, 犬と猿 first; 猫 is not in the top 3.
- Rule (English search, phase "fast"): for each token of length >= 4 not ending in `ss`, `us`, `is`: make stems `ies` -> `y`; else `es` -> `` and `s` -> ``; `ing` -> `` and `ing` -> `e`; `ed` -> `` and `ed` -> `e`. Keep a stem only if it is a key in space `e`. Search again with the stem in place of the token. Stem hits get class + 1 (A -> B, B -> C, C stays C) and the label "plural / -ing / -ed". Then the normal order (tier, class, senseIndex, rank).
- Expected: `cats`: 猫 (ff 1536) leads class B ahead of キャッツ (ff 64849). `running` (run, control): its own exact hits (運転, 経営) stay first.

### 2.13 Kinds that should NOT get a discount

| Kind | Why not |
|---|---|
| Any other consonant for another (kaki / kani / kagi) | No mechanism makes it likelier than chance, and nearly every result is a real word. Stays 10. |
| Vowel for vowel beyond what QWERTY gives (u-i, i-o already cost 5) | Every vowel change makes another real word. No extra discount. |
| Two independent slips in a word of 5 letters or fewer | Budget stays 10. Two slips reach half the dictionary. |
| Any near search for 3 letters or fewer | Stays off. |
| Wrong kanji with the same reading, look-alike kanji | Needs reading inference for kanji queries; a separate feature (open question 6). |
| Typo inside an unfinished word (`tabemn` on the way to tabemono) | Fuzzy prefix floods while typing. Not in this round (open question 5). |
| Romanisation habits from other languages (pinyin `x`, `q`, `zh`) | Only if the owner says he does this (open question 9). |

### 2.14 The price of the new order (stated, not hidden)

- `shiko` (run): no exact common word, so the gate opens. 思考 stays 1st (S 4). Up to 3 common neighbour-key words may follow it (式 would score 5 if its rank is under 1212; rank not looked up). Today the list is fold hits only.
- `kaisa` (run): the rare exact words 階差 (ff 146345) and 海佐 drop below 会社. A typist who really wants 階差 finds it 2nd or 3rd instead of 1st.
- `jitsuwa`: 実話 drops to 2nd under 実は.
- While typing, a promoted row can appear on top for one keystroke when a top-5000 word is one cheap slip from the unfinished text. `kakik` shows the limit holding for 活気.

---

## 3. Test searches

"Today" = real output of `query.mjs` in this session, fiction ranking, unless marked "not run". Position = place in the "Japanese words" group (English group for the last rows). "After" = expected under sections 1 and 2; where a rank was not looked up it says so.

| # | Typed | Intended first | Kind | Today | After |
|---|---|---|---|---|---|
| 1 | naiso | 内緒 | 2.1 | absent from top 12; 内装, 内層, 内争, 内奏, 内挿 first | 1st (S 7), 内装 2nd (S 8) |
| 2 | naisho | 内緒 | control | 1st, tier 0 | same |
| 3 | kaisa | 会社 | 2.1 | absent from top 7; 階差, 海佐 first | 1st (rank of 会社 not looked up) |
| 4 | densa | 電車 | 2.1 | absent from top 7; line says "Nearest: denwa" | top 2 with 電話 (ranks not looked up) |
| 5 | tosokan | 図書館 | 2.1 | 1st, cost 10 | 1st, cost 4 |
| 6 | isso | いっそ | harm probe 2.1 | 1st, tier 0 | same; 一緒 not offered (gate) |
| 7 | soji | 掃除 | harm probe 2.1 | 1st, tier 1 | 1st (S 3) |
| 8 | sensee | 先生 | 2.3 | 4th, under 3 prefix words | 1st |
| 9 | eega | 映画 | 2.3 | absent from top 7; Η (eta) is the first near hit | 1st |
| 10 | seki | 席 | harm probe 2.3 | 1st | 1st; 世紀 below the common exact rows |
| 11 | jitsuwa | 実は | 2.4 | 2nd under 実話 | 1st (if 実話 has no common flag) |
| 12 | matawa | 又は | 2.4 | 4th | 1st |
| 13 | konnichiwa | 今日は | 2.4 control | 1st, tier 0 | same |
| 14 | shimbun | 新聞 | 2.5 | 1st as near match with "No exact match" line | 1st as exact, no line |
| 15 | sempai | 先輩 | 2.5 | 1st as near match | 1st as exact |
| 16 | ohsaka | 大阪 | 2.5 | 3rd; お釈迦 1st | 1st |
| 17 | ohkii | 大きい | 2.5 | absent from top 5; 大っきい 1st | 1st |
| 18 | kalaoke | カラオケ | 2.6 | 7th; 鱗, 苔 first | 1st |
| 19 | aligatou | 有難う | 2.6 | 1st, near match cost 10 | 1st, exact |
| 20 | taksan | 沢山 | 2.7 | 6th | 1st |
| 21 | yoroshku | 宜しく | 2.7 | 2nd under 宜しゅう | 1st |
| 22 | gozaimas | 御座います | 2.7 control | 1st (prefix) | same |
| 23 | jihso | 辞書 | 2.8 | 1st | 1st (S 11) |
| 24 | kawiai | 可愛い | 2.8 | 1st | 1st |
| 25 | nrko | 猫 | 2.8 | 1st | 1st |
| 26 | arigto | ありがとう | 2.8 | ありがと 1st, 雷魚 2nd, 有難う 3rd | ありがと 1st, 有難う 2nd |
| 27 | nekjo | 猫 | 2.8 | 2nd under 根っこ | 1st |
| 28 | watasjhi | 私 | 2.8 | 1st | 1st |
| 29 | kakik | 書き込む (still typing) | harm probe 1.3 | 書き込む 1st | same; 活気 not promoted (10 > 9) |
| 30 | kakki | 活気 | control | 1st, tier 0 | same, gate closed |
| 31 | shiko | 思考 | harm probe 1.3 | 1st, 7 fold rows | 1st; up to 3 neighbour-key rows may follow |
| 32 | gakko | 学校 | 2.2 | 1st, がっこ 2nd | same |
| 33 | byoin | 病院 | 2.2 | 1st | 1st |
| 34 | tokitoki | 時々 | 2.10 | 1st, cost 8 | 1st |
| 35 | makisushi | 巻き寿司 | 2.10 | 1st, cost 5 | 1st |
| 36 | ないしよ | 内緒 | 2.9 V1 | absent; 内視鏡 1st | 1st |
| 37 | がつこう | 学校 | 2.9 V1 | absent; がっつく 1st | 1st |
| 38 | たへもの | 食べ物 | 2.9 V1 | 2nd under 建物 | 1st |
| 39 | たくえ | 机 | 2.9 V2 | absent from top 6 | first near row, after 3 prefix rows |
| 40 | さごと | 仕事 | 2.9 V2 | absent; サポート 1st | 1st |
| 41 | seperate | separate (離す ...) | 2.11 | corrected, 離す 1st | same |
| 42 | recieve | receive (受ける ...) | 2.11 | corrected, 受ける 1st | same |
| 43 | apples | 林檎 | 2.12 | 3 rows, no りんご | りんご listed (class B) |
| 44 | cats | 猫 | 2.12 | キャッツ, 犬猿, 犬と猿; no 猫 in top 3 | 猫 1st |
| 45 | running | 運転 etc. | 2.12 control | exact hits first | same |
| 46 | tensia | 天才 | 2.8 | not run here (coordinator verified 1st) | 1st |
| 47 | sense | 先生 | 2.3 | not run | 1st |
| 48 | keiki | 景気, then ケーキ | 2.3 | not run | 景気 exact first, ケーキ in the block |
| 49 | dewa | では | 2.4 | not run | 1st |
| 50 | rokou | 旅行 | 2.1 | not run | 1st |
| 51 | hirakana | 平仮名 | 2.10 | not run | 1st |
| 52 | biyoin | 美容院 | 2.1 control | not run | 美容院 first (fold), 病院 after |
| 53 | kaki | 柿 | harm probe 1.2 | not run | exact rows only; no kagi, kani |
| 54 | きよう | 器用 | harm probe 2.9 | not run | exact first; 今日 only if gate open |

---

## 4. Top 5 changes, and what looks wrong today

### 4.1 Top 5, in order

1. **One score and a wider gate (1.1 to 1.4).** Near matches run unless the typed text is itself a common word; cheap slips of common words join the top block; order by cost + rarity. Fixes the cause of `naiso`, `kaisa`, `densa`, `arigto`. Risk: medium (replaces the class ruling; section 2.14 lists the price).
2. **Two-letter-sound rule, cost 4 (2.1) and whispered-vowel rule, cost 5 (2.7).** Two small rows in `cost.js`. With change 1 this makes 内緒 first. Risk: low.
3. **Spelling variants: `ei`/`ee`/`e` and は as `wa` (2.3, 2.4).** A handful of extra exact lookups, fast phase. Fixes `sensee`, `eega`, `jitsuwa`, `matawa`. Risk: low.
4. **Canonical rewrites: `m` before b/p, `oh`, `l` as `r` (2.5, 2.6).** Three lines in `romaji.js`. Fixes `ohsaka`, `ohkii`, `kalaoke`, cleans `shimbun`, `sempai`. Risk: very low (one harm: `la` no longer means ぁ).
5. **One-kana variants for the flick keyboard (2.9).** Fixes `ないしよ`, `がつこう`, `たへもの`, `さごと`, all failing or wrong today. Risk: low under the gate. This is the board idea `flick-keyboard-slips`.

Changes 1 and 2 together are the answer to the trigger case. Neither works alone for `naiso`.

Next after the five: English stems (2.12), FATFINGER (2.8).

### 4.2 What looks wrong in the current rules

| # | Rule | Problem | Seen in |
|---|---|---|---|
| a | SPEC 4.4: tier 3 only when tiers 0+1 are empty | One rare fold or exact hit switches all correction off | `naiso`, `kaisa` |
| b | SPEC 4.6 ruling: tier 3 by exact cost, then rank | Rank only breaks exact ties; a rare word at 8 beats a top-500 word at 10 | `arigto` (雷魚 over 有難う), `taksan`, `yoroshku`, `eega` |
| c | SPEC 4.5: kana queries measured in Hepburn letters, table off | One kana slip costs 10 to 20+ by spelling luck | `ないしよ`, `がつこう`, `たくえ`, `さごと` |
| d | SPEC 4.5: "one key between" substitute costs 8 | No finger mechanism behind it; it only lets unrelated words undercut real one-letter fixes. Suggest 10. | `yoroshku` (宜しゅう at 8 over 宜しく), `taksan` (単産, 炭酸 at 8 over 沢山) |
| e | SPEC 2.2 / pack format: rank and common flag are per record, not per reading | A rare reading borrows the rank of the common one and pollutes prefix and fold lists | `naiso`: 内側【うちがわ】 ff 2784 is listed as a prefix hit, so it matched through a second reading that starts with naiso (record not opened; inferred); `soji`: 精進【しょうじん】 listed as a fold hit the same way; `naisho`: 内食【うちしょく】 as a prefix hit |
| f | `romaji.js`: `la li lu le lo` = small kana | Hides every l-for-r typo | `kalaoke` -> canon `kaaoke` |
| g | SPEC 4.9: no stems for English | Plurals miss the base word | `apples`, `cats` |

Fix for (e) is a data-lane change (a per-reading commonness bit from the dictionary's reading-level priority tags). It is not in the top 5 because it changes the pack format; it would remove noise from every list.

---

## 5. Open questions for the owner

1. **`naiso` order.** Under these numbers 内緒 is 1st and 内装 2nd, by a margin of one tenth (7 vs 8). Under news ranking the order flips, because 内緒 has fn 15000 and 内装 fn 7000. Is 1st-or-2nd enough, or must 内緒 be 1st with a wider margin? Under fiction ranking, cost 3 for the `sh` rule widens the margin to two tenths; it also pushes `shoji` words up for `soji`. Under news ranking 内装 stays first at any cost above 0 (内緒 scores cost + 7, 内装 scores 7), because the news list itself ranks 内装 higher.
2. **How pushy promoted rows may be.** Limit 9 lets a top-5000 word jump above the prefix list for one keystroke while typing. Limit 7 = calmer, rescues only top-2500 words (内緒 at 7 just passes). Limit 11 = rescues more, and 活気 would jump in while typing `kakikomi`.
3. **Rare exact words under common corrections.** `kaisa` puts 会社 over the real word 階差. Fine, or should an exact match always stay first even when rare? (Today a common fold hit already goes above a rare exact hit: the `gakko` ruling.)
4. **`l` as `r`.** Do you ever type `la`, `li` to get small ぁ, ぃ? If yes, keep both and treat l-as-r as a variant at cost 3 instead of a rewrite.
5. **Typos in unfinished words** (`tabemn`). Wanted? It is the one kind that can make the list jump on every keystroke.
6. **Kanji slips** (wrong kanji with the same reading, look-alike kanji). Worth a later round?
7. **Flick direction cost.** How much of the phone typing is 12-key flick versus phone QWERTY? If mostly flick, V2 could drop from 7 to 5 and become promotable.
8. **Measuring instead of judging.** A local-only list of searches that ended with no exact hit (kept on the device, never sent) would replace every "high / medium / low" in section 2 with counts. Wanted?
9. **Other romanisation habits** (for example pinyin letters). Do any of your own misses come from one? If so, name the letters and they get a variant row like 2.4.
10. **"One key between" at cost 8** (4.2 d). Remove, or keep as is?
