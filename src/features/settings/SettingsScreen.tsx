import Constants from 'expo-constants';
import { LinearGradient } from 'expo-linear-gradient';
import Animated from 'react-native-reanimated';
import { useState } from 'react';
import { ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { APP_ID } from '@/core/config';
import { clearRegenerableData } from '@/core/database/database';
import { usePreferences, type Preferences } from '@/core/preferences/preferences';
import { useTheme } from '@/core/theme/ThemeProvider';
import { ACCENT_LABELS, ACCENT_THEMES, accentSwatch, type AccentTheme } from '@/core/theme/tokens';
import { useLibraryRevision } from '@/features/library/library';
import { ConfirmDialog, showToast } from '@/shared/components/overlays';
import { AppText, Card, Chip, Divider, Icon, ListItem, SectionHeader, usePop } from '@/shared/components/primitives';
import { PressableScale } from '@/shared/motion/PressableScale';

function Toggle({ title, description, value, onChange }: { title: string; description: string; value: boolean; onChange: (value: boolean) => void }) {
  const theme = useTheme();
  return (
    <ListItem
      title={title}
      subtitle={description}
      onPress={() => onChange(!value)}
      accessibilityLabel={`${title}. ${description}`}
      accessibilityHint={value ? 'On. Double tap to turn off' : 'Off. Double tap to turn on'}
      trailing={
        <Switch
          value={value}
          onValueChange={onChange}
          trackColor={{ true: theme.colors.primary, false: theme.colors.borderStrong }}
          thumbColor="#FFFFFF"
          accessibilityLabel={title}
        />
      }
    />
  );
}

function AccentSwatch({ accent, selected, onPress }: { accent: AccentTheme; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const pop = usePop(selected);
  return (
    <PressableScale haptic scaleTo={0.85} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${ACCENT_LABELS[accent]} accent`} onPress={onPress} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
      <Animated.View style={[{ width: 52, height: 52, borderRadius: 26, padding: 3, borderWidth: 2, borderColor: selected ? theme.colors.textPrimary : 'transparent' }, selected ? pop : null]}>
        <LinearGradient colors={accentSwatch(accent)} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1, borderRadius: 23, alignItems: 'center', justifyContent: 'center' }}>
          {selected ? <Icon name="check" size={22} color="#FFFFFF" /> : null}
        </LinearGradient>
      </Animated.View>
      <AppText variant="caption" tone={selected ? 'primary' : 'tertiary'} numberOfLines={1} adjustsFontSizeToFit>
        {ACCENT_LABELS[accent]}
      </AppText>
    </PressableScale>
  );
}

export function SettingsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const prefs = usePreferences();
  const [confirmClear, setConfirmClear] = useState(false);
  const set = <K extends keyof Preferences>(key: K) => (value: Preferences[K]) => prefs.setPreference(key, value);

  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: insets.bottom + theme.spacing.xxl }}>
      <SectionHeader title="Appearance" />
      <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
        <LinearGradient colors={theme.colors.heroGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: theme.radii.lg, padding: theme.spacing.lg, gap: theme.spacing.xs }}>
          <AppText variant="heading" tone="onGradient">{`${ACCENT_LABELS[prefs.accentTheme]} · ${theme.scheme === 'dark' ? 'Dark' : 'Light'}`}</AppText>
          <AppText variant="helper" tone="onGradient" style={{ opacity: 0.85 }}>
            This is how Fileora looks right now.
          </AppText>
        </LinearGradient>
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
          {(['system', 'light', 'dark'] as const).map((mode) => (
            <Chip key={mode} icon={mode === 'system' ? 'theme-light-dark' : mode === 'light' ? 'white-balance-sunny' : 'weather-night'} label={mode === 'system' ? 'Match system' : mode === 'light' ? 'Light' : 'Dark'} selected={prefs.themeMode === mode} onPress={() => prefs.setPreference('themeMode', mode)} />
          ))}
        </View>
        <View>
          <AppText variant="caption" tone="secondary" style={{ marginBottom: theme.spacing.sm }}>
            ACCENT COLOUR
          </AppText>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            {ACCENT_THEMES.map((accent) => (
              <AccentSwatch key={accent} accent={accent} selected={prefs.accentTheme === accent} onPress={() => prefs.setPreference('accentTheme', accent)} />
            ))}
          </View>
        </View>
      </Card>

      <SectionHeader title="Experience" />
      <Card>
        <Toggle title="Haptic feedback" description="Gentle taps when you press, select or finish something." value={prefs.haptics} onChange={set('haptics')} />
      </Card>
      <AppText variant="helper" tone="tertiary" style={{ paddingTop: theme.spacing.sm }}>
        Animations follow your device’s “Remove animations” setting.
      </AppText>

      <SectionHeader title="Files" />
      <Card>
        <Toggle title="Use Trash" description="Deleted items go to Fileora Trash first so you can restore them." value={prefs.useTrash} onChange={set('useTrash')} />
        <Divider inset={theme.spacing.lg} />
        <Toggle title="Show hidden files" description="Show names that start with a dot." value={prefs.showHiddenFiles} onChange={set('showHiddenFiles')} />
        <Divider inset={theme.spacing.lg} />
        <Toggle title="Folders first" description="List folders before files." value={prefs.foldersFirst} onChange={set('foldersFirst')} />
      </Card>

      <SectionHeader title="Privacy" />
      <Card>
        <ListItem title="Clear recent files and searches" subtitle="Removes Fileora's lists. Your files are not touched." onPress={() => setConfirmClear(true)} />
      </Card>
      <AppText variant="helper" tone="tertiary" style={{ paddingTop: theme.spacing.sm }}>
        Fileora has no account, no analytics and no cloud service. File names, contents and paths never leave your device unless you share them.
      </AppText>

      <SectionHeader title="About" />
      <Card>
        <ListItem title="Version" subtitle={Constants.expoConfig?.version ?? 'Unknown'} />
        <Divider inset={theme.spacing.lg} />
        <ListItem title="App identifier" subtitle={APP_ID} />
      </Card>

      <ConfirmDialog
        visible={confirmClear}
        title="Clear recent files and searches?"
        message="Fileora forgets which files you opened and what you searched for. Favorites, history and Trash are kept."
        confirmLabel="Clear"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          void clearRegenerableData().then(() => {
            useLibraryRevision.getState().bump();
            showToast('Recent files and searches cleared', 'success');
          });
        }}
      />
    </ScrollView>
  );
}
