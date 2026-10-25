/**
 * Signs release builds with Fileora's own upload key when it is configured on the build machine, via
 * ~/.gradle/gradle.properties (never committed):
 *   FILEORA_RELEASE_STORE_FILE, FILEORA_RELEASE_STORE_PASSWORD, FILEORA_RELEASE_KEY_ALIAS, FILEORA_RELEASE_KEY_PASSWORD
 * Without them, release builds fall back to the shared debug key — fine for local testing, never for
 * publishing, because anyone holding the debug key could ship an "update" that installs over the real app.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// fileora:release-signing';

const SIGNING_CONFIG = `
        ${MARKER}
        if (project.hasProperty('FILEORA_RELEASE_STORE_FILE')) {
            release {
                storeFile file(FILEORA_RELEASE_STORE_FILE)
                storePassword FILEORA_RELEASE_STORE_PASSWORD
                keyAlias FILEORA_RELEASE_KEY_ALIAS
                keyPassword FILEORA_RELEASE_KEY_PASSWORD
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    let gradle = mod.modResults.contents;
    if (gradle.includes(MARKER)) return mod;
    gradle = gradle.replace(/signingConfigs\s*\{/, (match) => `${match}${SIGNING_CONFIG}`);
    // The template's release build type points at the debug key; prefer the release key when configured.
    gradle = gradle.replace(/(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/, '$1signingConfig project.hasProperty(\'FILEORA_RELEASE_STORE_FILE\') ? signingConfigs.release : signingConfigs.debug');
    mod.modResults.contents = gradle;
    return mod;
  });
};
