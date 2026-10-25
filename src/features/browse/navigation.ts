import { router } from 'expo-router';

import { storage } from '@/core/storage/storage';
import type { FileEntry, StorageLocation } from '@/core/storage/types';

/** One breadcrumb. SAF folders cannot be resolved upwards from their URI, so the trail is carried along. */
export type Crumb = { name: string; uri: string };

export type FolderParams = { loc: string; uri: string; trail: string };

export function parseTrail(raw: string | string[] | undefined): Crumb[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((c): c is Crumb => typeof c === 'object' && c !== null && typeof c.name === 'string' && typeof c.uri === 'string')
      : [];
  } catch {
    return [];
  }
}

export function openLocation(location: StorageLocation): void {
  const trail: Crumb[] = [{ name: location.label, uri: location.rootUri }];
  router.push({ pathname: '/folder', params: { loc: location.id, uri: location.rootUri, trail: JSON.stringify(trail) } });
}

export function openSubfolder(entry: FileEntry, trail: Crumb[]): void {
  const next = [...trail, { name: entry.name, uri: entry.uri }];
  router.push({ pathname: '/folder', params: { loc: entry.locationId, uri: entry.uri, trail: JSON.stringify(next) } });
}

/** Opens a folder reached from outside the browse stack (search, history, favorites). */
export function openFolderDirect(locationId: string, uri: string, name: string, trail?: Crumb[]): void {
  const crumbs = trail ?? [{ name, uri }];
  router.push({ pathname: '/folder', params: { loc: locationId, uri, trail: JSON.stringify(crumbs) } });
}

export function openDetails(entry: Pick<FileEntry, 'uri' | 'locationId' | 'parentUri' | 'name'>): void {
  router.push({ pathname: '/file', params: { uri: entry.uri, loc: entry.locationId, parent: entry.parentUri, name: entry.name } });
}

/** Opens the folder containing `entry`, resolving the folder's real name for the breadcrumb. */
export async function showInFolder(entry: Pick<FileEntry, 'parentUri' | 'locationId'>): Promise<void> {
  const parent = await storage.stat(entry.parentUri).catch(() => null);
  openFolderDirect(entry.locationId, entry.parentUri, parent?.name ?? 'Folder');
}
