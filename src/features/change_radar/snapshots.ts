import { randomUUID } from 'expo-crypto';
import { create } from 'zustand';

import { getDatabase } from '@/core/database/database';
import { FileoraError, isCancellation } from '@/core/errors/FileoraError';
import { storage } from '@/core/storage/storage';

import { compareSnapshots, type FolderChange, type SnapshotItem } from './diff';

/**
 * Folder snapshots: a record of every file's path, size, modification time and (optionally) SHA-256.
 * Change Radar compares a snapshot with the folder as it is now. Fileora does not watch folders in
 * the background — Android and iOS do not allow reliable continuous monitoring — so changes are
 * detected when you compare.
 */
export type Snapshot = { id: string; folderUri: string; locationId: string | null; label: string; itemCount: number; hashed: boolean; createdAt: number };

export const useSnapshotRevision = create<{ revision: number; bump: () => void }>()((set) => ({ revision: 0, bump: () => set((s) => ({ revision: s.revision + 1 })) }));

const MAX_ITEMS = 20_000;

export async function walkFolder(folderUri: string, hash: boolean, isCancelled: () => boolean, onProgress?: (count: number) => void): Promise<SnapshotItem[]> {
  const items: SnapshotItem[] = [];
  const queue: { uri: string; path: string }[] = [{ uri: folderUri, path: '' }];
  while (queue.length > 0) {
    if (isCancelled()) throw new FileoraError('ERR_CANCELLED', 'Cancelled');
    if (items.length >= MAX_ITEMS) throw new FileoraError('ERR_UNSUPPORTED', `This folder has more than ${MAX_ITEMS} items; choose a smaller folder`);
    const folder = queue.shift();
    if (!folder) break;
    const children = await storage.listChildren(folder.uri);
    for (const child of children) {
      const path = folder.path ? `${folder.path}/${child.name}` : child.name;
      if (child.isDirectory) {
        items.push({ path, isDirectory: true, size: null, modifiedAt: child.modifiedAt, sha256: null });
        queue.push({ uri: child.uri, path });
        continue;
      }
      let sha256: string | null = null;
      if (hash) {
        try {
          sha256 = await storage.hash(child.uri);
        } catch (error) {
          if (isCancellation(error)) throw error;
        }
      }
      items.push({ path, isDirectory: false, size: child.size, modifiedAt: child.modifiedAt, sha256 });
      onProgress?.(items.length);
    }
  }
  return items;
}

export async function takeSnapshot(folder: { uri: string; locationId: string | null; label: string }, hash: boolean, isCancelled: () => boolean, onProgress?: (count: number) => void): Promise<Snapshot> {
  const items = await walkFolder(folder.uri, hash, isCancelled, onProgress);
  const snapshot: Snapshot = { id: randomUUID(), folderUri: folder.uri, locationId: folder.locationId, label: folder.label, itemCount: items.length, hashed: hash, createdAt: Date.now() };
  const db = getDatabase();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'INSERT INTO folder_snapshots (id, folder_uri, location_id, label, item_count, hashed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      snapshot.id,
      snapshot.folderUri,
      snapshot.locationId,
      snapshot.label,
      snapshot.itemCount,
      hash ? 1 : 0,
      snapshot.createdAt,
    );
    for (const item of items) {
      await db.runAsync(
        'INSERT INTO snapshot_items (snapshot_id, path, is_directory, size, modified_at, sha256) VALUES (?, ?, ?, ?, ?, ?)',
        snapshot.id,
        item.path,
        item.isDirectory ? 1 : 0,
        item.size,
        item.modifiedAt,
        item.sha256,
      );
    }
  });
  useSnapshotRevision.getState().bump();
  return snapshot;
}

export async function listSnapshots(): Promise<Snapshot[]> {
  const rows = await getDatabase().getAllAsync<{ id: string; folder_uri: string; location_id: string | null; label: string; item_count: number; hashed: number; created_at: number }>('SELECT * FROM folder_snapshots ORDER BY created_at DESC');
  return rows.map((r) => ({ id: r.id, folderUri: r.folder_uri, locationId: r.location_id, label: r.label, itemCount: r.item_count, hashed: r.hashed === 1, createdAt: r.created_at }));
}

export async function deleteSnapshot(id: string): Promise<void> {
  await getDatabase().runAsync('DELETE FROM folder_snapshots WHERE id = ?', id);
  useSnapshotRevision.getState().bump();
}

/** Compares a snapshot with the folder now, using the same evidence the snapshot recorded. */
export async function compareWithNow(snapshot: Snapshot, isCancelled: () => boolean, onProgress?: (count: number) => void): Promise<FolderChange[]> {
  const before = (
    await getDatabase().getAllAsync<{ path: string; is_directory: number; size: number | null; modified_at: number | null; sha256: string | null }>('SELECT * FROM snapshot_items WHERE snapshot_id = ?', snapshot.id)
  ).map((r) => ({ path: r.path, isDirectory: r.is_directory === 1, size: r.size, modifiedAt: r.modified_at, sha256: r.sha256 }));
  const now = await walkFolder(snapshot.folderUri, snapshot.hashed, isCancelled, onProgress);
  return compareSnapshots(before, now);
}
