import { getDatabase } from '@/core/database/database';
import type { ErrorCode } from '@/core/errors/FileoraError';

import type {
  Journal,
  JournalItem,
  OperationRecord,
  OperationStatus,
  OperationType,
  TrashRecord,
} from './types';

type OperationRow = {
  id: string;
  type: string;
  status: string;
  title: string;
  location_id: string | null;
  destination_uri: string | null;
  item_count: number;
  total_bytes: number | null;
  processed_bytes: number;
  reversible: number;
  undo_operation_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  finished_at: number | null;
};

type ItemRow = {
  position: number;
  kind: string;
  source_uri: string | null;
  source_parent_uri: string | null;
  destination_uri: string | null;
  destination_parent_uri: string | null;
  name: string;
  is_directory: number;
  size: number | null;
  sha256: string | null;
  status: string;
  error_code: string | null;
};

type TrashRow = {
  id: string;
  operation_id: string;
  name: string;
  is_directory: number;
  size: number | null;
  original_parent_uri: string;
  original_location_id: string | null;
  trash_uri: string;
  sha256: string | null;
  deleted_at: number;
};

function toOperation(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    type: row.type as OperationType,
    status: row.status as OperationStatus,
    title: row.title,
    locationId: row.location_id,
    destinationUri: row.destination_uri,
    itemCount: row.item_count,
    totalBytes: row.total_bytes,
    processedBytes: row.processed_bytes,
    reversible: row.reversible === 1,
    undoOperationId: row.undo_operation_id,
    errorCode: row.error_code as ErrorCode | null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function toItem(row: ItemRow): JournalItem {
  return {
    position: row.position,
    kind: row.kind as JournalItem['kind'],
    sourceUri: row.source_uri,
    sourceParentUri: row.source_parent_uri,
    destinationUri: row.destination_uri,
    destinationParentUri: row.destination_parent_uri,
    name: row.name,
    isDirectory: row.is_directory === 1,
    size: row.size,
    sha256: row.sha256,
    status: row.status as JournalItem['status'],
    errorCode: row.error_code as ErrorCode | null,
  };
}

function toTrash(row: TrashRow): TrashRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    name: row.name,
    isDirectory: row.is_directory === 1,
    size: row.size,
    originalParentUri: row.original_parent_uri,
    originalLocationId: row.original_location_id,
    trashUri: row.trash_uri,
    sha256: row.sha256,
    deletedAt: row.deleted_at,
  };
}

