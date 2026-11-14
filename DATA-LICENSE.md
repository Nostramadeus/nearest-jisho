# Data licences

The program code of Nearest Jisho is under the MIT licence (`LICENSE`). The dictionary data that the build
(`build/build-data.mjs`) downloads and writes into `app/data/` is NOT covered by the MIT licence. It is a
derived work of the sources below and is distributed under the **Creative Commons Attribution-ShareAlike 4.0
International licence (CC BY-SA 4.0)**, https://creativecommons.org/licenses/by-sa/4.0/ , with the
additional terms each source names.

| Data in the app | Source | Licence | Link |
|---|---|---|---|
| Words (pack `words`) | JMdict, Electronic Dictionary Research and Development Group (EDRDG), JSON conversion by scriptin/jmdict-simplified | CC BY-SA 4.0 (EDRDG licence) | https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project ; https://github.com/scriptin/jmdict-simplified |
| Commonness tags (news ranking) | JMdict (`JMdict_e.gz`, EDRDG) | CC BY-SA 4.0 (EDRDG licence) | https://www.edrdg.org/jmdict/j_jmdict.html |
| Names (pack `names`) | JMnedict, EDRDG, via jmdict-simplified | CC BY-SA 4.0 (EDRDG licence) | https://www.edrdg.org/enamdict/enamdict_doc.html |
| Kanji information (`kanji.json`) | KANJIDIC2, EDRDG, via jmdict-simplified. Only literal, English meanings, on/kun readings, nanori, stroke count, grade, JLPT level and frequency are kept; SKIP codes and other third-party index fields are not included | CC BY-SA 4.0 (EDRDG licence) | https://www.edrdg.org/wiki/index.php/KANJIDIC_Project |
| Example sentences under meanings | Tatoeba (sentences linked to JMdict senses, via jmdict-simplified) | CC BY 2.0 FR | https://tatoeba.org/en/downloads |
| Sentences with this word (pack `sent`) | Tatoeba exports `jpn_sentences`, `eng_sentences`, `jpn_indices` | CC BY 2.0 FR (some sentences CC0) | https://tatoeba.org/en/downloads |
| Slang and extra entries, English definitions (pack `wikt`, `src: "we"`) | English Wiktionary, extracted by kaikki.org (wiktextract) | CC BY-SA 4.0 (Wiktionary is dual-licensed CC BY-SA 4.0 and GFDL; this project uses the CC BY-SA 4.0 option) | https://en.wiktionary.org/wiki/Wiktionary:Copyrights ; https://kaikki.org/dictionary/Japanese/ |
| Slang, Japanese definitions (pack `wikt`, `src: "wj"`) | Japanese Wiktionary, extracted by kaikki.org (wiktextract) | CC BY-SA 4.0 (as above) | https://ja.wiktionary.org/ ; https://kaikki.org/jawiktionary/index.html |
| Fiction and media ranking | jiten.moe frequency list (global) | CC BY-SA 4.0 | https://jiten.moe/frequency-dictionaries |
| JLPT levels | stephenmk/yomitan-jlpt-vocab | CC BY-SA 4.0 | https://github.com/stephenmk/yomitan-jlpt-vocab |
| Pitch accent (pack `pitch`, `pitch.json`) | UniDic `unidic-cwj-202512` (NINJAL, The UniDic Consortium), accent type field `aType`, joined to JMdict words | BSD 3-clause (UniDic is triple-licensed GPL 2.0 / LGPL 2.1 / BSD; this project uses the BSD option) | https://clrd.ninjal.ac.jp/unidic/ ; https://clrd.ninjal.ac.jp/unidic_archive/2512/unidic-cwj-202512.zip |

## Required credits

**EDRDG (JMdict, JMnedict, KANJIDIC2).** The app shows this acknowledgement on every screen:

> This site uses the JMdict/EDICT and KANJIDIC dictionary files. These files are the property of the
> Electronic Dictionary Research and Development Group, and are used in conformance with the Group's licence.

EDRDG licence: https://www.edrdg.org/edrdg/licence.html

**Wiktionary.** Every Wiktionary entry in the app links to its page on en.wiktionary.org or ja.wiktionary.org,
where the full list of authors is in the page history. Data extracted with wiktextract / kaikki.org
(Tatu Ylonen, "Wiktextract: Wiktionary as Machine-Readable Structured Data", LREC 2022).

**jiten.moe.** Word frequency ranks from jiten.moe (https://jiten.moe), CC BY-SA 4.0.

**Tatoeba.** Example sentences from the Tatoeba project (https://tatoeba.org), CC BY 2.0 FR; each sentence links
to its Tatoeba page, which names its authors. Many of the Japanese and English sentences are from the Tanaka
Corpus, which is in the public domain.

**JLPT levels.** From stephenmk/yomitan-jlpt-vocab (CC BY-SA 4.0). "JLPT data is sourced from Jonathan Waller's
JLPT Resources page under the terms of the Creative Commons BY license."

**UniDic.** Pitch accent values from UniDic (unidic-cwj-202512, https://clrd.ninjal.ac.jp/unidic/), used under
the BSD 3-clause licence option. The full BSD licence text (copyright notice, conditions and disclaimer) from the
UniDic package is stored with the data in `pitch.json` (field `license`).

## Share-alike

If you redistribute the data files in `app/data/` or a work built from them, you must keep them under
CC BY-SA 4.0 (or a compatible licence) and keep the credits above.
