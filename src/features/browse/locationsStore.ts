import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { toFileoraError, type FileoraError } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';
import { getAllFilesAccess, loadLocations, type AllFilesAccess } from '@/core/storage/locations';
import type { StorageLocation } from '@/core/storage/types';

type LocationsState = {
  locations: StorageLocation[];
  allFilesAccess: AllFilesAccess | null;
  loaded: boolean;
  error: FileoraError | null;
  refresh: () => Promise<void>;
};

let inFlight: Promise<void> | null = null;

export const useLocations = create<LocationsState>()((set) => ({
  locations: [],
  allFilesAccess: null,
  loaded: false,
  error: null,
  refresh: () => {
    inFlight ??= (async () => {
      try {
        const [locations, allFilesAccess] = await Promise.all([loadLocations(), Promise.resolve(getAllFilesAccess())]);
        set({ locations, allFilesAccess, loaded: true, error: null });
      } catch (error) {
        logger.error('locations', 'Could not load locations', error);
        set({ loaded: true, error: toFileoraError(error) });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },
}));

export function findLocation(id: string | null | undefined): StorageLocation | undefined {
  return useLocations.getState().locations.find((location) => location.id === id);
}

/** Keeps locations fresh: initial load, and re-check when returning from system settings or pickers. */
export function useLocationsAutoRefresh(): void {
  const refresh = useLocations((state) => state.refresh);
  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
}
