# Fileora

**Your files. Your control.** A privacy-first file manager for Android and iOS.

## Download (Android)

Get the latest APK from **[Releases](https://github.com/mscreations2309/fileora/releases/latest)**:

| File | For |
| --- | --- |
| `Fileora-<version>-arm64.apk` | Almost every phone from the last ~8 years — pick this one |
| `Fileora-<version>-armv7.apk` | Older 32-bit phones |
| `Fileora-<version>-x86_64.apk` | Android emulators |

Open the file on your phone and allow installing from that source when Android asks. Text recognition and QR scanning use Google Play services.

- Develop and build from a short path outside OneDrive (see below).
- Package / bundle identifier: `com.fileora.app`
- Stack: Expo SDK 58 · React Native 0.88 (New Architecture, Hermes) · TypeScript (strict) · Expo Router · SQLite · Zustand · FlashList
- Docs: [Architecture](docs/ARCHITECTURE.md) · [Platform limitations](docs/PLATFORM_LIMITATIONS.md) · [Validation checklist](docs/VALIDATION.md) · [Release](docs/RELEASE.md)

## Status

| Area | State |
| --- | --- |
| Foundation: navigation, theme, design system, SQLite + migrations, error model, logging | Done |
| Storage: Android native module (file paths + SAF), iOS sandbox/picked folders, access education | Done |
| Core file manager: browse, list/grid, sort, hidden files, selection, open, share, details, checksum | Done |
| Operations: copy, move (verified), rename, new folder, Trash/restore, permanent delete, conflicts, progress, cancel | Done |
| Reliability: operation journal, undo, interrupted-operation recovery, history | Done (first slice of Time Machine) |
| Filename search with filters, ranking and match explanations | Done |
| Search by meaning: opt-in on-device content index (text, Office, PDF and photo OCR), query understanding, explained matches | Done (Android OCR/PDF/Office; iOS text files) |
| Storage Detective: usage by type/folder, exact duplicates (SHA-256), similar photos, old downloads, repeated exports, review before Trash | Done |
| Workspaces: references without copies, collections, notes, labels, missing-file checks, suggestions, manifest export/import | Done |
| Private Vault: AES-256-GCM chunked encryption, biometric/passcode/recovery-key unlock, auto-lock, verified export, encrypted backup/restore | Done |
| Privacy scanner: checksummed identifiers, secrets, EXIF GPS, Office metadata/hidden content, verified redaction (text) and metadata removal (JPEG), pre-share check | Done |
| Expiry radar: labelled date extraction with source text, confirm/correct, reminders, calendar, renewal linking | Done |
| Change radar: text/JSON/CSV/OCR-PDF/Office/image comparison, folder snapshots, exportable reports | Done |
| Relationship graph: explained suggestions (identifiers, names, workspaces, timing), manual links, zoomable graph and list view | Done |
| Smart handoff: LAN transfer with QR pairing, ECDH pairing code, AES-GCM, SHA-256 verification, resume, history | Done (Android) |

## Requirements

- Node 20+ (tested with Node 24), JDK 17 or 21, Android SDK (API 36/37 platform, build-tools 36).
- iOS builds need macOS with Xcode, or EAS Build.
- **Expo Go is not supported** (Fileora has a local native module). Use a development build.

> **Windows:** build Android from a short path outside OneDrive/Dropbox (e.g. `C:\dev\fileora`).
> Under the current OneDrive path, the C++ builds of `react-native-screens` and `react-native-worklets`
> exceed the 260-character limit (`ninja: error: mkdir(...)`). A `subst` drive does not help, because
> Node resolves it back to the real path. Mapping a project directly at a drive root (`X:\`) also breaks
> Expo autolinking. OneDrive can also lock `android/`, which blocks `expo prebuild`. EAS Build avoids all of these.

## Commands

```bash
npm install
npm run typecheck        # tsc --noEmit
npx eslint .             # lint
npm test                 # Jest: engine integration + unit tests
npm run doctor           # expo-doctor
npx expo prebuild --platform android   # generate android/ (do not edit it by hand)
npm run android          # build + install debug build on a device/emulator (expo run:android)
npm start                # Metro for the development build
```

Native folders (`android/`, `ios/`) are generated and git-ignored. Change native behaviour through
`app.json`, `plugins/`, or `modules/fileora-storage`.
