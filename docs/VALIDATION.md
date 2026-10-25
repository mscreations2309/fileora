# Manual validation checklist (device / emulator)

Run on Android 10 (API 29), Android 13 (API 33) and Android 15 (API 35); iOS 17+ via an EAS build.
Record pass/fail and device for each item.

## Access
- [ ] First launch shows Home quickly with no file scanning.
- [ ] Android: Storage access → "Open Android settings" opens the All-files page; enabling it and returning shows Internal storage and shortcuts without restarting.
- [ ] Android: revoking All-files access in Settings and returning hides volumes; opening a folder shows "Fileora no longer has access" with a link to Storage access.
- [ ] "Choose a folder" grants a SAF folder; it survives an app restart (Android) / shows "Access expired" after restart (iOS).
- [ ] Removing a granted folder releases access (Android: Settings › Apps › Fileora shows no persisted grant).
- [ ] Removing an SD card while viewing it produces an "unavailable" state, not a crash.

## Browsing
- [ ] A folder with 5,000+ files scrolls smoothly in list and grid views.
- [ ] Sorting (name/date/size/type, asc/desc, folders first) and hidden-file toggle work and persist.
- [ ] Breadcrumbs navigate back to any level; Android back clears selection before leaving.
- [ ] Opening PDF/image/video/unknown files opens a viewer or shows "No app can open this file".
- [ ] Sharing one and several files works (Android); iOS shares one file and explains multi-share.

## Operations
- [ ] Copy a 2 GB file: progress, speed of updates, cancel mid-way leaves no partial file and keeps the source.
- [ ] Move between Internal storage and an SD card (copy → verify → delete) — source removed only after success.
- [ ] Move within the same volume is instant.
- [ ] Paste into a folder with name clashes: Keep both / Skip / Replace (replaced file appears in Trash).
- [ ] Rename to an existing name shows the clash error; case-only rename (a.txt → A.txt) works.
- [ ] Delete → Trash → Restore returns the item to its folder; restore with a name clash keeps both.
- [ ] Undo from the toast and from History for copy, move, rename, trash and new folder.
- [ ] Fill the destination storage: the copy stops with "Not enough storage" and nothing is overwritten.
- [ ] Kill the app during a large copy: next launch shows the operation as Interrupted and no `.fileora-partial-*` remains.

## Search
- [ ] Typing shows first results in under a second on Internal storage; changing the query cancels the old search.
- [ ] Accent-insensitive matching ("resume" finds "Résumé"); filters by type and date.
- [ ] Very broad queries show the "stopped early" notice.

## Accessibility & appearance
- [ ] TalkBack / VoiceOver: every control has a label; file rows announce name, type, size, date and selection.
- [ ] Font scale 200%: rows, dialogs and bars remain usable.
- [ ] Light, dark and system themes; reduced motion disables the indeterminate progress animation.
