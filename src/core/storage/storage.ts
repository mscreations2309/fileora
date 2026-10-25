import { FileoraStorage } from 'fileora-storage';

import { categorize, extensionOf, mimeTypeFor } from './fileTypes';
import { createAndroidNativeProvider } from './providers/androidNativeProvider';
import { createExpoFileSystemProvider } from './providers/expoFileSystemProvider';
import type { FileEntry, RawEntry, StorageProvider } from './types';

/**
 * The active storage provider. Android uses the native module (file paths + SAF); iOS, and Android
 * builds without the native module (Expo Go), use expo-file-system for sandbox `file://` access.
 */
export const storage: StorageProvider = FileoraStorage
  ? createAndroidNativeProvider(FileoraStorage)
  : createExpoFileSystemProvider();

export const hasNativeStorage = FileoraStorage !== null;

export function toFileEntry(raw: RawEntry, parentUri: string, locationId: string): FileEntry {
  const mimeType = raw.isDirectory ? null : mimeTypeFor(raw.name, raw.mimeType);
  return {
    uri: raw.uri,
    parentUri,
    locationId,
    name: raw.name,
    extension: raw.isDirectory ? '' : extensionOf(raw.name),
    isDirectory: raw.isDirectory,
    size: raw.isDirectory ? null : raw.size,
    modifiedAt: raw.modifiedAt,
    mimeType,
    category: categorize(raw.name, raw.isDirectory, mimeType),
    childCount: raw.childCount,
    isHidden: raw.isHidden,
    capabilities: {
      canRename: raw.canRename,
      canDelete: raw.canDelete,
      canMove: raw.canMove,
      canWrite: raw.canWrite,
    },
  };
}
