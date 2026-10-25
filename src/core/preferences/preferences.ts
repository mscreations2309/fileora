import { create } from 'zustand';

import { getDatabase } from '@/core/database/database';
import { logger } from '@/core/logging/logger';

import type { AccentTheme } from '@/core/theme/tokens';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ViewMode = 'list' | 'grid';
export type SortField = 'name' | 'size' | 'modified' | 'type';
export type SortDirection = 'asc' | 'desc';

export type Preferences = {
  themeMode: ThemeMode;
  accentTheme: AccentTheme;
  /** Light taps on presses and confirmations. */
  haptics: boolean;
  viewMode: ViewMode;
  sortField: SortField;
  sortDirection: SortDirection;
  foldersFirst: boolean;
  showHiddenFiles: boolean;
  /** Delete moves items to the Fileora trash first; permanent deletion is a separate, explicit action. */
  useTrash: boolean;
  storageOnboardingSeen: boolean;
  /** Opt-in: read document text on this device to enable content search. */
  contentIndexEnabled: boolean;
  /** Opt-in: also run OCR on photos and screenshots while indexing (slower). */
  indexImages: boolean;
  /** Vault locks immediately when the app goes to the background. */
  vaultLockOnBackground: boolean;
  /** Minutes of inactivity before the vault locks. */
  vaultAutoLockMinutes: number;
  /** Fileora Web: laptops on the same network (or this phone's hotspot) can manage files in a browser. */
  remoteAccessEnabled: boolean;
};

export const DEFAULT_PREFERENCES: Preferences = {
  themeMode: 'system',
  accentTheme: 'iris',
  haptics: true,
  viewMode: 'list',
  sortField: 'name',
  sortDirection: 'asc',
  foldersFirst: true,
  showHiddenFiles: false,
  useTrash: true,
  storageOnboardingSeen: false,
  contentIndexEnabled: false,
  indexImages: false,
  vaultLockOnBackground: true,
  vaultAutoLockMinutes: 2,
  remoteAccessEnabled: false,
};

type PreferencesState = Preferences & {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
};

function isValid<K extends keyof Preferences>(key: K, value: unknown): value is Preferences[K] {
  return typeof value === typeof DEFAULT_PREFERENCES[key];
}

export const usePreferences = create<PreferencesState>()((set) => ({
  ...DEFAULT_PREFERENCES,
  hydrated: false,
  hydrate: async () => {
    const rows = await getDatabase().getAllAsync<{ key: string; value: string }>('SELECT key, value FROM preferences');
    const loaded: Partial<Preferences> = {};
    for (const row of rows) {
      if (!(row.key in DEFAULT_PREFERENCES)) continue;
      const key = row.key as keyof Preferences;
      try {
        const value: unknown = JSON.parse(row.value);
        if (isValid(key, value)) (loaded as Record<string, unknown>)[key] = value;
      } catch {
        logger.warn('preferences', `Ignoring unreadable preference ${row.key}`);
      }
    }
    set({ ...loaded, hydrated: true });
  },
  setPreference: (key, value) => {
    set({ [key]: value } as Partial<PreferencesState>);
    getDatabase()
      .runAsync('INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)', key, JSON.stringify(value))
      .catch((error: unknown) => logger.error('preferences', `Failed to save ${key}`, error));
  },
}));
