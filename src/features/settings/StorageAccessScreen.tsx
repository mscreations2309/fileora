import { Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { presentError, toFileoraError } from '@/core/errors/FileoraError';
import { usePreferences } from '@/core/preferences/preferences';
import { forgetGrantedFolder, requestAllFilesAccess } from '@/core/storage/locations';
import { hasNativeStorage } from '@/core/storage/storage';
import { useTheme } from '@/core/theme/ThemeProvider';
import { addFolder } from '@/features/browse/components/LocationList';
import { useLocations } from '@/features/browse/locationsStore';
import { LocationGlyph } from '@/shared/components/FileIcon';
import { showToast } from '@/shared/components/overlays';
import { AppText, Badge, Button, Card, Divider, Icon, IconButton, ListItem, SectionHeader, type IconName } from '@/shared/components/primitives';

function Point({ icon, text }: { icon: IconName; text: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.md, alignItems: 'flex-start' }}>
      <Icon name={icon} size={theme.iconSizes.md} color={theme.colors.accent} />
      <AppText variant="body" tone="secondary" style={{ flex: 1 }}>
        {text}
      </AppText>
    </View>
  );
}

/** Permission education: explains each access model before the system prompt appears. */
export function StorageAccessScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { allFilesAccess, locations, refresh } = useLocations();
  const setPreference = usePreferences((state) => state.setPreference);
  const granted = locations.filter((l) => l.kind === 'grantedFolder');

  const requestBroad = async () => {
    setPreference('storageOnboardingSeen', true);
    try {
      await requestAllFilesAccess();
    } finally {
      await refresh();
    }
  };

  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: insets.bottom + theme.spacing.xxl, gap: theme.spacing.lg }}>
      {Platform.OS === 'android' && hasNativeStorage ? (
        <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
            <LocationGlyph icon="phone" />
            <AppText variant="heading" style={{ flex: 1 }}>
              All files access
            </AppText>
            <Badge label={allFilesAccess?.granted ? 'Allowed' : 'Not allowed'} tone={allFilesAccess?.granted ? 'success' : 'neutral'} />
          </View>
          <Point icon="folder-multiple-outline" text="Browse, search and organize everything in shared storage, SD cards and USB drives, like a desktop file manager." />
          <Point icon="shield-lock-outline" text="Android still protects other apps' private data. Fileora works offline and never uploads files." />
          <Point icon="information-outline" text={allFilesAccess?.mode === 'legacy' ? 'Android will ask for storage permission.' : 'Android opens a settings page. Turn on “Allow access to manage all files”, then come back.'} />
          {allFilesAccess?.granted ? (
            <AppText variant="helper" tone="tertiary">
              You can turn this off any time in Android Settings › Apps › Fileora › Permissions.
            </AppText>
          ) : (
            <Button label={allFilesAccess?.mode === 'legacy' ? 'Allow storage access' : 'Open Android settings'} icon="open-in-new" onPress={() => void requestBroad()} />
          )}
        </Card>
      ) : null}

      <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
          <LocationGlyph icon="folder" />
          <AppText variant="heading" style={{ flex: 1 }}>
            {Platform.OS === 'ios' ? 'Folders from Files' : 'Individual folders'}
          </AppText>
        </View>
        <Point icon="check-circle-outline" text="Fileora only sees the folders you pick, and everything inside them." />
        {Platform.OS === 'ios' ? (
          <Point icon="timer-sand" text="iOS grants folder access until Fileora closes. After restarting, pick the folder again. Files in “On My Device” are always available." />
        ) : (
          <Point icon="sd" text="Works for SD cards and USB drives too. Android remembers your choice until you remove it here." />
        )}
        <Button label="Choose a folder" variant="secondary" icon="folder-plus-outline" onPress={() => void addFolder()} />
      </Card>

      {granted.length > 0 ? (
        <View>
          <SectionHeader title="Granted folders" />
          <Card>
            {granted.map((location, index) => (
              <View key={location.id}>
                {index > 0 ? <Divider inset={72} /> : null}
                <ListItem
                  title={location.label}
                  subtitle={location.description}
                  leading={<LocationGlyph icon="folder" muted={location.status !== 'available'} />}
                  trailing={
                    <IconButton
                      icon="close"
                      label={`Remove access to ${location.label}`}
                      onPress={() => {
                        forgetGrantedFolder(location)
                          .then(() => refresh())
                          .then(() => showToast(`Removed “${location.label}”. Fileora can no longer access it.`, 'success'))
                          .catch((error: unknown) => showToast(presentError(toFileoraError(error)).title, 'error'));
                      }}
                    />
                  }
                />
              </View>
            ))}
          </Card>
        </View>
      ) : null}
    </ScrollView>
  );
}
