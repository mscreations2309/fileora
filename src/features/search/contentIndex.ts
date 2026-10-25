import { create } from 'zustand';

import { extractText, extractionMethodFor, type ExtractionMethod } from '@/core/content/extract';
import { getDatabase } from '@/core/database/database';
import { toFileoraError } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';
import { usePreferences } from '@/core/preferences/preferences';
import { categorize, mimeTypeFor } from '@/core/storage/fileTypes';
import { storage } from '@/core/storage/storage';
import type { FileCategory, StorageLocation } from '@/core/storage/types';

import { explainMatch, toFtsQuery, type ParsedQuery } from './queryUnderstanding';

/**
 * Opt-in local content index (SQLite FTS5). Incremental: files whose size and modification time are
 * unchanged are skipped. Text never leaves the device and can be deleted at any time.
 */

export type IndexerState = {
  running: boolean;
  phase: 'idle' | 'indexing' | 'done' | 'cancelled' | 'failed';
  foldersScanned: number;
  filesSeen: number;
  indexed: number;
  unchanged: number;
  failed: number;
  currentName: string | null;
  truncated: boolean;
  finishedAt: number | null;
};

const INITIAL: IndexerState = {
  running: false,
  phase: 'idle',
  foldersScanned: 0,
  filesSeen: 0,
  indexed: 0,
  unchanged: 0,
  failed: 0,
  currentName: null,
  truncated: false,
  finishedAt: null,
};

export const useIndexer = create<IndexerState & { cancelRequested: boolean }>()(() => ({ ...INITIAL, cancelRequested: false }));

const MAX_FOLDERS = 15_000;
const MAX_FILES = 60_000;
const SKIPPED_PATHS = new Set(['android/data', 'android/obb']);

type Known = { size: number | null; modifiedAt: number | null; status: string };

export function cancelIndexing(): void {
  useIndexer.setState({ cancelRequested: true });
}

export async function listExclusions(): Promise<{ uri: string; label: string }[]> {
  return getDatabase().getAllAsync<{ uri: string; label: string }>('SELECT uri, label FROM index_exclusions ORDER BY label');
}

