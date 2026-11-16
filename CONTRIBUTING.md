# Contributing to Fileora

Thank you for your interest in improving Fileora. Bug fixes, documentation updates, accessibility improvements, and well-scoped features are welcome.

## Development prerequisites

Before setting up the project, install:

- Node.js 20 or newer (the project has also been tested with Node 24).
- JDK 17 or 21.
- Android SDK and Android build tools 36 for Android development.
- Xcode on macOS for local iOS builds. Alternatively, use EAS Build.

Fileora uses Expo with a local native module. **Expo Go is not supported**; use a development build.

## Set up the project

1. Fork the repository on GitHub and clone your fork.
2. Create a feature branch for your change.
3. Install dependencies:

   ```bash
   npm install
   ```

4. On Windows, keep the checkout in a short path outside OneDrive or Dropbox (for example, `C:\dev\fileora`). Long synchronized paths can cause native build path-length and file-locking problems.

## Validate your changes

Run the checks relevant to your change before opening a pull request:

```bash
npm run typecheck
npx eslint .
npm test
npm run doctor
```

For Android changes, also build and test on a development device or emulator:

```bash
npx expo prebuild --platform android
npm run android
```

The native `android/` and `ios/` directories are generated and git-ignored. Make persistent native changes through `app.json`, `plugins/`, or `modules/fileora-storage`, rather than editing generated folders by hand.

## Pull request checklist

Before submitting a pull request:

- Keep the change focused and explain the user problem it solves.
- Update documentation when behaviour, setup, or commands change.
- Add or update tests when appropriate.
- Run the relevant validation commands and report their results accurately.
- Include screenshots or a short recording for visible UI changes.
- Do not include secrets, API keys, personal data, generated build output, or unrelated files.
- Mention known limitations or follow-up work.

## Reporting a bug

When opening an issue, include:

- A clear description of the problem and expected behaviour.
- Reproduction steps.
- Device, OS, and app/runtime versions where relevant.
- Relevant logs or screenshots, with personal information removed.

Please search existing issues first to avoid duplicates.

Thank you for helping make Fileora better!
