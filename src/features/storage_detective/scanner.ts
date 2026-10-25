import { randomUUID } from 'expo-crypto';
import { FileoraStorage } from 'fileora-storage';
import { create } from 'zustand';

import { getDatabase } from '@/core/database/database';
import { isCancellation } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';
import { usePreferences } from '@/core/preferences/preferences';
import { categorize, extensionOf, mimeTypeFor } from '@/core/storage/fileTypes';
import { storage } from '@/core/storage/storage';
import type { FileCategory, StorageLocation } from '@/core/storage/types';

import {
  bytesByCategory,
  bytesByTopFolder,
  exactDuplicates,
  largestFiles,
  oldDownloads,
  repeatedExports,
  similarImageGroups,
  sizeCandidates,
  type DuplicateGroup,
  type ScannedFile,
} from './analysis';

export type ScanResult = {
  files: ScannedFile[];
  totalBytes: number;
  categories: { category: FileCategory; bytes: number; count: number }[];
  topFolders: { folder: string; bytes: number }[];
  largest: ScannedFile[];
  duplicates: DuplicateGroup[];
  similar: ScannedFile[][] | null;
  repeated: ScannedFile[][];
  oldDownloads: ScannedFile[];
  hashes: Map<string, string>;
  imageHashes: Map<string, string>;
  hashFailures: number;
  locations: string[];
  finishedAt: number;
};

export type ScanState = {
  status: 'idle' | 'scanning' | 'hashing' | 'imaging' | 'done' | 'cancelled' | 'failed';
  foldersScanned: number;
  filesFound: number;
  bytesFound: number;
  processed: number;
  toProcess: number;
  currentName: string | null;
  truncated: boolean;
  result: ScanResult | null;
};

export const useDetective = create<ScanState & { cancelRequested: boolean; operationId: string | null }>()(() => ({
  status: 'idle',
  foldersScanned: 0,
  filesFound: 0,
  bytesFound: 0,
  processed: 0,
  toProcess: 0,
  currentName: null,
  truncated: false,
  result: null,
  cancelRequested: false,
  operationId: null,
}));

const MAX_FOLDERS = 20_000;
const MAX_FILES = 150_000;
const SKIPPED = new Set(['android/data', 'android/obb']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'bmp']);
const MAX_SIMILAR_IMAGES = 4000;

export function cancelScan(): void {
  const { operationId } = useDetective.getState();
  useDetective.setState({ cancelRequested: true });
  if (operationId) storage.cancel(operationId);
}

type CacheRow = { uri: string; size: number; modified_at: number | null; sha256: string | null; image_hash: string | null };

async function loadCache(): Promise<Map<string, CacheRow>> {
  const rows = await getDatabase().getAllAsync<CacheRow>('SELECT uri, size, modified_at, sha256, image_hash FROM file_hashes');
  return new Map(rows.map((r) => [r.uri, r]));
}

async function saveCache(file: ScannedFile, patch: { sha256?: string; imageHash?: string }): Promise<void> {
  await getDatabase().runAsync(
    `INSERT INTO file_hashes (uri, size, modified_at, sha256, image_hash, computed_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       sha256 = CASE WHEN excluded.size = file_hashes.size AND excluded.modified_at IS file_hashes.modified_at THEN COALESCE(excluded.sha256, file_hashes.sha256) ELSE excluded.sha256 END,
       image_hash = CASE WHEN excluded.size = file_hashes.size AND excluded.modified_at IS file_hashes.modified_at THEN COALESCE(excluded.image_hash, file_hashes.image_hash) ELSE excluded.image_hash END,
       size = excluded.size, modified_at = excluded.modified_at, computed_at = excluded.computed_at`,
    file.uri,
    file.size,
    file.modifiedAt,
    patch.sha256 ?? null,
    patch.imageHash ?? null,
    Date.now(),
  );
}

function cached(cache: Map<string, CacheRow>, file: ScannedFile): CacheRow | null {
  const row = cache.get(file.uri);
  return row && row.size === file.size && row.modified_at === file.modifiedAt ? row : null;
}

/** Recomputes every derived list from the file set; used after a scan and after items are removed. */
export function buildResult(files: ScannedFile[], hashes: Map<string, string>, imageHashes: Map<string, string>, base: Pick<ScanResult, 'hashFailures' | 'locations' | 'similar'>): ScanResult {
  const duplicates = exactDuplicates(files.filter((f) => hashes.has(f.uri)).map((file) => ({ file, sha256: hashes.get(file.uri) ?? '' })));
  const exactUris = new Set(duplicates.flatMap((g) => g.files.map((f) => f.uri)));
  const similar =
    base.similar === null
      ? null
      : similarImageGroups(files.filter((f) => imageHashes.has(f.uri) && !exactUris.has(f.uri)).map((file) => ({ file, imageHash: imageHashes.get(file.uri) ?? '' })));
  return {
    files,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    categories: bytesByCategory(files),
    topFolders: bytesByTopFolder(files),
    largest: largestFiles(files),
    duplicates,
    similar,
    repeated: repeatedExports(files, exactUris),
    oldDownloads: oldDownloads(files, Date.now()),
    hashes,
    imageHashes,
    hashFailures: base.hashFailures,
    locations: base.locations,
    finishedAt: Date.now(),
  };
}

