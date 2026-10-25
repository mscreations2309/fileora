/**
 * Keeps the Android download small:
 * - ABI splits: one APK per CPU architecture instead of one APK carrying every architecture's native code.
 *   Almost every phone in use is arm64-v8a; armeabi-v7a covers older 32-bit phones; x86_64 is for emulators.
 * - ML Kit barcode scanning (pulled in by expo-camera) is swapped for the Google Play services build, which
 *   shares one downloaded model across apps instead of bundling ~5 MB per architecture. The API is identical.
 * - Asks Google Play services to fetch the OCR and barcode models soon after install, so the first scan or
 *   text search does not have to wait for them.
 */
const { withAppBuildGradle, withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];
const MARKER = '// fileora:smaller-apk';

const SPLITS = `
    ${MARKER}
    splits {
        abi {
            enable true
            reset()
            include ${ABIS.map((a) => `"${a}"`).join(', ')}
            universalApk false
        }
    }
`;

const SUBSTITUTION = `
${MARKER}
configurations.all {
    resolutionStrategy.dependencySubstitution {
        substitute module("com.google.mlkit:barcode-scanning") using module("com.google.android.gms:play-services-mlkit-barcode-scanning:18.3.1")
    }
}
`;

function withSplitsAndSubstitution(config) {
  return withAppBuildGradle(config, (mod) => {
    let gradle = mod.modResults.contents;
    if (!gradle.includes(MARKER)) {
      gradle = gradle.replace(/\nandroid\s*\{\n/, (match) => `${match}${SPLITS}`);
      gradle = `${gradle.trimEnd()}\n${SUBSTITUTION}`;
    }
    mod.modResults.contents = gradle;
    return mod;
  });
}

function withModelDependencies(config) {
  return withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, 'com.google.mlkit.vision.DEPENDENCIES', 'ocr,barcode');
    return mod;
  });
}

module.exports = function withSmallerApk(config) {
  return withModelDependencies(withSplitsAndSubstitution(config));
};
