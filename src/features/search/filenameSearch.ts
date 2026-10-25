import { getDatabase } from '@/core/database/database';
import { toFileoraError } from '@/core/errors/FileoraError';
import { storage, toFileEntry } from '@/core/storage/storage';
import type { FileCategory, FileEntry, StorageLocation } from '@/core/storage/types';

import { matchName, type NameMatch } from './ranking';

export type SearchFilters = {
  category: FileCategory | 'any';
  modifiedWithinDays: number | null;
  /** Additional constraints understood from the query text. */
  categories?: FileCategory[];
  extensions?: string[];
  modifiedAfter?: number | null;
  modifiedBefore?: number | null;
};

export type SearchHit = { entry: FileEntry; match: NameMatch };

export type SearchProgress = {
  foldersScanned: number;
  done: boolean;
  /** True when the scan budget was reached before every folder was visited. */
  truncated: boolean;
  /** Locations or folders that could not be read (e.g. revoked access). */
  unreadable: number;
};

export type SearchHandle = { cancel: () => void };

const MAX_FOLDERS = 4000;
const MAX_RESULTS = 500;
const BATCH_INTERVAL_MS = 120;
/** Android app-private trees: never readable by other apps and huge; skip outright. */
const SKIPPED_FOLDER_NAMES = new Set(['android/data', 'android/obb']);

/**
 * Breadth-first filename search across the given locations. Results are delivered in batches as
 * they are found, so the first matches appear immediately; call `cancel()` when the query changes.
 * This scans live folders and makes no index — content search arrives with the local index.
 */
export function searchFileNames(
  locations: StorageLocation[],
  query: string,
  filters: SearchFilters,
  options: { includeHidden: boolean },
  onResults: (hits: SearchHit[], progress: SearchProgress) => void,
): SearchHandle {
  let cancelled = false;
  const minModified = filters.modifiedWithinDays ? Date.now() - filters.modifiedWithinDays * 86_400_000 : null;
  const seenRoots = new Set<string>();
  const queue: { uri: string; locationId: string; path: string }[] = [];
  for (const location of locations) {
    if (location.status !== 'available' || seenRoots.has(location.rootUri)) continue;
    // Shortcuts live inside volumes; scanning both would duplicate results.
    if (location.kind === 'shortcut' && locations.some((l) => l.kind === 'volume' && location.rootUri.startsWith(l.rootUri))) continue;
    seenRoots.add(location.rootUri);
    queue.push({ uri: location.rootUri, locationId: location.id, path: '' });
  }

  const progress: SearchProgress = { foldersScanned: 0, done: false, truncated: false, unreadable: 0 };
  let pending: SearchHit[] = [];
  let lastFlush = Date.now();
  let total = 0;

  const flush = (force: boolean) => {
    if (cancelled) return;
    if (!force && Date.now() - lastFlush < BATCH_INTERVAL_MS) return;
    lastFlush = Date.now();
    const batch = pending;
    pending = [];
    onResults(batch, { ...progress });
  };

  const run = async () => {
    while (queue.length > 0 && !cancelled) {
      if (progress.foldersScanned >= MAX_FOLDERS || total >= MAX_RESULTS) {
        progress.truncated = true;
        break;
      }
      const folder = queue.shift();
      if (!folder) break;
      let children;
      try {
        children = await storage.listChildren(folder.uri);
      } catch (error) {
        if (toFileoraError(error).code !== 'ERR_NOT_FOUND') progress.unreadable += 1;
        continue;
      }
      progress.foldersScanned += 1;
      for (const raw of children) {
        if (cancelled) return;
        if (!options.includeHidden && raw.isHidden) continue;
        const childPath = folder.path ? `${folder.path}/${raw.name}` : raw.name;
        if (raw.isDirectory && !SKIPPED_FOLDER_NAMES.has(childPath.toLowerCase())) {
          queue.push({ uri: raw.uri, locationId: folder.locationId, path: childPath });
        }
        // A query made only of filters ("pdfs from last week") matches every file that passes them.
        const match = query.trim() ? matchName(raw.name, query) : { score: 0, ranges: [], reason: 'Matches your filters' };
        if (!match) continue;
        const entry = toFileEntry(raw, folder.uri, folder.locationId);
        if (filters.category !== 'any' && entry.category !== filters.category) continue;
        if (filters.categories?.length && !filters.categories.includes(entry.category)) continue;
        if (filters.extensions?.length && !filters.extensions.includes(entry.extension)) continue;
        if (minModified !== null && (entry.modifiedAt === null || entry.modifiedAt < minModified)) continue;
        if (filters.modifiedAfter && (entry.modifiedAt === null || entry.modifiedAt < filters.modifiedAfter)) continue;
        if (filters.modifiedBefore && (entry.modifiedAt === null || entry.modifiedAt >= filters.modifiedBefore)) continue;
        pending.push({ entry, match });
        total += 1;
      }
      flush(false);
    }
    progress.done = true;
    flush(true);
  };

  run().catch(() => {
    progress.done = true;
    flush(true);
  });

  return {
    cancel: () => {
      cancelled = true;
    },
  };
}

export async function recordSearch(query: string): Promise<void> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return;
  const db = getDatabase();
  await db.runAsync('INSERT OR REPLACE INTO search_history (query, searched_at) VALUES (?, ?)', trimmed, Date.now());
  await db.runAsync('DELETE FROM search_history WHERE query NOT IN (SELECT query FROM search_history ORDER BY searched_at DESC LIMIT 20)');
}

export async function recentSearches(): Promise<string[]> {
  const rows = await getDatabase().getAllAsync<{ query: string }>('SELECT query FROM search_history ORDER BY searched_at DESC LIMIT 8');
  return rows.map((row) => row.query);
}

export async function clearSearchHistory(): Promise<void> {
  await getDatabase().runAsync('DELETE FROM search_history');
}
