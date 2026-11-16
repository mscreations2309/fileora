# Fileora privacy overview

Fileora is designed as a local-first file manager. This page explains the privacy and platform-access behaviour documented by the project.

## Data and network behaviour

- The architecture documents no network calls, analytics, or user accounts.
- Sharing is initiated through the device's system share sheet.
- Application logs pass through a redaction function that removes URIs and file paths.

## File access

Fileora uses the access model provided by each platform:

- **Android:** users can grant All files access from the Storage access screen, or grant access to selected folders through the Storage Access Framework (SAF).
- **iOS:** the app can browse its own Documents folder and folders selected by the user. iOS apps do not receive device-wide file-system access.

Access can be limited by the operating system or by the selected storage provider. See [Platform limitations](PLATFORM_LIMITATIONS.md) for details, including Android protected folders and iOS picked-folder access.

## Local storage, Trash, and backups

- Fileora stores its operation journal and app data locally using SQLite.
- On Android, app data is configured with `allowBackup=false`.
- On Android, the Fileora Trash is stored in app-specific storage. The operating system removes that storage when the app is uninstalled.

Keep important files in their original locations or in a separate backup. Do not treat the in-app Trash as an uninstall-safe backup.

## Sharing files

File sharing is user-initiated through the operating system's share sheet or platform file-opening flow. Once a file is shared with another app or person, that recipient or app controls its subsequent handling.

## Platform-specific access notes

Permissions and storage behaviour differ between Android and iOS. In particular, SAF providers can restrict individual operations, iOS picked-folder access is session-scoped in the current implementation, and long-running operations can be interrupted when the app is backgrounded.

See:

- [Platform limitations](PLATFORM_LIMITATIONS.md)
- [Architecture](ARCHITECTURE.md)
- [Release checklist](RELEASE.md)

## Scope of this document

This overview describes the behaviour recorded in the repository's architecture and platform-limitations documents. It is not a claim that every permission or platform edge case has been independently verified on every device. Check the [validation checklist](VALIDATION.md) before a pilot or release.
