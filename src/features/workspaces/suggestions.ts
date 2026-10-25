import { usePreferences } from '@/core/preferences/preferences';
import type { FileEntry, StorageLocation } from '@/core/storage/types';
import { searchContent } from '@/features/search/contentIndex';
import { searchFileNames } from '@/features/search/filenameSearch';
import { parseQuery } from '@/features/search/queryUnderstanding';

import type { Workspace } from './repository';

export type Suggestion = {
  uri: string;
  parentUri: string;
  locationId: string;
  name: string;
  isDirectory: boolean;
  size: number | null;
  mimeType: string | null;
  reason: string;
};

/**
 * Suggests files for a workspace from its name and labels — only when the user asks. Every suggestion
 * says why it was proposed; nothing is added automatically.
 */
export async function suggestForWorkspace(workspace: Workspace, locations: StorageLocation[], existing: Set<string>): Promise<Suggestion[]> {
  const parsed = parseQuery([workspace.name, ...workspace.labels].join(' '));
  if (parsed.terms.length === 0) return [];
  const suggestions = new Map<string, Suggestion>();

  if (usePreferences.getState().contentIndexEnabled) {
    // Match any one term: workspace names are short, so requiring all words is too strict.
    for (const term of parsed.terms) {
      const hits = await searchContent({ ...parsed, terms: [term], related: parsed.related[term] ? { [term]: parsed.related[term] ?? [] } : {} }, 30);
      for (const hit of hits) {
        if (existing.has(hit.uri) || suggestions.has(hit.uri)) continue;
        suggestions.set(hit.uri, {
          uri: hit.uri,
          parentUri: hit.parentUri,
          locationId: hit.locationId ?? '',
          name: hit.name,
          isDirectory: false,
          size: hit.size,
          mimeType: hit.mimeType,
          reason: hit.approximate ? `Mentions “${hit.related[0] ?? term}” (related to “${term}”)` : `Mentions “${term}”`,
        });
      }
    }
  }

  for (const term of parsed.terms) {
    const entries = await new Promise<FileEntry[]>((resolve) => {
      const found: FileEntry[] = [];
      searchFileNames(locations, term, { category: 'any', modifiedWithinDays: null }, { includeHidden: false }, (batch, progress) => {
        found.push(...batch.map((hit) => hit.entry));
        if (progress.done || found.length >= 40) resolve(found);
      });
    });
    for (const entry of entries.slice(0, 40)) {
      if (existing.has(entry.uri) || suggestions.has(entry.uri)) continue;
      suggestions.set(entry.uri, {
        uri: entry.uri,
        parentUri: entry.parentUri,
        locationId: entry.locationId,
        name: entry.name,
        isDirectory: entry.isDirectory,
        size: entry.size,
        mimeType: entry.mimeType,
        reason: `Name contains “${term}”`,
      });
    }
  }
  return [...suggestions.values()].slice(0, 60);
}
