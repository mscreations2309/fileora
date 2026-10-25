import { Directory, File } from 'expo-file-system';
import { PARTIAL_FILE_PREFIX } from 'fileora-storage';

import { FileoraError, toFileoraError } from '@/core/errors/FileoraError';

import type { CopiedEntry, RawEntry, StorageProvider } from '../types';

function fileEntry(file: File): RawEntry {
  return {
    name: file.name,
    uri: file.uri,
    isDirectory: false,
    size: file.size,
    modifiedAt: file.lastModified,
    mimeType: file.type || null,
    childCount: null,
    isHidden: file.name.startsWith('.'),
    canWrite: true,
    canDelete: true,
    canRename: true,
    canMove: true,
  };
}

function directoryEntry(directory: Directory): RawEntry {
  const info = directory.info();
  return {
    name: directory.name,
    uri: directory.uri,
    isDirectory: true,
    size: null,
    modifiedAt: info.modificationTime ?? null,
    mimeType: null,
    childCount: info.files?.length ?? null,
    isHidden: directory.name.startsWith('.'),
    canWrite: true,
    canDelete: true,
    canRename: true,
    canMove: true,
  };
}

function entryFor(uri: string): RawEntry | null {
  const directory = new Directory(uri);
  if (directory.exists) return directoryEntry(directory);
  const file = new File(uri);
  return file.exists ? fileEntry(file) : null;
}

function guard<T>(task: () => T): T {
  try {
    return task();
  } catch (error) {
    throw toFileoraError(error);
  }
}

async function guardAsync<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw toFileoraError(error);
  }
}

function assertAvailable(parent: Directory, name: string): void {
  if (new File(parent, name).exists || new Directory(parent, name).exists) {
    throw new FileoraError('ERR_ALREADY_EXISTS', `"${name}" already exists`);
  }
}

function validateName(name: string): void {
  if (!name.trim() || name === '.' || name === '..' || name.includes('/') || name.includes('\u0000')) {
    throw new FileoraError('ERR_INVALID_NAME', 'Invalid name');
  }
}

/**
 * Provider for `file://` locations reachable through expo-file-system: the iOS app sandbox and
 * folders picked through the iOS document picker (session-scoped), and the Android app sandbox
 * when the native module is unavailable. Copies are verified by hashing source and destination,
 * because this API offers no byte-level progress or mid-file cancellation.
 */
export function createExpoFileSystemProvider(): StorageProvider {
  return {
    name: 'expo-file-system',
    capabilities: {
      reportsProgress: false,
      verifiesCopies: true,
      cancellableTransfers: false,
      persistentFolderGrants: false,
      volumeBrowsing: false,
    },
    listChildren: async (uri, options) =>
      guard(() => {
        const directory = new Directory(uri);
        if (!directory.exists) throw new FileoraError('ERR_NOT_FOUND', 'Folder not found');
        return directory
          .list()
          .filter((item) => options?.includePartials || !item.name.startsWith(PARTIAL_FILE_PREFIX))
          .map((item) => (item instanceof Directory ? directoryEntry(item) : fileEntry(item)));
      }),
    stat: async (uri) => guard(() => entryFor(uri)),
    createDirectory: async (parentUri, name) =>
      guard(() => {
        validateName(name);
        const parent = new Directory(parentUri);
        assertAvailable(parent, name);
        const created = parent.createDirectory(name);
        return directoryEntry(created);
      }),
    rename: async (uri, newName) =>
      guard(() => {
        validateName(newName);
        const directory = new Directory(uri);
        const target: File | Directory = directory.exists ? directory : new File(uri);
        if (!target.exists) throw new FileoraError('ERR_NOT_FOUND', 'Item not found');
        if (target.name !== newName && target.name.toLowerCase() !== newName.toLowerCase()) {
          assertAvailable(target.parentDirectory, newName);
        }
        target.rename(newName);
        return target instanceof Directory ? directoryEntry(target) : fileEntry(target);
      }),
    delete: async (uri) =>
      guard(() => {
        const directory = new Directory(uri);
        if (directory.exists) {
          directory.delete();
          return;
        }
        const file = new File(uri);
        if (!file.exists) throw new FileoraError('ERR_NOT_FOUND', 'Item not found');
        file.delete();
      }),
    copyFile: (operationId, sourceUri, destinationParentUri, name, _mimeType, overwrite) =>
      guardAsync(async (): Promise<CopiedEntry> => {
        validateName(name);
        const source = new File(sourceUri);
        if (!source.exists) throw new FileoraError('ERR_NOT_FOUND', 'Source not found');
        const parent = new Directory(destinationParentUri);
        if (!parent.exists) throw new FileoraError('ERR_NOT_FOUND', 'Destination folder not found');
        const target = new File(parent, name);
        if (!overwrite) assertAvailable(parent, name);
        const partial = new File(parent, `${PARTIAL_FILE_PREFIX}${operationId}-${name}`);
        try {
          const sourceHash = await source.digest('SHA-256');
          await source.copy(partial);
          const copiedHash = await partial.digest('SHA-256');
          if (copiedHash !== sourceHash) {
            throw new FileoraError('ERR_VERIFICATION_FAILED', 'Copied data does not match the source');
          }
          if (target.exists) target.delete();
          partial.rename(name);
          return { ...fileEntry(partial), sha256: sourceHash };
        } finally {
          if (partial.exists && partial.name !== name) partial.delete();
        }
      }),
    tryFastMove: async (sourceUri, _sourceParentUri, destinationParentUri, name) =>
      guardAsync(async () => {
        validateName(name);
        const parent = new Directory(destinationParentUri);
        assertAvailable(parent, name);
        const directory = new Directory(sourceUri);
        if (directory.exists) {
          await directory.move(new Directory(parent, name));
          return directoryEntry(directory);
        }
        const file = new File(sourceUri);
        if (!file.exists) throw new FileoraError('ERR_NOT_FOUND', 'Source not found');
        await file.move(new File(parent, name));
        return fileEntry(file);
      }),
    hash: (uri) => guardAsync(() => new File(uri).digest('SHA-256')),
    cancel: () => undefined,
    onProgress: () => () => undefined,
  };
}
