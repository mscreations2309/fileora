# Fileora — Architecture

Fileora is a privacy-first file manager for Android and iOS built with Expo SDK 58 (React Native 0.88,
React 19.3, New Architecture, Hermes) and strict TypeScript.

## Why Expo (with development builds)

- **Continuous Native Generation**: `android/` and `ios/` are generated from `app.json` and config
  plugins (`expo prebuild`). Identifiers (`com.fileora.app`) and permissions live in one place.
- **SDK modules cover most native needs**: `expo-file-system` (File/Directory API, SAF pickers,
  streaming handles, native SHA-256), `expo-sqlite`, `expo-secure-store` (Keystore/Keychain),
  `expo-local-authentication`, `expo-sharing`, `expo-crypto`.
- **Custom native code is still first-class**: `modules/fileora-storage` is a local Expo module
  (Kotlin) for Android features the SDK lacks. Expo Go cannot run Fileora; use a development build.
- **iOS from Windows**: iOS binaries are built with EAS Build (or a Mac). See `docs/RELEASE.md`.

## Layers

```
src/app/                 Expo Router routes only (thin files re-exporting feature screens)
src/core/                Cross-cutting infrastructure
  bootstrap/             Startup: DB open + migrations + preferences; no storage scanning
  database/              SQLite connection and versioned migrations (PRAGMA user_version)
  errors/                FileoraError: stable codes, user-facing title + guidance
  format/                Locale-aware sizes, dates, numbers (Intl, device locale)
  logging/               Logger that redacts URIs and paths
  preferences/           Zustand store persisted to SQLite
  storage/               StorageProvider interface, providers, locations, URI helpers
  theme/                 Design tokens (color, type, spacing, radii, motion) + ThemeProvider
src/features/            Feature modules (screens, hooks, domain logic)
  browse/                Locations, folder listing, breadcrumbs, selection, clipboard paste
  file_operations/       Engine (copy/move/trash/delete/rename/undo), journal, store, dialogs
  file_details/          Metadata, checksum, per-file history
  home/ search/ settings/ time_machine/ tools/ library/
src/shared/components/   Design-system components (rows, buttons, sheets, dialogs, toasts, ...)
modules/fileora-storage/ Local Expo native module (Android)
plugins/                 Config plugins (Android storage permissions with SDK bounds)
```

## Storage model

Every item is addressed by the URI the platform provides, never by an assumed absolute path:

| Scheme | Where | Provider |
| --- | --- | --- |
| `file://` | Android shared storage with All-files access, SD/USB volumes, app storage; iOS sandbox and picked folders | Android: native module · iOS: expo-file-system |
| `content://` | Android Storage Access Framework (SAF) document trees the user granted | Android: native module |

`StorageProvider` (`src/core/storage/types.ts`) defines `listChildren`, `stat`, `createDirectory`,
`rename`, `delete`, `copyFile`, `tryFastMove`, `hash`, `cancel`, `onProgress`, and advertises
`ProviderCapabilities`. Each `FileEntry` carries per-item capabilities (`canRename`, `canDelete`,
`canMove`, `canWrite`) from provider flags (SAF `FLAG_SUPPORTS_*`) or filesystem permissions; the UI
disables unsupported actions with an explanation.

Parent URIs are tracked explicitly (`FileEntry.parentUri`, breadcrumb trail) because SAF document URIs
cannot be walked upwards.

### Android native module (`modules/fileora-storage`)

Why it exists:

1. **Listing performance** — `expo-file-system` lists SAF folders through `DocumentFile`, issuing one
   ContentResolver query per property per child (thousands of IPC calls for a large folder). The module
   lists a folder with **one** `DocumentsContract` children query returning all metadata, and lists
   `file://` folders in one batched call on `Dispatchers.IO`.
2. **Streaming copy with integrity** — copies stream in 256 KB chunks to a hidden
   `.fileora-partial-<operationId>-<name>` file, `fsync` (for `file://`), compute SHA-256 of the source
   bytes while copying, then rename into place. A failed or cancelled copy never leaves a truncated file
   under the real name. Progress events are throttled (200 ms); cancellation is checked per chunk.
3. **Opening and sharing** — `expo-file-system`'s FileProvider only covers app-private directories and
   `expo-sharing` rejects `content://` URIs. The module has its own FileProvider (`root-path`, needed for
   removable volumes) and issues `ACTION_VIEW` / `ACTION_SEND(_MULTIPLE)` with temporary read grants.
4. **Access management** — All-files-access status, storage volumes with free/total space, persisted
   SAF grants and their release.

The module is Android-only and loaded with `requireOptionalNativeModule`; when absent (iOS, Jest, Expo
Go) the app falls back to the expo-file-system provider.

## File operations engine

`src/features/file_operations/engine.ts` is platform-independent and depends only on `StorageProvider`
and `Journal` (injected), which is why it is tested against an in-memory filesystem with fault injection.

- **Move** = fast metadata move when possible (same-volume rename / provider move), otherwise
  copy → verify SHA-256 → delete source, file by file. A source is never deleted before its copy is
  verified; folders are removed only after every descendant was verified.
- **Conflicts** are resolved before execution: keep both (`name (1).ext`, case-insensitive), skip, or
  replace (existing file goes to Trash first; folders are never merged).
- **Trash** moves items into Fileora-managed storage (Android: app-specific external storage on the
  same volume, so usually an instant rename) and indexes them for restore.
- **Journal**: every operation and top-level item is written to SQLite before it runs and updated after.
  Operations still `running` at next launch are marked `interrupted`, and their hidden partial files are
  removed. **Undo** inverts done items (rename back, move back, restore from trash, trash copies,
  delete still-empty folders); permanent deletion is recorded as irreversible.
- **Failure semantics**: per-item errors are collected and the operation continues; storage-wide errors
  (no space, read-only, cancellation) stop it. Results are `completed | partial | failed | cancelled`
  and the UI reports exactly that.

## Performance

- Startup opens SQLite and reads preferences only. Locations load after first render; nothing scans.
- Folder lists use FlashList v2 with memoized rows; sorting/filtering is in memory; stale listing
  responses are discarded.
- Filename search is breadth-first and incremental (results stream in batches), cancellable on every
  keystroke (250 ms debounce), with a scan budget (4,000 folders / 500 results) reported to the user.
- Hashing and copying stream natively; JavaScript never holds file contents.

## Privacy and security

- No network calls, analytics or accounts. Sharing only happens through the system share sheet.
- Logs pass through `redact()`, which strips URIs and paths.
- Android `allowBackup=false`; app data is excluded from cloud backups.
- Permissions are requested only from the Storage access screen, after an explanation.

## Testing

`npm test` runs Jest (`jest-expo`):

- Engine integration tests against `src/test/memoryStorage.ts` (copy trees, partial failure, verification
  failure keeps sources, no-space abort, cancellation, replace-via-trash, undo of move/rename/folder,
  trash/restore with name clashes and missing folders).
- Unit tests for conflict naming, name validation, search ranking, sorting, file types, URI helpers,
  error classification and log redaction.