export async function runScan(locations: StorageLocation[]): Promise<void> {
  const state = useDetective.getState();
  if (state.status === 'scanning' || state.status === 'hashing' || state.status === 'imaging') return;
  const operationId = randomUUID();
  useDetective.setState({ status: 'scanning', foldersScanned: 0, filesFound: 0, bytesFound: 0, processed: 0, toProcess: 0, currentName: null, truncated: false, cancelRequested: false, operationId });
  const showHidden = usePreferences.getState().showHiddenFiles;
  const roots = locations.filter((l) => l.status === 'available' && !(l.kind === 'shortcut' && locations.some((v) => v.kind === 'volume' && l.rootUri.startsWith(v.rootUri))));
  const files: ScannedFile[] = [];
  let foldersScanned = 0;
  let bytes = 0;
  let truncated = false;
  let lastEmit = 0;
  const emit = (patch: Partial<ScanState>, force = false) => {
    const now = Date.now();
    if (force || now - lastEmit > 200) {
      lastEmit = now;
      useDetective.setState(patch);
    }
  };
  try {
    const queue = roots.map((l) => ({ uri: l.rootUri, locationId: l.id, path: '' }));
    while (queue.length > 0 && !useDetective.getState().cancelRequested) {
      if (foldersScanned >= MAX_FOLDERS || files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      const folder = queue.shift();
      if (!folder) break;
      let children;
      try {
        children = await storage.listChildren(folder.uri);
      } catch {
        continue;
      }
      foldersScanned += 1;
      for (const raw of children) {
        if (!showHidden && raw.isHidden) continue;
        const path = folder.path ? `${folder.path}/${raw.name}` : raw.name;
        if (raw.isDirectory) {
          if (!SKIPPED.has(path.toLowerCase())) queue.push({ uri: raw.uri, locationId: folder.locationId, path });
          continue;
        }
        const size = raw.size ?? 0;
        const mimeType = mimeTypeFor(raw.name, raw.mimeType);
        files.push({
          uri: raw.uri,
          parentUri: folder.uri,
          locationId: folder.locationId,
          name: raw.name,
          path,
          size,
          modifiedAt: raw.modifiedAt,
          category: categorize(raw.name, false, mimeType),
          extension: extensionOf(raw.name),
          mimeType,
        });
        bytes += size;
      }
      emit({ foldersScanned, filesFound: files.length, bytesFound: bytes });
    }
    if (useDetective.getState().cancelRequested) {
      useDetective.setState({ status: 'cancelled' });
      return;
    }

    // Hash only same-size candidates; reuse cached hashes for unchanged files.
    const cache = await loadCache();
    const candidates = sizeCandidates(files, 1).flat();
    const hashes = new Map<string, string>();
    let hashFailures = 0;
    useDetective.setState({ status: 'hashing', processed: 0, toProcess: candidates.length, foldersScanned, filesFound: files.length, bytesFound: bytes, truncated });
    for (const [index, file] of candidates.entries()) {
      if (useDetective.getState().cancelRequested) break;
      const hit = cached(cache, file);
      if (hit?.sha256) {
        hashes.set(file.uri, hit.sha256);
      } else {
        emit({ currentName: file.name, processed: index });
        try {
          const sha256 = await storage.hash(file.uri, operationId);
          hashes.set(file.uri, sha256);
          await saveCache(file, { sha256 });
        } catch (error) {
          if (isCancellation(error)) break;
          hashFailures += 1;
        }
      }
    }
    const cancelled = useDetective.getState().cancelRequested;
    const result = buildResult(files, hashes, new Map(), { hashFailures, locations: roots.map((r) => r.label), similar: null });
    useDetective.setState({ status: cancelled ? 'cancelled' : 'done', currentName: null, result: cancelled ? null : result });
  } catch (error) {
    logger.error('detective', 'Scan failed', error);
    useDetective.setState({ status: 'failed', currentName: null });
  } finally {
    useDetective.setState({ cancelRequested: false, operationId: null });
  }
}

/** Optional second pass: perceptual hashes of photos to find look-alikes (Android). */
export async function findSimilarImages(): Promise<void> {
  const result = useDetective.getState().result;
  if (!result || !FileoraStorage) return;
  const native = FileoraStorage;
  const images = result.files.filter((f) => IMAGE_EXTENSIONS.has(f.extension)).slice(0, MAX_SIMILAR_IMAGES);
  useDetective.setState({ status: 'imaging', processed: 0, toProcess: images.length, cancelRequested: false });
  const cache = await loadCache();
  const imageHashes = new Map(result.imageHashes);
  let lastEmit = 0;
  for (const [index, file] of images.entries()) {
    if (useDetective.getState().cancelRequested) break;
    const hit = cached(cache, file);
    if (hit?.image_hash) {
      imageHashes.set(file.uri, hit.image_hash);
      continue;
    }
    try {
      const imageHash = await native.imageHash(file.uri);
      imageHashes.set(file.uri, imageHash);
      await saveCache(file, { imageHash });
    } catch {
      // Undecodable images are simply left out of the comparison.
    }
    if (Date.now() - lastEmit > 200) {
      lastEmit = Date.now();
      useDetective.setState({ processed: index + 1, currentName: file.name });
    }
  }
  const cancelled = useDetective.getState().cancelRequested;
  const next = buildResult(result.files, result.hashes, imageHashes, { hashFailures: result.hashFailures, locations: result.locations, similar: [] });
  useDetective.setState({ status: cancelled ? 'cancelled' : 'done', currentName: null, cancelRequested: false, result: cancelled ? result : next });
}

/** Removes files the user trashed from the in-memory result without rescanning. */
export function forgetFiles(uris: Set<string>): void {
  const result = useDetective.getState().result;
  if (!result) return;
  const files = result.files.filter((f) => !uris.has(f.uri));
  useDetective.setState({
    result: buildResult(files, result.hashes, result.imageHashes, { hashFailures: result.hashFailures, locations: result.locations, similar: result.similar === null ? null : [] }),
  });
}
