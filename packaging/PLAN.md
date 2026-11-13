# Packaging plan (details for SPEC section 8)

Everything is built on GitHub Actions. Nothing heavy is built on a developer machine.
Repo: `Nostramadeus/nearest-jisho`, branch `main`. Web address: `https://nostramadeus.github.io/nearest-jisho/`.

## 1. One workflow: `.github/workflows/build.yml`

Triggers: `push` to main (paths-ignore: `**.md`, `DATA-VERSION`), `workflow_dispatch` (input `release`, boolean,
default true), `schedule` cron `17 3 1 * *` (monthly, UTC). A release is published when the trigger is the schedule,
or a dispatch with `release` true. A plain push builds and deploys the web page and uploads the app files as workflow
artifacts only.

| Job | Runner | Does |
|---|---|---|
| `data` | ubuntu-latest, Node 24 | `node --test test/`, `node build/build-data.mjs`, `node build/verify-data.mjs`, `node tools/query.mjs --accept` (fail the job on any failed acceptance query), upload artifact `app` = the whole `app/` folder with `data/` |
| `pages` | ubuntu-latest | needs data; `actions/upload-pages-artifact` + `actions/deploy-pages` with `app/` |
| `android` | ubuntu-latest, JDK 21 | needs data; section 2 |
| `desktop` | matrix: windows-latest, ubuntu-22.04 | needs data; section 3 |
| `release` | ubuntu-latest | needs android + desktop; section 4; only when releasing |
| `keepalive` | ubuntu-latest | schedule only; writes the UTC date into `DATA-VERSION`, commits as `github-actions[bot]` with message `data: monthly refresh [skip ci]`, pushes. Keeps the schedule from being auto-disabled after 60 quiet days |

Pin every action to a major version tag. Workflow permissions are set per job (pages: `pages: write`, `id-token: write`;
release and keepalive: `contents: write`; others read only).

## 2. Android (.apk) with Capacitor

- Folder `packaging/android/`: `package.json` (pinned `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, same
  major, current stable) and `capacitor.config.json`: appId `io.github.nostramadeus.nearestjisho`, appName
  `Nearest Jisho`, webDir `www`, `android.allowMixedContent` false.
- CI steps: copy the `app` artifact to `packaging/android/www`; `npm ci`; `npx cap add android`; `npx cap sync`;
  set `versionCode` = `github.run_number`, `versionName` = data date `YYYY.MM.DD`; launcher icons generated from
  `app/icons/icon-512.png` (use `@capacitor/assets` or copy into the mipmap folders); `android:largeHeap="true"` on the
  application element; no extra permissions besides INTERNET.
- The generated `android/` folder is NOT committed. Lock file `package-lock.json` IS committed.
- Signing: release build signed with a keystore from secrets `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`
  (key alias `nearestjisho`, same password for store and key). `./gradlew assembleRelease`, then verify with
  `apksigner verify`. Output name `nearest-jisho-<date>.apk`.
- Assets must not be compressed twice: add `aaptOptions { noCompress 'dat', 'off', 'meta', 'json' }` only if the
  default build fails or the WebView cannot read the files; otherwise leave defaults.

## 3. Desktop (Windows .exe, Linux .AppImage) with Electron

Electron is chosen over Tauri because the app is 173 MB of loose data files; Electron serves them from disk unchanged.

- Folder `packaging/desktop/`: `package.json` (pinned `electron`, `electron-builder`), `main.cjs`, lock file committed.
- `main.cjs`: starts an HTTP server on `127.0.0.1` serving the bundled `app/` folder (same logic as
  `tools/serve.mjs`), fixed port 47831, and if busy tries 47832..47840. Fixed port = stable origin, so settings, recent
  searches and the downloaded data updates survive restarts. Then opens ONE BrowserWindow (1100x800, min 360x480,
  title `Nearest Jisho`, no menu bar, `contextIsolation` true, `nodeIntegration` false, no preload) at that address.
  `requestSingleInstanceLock`; a second start focuses the first window. Links to other origins open in the system
  browser (`setWindowOpenHandler` + `will-navigate` -> `shell.openExternal`), never inside the app.
- electron-builder: `appId` same as Android, `productName` `Nearest Jisho`, `extraResources` = the `app/` folder
  (not inside asar), targets: Windows `nsis` (per-user install, no admin, `oneClick` true) and Linux `AppImage`,
  x64 only. Icons from `app/icons/icon-512.png`. No auto-update, no code signing, `publish: null`.
  Output names `nearest-jisho-<date>-windows-setup.exe`, `nearest-jisho-<date>-linux.AppImage`.
- Smoke test in CI, both systems, on the unpacked build (`--dir` output): start the app (Linux: `xvfb-run`, flag
  `--no-sandbox`), wait up to 30 s for `http://127.0.0.1:47831/data/version.json` to answer 200 and for
  `/index.html` and `/worker.js` to answer 200, check the process is still alive after 10 more seconds, then stop it.
  A failed smoke test fails the job.

## 4. Release

Tag and title `data-<YYYY-MM-DD>` (UTC date of the data build). If the tag exists (two runs on one day), add
`-<run_number>`. Assets: the .apk, the Windows setup .exe, the Linux .AppImage. Body (plain words): what the three
files are, the two "unknown publisher / unknown source" warnings users will see and that they are expected because
the files are unsigned by a paid certificate, the web address, data sources line with a link to `DATA-LICENSE.md`.
Mark as latest.

## 5. README

Add a "Download" section at the top: web address, link to the latest release, one line per platform on how to
install (Android: open the .apk, allow "install unknown apps" once; Windows: run the setup, click "More info" then
"Run anyway" on the blue warning; Linux: `chmod +x` then run; iPhone and Mac: open the web address, add to home
screen / install from the browser).

## 6. Rules for whoever implements this

- Public repo. Commits: `TZ=UTC`, the repo's configured author, messages in plain English, no personal details,
  no machine paths, no location or time zone in any file. Never force-push. Never commit `app/data/`, keystores or
  passwords. `.secrets/` is gitignored and stays local.
- No local heavy builds: no `npm install` of Electron or Gradle runs on the developer machine. Lock files are
  produced with `npm install --package-lock-only`.
- If the plan is silent on something needed, stop that part and write the question in `PROGRESS-packaging.md`.
