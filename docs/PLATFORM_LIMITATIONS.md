# Platform limitations and how Fileora handles them

These constraints come from Android and iOS, not from Fileora. The app is designed so it never claims
access, recoverability or monitoring it does not have.

## Android

| Limitation | Consequence | Fileora's handling |
| --- | --- | --- |
| Scoped storage (Android 10+) | Without special access, apps cannot list arbitrary folders. | Two models: **All files access** (`MANAGE_EXTERNAL_STORAGE`, explained first, granted in system Settings) or **per-folder SAF grants**. Everything works with either. |
| Google Play policy for `MANAGE_EXTERNAL_STORAGE` | Play requires a declaration; file managers are a permitted use case. | Requested only from the Storage access screen. Release builds need the Play Console declaration (see `RELEASE.md`). |
| SAF picker cannot select the storage root or `Download/` on Android 11+ | Without All-files access, users must pick subfolders. | Explained in the Storage access screen; SD cards and USB drives can be picked. |
| `Android/data` and `Android/obb` are private to each app | Not readable even with All-files access. | Skipped by search; not shown as errors. |
| App-specific storage is removed on uninstall | Fileora Trash lives there (same volume → instant moves). | Stated on the Trash screen. |
| SAF provider behaviour varies (renames may be adjusted, some providers lack move/delete) | Requested names may change; some actions are impossible. | Results are read back from the provider and reported as-is; unsupported actions are disabled using provider flags. |
| Background execution limits | Long operations can be stopped when the app is backgrounded or killed. | Journaled; interrupted operations are marked on next launch and hidden partial files removed. A foreground service for long copies is planned. |

## iOS

| Limitation | Consequence | Fileora's handling |
| --- | --- | --- |
| App sandbox | No device-wide file system access exists for any app. | Fileora browses its own Documents folder (visible in Files › On My iPhone › Fileora via `UIFileSharingEnabled` / `LSSupportsOpeningDocumentsInPlace`) and folders the user picks. |
| Picked-folder access is session-scoped in `expo-file-system` | Access ends when the app closes. | Granted folders are shown as "Access expired — choose the folder again" after restart. Persistent access needs security-scoped bookmarks in a native iOS module (planned; must be built and verified on macOS). |
| No byte-level progress or mid-file cancel in expo-file-system copy | Progress is per file; cancellation applies between files. | The progress panel says so. Copies are verified by hashing source and destination. |
| Multi-file share via expo-sharing | Single file per share sheet. | Multi-select share is disabled on iOS with an explanation. |
| Background execution | Operations pause or stop when backgrounded. | Same journaling and interruption handling as Android. |

## Not yet verified on devices

The environment used for this milestone has no attached device and cannot build iOS. Before a pilot:

1. Android: install the debug build on Android 10, 13 and 15 devices (or emulators) and run the
   validation checklist in `docs/VALIDATION.md`.
2. iOS: build with EAS (`eas build --profile development --platform ios`) and run the same checklist,
   focusing on the sandbox location and picked folders.