export async function addExclusion(uri: string, label: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync('INSERT OR REPLACE INTO index_exclusions (uri, label, created_at) VALUES (?, ?, ?)', uri, label, Date.now());
  // Excluding a folder also removes what was already indexed from it.
  const like = `${uri.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  await db.runAsync("DELETE FROM content_fts WHERE uri IN (SELECT uri FROM content_index WHERE uri LIKE ? ESCAPE '\\')", like);
  await db.runAsync("DELETE FROM content_index WHERE uri LIKE ? ESCAPE '\\'", like);
}

export async function removeExclusion(uri: string): Promise<void> {
  await getDatabase().runAsync('DELETE FROM index_exclusions WHERE uri = ?', uri);
}

export async function clearIndex(): Promise<void> {
  const db = getDatabase();
  await db.execAsync('DELETE FROM content_fts; DELETE FROM content_index;');
  useIndexer.setState({ ...INITIAL, cancelRequested: false });
}

export async function indexStats(): Promise<{ documents: number; failed: number; unsupported: number; lastIndexedAt: number | null }> {
  const row = await getDatabase().getFirstAsync<{ documents: number; failed: number; unsupported: number; last: number | null }>(
    `SELECT SUM(status = 'indexed') AS documents, SUM(status = 'failed') AS failed, SUM(status = 'unsupported') AS unsupported,
            MAX(indexed_at) AS last FROM content_index`,
  );
  return { documents: row?.documents ?? 0, failed: row?.failed ?? 0, unsupported: row?.unsupported ?? 0, lastIndexedAt: row?.last ?? null };
}

/** Text previously extracted for a file, if it is indexed. Used by expiry, privacy and relationship features. */
export async function getIndexedText(uri: string): Promise<{ text: string; method: ExtractionMethod | null } | null> {
  const row = await getDatabase().getFirstAsync<{ body: string; method: string | null }>(
    'SELECT f.body AS body, c.method AS method FROM content_fts f JOIN content_index c ON c.uri = f.uri WHERE f.uri = ?',
    uri,
  );
  return row ? { text: row.body, method: row.method as ExtractionMethod | null } : null;
}

export async function indexedDocuments(limit = 5000): Promise<{ uri: string; name: string; parentUri: string; locationId: string | null; modifiedAt: number | null; method: ExtractionMethod }[]> {
  const rows = await getDatabase().getAllAsync<{ uri: string; name: string; parent_uri: string; location_id: string | null; modified_at: number | null; method: string }>(
    "SELECT uri, name, parent_uri, location_id, modified_at, method FROM content_index WHERE status = 'indexed' ORDER BY modified_at DESC LIMIT ?",
    limit,
  );
  return rows.map((r) => ({ uri: r.uri, name: r.name, parentUri: r.parent_uri, locationId: r.location_id, modifiedAt: r.modified_at, method: r.method as ExtractionMethod }));
}

async function store(file: { uri: string; parentUri: string; locationId: string; name: string; mimeType: string | null; size: number | null; modifiedAt: number | null }, outcome: { status: 'indexed' | 'failed' | 'unsupported'; method: ExtractionMethod | null; text: string; error: string | null }): Promise<void> {
  const db = getDatabase();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM content_fts WHERE uri = ?', file.uri);
    await db.runAsync(
      `INSERT OR REPLACE INTO content_index (uri, location_id, parent_uri, name, mime_type, size, modified_at, status, method, text_length, error, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      file.uri,
      file.locationId,
      file.parentUri,
      file.name,
      file.mimeType,
      file.size,
      file.modifiedAt,
      outcome.status,
      outcome.method,
      outcome.text.length,
      outcome.error,
      Date.now(),
    );
    if (outcome.status === 'indexed' && outcome.text.trim()) {
      await db.runAsync('INSERT INTO content_fts (uri, name, body) VALUES (?, ?, ?)', file.uri, file.name, outcome.text);
    }
  });
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Walks the given locations and indexes supported documents. Safe to call again; resumes incrementally. */
export async function runIndexing(locations: StorageLocation[]): Promise<void> {
  if (useIndexer.getState().running) return;
  useIndexer.setState({ ...INITIAL, running: true, phase: 'indexing', cancelRequested: false });
  const update = (patch: Partial<IndexerState>) => useIndexer.setState(patch);
  const includeImages = usePreferences.getState().indexImages;
  const showHidden = usePreferences.getState().showHiddenFiles;
  try {
    const db = getDatabase();
    const exclusions = (await listExclusions()).map((e) => e.uri);
    const knownRows = await db.getAllAsync<{ uri: string; size: number | null; modified_at: number | null; status: string; location_id: string | null }>(
      'SELECT uri, size, modified_at, status, location_id FROM content_index',
    );
    const known = new Map<string, Known>(knownRows.map((r) => [r.uri, { size: r.size, modifiedAt: r.modified_at, status: r.status }]));
    const seen = new Set<string>();
    const roots = locations.filter(
      (l) => l.status === 'available' && !(l.kind === 'shortcut' && locations.some((v) => v.kind === 'volume' && l.rootUri.startsWith(v.rootUri))),
    );
    const queue = roots.map((l) => ({ uri: l.rootUri, locationId: l.id, path: '' }));
    let state = { ...useIndexer.getState() };
    let lastEmit = 0;
    const emit = (force = false) => {
      const now = Date.now();
      if (force || now - lastEmit > 250) {
        lastEmit = now;
        update(state);
      }
    };
    let complete = true;
    while (queue.length > 0) {
      if (useIndexer.getState().cancelRequested) {
        complete = false;
        break;
      }
      if (state.foldersScanned >= MAX_FOLDERS || state.filesSeen >= MAX_FILES) {
        state = { ...state, truncated: true };
        complete = false;
        break;
      }
      const folder = queue.shift();
      if (!folder) break;
      if (exclusions.some((ex) => folder.uri.startsWith(ex))) continue;
      let children;
      try {
        children = await storage.listChildren(folder.uri);
      } catch {
        continue;
      }
      state = { ...state, foldersScanned: state.foldersScanned + 1 };
      for (const raw of children) {
        if (!showHidden && raw.isHidden) continue;
        const path = folder.path ? `${folder.path}/${raw.name}` : raw.name;
        if (raw.isDirectory) {
          if (!SKIPPED_PATHS.has(path.toLowerCase())) queue.push({ uri: raw.uri, locationId: folder.locationId, path });
          continue;
        }
        const mimeType = mimeTypeFor(raw.name, raw.mimeType);
        const method = extractionMethodFor(raw.name, mimeType);
        if (!method || (method === 'image-ocr' && !includeImages)) continue;
        if (exclusions.some((ex) => raw.uri.startsWith(ex))) continue;
        seen.add(raw.uri);
        state = { ...state, filesSeen: state.filesSeen + 1 };
        const previous = known.get(raw.uri);
        if (previous && previous.size === raw.size && previous.modifiedAt === raw.modifiedAt && previous.status !== 'failed') {
          state = { ...state, unchanged: state.unchanged + 1 };
          emit();
          continue;
        }
        if (useIndexer.getState().cancelRequested) break;
        state = { ...state, currentName: raw.name };
        emit();
        const file = { uri: raw.uri, parentUri: folder.uri, locationId: folder.locationId, name: raw.name, mimeType, size: raw.size, modifiedAt: raw.modifiedAt };
        try {
          const extraction = await extractText(file, { maxPdfPages: 5 });
          await store(file, { status: 'indexed', method: extraction.method, text: extraction.text, error: null });
          state = { ...state, indexed: state.indexed + 1 };
        } catch (error) {
          const failure = toFileoraError(error);
          await store(file, { status: failure.code === 'ERR_UNSUPPORTED' ? 'unsupported' : 'failed', method, text: '', error: failure.code });
          state = { ...state, failed: state.failed + 1 };
        }
        emit();
        await yieldToUi();
      }
    }
    if (complete) {
      // Forget files that disappeared from the indexed locations.
      const rootIds = new Set(roots.map((r) => r.id));
      for (const row of knownRows) {
        if (!seen.has(row.uri) && row.location_id && rootIds.has(row.location_id)) {
          await db.runAsync('DELETE FROM content_fts WHERE uri = ?', row.uri);
          await db.runAsync('DELETE FROM content_index WHERE uri = ?', row.uri);
        }
      }
    }
    const cancelled = useIndexer.getState().cancelRequested;
    update({ ...state, running: false, phase: cancelled ? 'cancelled' : 'done', currentName: null, finishedAt: Date.now() });
  } catch (error) {
    logger.error('index', 'Indexing failed', error);
    update({ running: false, phase: 'failed', currentName: null, finishedAt: Date.now() });
  } finally {
    useIndexer.setState({ cancelRequested: false });
  }
}

