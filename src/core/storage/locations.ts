import { Directory, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { FileoraStorage, type NativeVolume } from 'fileora-storage';
import { PermissionsAndroid, Platform } from 'react-native';

import { APP_ID } from '@/core/config';
import { getDatabase } from '@/core/database/database';
import { toFileoraError } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';

import { storage } from './storage';
import type { LocationIcon, StorageLocation } from './types';
import { isContentUri, isSameOrDescendant, joinFileUri, stableId } from './uri';

export type AllFilesAccess = { mode: 'manage' | 'legacy'; granted: boolean };

type LocationRow = { id: string; kind: string; root_uri: string; label: string };

const ANDROID_SHORTCUTS: { folder: string; label: string; icon: LocationIcon }[] = [
  { folder: 'Download', label: 'Downloads', icon: 'download' },
  { folder: 'Documents', label: 'Documents', icon: 'document' },
  { folder: 'DCIM', label: 'Camera', icon: 'camera' },
  { folder: 'Pictures', label: 'Pictures', icon: 'image' },
  { folder: 'Movies', label: 'Movies', icon: 'video' },
  { folder: 'Music', label: 'Music', icon: 'music' },
];

/** Android only: status of broad storage access. `null` on iOS, where it does not exist. */
export function getAllFilesAccess(): AllFilesAccess | null {
  return FileoraStorage ? FileoraStorage.getAllFilesAccessStatus() : null;
}

/**
 * Android 11+: opens the system "All files access" screen (the user returns to Fileora afterwards;
 * re-check with `getAllFilesAccess` on resume). Android 10 and below: runtime storage permission.
 */
export async function requestAllFilesAccess(): Promise<void> {
  const status = getAllFilesAccess();
  if (!status) return;
  if (status.mode === 'legacy') {
    await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
      PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
    ]);
    return;
  }
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, {
      data: `package:${APP_ID}`,
    });
  } catch {
    // Some OEM builds lack the per-app screen; fall back to the global list.
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.MANAGE_ALL_FILES_ACCESS_PERMISSION);
  }
}

/** iOS: Fileora's Documents folder, visible to the user in Files › On My iPhone › Fileora. */
function appSandboxLocation(): StorageLocation {
  return {
    id: 'sandbox',
    kind: 'appSandbox',
    rootUri: Paths.document.uri,
    label: Platform.OS === 'ios' ? 'On My Device' : 'Fileora storage',
    description: Platform.OS === 'ios' ? 'Files › On My iPhone › Fileora' : 'Private to Fileora',
    icon: 'app',
    isRemovable: false,
    status: 'available',
  };
}

function volumeLocation(volume: NativeVolume): StorageLocation {
  return {
    id: `volume:${volume.id}`,
    kind: 'volume',
    rootUri: volume.uri,
    label: volume.isPrimary ? 'Internal storage' : (volume.label ?? 'External storage'),
    description: volume.isReadOnly ? 'Read-only' : undefined,
    icon: volume.isPrimary ? 'phone' : volume.label?.toLowerCase().includes('usb') ? 'usb' : 'sd-card',
    isRemovable: volume.isRemovable,
    status: volume.isMounted ? 'available' : 'unavailable',
    totalBytes: volume.totalBytes,
    freeBytes: volume.freeBytes,
  };
}

async function grantedFolderLocations(): Promise<StorageLocation[]> {
  const rows = await getDatabase().getAllAsync<LocationRow>(
    "SELECT id, kind, root_uri, label FROM locations WHERE kind = 'grantedFolder' ORDER BY label COLLATE NOCASE",
  );
  const persisted = FileoraStorage?.getPersistedPermissions() ?? [];
  return Promise.all(
    rows.map(async (row): Promise<StorageLocation> => {
      let status: StorageLocation['status'] = 'available';
      if (FileoraStorage) {
        const granted = persisted.some((p) => row.root_uri.startsWith(p.uri));
        if (!granted) status = 'accessExpired';
      }
      if (status === 'available') {
        try {
          if (!(await storage.stat(row.root_uri))) status = FileoraStorage ? 'unavailable' : 'accessExpired';
        } catch (error) {
          status = toFileoraError(error).code === 'ERR_ACCESS_DENIED' ? 'accessExpired' : 'unavailable';
        }
      }
      return {
        id: row.id,
        kind: 'grantedFolder',
        rootUri: row.root_uri,
        label: row.label,
        description:
          status === 'accessExpired'
            ? 'Access expired — choose the folder again'
            : status === 'unavailable'
              ? 'Not available — storage may be disconnected'
              : 'Folder you granted',
        icon: 'folder',
        isRemovable: false,
        status,
      };
    }),
  );
}

