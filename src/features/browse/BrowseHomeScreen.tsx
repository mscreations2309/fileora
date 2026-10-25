import { useMemo } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';

import { presentError } from '@/core/errors/FileoraError';
import { useTheme } from '@/core/theme/ThemeProvider';
import { EmptyState, IconButton, SectionHeader } from '@/shared/components/primitives';
import { TabScreen } from '@/shared/components/TabScreen';

import { addFolder, LocationCard, StorageAccessPrompt } from './components/LocationList';
import { useLocations } from './locationsStore';

export function BrowseHomeScreen() {
  const theme = useTheme();
  const { locations, loaded, error, refresh } = useLocations();
  const groups = useMemo(
    () => ({
      storage: locations.filter((l) => l.kind === 'volume' || l.kind === 'appSandbox'),
      shortcuts: locations.filter((l) => l.kind === 'shortcut'),
      folders: locations.filter((l) => l.kind === 'grantedFolder'),
    }),
    [locations],
  );

  return (
    <TabScreen
      title="Browse"
      onRefresh={() => void refresh()}
      headerAccessory={<IconButton icon="folder-plus-outline" label="Add a folder" onPress={() => void addFolder()} />}
    >
      <StorageAccessPrompt />
      {!loaded ? (
        <View style={{ padding: theme.spacing.xxl }}>
          <ActivityIndicator color={theme.colors.primary} accessibilityLabel="Loading locations" />
        </View>
      ) : error ? (
        <EmptyState tone="error" icon="alert-circle-outline" title={presentError(error).title} message={presentError(error).guidance} action={{ label: 'Try again', onPress: () => void refresh() }} />
      ) : (
        <View style={{ paddingHorizontal: theme.spacing.lg }}>
          {groups.storage.length > 0 ? (
            <>
              <SectionHeader title="Storage" />
              <LocationCard locations={groups.storage} />
            </>
          ) : null}
          {groups.shortcuts.length > 0 ? (
            <>
              <SectionHeader title="Folders" />
              <LocationCard locations={groups.shortcuts} />
            </>
          ) : null}
          <SectionHeader title={Platform.OS === 'ios' ? 'Folders from Files' : 'Folders you granted'} action={{ label: 'Add', onPress: () => void addFolder() }} />
          {groups.folders.length > 0 ? (
            <LocationCard locations={groups.folders} />
          ) : (
            <EmptyState
              icon="folder-key-outline"
              title="No folders added"
              message={
                Platform.OS === 'ios'
                  ? 'Add a folder from iCloud Drive, On My iPhone, or another provider. iOS grants access until Fileora closes.'
                  : 'Grant access to a specific folder, an SD card, or a USB drive using the system picker.'
              }
              action={{ label: 'Add a folder', icon: 'folder-plus-outline', onPress: () => void addFolder() }}
            />
          )}
        </View>
      )}
    </TabScreen>
  );
}
