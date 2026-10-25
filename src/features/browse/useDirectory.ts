import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { toFileoraError, type FileoraError } from '@/core/errors/FileoraError';
import { usePreferences } from '@/core/preferences/preferences';
import { storage, toFileEntry } from '@/core/storage/storage';
import type { FileEntry } from '@/core/storage/types';
import { useOperations } from '@/features/file_operations/operationsStore';

import { filterHidden, sortEntries } from './sort';

export type DirectoryState = {
  entries: FileEntry[];
  status: 'loading' | 'ready' | 'error';
  error: FileoraError | null;
  refreshing: boolean;
  refresh: () => void;
};

type Listing = { uri: string; entries: FileEntry[]; error: FileoraError | null };

async function fetchListing(uri: string, locationId: string): Promise<Listing> {
  try {
    const children = await storage.listChildren(uri);
    return { uri, entries: children.map((child) => toFileEntry(child, uri, locationId)), error: null };
  } catch (cause) {
    return { uri, entries: [], error: toFileoraError(cause) };
  }
}

/**
 * Loads one folder. Responses for superseded requests (navigation, refresh) are discarded; the list
 * reloads after file operations finish and when the screen regains focus. Sorting and filtering
 * happen in memory without re-listing.
 */
export function useDirectory(uri: string, locationId: string): DirectoryState {
  const [listing, setListing] = useState<Listing | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  const revision = useOperations((state) => state.revision);
  const { sortField, sortDirection, foldersFirst, showHiddenFiles } = usePreferences();

  // Initial load, and reload whenever an operation finishes (the revision changes).
  useEffect(() => {
    const id = (requestId.current += 1);
    void fetchListing(uri, locationId).then((result) => {
      if (id === requestId.current) setListing(result);
    });
    return () => {
      requestId.current += 1;
    };
  }, [uri, locationId, revision]);

  const reload = useCallback(() => {
    const id = (requestId.current += 1);
    void fetchListing(uri, locationId).then((result) => {
      if (id !== requestId.current) return;
      setListing(result);
      setRefreshing(false);
    });
  }, [uri, locationId]);

  // Pick up changes made by other apps when returning to this screen (skip the first focus).
  const focusCount = useRef(0);
  useFocusEffect(
    useCallback(() => {
      if ((focusCount.current += 1) > 1) reload();
    }, [reload]),
  );

  const current = listing?.uri === uri ? listing : null;
  const entries = useMemo(
    () => sortEntries(filterHidden(current?.entries ?? [], showHiddenFiles), { field: sortField, direction: sortDirection, foldersFirst }),
    [current, showHiddenFiles, sortField, sortDirection, foldersFirst],
  );

  return {
    entries,
    status: !current ? 'loading' : current.error ? 'error' : 'ready',
    error: current?.error ?? null,
    refreshing,
    refresh: () => {
      setRefreshing(true);
      reload();
    },
  };
}