/** Lists every location Fileora can currently show, in display order. Does no deep scanning. */
export async function loadLocations(): Promise<StorageLocation[]> {
  const locations: StorageLocation[] = [];
  const access = getAllFilesAccess();
  if (FileoraStorage && access?.granted) {
    const volumes = await FileoraStorage.getStorageVolumes();
    for (const volume of volumes) {
      const location = volumeLocation(volume);
      locations.push(location);
      if (volume.isPrimary && volume.isMounted) {
        const shortcuts = await Promise.all(
          ANDROID_SHORTCUTS.map(async (shortcut): Promise<StorageLocation | null> => {
            const uri = joinFileUri(volume.uri, shortcut.folder);
            const exists = await storage.stat(uri).catch(() => null);
            return exists?.isDirectory
              ? {
                  id: `shortcut:${shortcut.folder}`,
                  kind: 'shortcut',
                  rootUri: uri,
                  label: shortcut.label,
                  icon: shortcut.icon,
                  isRemovable: false,
                  status: 'available',
                }
              : null;
          }),
        );
        locations.push(...shortcuts.filter((s): s is StorageLocation => s !== null));
      }
    }
  }
  if (Platform.OS === 'ios' || !FileoraStorage) locations.push(appSandboxLocation());
  locations.push(...(await grantedFolderLocations()));
  return locations;
}

/** Opens the system folder picker and remembers the grant. Resolves null if the user cancels. */
export async function grantFolder(): Promise<StorageLocation | null> {
  let picked: Directory;
  try {
    picked = await Directory.pickDirectoryAsync();
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('cancel')) return null;
    throw toFileoraError(error);
  }
  let rootUri = picked.uri;
  let label = picked.name || 'Folder';
  if (FileoraStorage) {
    const root = await FileoraStorage.resolveTreeRoot(picked.uri);
    rootUri = root.uri;
    label = root.name;
  }
  const id = stableId('folder', rootUri);
  await getDatabase().runAsync(
    `INSERT INTO locations (id, kind, root_uri, label, created_at) VALUES (?, 'grantedFolder', ?, ?, ?)
     ON CONFLICT(root_uri) DO UPDATE SET label = excluded.label`,
    id,
    rootUri,
    label,
    Date.now(),
  );
  logger.info('locations', 'Folder access granted');
  return {
    id,
    kind: 'grantedFolder',
    rootUri,
    label,
    description: 'Folder you granted',
    icon: 'folder',
    isRemovable: false,
    status: 'available',
  };
}

/** Removes a granted folder from Fileora and releases the system permission where possible. */
export async function forgetGrantedFolder(location: StorageLocation): Promise<void> {
  if (FileoraStorage) {
    const treeUri = location.rootUri.split('/document/')[0] ?? location.rootUri;
    FileoraStorage.releasePersistedPermission(treeUri);
  }
  await getDatabase().runAsync('DELETE FROM locations WHERE id = ?', location.id);
}

/** Finds the location that contains `uri` (longest root wins), for items reached from search or history. */
export function locationForUri(locations: StorageLocation[], uri: string): StorageLocation | null {
  let best: StorageLocation | null = null;
  for (const location of locations) {
    // All documents of one SAF tree share the ".../tree/<id>/" prefix; file URIs nest by path.
    const contains = isContentUri(location.rootUri)
      ? uri.startsWith(`${location.rootUri.split('/document/')[0] ?? location.rootUri}/`)
      : isSameOrDescendant(uri, location.rootUri);
    if (contains && (!best || location.rootUri.length > best.rootUri.length)) best = location;
  }
  return best;
}

/**
 * Directory for Fileora-managed trash. On Android it lives in app-specific external storage, which is on
 * the same volume as shared storage, so moving items to trash is usually an instant rename. Note: Android
 * removes this directory when Fileora is uninstalled; the Trash screen says so.
 */
export function trashDirectoryUri(): string {
  const roots = FileoraStorage?.getAppStorageRoots();
  const base = roots?.externalFiles ?? Paths.document.uri;
  const directory = new Directory(base, '.fileora-trash');
  if (!directory.exists) {
    // expo-file-system may not be allowed to write to app-specific external storage; the native module is.
    if (FileoraStorage) FileoraStorage.ensureAppDirectory(directory.uri);
    else directory.create({ intermediates: true, idempotent: true });
  }
  return directory.uri;
}

/**
 * One-off folder pick (export/backup destinations). Returns a URI the storage provider can write to,
 * or null if the user cancels. Unlike `grantFolder`, the folder is not added to Browse.
 */
export async function pickFolderUri(): Promise<{ uri: string; name: string } | null> {
  let picked: Directory;
  try {
    picked = await Directory.pickDirectoryAsync();
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('cancel')) return null;
    throw toFileoraError(error);
  }
  if (FileoraStorage) {
    const root = await FileoraStorage.resolveTreeRoot(picked.uri);
    return { uri: root.uri, name: root.name };
  }
  return { uri: picked.uri, name: picked.name };
}