/** SQLite-backed operation journal. */
export const sqliteJournal: Journal = {
  async begin(record) {
    await getDatabase().runAsync(
      `INSERT INTO operations (id, type, status, title, location_id, destination_uri, item_count, total_bytes, created_at)
       VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.type,
      record.title,
      record.locationId,
      record.destinationUri,
      record.itemCount,
      record.totalBytes,
      record.createdAt,
    );
  },
  async addItem(operationId, item) {
    const db = getDatabase();
    const row = await db.getFirstAsync<{ next: number }>(
      'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM operation_items WHERE operation_id = ?',
      operationId,
    );
    const position = row?.next ?? 0;
    await db.runAsync(
      `INSERT INTO operation_items (operation_id, position, kind, source_uri, source_parent_uri, destination_uri,
         destination_parent_uri, name, is_directory, size, sha256, status, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      operationId,
      position,
      item.kind,
      item.sourceUri,
      item.sourceParentUri,
      item.destinationUri,
      item.destinationParentUri,
      item.name,
      item.isDirectory ? 1 : 0,
      item.size,
      item.sha256,
      item.status,
      item.errorCode,
    );
    return position;
  },
  async updateItem(operationId, position, patch) {
    await getDatabase().runAsync(
      `UPDATE operation_items SET
         status = COALESCE(?, status),
         destination_uri = COALESCE(?, destination_uri),
         sha256 = COALESCE(?, sha256),
         error_code = COALESCE(?, error_code)
       WHERE operation_id = ? AND position = ?`,
      patch.status ?? null,
      patch.destinationUri ?? null,
      patch.sha256 ?? null,
      patch.errorCode ?? null,
      operationId,
      position,
    );
  },
  async finish(operationId, patch) {
    const db = getDatabase();
    // Items never reached (fatal error / cancellation) are closed out so history shows the truth.
    await db.runAsync(
      "UPDATE operation_items SET status = 'failed', error_code = COALESCE(error_code, ?) WHERE operation_id = ? AND status = 'pending'",
      patch.errorCode ?? "ERR_CANCELLED",
      operationId,
    );
    await db.runAsync(
      `UPDATE operations SET status = ?, processed_bytes = ?, reversible = ?, error_code = ?, error_message = ?, finished_at = ?
       WHERE id = ?`,
      patch.status,
      patch.processedBytes,
      patch.reversible ? 1 : 0,
      patch.errorCode,
      patch.errorMessage,
      Date.now(),
      operationId,
    );
  },
  async linkUndo(operationId, undoOperationId) {
    await getDatabase().runAsync(
      'UPDATE operations SET undo_operation_id = ?, reversible = 0 WHERE id = ?',
      undoOperationId,
      operationId,
    );
  },
  async addTrash(record) {
    await getDatabase().runAsync(
      `INSERT INTO trash_items (id, operation_id, name, is_directory, size, original_parent_uri, original_location_id,
         trash_uri, sha256, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.operationId,
      record.name,
      record.isDirectory ? 1 : 0,
      record.size,
      record.originalParentUri,
      record.originalLocationId,
      record.trashUri,
      record.sha256,
      record.deletedAt,
    );
  },
  async removeTrash(id) {
    await getDatabase().runAsync('DELETE FROM trash_items WHERE id = ?', id);
  },
  async findTrashByUri(trashUri) {
    const row = await getDatabase().getFirstAsync<TrashRow>('SELECT * FROM trash_items WHERE trash_uri = ?', trashUri);
    return row ? toTrash(row) : null;
  },
};

export type OperationFilter = { type?: OperationType | null; status?: OperationStatus | null };

export async function listOperations(filter: OperationFilter = {}, limit = 100): Promise<OperationRecord[]> {
  const rows = await getDatabase().getAllAsync<OperationRow>(
    `SELECT * FROM operations
     WHERE (? IS NULL OR type = ?) AND (? IS NULL OR status = ?)
     ORDER BY created_at DESC LIMIT ?`,
    filter.type ?? null,
    filter.type ?? null,
    filter.status ?? null,
    filter.status ?? null,
    limit,
  );
  return rows.map(toOperation);
}

export async function getOperation(id: string): Promise<{ record: OperationRecord; items: JournalItem[] } | null> {
  const db = getDatabase();
  const row = await db.getFirstAsync<OperationRow>('SELECT * FROM operations WHERE id = ?', id);
  if (!row) return null;
  const items = await db.getAllAsync<ItemRow>(
    'SELECT * FROM operation_items WHERE operation_id = ? ORDER BY position',
    id,
  );
  return { record: toOperation(row), items: items.map(toItem) };
}

export async function listTrash(): Promise<TrashRecord[]> {
  const rows = await getDatabase().getAllAsync<TrashRow>('SELECT * FROM trash_items ORDER BY deleted_at DESC');
  return rows.map(toTrash);
}

export async function getTrashForOperation(operationId: string): Promise<TrashRecord[]> {
  const rows = await getDatabase().getAllAsync<TrashRow>(
    'SELECT * FROM trash_items WHERE operation_id = ? ORDER BY deleted_at',
    operationId,
  );
  return rows.map(toTrash);
}

/**
 * Marks operations left 'running' by a previous process as interrupted, and returns them together with
 * the destination folders that may contain hidden partial files to clean up.
 */
export async function takeInterruptedOperations(): Promise<{ id: string; folders: string[] }[]> {
  const db = getDatabase();
  const running = await db.getAllAsync<{ id: string; destination_uri: string | null }>(
    "SELECT id, destination_uri FROM operations WHERE status = 'running'",
  );
  const result: { id: string; folders: string[] }[] = [];
  for (const op of running) {
    const parents = await db.getAllAsync<{ destination_parent_uri: string }>(
      'SELECT DISTINCT destination_parent_uri FROM operation_items WHERE operation_id = ? AND destination_parent_uri IS NOT NULL',
      op.id,
    );
    const folders = new Set(parents.map((p) => p.destination_parent_uri));
    if (op.destination_uri) folders.add(op.destination_uri);
    result.push({ id: op.id, folders: [...folders] });
    await db.runAsync(
      `UPDATE operations SET status = 'interrupted', reversible = 0, finished_at = ?,
         error_message = 'Fileora was closed before this operation finished.' WHERE id = ?`,
      Date.now(),
      op.id,
    );
  }
  return result;
}

/** Operations that touched `uri` as source or destination, newest first. */
export async function operationsForUri(uri: string, limit = 20): Promise<OperationRecord[]> {
  const rows = await getDatabase().getAllAsync<OperationRow>(
    `SELECT DISTINCT o.* FROM operations o JOIN operation_items i ON i.operation_id = o.id
     WHERE i.source_uri = ? OR i.destination_uri = ?
     ORDER BY o.created_at DESC LIMIT ?`,
    uri,
    uri,
    limit,
  );
  return rows.map(toOperation);
}
