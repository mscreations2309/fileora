import { create } from 'zustand';

import type { FileEntry, RawEntry } from '@/core/storage/types';
import { storage } from '@/core/storage/storage';
import { usePreferences } from '@/core/preferences/preferences';

import {
  findConflicts,
  planRoots,
  runCopy,
  runCreateFolder,
  runDelete,
  runMove,
  runRename,
  runRestore,
  runTrash,
  runUndo,
  type Destination,
} from './engine';
import type { ConflictResolution } from './conflicts';
import { getOperation } from './journal';
import { track } from './operationsStore';
import type { OperationResult, SourceItem, TrashRecord } from './types';

export function toSourceItem(entry: FileEntry): SourceItem {
  return {
    uri: entry.uri,
    parentUri: entry.parentUri,
    name: entry.name,
    isDirectory: entry.isDirectory,
    size: entry.size,
    mimeType: entry.mimeType,
    locationId: entry.locationId,
  };
}

export type ClipboardMode = 'copy' | 'move';

type ClipboardState = {
  mode: ClipboardMode | null;
  items: SourceItem[];
  set: (mode: ClipboardMode, entries: FileEntry[]) => void;
  clear: () => void;
};

/** Copy/move works as "pick items → navigate → paste here", like desktop file managers. */
export const useClipboard = create<ClipboardState>()((set) => ({
  mode: null,
  items: [],
  set: (mode, entries) => set({ mode, items: entries.map(toSourceItem) }),
  clear: () => set({ mode: null, items: [] }),
}));

export function conflictsFor(items: SourceItem[], destinationUri: string): Promise<SourceItem[]> {
  return findConflicts(storage, items, destinationUri);
}

export async function paste(
  mode: ClipboardMode,
  items: SourceItem[],
  destination: Destination,
  resolution: ConflictResolution,
): Promise<OperationResult & { skippedNames: string[] }> {
  const useTrash = usePreferences.getState().useTrash;
  const plan = await planRoots(storage, mode, items, destination.uri, resolution);
  const skippedNames = [...plan.skipped, ...plan.unchanged].map((item) => item.name);
  if (plan.roots.length === 0) {
    return { status: 'completed', failures: [], skipped: skippedNames.length, error: null, skippedNames };
  }
  const result = await track(mode, mode === 'copy' ? 'Copying' : 'Moving', (deps, ctx) =>
    mode === 'copy' ? runCopy(deps, ctx, plan.roots, destination, useTrash) : runMove(deps, ctx, plan.roots, destination, useTrash),
  );
  return { ...result, skipped: result.skipped + skippedNames.length, skippedNames };
}

export function deleteItems(entries: FileEntry[], permanently: boolean): Promise<OperationResult> {
  const items = entries.map(toSourceItem);
  return permanently
    ? track('delete', 'Deleting', (deps, ctx) => runDelete(deps, ctx, items))
    : track('trash', 'Moving to Trash', (deps, ctx) => runTrash(deps, ctx, items));
}

export function renameItem(entry: FileEntry, newName: string): Promise<OperationResult & { entry: RawEntry | null }> {
  return track('rename', 'Renaming', (deps, ctx) => runRename(deps, ctx, toSourceItem(entry), newName));
}

export function createFolder(parent: Destination, name: string): Promise<OperationResult & { entry: RawEntry | null }> {
  return track('createFolder', 'Creating folder', (deps, ctx) => runCreateFolder(deps, ctx, parent, name));
}

export function restoreFromTrash(records: TrashRecord[]): Promise<OperationResult> {
  return track('restore', 'Restoring', (deps, ctx) => runRestore(deps, ctx, records));
}

export function deleteFromTrash(records: TrashRecord[]): Promise<OperationResult> {
  const items: SourceItem[] = records.map((record) => ({
    uri: record.trashUri,
    parentUri: '',
    name: record.name,
    isDirectory: record.isDirectory,
    size: record.size,
    mimeType: null,
    locationId: null,
  }));
  const title = records.length === 1 ? `Permanently delete “${records[0]?.name}” from Trash` : `Empty ${records.length} items from Trash`;
  return track('delete', 'Deleting permanently', (deps, ctx) => runDelete(deps, ctx, items, title));
}

export async function undoOperation(operationId: string): Promise<OperationResult> {
  const operation = await getOperation(operationId);
  if (!operation) {
    return { status: 'failed', failures: [], skipped: 0, error: null };
  }
  return track('undo', 'Undoing', (deps, ctx) =>
    runUndo(deps, ctx, { id: operation.record.id, title: operation.record.title }, operation.items),
  );
}
