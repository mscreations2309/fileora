import { randomUUID } from 'expo-crypto';
import { create } from 'zustand';

import { getDatabase } from '@/core/database/database';
import { storage } from '@/core/storage/storage';
import type { FileEntry } from '@/core/storage/types';

export type Workspace = {
  id: string;
  name: string;
  note: string;
  labels: string[];
  color: WorkspaceColor;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
  missingCount: number;
};

export type WorkspaceColor = 'indigo' | 'teal' | 'amber' | 'rose' | 'violet' | 'slate';
export const WORKSPACE_COLORS: WorkspaceColor[] = ['indigo', 'teal', 'amber', 'rose', 'violet', 'slate'];

export type WorkspaceItem = {
  workspaceId: string;
  uri: string;
  parentUri: string;
  locationId: string | null;
  name: string;
  isDirectory: boolean;
  size: number | null;
  mimeType: string | null;
  collection: string;
  note: string;
  missing: boolean;
  addedAt: number;
  checkedAt: number | null;
};

/** Bumped on every change so lists refresh. */
export const useWorkspaceRevision = create<{ revision: number; bump: () => void }>()((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

const bump = () => useWorkspaceRevision.getState().bump();

type WorkspaceRow = {
  id: string;
  name: string;
  note: string;
  labels: string;
  color: string;
  pinned: number;
  archived: number;
  created_at: number;
  updated_at: number;
  item_count: number;
  missing_count: number;
};

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    labels: row.labels ? row.labels.split(',').map((l) => l.trim()).filter(Boolean) : [],
    color: (WORKSPACE_COLORS as string[]).includes(row.color) ? (row.color as WorkspaceColor) : 'indigo',
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount: row.item_count,
    missingCount: row.missing_count,
  };
}

const SELECT_WORKSPACES = `SELECT w.*, COUNT(i.uri) AS item_count, COALESCE(SUM(i.missing), 0) AS missing_count
  FROM workspaces w LEFT JOIN workspace_items i ON i.workspace_id = w.id`;

export function validateWorkspaceName(value: string): string | null {
  const name = value.trim();
  if (!name) return 'Enter a name.';
  if (name.length > 80) return 'Use 80 characters or fewer.';
  return null;
}

export async function listWorkspaces(includeArchived = false): Promise<Workspace[]> {
  const rows = await getDatabase().getAllAsync<WorkspaceRow>(
    `${SELECT_WORKSPACES} WHERE (? = 1 OR w.archived = 0) GROUP BY w.id ORDER BY w.pinned DESC, w.updated_at DESC`,
    includeArchived ? 1 : 0,
  );
  return rows.map(toWorkspace);
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const row = await getDatabase().getFirstAsync<WorkspaceRow>(`${SELECT_WORKSPACES} WHERE w.id = ? GROUP BY w.id`, id);
  return row ? toWorkspace(row) : null;
}

export async function createWorkspace(name: string, color: WorkspaceColor = 'indigo'): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await getDatabase().runAsync(
    'INSERT INTO workspaces (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id,
    name.trim(),
    color,
    now,
    now,
  );
  bump();
  return id;
}

export async function updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'name' | 'note' | 'labels' | 'color' | 'pinned' | 'archived'>>): Promise<void> {
  const current = await getWorkspace(id);
  if (!current) return;
  const next = { ...current, ...patch };
  await getDatabase().runAsync(
    'UPDATE workspaces SET name = ?, note = ?, labels = ?, color = ?, pinned = ?, archived = ?, updated_at = ? WHERE id = ?',
    next.name.trim(),
    next.note,
    next.labels.join(', '),
    next.color,
    next.pinned ? 1 : 0,
    next.archived ? 1 : 0,
    Date.now(),
    id,
  );
  bump();
}

export async function deleteWorkspace(id: string): Promise<void> {
  // Only the workspace and its references are removed; files are never touched.
  await getDatabase().runAsync('DELETE FROM workspaces WHERE id = ?', id);
  bump();
}

type ItemRow = {
  workspace_id: string;
  uri: string;
  parent_uri: string;
  location_id: string | null;
  name: string;
  is_directory: number;
  size: number | null;
  mime_type: string | null;
  collection: string;
  note: string;
  missing: number;
  added_at: number;
  checked_at: number | null;
};

