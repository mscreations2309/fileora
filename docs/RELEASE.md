# Build and release

## Development builds

- Android (local): `npx expo run:android` (requires Android SDK; builds `android/` via prebuild).
- Android/iOS (cloud): `npx eas-cli@latest build --profile development --platform android|ios`.
  Create `eas.json` with `npx eas-cli@latest build:configure` the first time.

## Release signing

- Android: let EAS manage the upload keystore (`eas credentials`), or provide your own. Never commit
  keystores; `*.jks`, `*.keystore`-style files are git-ignored.
- iOS: EAS manages certificates and provisioning profiles for `com.fileora.app` with an Apple Developer account.

## Store requirements specific to Fileora

- **Google Play — All files access**: `MANAGE_EXTERNAL_STORAGE` requires the "All files access"
  declaration in Play Console. Category: file manager. Describe that access is requested only after an
  in-app explanation and that the app is fully usable with per-folder access.
- **Data safety / privacy labels**: no data collected, no data shared, no tracking. Update this if crash
  reporting is added (it must exclude file names, paths and contents).
- **iOS export compliance**: the current build uses only OS-provided encryption. When the Private Vault
  ships, re-evaluate `ITSAppUsesNonExemptEncryption` and export documentation.

## Before each release

1. `npm run typecheck && npx eslint . && npm test && npm run doctor`
2. Run `docs/VALIDATION.md` on the supported Android versions and iOS.
3. Bump `version` in `app.json` (EAS can auto-increment build numbers).
