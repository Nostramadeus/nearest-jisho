# Nearest Jisho - Japanese Dictionary

An offline Japanese-English dictionary that finds the word you meant even when you mistype it.
Results appear while you type. Search in English, kana, kanji or romaji.

- Typos are fine: `jihso` finds 辞書 (jisho) and says "letters swapped".
- Long vowels and double letters are optional: `gakko` finds 学校 (gakkou), `shojo` finds 少女 (shoujo).
- Verb and adjective forms lead to the dictionary form: `食べさせられた` finds 食べる.
- Slang from JMdict and Wiktionary is shown with labels; names come from JMnedict; tap a kanji for its details.
- Everything runs on the device. After the first visit the app works offline.

## Download

- Web (any device): https://nostramadeus.github.io/nearest-jisho/
- App files: [latest release](https://github.com/Nostramadeus/nearest-jisho/releases/latest)

| Platform | How to install |
|---|---|
| Android | Download the `.apk` and open it. Allow "install unknown apps" once when the phone asks. |
| Windows | Download and run the `-windows-setup.exe`. On the blue warning, click "More info", then "Run anyway". |
| Linux | Download the `.AppImage`, run `chmod +x` on it, then run it. |
| iPhone and Mac | Open the web address. iPhone: Share, then "Add to Home Screen". Mac: install it from the browser (Chrome/Edge install button, Safari "Add to Dock"). |

The warnings are expected: the files are not signed with a paid certificate.
The data is rebuilt every month; each build is a new release.

## Build the data

Node 24, no npm packages. The build downloads the sources (streamed, temporary files in `build/.cache/`)
and writes the packs into `app/data/`.

```
node build/build-data.mjs
node build/build-data.mjs --only words,kanji    # rebuild some packs only
```

## Run

Serve the folder `app/` with any static web server and open it in a browser, for example:

```
npx http-server app -a 127.0.0.1      # or any other static server
```

The page needs to be served over `http://127.0.0.1` / `localhost` or `https://` (web workers and the offline
cache do not run from `file://`).

## Command line and tests

```
node tools/query.mjs "jihso"          # ranked results from app/data
node tools/query.mjs --accept         # the acceptance queries from SPEC.md section 7
node tools/query.mjs --bench          # search timings and memory
node --test test/                     # unit and engine tests on a small hand-made fixture
```

## Layout

| Path | What |
|---|---|
| `app/` | the web app: `index.html`, `main.js` (page), `worker.js` (loads data, runs searches), `sw.js` (offline cache) |
| `app/search/` | search engine, runs in the browser worker and in node: romaji, fold keys, typo costs, deinflection, packs |
| `build/` | data build scripts |
| `tools/` | `query.mjs` command line, `make-icons.mjs` |
| `test/` | `node --test test/` |
| `packaging/` | Android (Capacitor) and desktop (Electron) wrappers; built only on GitHub Actions by `.github/workflows/build.yml` |
| `SPEC.md` | the plan of record |

## Licences

- Code: MIT, see `LICENSE`.
- Dictionary data: JMdict, JMnedict and KANJIDIC2 (© EDRDG, CC BY-SA 4.0), Wiktionary (CC BY-SA 4.0),
  jiten.moe (CC BY-SA 4.0), Tatoeba (CC BY 2.0 FR), JLPT lists (CC BY-SA 4.0). Details and required credits are in
  `DATA-LICENSE.md` and on the app's "About and licences" page.

This site uses the JMdict/EDICT and KANJIDIC dictionary files. These files are the property of the Electronic
Dictionary Research and Development Group, and are used in conformance with the Group's licence.