function toItem(row: ItemRow): WorkspaceItem {
  return {
    workspaceId: row.workspace_id,
    uri: row.uri,
    parentUri: row.parent_uri,
    locationId: row.location_id,
    name: row.name,
    isDirectory: row.is_directory === 1,
    size: row.size,
    mimeType: row.mime_type,
    collection: row.collection,
    note: row.note,
    missing: row.missing === 1,
    addedAt: row.added_at,
    checkedAt: row.checked_at,
  };
}

export async function listItems(workspaceId: string): Promise<WorkspaceItem[]> {
  const rows = await getDatabase().getAllAsync<ItemRow>(
    'SELECT * FROM workspace_items WHERE workspace_id = ? ORDER BY collection COLLATE NOCASE, name COLLATE NOCASE',
    workspaceId,
  );
  return rows.map(toItem);
}

export type ItemInput = Pick<FileEntry, 'uri' | 'parentUri' | 'name' | 'isDirectory' | 'size' | 'mimeType'> & { locationId: string | null };

export async function addItems(workspaceId: string, entries: ItemInput[], collection = ''): Promise<number> {
  const db = getDatabase();
  let added = 0;
  await db.withTransactionAsync(async () => {
    for (const entry of entries) {
      const result = await db.runAsync(
        `INSERT OR IGNORE INTO workspace_items (workspace_id, uri, parent_uri, location_id, name, is_directory, size, mime_type, collection, added_at, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        workspaceId,
        entry.uri,
        entry.parentUri,
        entry.locationId,
        entry.name,
        entry.isDirectory ? 1 : 0,
        entry.size,
        entry.mimeType,
        collection,
        Date.now(),
        Date.now(),
      );
      added += result.changes;
    }
    await db.runAsync('UPDATE workspaces SET updated_at = ? WHERE id = ?', Date.now(), workspaceId);
  });
  bump();
  return added;
}

export async function updateItem(workspaceId: string, uri: string, patch: { collection?: string; note?: string }): Promise<void> {
  await getDatabase().runAsync(
    'UPDATE workspace_items SET collection = COALESCE(?, collection), note = COALESCE(?, note) WHERE workspace_id = ? AND uri = ?',
    patch.collection ?? null,
    patch.note ?? null,
    workspaceId,
    uri,
  );
  bump();
}

export async function removeItems(workspaceId: string, uris: string[]): Promise<void> {
  const db = getDatabase();
  for (const uri of uris) await db.runAsync('DELETE FROM workspace_items WHERE workspace_id = ? AND uri = ?', workspaceId, uri);
  bump();
}

/**
 * Re-checks every reference. Items are marked missing when the file is gone or access was revoked;
 * a renamed item is matched again by searching its old folder for the same size (best effort).
 */
export async function checkItems(workspaceId: string): Promise<{ missing: number; relinked: number }> {
  const db = getDatabase();
  const items = await listItems(workspaceId);
  let missing = 0;
  let relinked = 0;
  for (const item of items) {
    const raw = await storage.stat(item.uri).catch(() => null);
    if (raw) {
      await db.runAsync(
        'UPDATE workspace_items SET missing = 0, name = ?, size = ?, checked_at = ? WHERE workspace_id = ? AND uri = ?',
        raw.name,
        raw.isDirectory ? null : raw.size,
        Date.now(),
        workspaceId,
        item.uri,
      );
      continue;
    }
    // Try to find a renamed copy in the same folder: same size and type, not already referenced.
    let replacement = null;
    if (!item.isDirectory && item.size) {
      const siblings = await storage.listChildren(item.parentUri).catch(() => []);
      const referenced = new Set(items.map((i) => i.uri));
      const candidates = siblings.filter((s) => !s.isDirectory && s.size === item.size && !referenced.has(s.uri));
      if (candidates.length === 1) replacement = candidates[0] ?? null;
    }
    if (replacement) {
      await db.runAsync(
        'UPDATE workspace_items SET uri = ?, name = ?, missing = 0, checked_at = ? WHERE workspace_id = ? AND uri = ?',
        replacement.uri,
        replacement.name,
        Date.now(),
        workspaceId,
        item.uri,
      );
      relinked += 1;
    } else {
      await db.runAsync('UPDATE workspace_items SET missing = 1, checked_at = ? WHERE workspace_id = ? AND uri = ?', Date.now(), workspaceId, item.uri);
      missing += 1;
    }
  }
  bump();
  return { missing, relinked };
}

export type ManifestOptions = { includeLocations: boolean; includeNotes: boolean };

/**
 * Builds a shareable manifest. By default it lists names, sizes and collections only — no file paths,
 * URIs or notes — so sharing a workspace never exposes private locations or file contents.
 */
export function buildManifest(workspace: Workspace, items: WorkspaceItem[], options: ManifestOptions): string {
  const manifest = {
    format: 'fileora-workspace',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: {
      name: workspace.name,
      labels: workspace.labels,
      ...(options.includeNotes ? { note: workspace.note } : {}),
    },
    items: items.map((item) => ({
      name: item.name,
      type: item.isDirectory ? 'folder' : 'file',
      size: item.size,
      collection: item.collection || undefined,
      ...(options.includeNotes && item.note ? { note: item.note } : {}),
      ...(options.includeLocations ? { location: item.uri } : {}),
      missing: item.missing || undefined,
    })),
  };
  return JSON.stringify(manifest, null, 2);
}

/** Workspaces that already contain `uri`, for the "Add to workspace" sheet. */
export async function workspacesContaining(uri: string): Promise<Set<string>> {
  const rows = await getDatabase().getAllAsync<{ workspace_id: string }>('SELECT workspace_id FROM workspace_items WHERE uri = ?', uri);
  return new Set(rows.map((r) => r.workspace_id));
}

type ManifestFile = {
  format?: string;
  version?: number;
  workspace?: { name?: string; labels?: string[]; note?: string };
  items?: { name?: string; type?: string; size?: number | null; collection?: string; note?: string; location?: string }[];
};

/**
 * Imports a workspace manifest (for example one received with Smart Handoff). Items are matched by
 * their saved location when it is accessible, otherwise by exact name and size in `candidates`.
 * Unmatched items are kept as missing references so nothing is silently dropped.
 */
export async function importManifest(json: string, findByName: (name: string, size: number | null) => Promise<ItemInput | null>): Promise<{ id: string; matched: number; missing: number }> {
  let manifest: ManifestFile;
  try {
    manifest = JSON.parse(json) as ManifestFile;
  } catch {
    throw new Error('This is not a valid workspace manifest');
  }
  if (manifest.format !== 'fileora-workspace' || !Array.isArray(manifest.items)) throw new Error('This is not a Fileora workspace manifest');
  const id = await createWorkspace(manifest.workspace?.name?.slice(0, 80) || 'Imported workspace');
  await updateWorkspace(id, { labels: (manifest.workspace?.labels ?? []).map(String).slice(0, 20), note: String(manifest.workspace?.note ?? '').slice(0, 500) });
  let matched = 0;
  let missing = 0;
  for (const item of manifest.items.slice(0, 5000)) {
    const name = String(item.name ?? '').slice(0, 255);
    if (!name) continue;
    let input: ItemInput | null = null;
    if (item.location) {
      const raw = await storage.stat(item.location).catch(() => null);
      if (raw) input = { uri: raw.uri, parentUri: '', locationId: null, name: raw.name, isDirectory: raw.isDirectory, size: raw.size, mimeType: raw.mimeType };
    }
    input ??= await findByName(name, item.size ?? null);
    if (input) {
      matched += await addItems(id, [input], String(item.collection ?? ''));
    } else {
      await addItems(id, [{ uri: `missing:${id}/${encodeURIComponent(name)}`, parentUri: '', locationId: null, name, isDirectory: item.type === 'folder', size: item.size ?? null, mimeType: null }], String(item.collection ?? ''));
      await getDatabase().runAsync('UPDATE workspace_items SET missing = 1 WHERE workspace_id = ? AND name = ?', id, name);
      missing += 1;
    }
  }
  bump();
  return { id, matched, missing };
}