export type ContentHit = {
  uri: string;
  name: string;
  parentUri: string;
  locationId: string | null;
  mimeType: string | null;
  category: FileCategory;
  size: number | null;
  modifiedAt: number | null;
  method: ExtractionMethod | null;
  /** Snippet with \u0001…\u0002 around matched words. */
  snippet: string;
  exact: string[];
  related: string[];
  /** True when the document only matched through related words, not the words you typed. */
  approximate: boolean;
  rank: number;
};

type HitRow = {
  uri: string;
  name: string;
  parent_uri: string;
  location_id: string | null;
  mime_type: string | null;
  size: number | null;
  modified_at: number | null;
  method: string | null;
  snip: string;
  rank: number;
};

async function queryFts(match: string, parsed: ParsedQuery, limit: number): Promise<HitRow[]> {
  return getDatabase().getAllAsync<HitRow>(
    `SELECT c.uri, c.name, c.parent_uri, c.location_id, c.mime_type, c.size, c.modified_at, c.method,
            snippet(content_fts, 2, char(1), char(2), '…', 16) AS snip,
            bm25(content_fts, 0.0, 4.0, 1.0) AS rank
     FROM content_fts JOIN content_index c ON c.uri = content_fts.uri
     WHERE content_fts MATCH ?
       AND (? IS NULL OR c.modified_at >= ?)
       AND (? IS NULL OR c.modified_at < ?)
     ORDER BY rank LIMIT ?`,
    match,
    parsed.modifiedAfter,
    parsed.modifiedAfter,
    parsed.modifiedBefore,
    parsed.modifiedBefore,
    limit,
  );
}

/** Content search: exact matches first, then documents found only through related words. */
export async function searchContent(parsed: ParsedQuery, limit = 100): Promise<ContentHit[]> {
  const exactQuery = toFtsQuery(parsed, false);
  if (!exactQuery) return [];
  const relatedQuery = Object.keys(parsed.related).length > 0 ? toFtsQuery(parsed, true) : null;
  let rows: HitRow[] = [];
  try {
    rows = await queryFts(exactQuery, parsed, limit);
    if (relatedQuery) {
      const seen = new Set(rows.map((r) => r.uri));
      for (const row of await queryFts(relatedQuery, parsed, limit)) if (!seen.has(row.uri)) rows.push(row);
    }
  } catch (error) {
    logger.warn('index', 'Content query failed', error);
    return [];
  }
  const hits = rows
    .map((row): ContentHit => {
      const plain = row.snip.replace(/[\u0001\u0002]/g, '');
      const why = explainMatch(parsed, `${row.name} ${plain}`);
      const mimeType = row.mime_type;
      return {
        uri: row.uri,
        name: row.name,
        parentUri: row.parent_uri,
        locationId: row.location_id,
        mimeType,
        category: categorize(row.name, false, mimeType),
        size: row.size,
        modifiedAt: row.modified_at,
        method: row.method as ExtractionMethod | null,
        snippet: row.snip,
        exact: why.exact,
        related: why.related,
        approximate: why.exact.length < parsed.terms.length,
        rank: row.rank,
      };
    })
    .filter((hit) => {
      if (parsed.extensions.length > 0 && !parsed.extensions.some((ext) => hit.name.toLowerCase().endsWith(`.${ext}`))) return false;
      if (parsed.categories.length > 0 && !parsed.categories.includes(hit.category)) return false;
      return true;
    });
  hits.sort((a, b) => {
    if (a.approximate !== b.approximate) return a.approximate ? 1 : -1;
    if (parsed.preferLatest) return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
    return a.rank - b.rank;
  });
  return hits;
}
