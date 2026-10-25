import type { FileCategory } from '@/core/storage/types';
import { splitName } from '@/features/file_operations/conflicts';

/**
 * Pure analysis for Storage Detective. Everything here is conservative: only byte-identical files
 * (same SHA-256) count as reclaimable; name- and appearance-based groups are suggestions to review.
 */
export type ScannedFile = {
  uri: string;
  parentUri: string;
  locationId: string;
  name: string;
  path: string;
  size: number;
  modifiedAt: number | null;
  category: FileCategory;
  extension: string;
  mimeType: string | null;
};

export type DuplicateGroup = { key: string; size: number; files: ScannedFile[]; reclaimable: number };

/** Files that share a size are the only candidates worth hashing. */
export function sizeCandidates(files: ScannedFile[], minSize = 1): ScannedFile[][] {
  const bySize = new Map<number, ScannedFile[]>();
  for (const file of files) {
    if (file.size < minSize) continue;
    const list = bySize.get(file.size);
    if (list) list.push(file);
    else bySize.set(file.size, [file]);
  }
  return [...bySize.values()].filter((group) => group.length > 1);
}

/** Groups by verified content hash. Reclaimable assumes keeping one copy per group. */
export function exactDuplicates(hashed: { file: ScannedFile; sha256: string }[]): DuplicateGroup[] {
  const groups = new Map<string, ScannedFile[]>();
  for (const { file, sha256 } of hashed) {
    const key = `${file.size}:${sha256}`;
    const list = groups.get(key);
    if (list) list.push(file);
    else groups.set(key, [file]);
  }
  return [...groups.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([key, files]) => {
      const size = files[0]?.size ?? 0;
      // Oldest first: the first copy is the one we suggest keeping.
      const ordered = [...files].sort((a, b) => (a.modifiedAt ?? Infinity) - (b.modifiedAt ?? Infinity) || a.path.length - b.path.length);
      return { key, size, files: ordered, reclaimable: size * (files.length - 1) };
    })
    .sort((a, b) => b.reclaimable - a.reclaimable);
}

export function hammingDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    let x = parseInt(a[i] ?? '0', 16) ^ parseInt(b[i] ?? '0', 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

/**
 * Clusters images whose perceptual hashes are within `threshold` bits. Exact duplicates are excluded
 * by the caller; what remains are look-alikes (bursts, edits, re-saves) for the user to review.
 */
export function similarImageGroups(hashes: { file: ScannedFile; imageHash: string }[], threshold = 6): ScannedFile[][] {
  const parent = hashes.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    let node = i;
    while (parent[node] !== root) {
      const next = parent[node] ?? root;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  for (let i = 0; i < hashes.length; i += 1) {
    for (let j = i + 1; j < hashes.length; j += 1) {
      const a = hashes[i];
      const b = hashes[j];
      if (a && b && hammingDistance(a.imageHash, b.imageHash) <= threshold) parent[find(j)] = find(i);
    }
  }
  const clusters = new Map<number, ScannedFile[]>();
  hashes.forEach((entry, i) => {
    const root = find(i);
    const list = clusters.get(root);
    if (list) list.push(entry.file);
    else clusters.set(root, [entry.file]);
  });
  return [...clusters.values()].filter((group) => group.length > 1).sort((a, b) => b.length - a.length);
}

const COPY_SUFFIX = /(?:\s*[-_ ]\s*(?:copy|final|v\d+|\d+))+$|\s*\(\d+\)$/i;

/** "report.pdf", "report (1).pdf", "report copy.pdf", "report-final-v2.pdf" share the stem "report". */
export function exportStem(name: string): string {
  const { base, extension } = splitName(name, false);
  let stem = base.trim();
  let previous = '';
  while (stem !== previous) {
    previous = stem;
    stem = stem.replace(COPY_SUFFIX, '').trim();
  }
  return `${stem.toLowerCase()}${extension.toLowerCase()}`;
}

/** Files in the same folder sharing a stem, excluding groups that are exact duplicates already. */
export function repeatedExports(files: ScannedFile[], exactUris: Set<string>): ScannedFile[][] {
  const groups = new Map<string, ScannedFile[]>();
  for (const file of files) {
    if (file.category === 'folder' || exactUris.has(file.uri)) continue;
    const key = `${file.parentUri}|${exportStem(file.name)}`;
    const list = groups.get(key);
    if (list) list.push(file);
    else groups.set(key, [file]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1 && new Set(group.map((f) => f.name.toLowerCase())).size > 1)
    .map((group) => [...group].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0)))
    .sort((a, b) => b.reduce((s, f) => s + f.size, 0) - a.reduce((s, f) => s + f.size, 0));
}

export function oldDownloads(files: ScannedFile[], now: number, days = 90): ScannedFile[] {
  const cutoff = now - days * 86_400_000;
  return files
    .filter((f) => /(^|\/)downloads?(\/|$)/i.test(f.path) && f.modifiedAt !== null && f.modifiedAt < cutoff)
    .sort((a, b) => b.size - a.size);
}

export function largestFiles(files: ScannedFile[], count = 50): ScannedFile[] {
  return [...files].sort((a, b) => b.size - a.size).slice(0, count);
}

export function bytesByCategory(files: ScannedFile[]): { category: FileCategory; bytes: number; count: number }[] {
  const totals = new Map<FileCategory, { bytes: number; count: number }>();
  for (const file of files) {
    const current = totals.get(file.category) ?? { bytes: 0, count: 0 };
    current.bytes += file.size;
    current.count += 1;
    totals.set(file.category, current);
  }
  return [...totals.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.bytes - a.bytes);
}

export function bytesByTopFolder(files: ScannedFile[], count = 8): { folder: string; bytes: number }[] {
  const totals = new Map<string, number>();
  for (const file of files) {
    const top = file.path.includes('/') ? (file.path.split('/')[0] ?? '') : '(top level)';
    totals.set(top, (totals.get(top) ?? 0) + file.size);
  }
  return [...totals.entries()].map(([folder, bytes]) => ({ folder, bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, count);
}
