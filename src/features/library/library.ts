import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { FileoraStorage } from 'fileora-storage';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { getDatabase } from '@/core/database/database';
import { FileoraError, toFileoraError } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';
import type { FileEntry } from '@/core/storage/types';

export type RecentFile = {
  uri: string;
  locationId: string | null;
  name: string;
  mimeType: string | null;
  size: number | null;
  openedAt: number;
};

export type Favorite = {
  uri: string;
  locationId: string | null;
  name: string;
  isDirectory: boolean;
  createdAt: number;
};

/** Bumped when recents/favorites change so Home refreshes without polling. */
export const useLibraryRevision = create<{ revision: number; bump: () => void }>()((set) => ({
  revision: 0,
  bump: () => set((state) => ({ revision: state.revision + 1 })),
}));

const RECENTS_LIMIT = 200;

export async function recordRecent(entry: FileEntry): Promise<void> {
  const db = getDatabase();
  await db.runAsync(
    `INSERT INTO recent_files (uri, location_id, name, mime_type, size, opened_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET opened_at = excluded.opened_at, name = excluded.name, size = excluded.size`,
    entry.uri,
    entry.locationId,
    entry.name,
    entry.mimeType,
    entry.size,
    Date.now(),
  );
  await db.runAsync(
    'DELETE FROM recent_files WHERE uri NOT IN (SELECT uri FROM recent_files ORDER BY opened_at DESC LIMIT ?)',
    RECENTS_LIMIT,
  );
  useLibraryRevision.getState().bump();
}

export async function listRecents(limit = 20): Promise<RecentFile[]> {
  const rows = await getDatabase().getAllAsync<{
    uri: string;
    location_id: string | null;
    name: string;
    mime_type: string | null;
    size: number | null;
    opened_at: number;
  }>('SELECT * FROM recent_files ORDER BY opened_at DESC LIMIT ?', limit);
  return rows.map((row) => ({
    uri: row.uri,
    locationId: row.location_id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    openedAt: row.opened_at,
  }));
}

export async function removeRecent(uri: string): Promise<void> {
  await getDatabase().runAsync('DELETE FROM recent_files WHERE uri = ?', uri);
  useLibraryRevision.getState().bump();
}

export async function listFavorites(): Promise<Favorite[]> {
  const rows = await getDatabase().getAllAsync<{
    uri: string;
    location_id: string | null;
    name: string;
    is_directory: number;
    created_at: number;
  }>('SELECT * FROM favorites ORDER BY is_directory DESC, name COLLATE NOCASE');
  return rows.map((row) => ({
    uri: row.uri,
    locationId: row.location_id,
    name: row.name,
    isDirectory: row.is_directory === 1,
    createdAt: row.created_at,
  }));
}

export async function isFavorite(uri: string): Promise<boolean> {
  return (await getDatabase().getFirstAsync('SELECT 1 FROM favorites WHERE uri = ?', uri)) !== null;
}

export async function setFavorite(entry: Pick<FileEntry, 'uri' | 'locationId' | 'name' | 'isDirectory'>, favorite: boolean): Promise<void> {
  const db = getDatabase();
  if (favorite) {
    await db.runAsync(
      'INSERT OR REPLACE INTO favorites (uri, location_id, name, is_directory, created_at) VALUES (?, ?, ?, ?, ?)',
      entry.uri,
      entry.locationId,
      entry.name,
      entry.isDirectory ? 1 : 0,
      Date.now(),
    );
  } else {
    await db.runAsync('DELETE FROM favorites WHERE uri = ?', entry.uri);
  }
  useLibraryRevision.getState().bump();
}

/** Opens a file with the platform's viewer (Android: app chooser, iOS: Quick Look). */
export async function openFile(entry: FileEntry): Promise<void> {
  try {
    if (FileoraStorage) {
      await FileoraStorage.openFile(entry.uri, entry.mimeType);
    } else {
      const file = new File(entry.uri);
      if (!(await file.canPreview({ mimeType: entry.mimeType ?? undefined }))) {
        throw new FileoraError('ERR_NO_HANDLER', 'No viewer for this file');
      }
      await file.preview({ title: entry.name, mimeType: entry.mimeType ?? undefined });
    }
  } catch (error) {
    throw toFileoraError(error);
  }
  recordRecent(entry).catch((error: unknown) => logger.warn('library', 'Could not record recent file', error));
}

export function canShareMultiple(): boolean {
  return FileoraStorage !== null;
}

/** Shares files through the system share sheet. Nothing is uploaded by Fileora itself. */
export async function shareFiles(entries: FileEntry[]): Promise<void> {
  const files = entries.filter((entry) => !entry.isDirectory);
  if (files.length === 0) throw new FileoraError('ERR_UNSUPPORTED', 'Folders cannot be shared directly');
  const sameType = files.every((file) => file.mimeType === files[0]?.mimeType);
  const mimeType = sameType ? (files[0]?.mimeType ?? null) : null;
  try {
    if (FileoraStorage) {
      await FileoraStorage.shareFiles(
        files.map((file) => file.uri),
        mimeType,
      );
      return;
    }
    if (files.length > 1) {
      throw new FileoraError('ERR_UNSUPPORTED', `Sharing several files at once is not available on ${Platform.OS} yet`);
    }
    const [file] = files;
    if (file) await Sharing.shareAsync(file.uri, { mimeType: mimeType ?? undefined, dialogTitle: file.name });
  } catch (error) {
    throw toFileoraError(error);
  }
}

/**
 * Writes generated text (a manifest or report) to Fileora's cache and opens the share sheet.
 * The temporary file is replaced on the next share of the same name.
 */
export async function shareTextFile(fileName: string, content: string, mimeType: string): Promise<void> {
  const file = new File(Paths.cache, fileName);
  if (file.exists) file.delete();
  file.create();
  file.write(content);
  try {
    if (FileoraStorage) await FileoraStorage.shareFiles([file.uri], mimeType);
    else await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: fileName });
  } catch (error) {
    throw toFileoraError(error);
  }
}
