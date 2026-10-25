/**
 * Declares Android storage permissions with the SDK bounds Google Play expects:
 * - READ_EXTERNAL_STORAGE only up to Android 12L (API 32); WRITE_EXTERNAL_STORAGE only up to Android 10 (API 29).
 * - MANAGE_EXTERNAL_STORAGE ("All files access") for Android 11+. Fileora asks for it only after an
 *   in-app explanation, and every feature keeps working through Storage Access Framework folder grants
 *   when the user declines.
 * - requestLegacyExternalStorage so Android 10 behaves like the legacy model when the user grants storage.
 */
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const PERMISSIONS = [
  { name: 'android.permission.READ_EXTERNAL_STORAGE', maxSdkVersion: '32' },
  { name: 'android.permission.WRITE_EXTERNAL_STORAGE', maxSdkVersion: '29' },
  { name: 'android.permission.MANAGE_EXTERNAL_STORAGE' },
];

module.exports = function withAndroidStoragePermissions(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] ?? 'http://schemas.android.com/tools';
    const existing = (manifest['uses-permission'] ?? []).filter(
      (entry) => !PERMISSIONS.some((p) => p.name === entry.$['android:name']),
    );
    manifest['uses-permission'] = [
      ...existing,
      ...PERMISSIONS.map((p) => ({
        $: {
          'android:name': p.name,
          // Libraries (e.g. expo-file-system) declare looser bounds; ours must win in the merged manifest.
          ...(p.maxSdkVersion ? { 'android:maxSdkVersion': p.maxSdkVersion, 'tools:replace': 'android:maxSdkVersion' } : {}),
          ...(p.name.endsWith('MANAGE_EXTERNAL_STORAGE') ? { 'tools:ignore': 'ScopedStorage' } : {}),
        },
      })),
    ];
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    application.$['android:requestLegacyExternalStorage'] = 'true';
    return mod;
  });
};
