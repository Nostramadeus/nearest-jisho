Nearest Jisho: an offline Japanese-English dictionary that finds the word you meant even when you mistype it.
Dictionary data built @DATE@ (UTC).

## The three files

- `nearest-jisho-@DATE@.apk`: the Android app. Open the file on the phone to install it.
- `nearest-jisho-@DATE@-windows-setup.exe`: the Windows installer (64-bit). It installs for your user account only and does not need administrator rights. The app uses Microsoft Edge WebView2, which Windows 10 and 11 already have; if it is missing, the installer downloads it.
- `nearest-jisho-@DATE@-linux.AppImage`: the Linux app (64-bit). Make it executable with `chmod +x`, then run it.

## Warnings you will see (expected)

These files are not signed with a paid code-signing certificate, so the system shows a warning before the first start. This is expected.

- Android: the phone asks to allow "install unknown apps" (unknown source) for the browser or file manager you opened the file with. Allow it once.
- Windows: a blue "Windows protected your PC" window says the publisher is unknown. Click "More info", then "Run anyway".

## Web version

The same app runs in the browser, also on iPhone and Mac: https://nostramadeus.github.io/nearest-jisho/
Open it once, then add it to the home screen (iPhone) or install it from the browser. It works offline after the first visit.

## Data sources

JMdict, JMnedict and KANJIDIC2 (EDRDG, CC BY-SA 4.0), Wiktionary (CC BY-SA 4.0), jiten.moe (CC BY-SA 4.0), Tatoeba (CC BY 2.0 FR), JLPT lists (CC BY-SA 4.0). Licences and required credits: [DATA-LICENSE.md](https://github.com/Nostramadeus/nearest-jisho/blob/main/DATA-LICENSE.md).

This app uses the JMdict/EDICT and KANJIDIC dictionary files. These files are the property of the Electronic Dictionary Research and Development Group, and are used in conformance with the Group's licence.
