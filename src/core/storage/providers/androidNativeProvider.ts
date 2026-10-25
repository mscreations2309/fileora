import { FileoraStorage, PARTIAL_FILE_PREFIX, type NativeEntry } from 'fileora-storage';

import { toFileoraError } from '@/core/errors/FileoraError';

import type { CopiedEntry, RawEntry, StorageProvider, TransferProgress } from '../types';

type NativeModule = NonNullable<typeof FileoraStorage>;

function fromNative(entry: NativeEntry): RawEntry {
  return {
    name: entry.name,
    uri: entry.uri,
    isDirectory: entry.isDirectory,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    mimeType: entry.mimeType,
    childCount: entry.childCount,
    isHidden: entry.isHidden,
    canWrite: entry.canWrite,
    canDelete: entry.canDelete,
    canRename: entry.canRename,
    canMove: entry.canMove,
  };
}

async function call<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw toFileoraError(error);
  }
}

/**
 * Android provider backed by the local `fileora-storage` native module. Handles both `file://`
 * locations (All-files access / app storage) and SAF `content://` document trees.
 */
export function createAndroidNativeProvider(native: NativeModule): StorageProvider {
  return {
    name: 'android-native',
    capabilities: {
      reportsProgress: true,
      verifiesCopies: false,
      cancellableTransfers: true,
      persistentFolderGrants: true,
      volumeBrowsing: true,
    },
    listChildren: (uri, options) =>
      call(async () =>
        (await native.listChildren(uri))
          .filter((e) => options?.includePartials || !e.name.startsWith(PARTIAL_FILE_PREFIX))
          .map(fromNative),
      ),
    stat: (uri) => call(async () => {
      const entry = await native.stat(uri);
      return entry ? fromNative(entry) : null;
    }),
    createDirectory: (parentUri, name) => call(async () => fromNative(await native.createDirectory(parentUri, name))),
    rename: (uri, newName) => call(async () => fromNative(await native.rename(uri, newName))),
    delete: (uri) => call(async () => {
      await native.delete(uri);
    }),
    copyFile: (operationId, sourceUri, destinationParentUri, name, mimeType, overwrite) =>
      call(async (): Promise<CopiedEntry> => {
        const result = await native.copyFile(operationId, sourceUri, destinationParentUri, name, mimeType, overwrite);
        return { ...fromNative(result), sha256: result.sha256 };
      }),
    tryFastMove: (sourceUri, sourceParentUri, destinationParentUri, name) =>
      call(async () => {
        const moved = await native.tryFastMove(sourceUri, sourceParentUri, destinationParentUri, name);
        return moved ? fromNative(moved) : null;
      }),
    hash: (uri, operationId) => call(() => native.hash(uri, 'SHA-256', operationId ?? null)),
    cancel: (operationId) => native.cancel(operationId),
    onProgress: (listener: (progress: TransferProgress) => void) => {
      const subscription = native.addListener('onTransferProgress', listener);
      return () => subscription.remove();
    },
  };
}
