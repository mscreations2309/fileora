import { router } from 'expo-router';
import { Platform, View } from 'react-native';

import { presentError, toFileoraError } from '@/core/errors/FileoraError';
import { formatBytes } from '@/core/format/format';
import { grantFolder } from '@/core/storage/locations';
import type { StorageLocation } from '@/core/storage/types';
import { useTheme } from '@/core/theme/ThemeProvider';
import { LocationGlyph } from '@/shared/components/FileIcon';
import { showToast } from '@/shared/components/overlays';
import { AppText, Button, Card, Divider, FadeIn, Icon, ListItem } from '@/shared/components/primitives';

import { useLocations } from '../locationsStore';
import { openLocation } from '../navigation';

function locationSubtitle(location: StorageLocation): string | undefined {
  if (location.status !== 'available') return location.description;
  if (location.totalBytes && location.freeBytes !== null && location.freeBytes !== undefined) {
    return `${formatBytes(location.freeBytes)} free of ${formatBytes(location.totalBytes)}`;
  }
  return location.description;
}

export function LocationRow({ location }: { location: StorageLocation }) {
  const theme = useTheme();
  const available = location.status === 'available';
  return (
    <ListItem
      title={location.label}
      subtitle={locationSubtitle(location)}
      leading={<LocationGlyph icon={location.icon} muted={!available} />}
      trailing={available ? <Icon name="chevron-right" color={theme.colors.textTertiary} /> : <Icon name="alert-circle-outline" color={theme.colors.warning} />}
      onPress={() => (available ? openLocation(location) : router.push('/storage-access'))}
      accessibilityHint={available ? 'Opens this location' : 'Opens storage access settings to fix this location'}
    />
  );
}

export function LocationCard({ locations }: { locations: StorageLocation[] }) {
  return (
    <Card>
      {locations.map((location, index) => (
        <FadeIn key={location.id} index={index}>
          {index > 0 ? <Divider inset={72} /> : null}
          <LocationRow location={location} />
        </FadeIn>
      ))}
    </Card>
  );
}

export async function addFolder(): Promise<void> {
  try {
    const location = await grantFolder();
    if (!location) return;
    await useLocations.getState().refresh();
    showToast(
      Platform.OS === 'ios' ? `Added “${location.label}”. iOS keeps this access until Fileora closes.` : `Added “${location.label}”`,
      'success',
    );
  } catch (error) {
    showToast(presentError(toFileoraError(error)).title, 'error');
  }
}

/** Prompts for broad access when Fileora cannot see device storage yet. Explains before asking. */
export function StorageAccessPrompt() {
  const theme = useTheme();
  const access = useLocations((state) => state.allFilesAccess);
  const locations = useLocations((state) => state.locations);
  const hasGrantedFolders = locations.some((l) => l.kind === 'grantedFolder');
  if (Platform.OS === 'android' && access && !access.granted) {
    return (
      <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.md, marginHorizontal: theme.spacing.lg, marginTop: theme.spacing.lg }}>
        <View style={{ flexDirection: 'row', gap: theme.spacing.md, alignItems: 'center' }}>
          <Icon name="folder-key-outline" color={theme.colors.primary} size={theme.iconSizes.xl} />
          <AppText variant="heading" style={{ flex: 1 }}>
            {hasGrantedFolders ? 'See all your files' : 'Let Fileora see your files'}
          </AppText>
        </View>
        <AppText variant="body" tone="secondary">
          Allow access to device storage, or choose individual folders. Fileora works offline and never uploads your files.
        </AppText>
        <Button label="Review access options" icon="arrow-right" onPress={() => router.push('/storage-access')} />
      </Card>
    );
  }
  return null;
}
