import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { formatBytes, formatShortDate } from '@/core/format/format';
import { categorize, mimeTypeFor } from '@/core/storage/fileTypes';
import { storage, toFileEntry } from '@/core/storage/storage';
import { useTheme } from '@/core/theme/ThemeProvider';
import { StorageAccessPrompt } from '@/features/browse/components/LocationList';
import { findLocation, useLocations } from '@/features/browse/locationsStore';
import { openFolderDirect } from '@/features/browse/navigation';
import { listOperations } from '@/features/file_operations/journal';
import { useOperations } from '@/features/file_operations/operationsStore';
import type { OperationRecord } from '@/features/file_operations/types';
import { useFileActions } from '@/features/file_operations/useFileActions';
import { listFavorites, listRecents, removeRecent, useLibraryRevision, type Favorite, type RecentFile } from '@/features/library/library';
import { FileIcon } from '@/shared/components/FileIcon';
import { showToast } from '@/shared/components/overlays';
import { AppText, Card, Divider, FadeIn, GradientTile, Icon, ListItem, SectionHeader, type IconName } from '@/shared/components/primitives';
import { StorageRing } from '@/shared/components/StorageRing';
import { TabScreen } from '@/shared/components/TabScreen';
import { PressableScale } from '@/shared/motion/PressableScale';

type Shortcut = { icon: IconName; label: string; href: Href; colors?: [string, string] };

const SHORTCUTS: Shortcut[] = [
  { icon: 'folder-outline', label: 'Browse', href: '/browse' },
  { icon: 'text-search', label: 'Search', href: '/search', colors: ['#00B3A4', '#2F8CFF'] },
  { icon: 'shield-lock-outline', label: 'Vault', href: '/vault', colors: ['#7C3AED', '#DB2777'] },
  { icon: 'database-search-outline', label: 'Cleanup', href: '/detective', colors: ['#F97316', '#E11D48'] },
  { icon: 'briefcase-outline', label: 'Workspaces', href: '/workspaces', colors: ['#0EA5E9', '#6366F1'] },
  { icon: 'calendar-clock', label: 'Expiry', href: '/expiry', colors: ['#F59E0B', '#EF4444'] },
  { icon: 'cellphone-arrow-down', label: 'Handoff', href: '/handoff', colors: ['#10B981', '#0EA5E9'] },
  { icon: 'history', label: 'History', href: '/history', colors: ['#64748B', '#334155'] },
];

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

export function HomeScreen() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const locations = useLocations((state) => state.locations);
  const libraryRevision = useLibraryRevision((state) => state.revision);
  const operationsRevision = useOperations((state) => state.revision);
  const actions = useFileActions();
  const [recents, setRecents] = useState<RecentFile[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [activity, setActivity] = useState<OperationRecord[]>([]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void Promise.all([listRecents(10), listFavorites(), listOperations({}, 4)]).then(([r, f, a]) => {
        if (!active) return;
        setRecents(r);
        setFavorites(f);
        setActivity(a);
      });
      return () => {
        active = false;
      };
      // Revisions are dependencies so the lists refresh after changes even while focused.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [libraryRevision, operationsRevision]),
  );

  const primary = locations.find((l) => l.kind === 'volume' && l.id === 'volume:primary') ?? locations.find((l) => l.kind === 'volume');
  const used = primary?.totalBytes && primary.freeBytes != null ? primary.totalBytes - primary.freeBytes : null;

  const openRecent = async (recent: RecentFile) => {
    const raw = await storage.stat(recent.uri).catch(() => null);
    if (!raw) {
      await removeRecent(recent.uri);
      showToast(`“${recent.name}” is no longer available. It may have been moved or deleted.`, 'error');
      return;
    }
    actions.open(toFileEntry(raw, '', recent.locationId ?? ''));
  };

  const openFavorite = async (favorite: Favorite) => {
    const raw = await storage.stat(favorite.uri).catch(() => null);
    if (!raw) {
      showToast(`“${favorite.name}” is no longer available.`, 'error');
      return;
    }
    if (raw.isDirectory) openFolderDirect(favorite.locationId ?? '', favorite.uri, favorite.name);
    else actions.open(toFileEntry(raw, '', favorite.locationId ?? ''));
  };

  const columns = width > 600 ? 8 : 4;
  const tileWidth = (width - theme.spacing.lg * 2 - theme.spacing.sm * (columns - 1)) / columns;

  const hero = (
    <LinearGradient colors={theme.colors.heroGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, styles.hero, { borderBottomLeftRadius: theme.radii.xxl, borderBottomRightRadius: theme.radii.xxl }]}>
      <View style={[styles.orb, { backgroundColor: 'rgba(255,255,255,0.10)', top: -60, right: -40 }]} />
      <View style={[styles.orb, { backgroundColor: 'rgba(255,255,255,0.06)', width: 160, height: 160, bottom: 20, left: -50 }]} />
    </LinearGradient>
  );

  return (
    <TabScreen title={greeting()} subtitle="Your files. Your control." hero={hero}>
      <FadeIn index={0}>
        <PressableScale
          haptic
          scaleTo={0.98}
          accessibilityRole="search"
          accessibilityLabel="Search files"
          onPress={() => router.navigate('/search')}
          style={[styles.search, { marginHorizontal: theme.spacing.lg, marginTop: theme.spacing.lg, backgroundColor: theme.colors.surfaceGlass, borderRadius: theme.radii.lg, paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm }, theme.elevation('medium')]}
        >
          <Icon name="magnify" size={theme.iconSizes.md} color={theme.colors.primary} />
          <AppText variant="body" tone="tertiary" style={styles.flex}>
            Search names or what’s inside
          </AppText>
        </PressableScale>
      </FadeIn>

      {used !== null && primary?.totalBytes ? (
        <FadeIn index={1}>
          <PressableScale
            haptic
            scaleTo={0.98}
            accessibilityRole="button"
            accessibilityLabel={`${primary.label}: ${formatBytes(used)} used of ${formatBytes(primary.totalBytes)}. Opens Storage Detective.`}
            onPress={() => router.push('/detective')}
            style={[{ marginHorizontal: theme.spacing.lg, marginTop: theme.spacing.lg, borderRadius: theme.radii.xxl, overflow: 'hidden' }, theme.elevation('high')]}
          >
            <LinearGradient colors={theme.colors.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.storageCard, { padding: theme.spacing.xl, gap: theme.spacing.xl }]}>
              <StorageRing fraction={used / primary.totalBytes} label="used" onGradient />
              <View style={[styles.flex, { gap: theme.spacing.sm }]}>
                <AppText variant="caption" tone="onGradient" style={{ opacity: 0.85, letterSpacing: 0.8 }}>
                  {primary.label.toUpperCase()}
                </AppText>
                <AppText variant="title" tone="onGradient">
                  {`${formatBytes(primary.freeBytes)} free`}
                </AppText>
                <AppText variant="meta" tone="onGradient" style={{ opacity: 0.85 }}>
                  {`${formatBytes(used)} of ${formatBytes(primary.totalBytes)}`}
                </AppText>
                <View style={[styles.row, { gap: 4, marginTop: theme.spacing.xs }]}>
                  <AppText variant="caption" tone="onGradient">
                    Find space to free
                  </AppText>
                  <Icon name="arrow-right" size={theme.iconSizes.sm} color={theme.colors.textOnGradient} />
                </View>
              </View>
            </LinearGradient>
          </PressableScale>
        </FadeIn>
      ) : null}

      <StorageAccessPrompt />

      <View style={{ paddingHorizontal: theme.spacing.lg }}>
        <SectionHeader title="Quick actions" />
        <View style={[styles.grid, { gap: theme.spacing.sm }]}>
          {SHORTCUTS.map((shortcut, index) => (
            <FadeIn key={shortcut.label} index={index + 2}>
              <PressableScale
                haptic
                scaleTo={0.92}
                accessibilityRole="button"
                accessibilityLabel={shortcut.label}
                onPress={() => router.navigate(shortcut.href)}
                style={[styles.tile, { width: tileWidth, paddingVertical: theme.spacing.md, borderRadius: theme.radii.xl, backgroundColor: theme.colors.surface, gap: theme.spacing.xs }, theme.elevation('low')]}
              >
                <GradientTile icon={shortcut.icon} size={44} colors={shortcut.colors} />
                <AppText variant="caption" numberOfLines={1}>
                  {shortcut.label}
                </AppText>
              </PressableScale>
            </FadeIn>
          ))}
        </View>
      </View>

      <View>
        <View style={{ paddingHorizontal: theme.spacing.lg }}>
          <SectionHeader title="Recent files" action={recents.length ? { label: 'Search', onPress: () => router.navigate('/search') } : undefined} />
        </View>
        {recents.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md }}>
            {recents.map((recent, index) => (
              <FadeIn key={recent.uri} index={index + 4}>
                <PressableScale
                  haptic
                  scaleTo={0.95}
                  accessibilityRole="button"
                  accessibilityLabel={`${recent.name}, opened ${formatShortDate(recent.openedAt)}`}
                  onPress={() => void openRecent(recent)}
                  style={[styles.recent, { width: 136, padding: theme.spacing.md, borderRadius: theme.radii.xl, backgroundColor: theme.colors.surface, gap: theme.spacing.sm }, theme.elevation('low')]}
                >
                  <FileIcon category={categorize(recent.name, false, recent.mimeType)} size={48} />
                  <AppText variant="caption" numberOfLines={2}>
                    {recent.name}
                  </AppText>
                  <AppText variant="caption" tone="tertiary" numberOfLines={1}>
                    {formatShortDate(recent.openedAt)}
                  </AppText>
                </PressableScale>
              </FadeIn>
            ))}
          </ScrollView>
        ) : (
          <AppText variant="body" tone="tertiary" style={{ paddingHorizontal: theme.spacing.lg }}>
            Files you open in Fileora appear here.
          </AppText>
        )}
      </View>

      {favorites.length > 0 ? (
        <View style={{ paddingHorizontal: theme.spacing.lg }}>
          <SectionHeader title="Favorites" />
          <Card>
            {favorites.map((favorite, index) => (
              <View key={favorite.uri}>
                {index > 0 ? <Divider inset={76} /> : null}
                <ListItem
                  title={favorite.name}
                  subtitle={findLocation(favorite.locationId)?.label ?? null}
                  leading={<FileIcon category={categorize(favorite.name, favorite.isDirectory, mimeTypeFor(favorite.name))} />}
                  trailing={<Icon name="star" size={theme.iconSizes.md} color={theme.colors.warning} />}
                  onPress={() => void openFavorite(favorite)}
                />
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {activity.length > 0 ? (
        <View style={{ paddingHorizontal: theme.spacing.lg }}>
          <SectionHeader title="Recent activity" action={{ label: 'History', onPress: () => router.push('/history') }} />
          <Card>
            {activity.map((operation, index) => (
              <View key={operation.id}>
                {index > 0 ? <Divider inset={76} /> : null}
                <ListItem
                  title={operation.title}
                  subtitle={`${formatShortDate(operation.createdAt)} · ${operation.status}`}
                  leading={
                    <View style={[styles.dotWrap, { backgroundColor: operation.status === 'completed' ? theme.colors.successSubtle : theme.colors.warningSubtle, borderRadius: theme.radii.md }]}>
                      <Icon name={operation.status === 'completed' ? 'check' : 'alert-outline'} size={theme.iconSizes.md} color={operation.status === 'completed' ? theme.colors.success : theme.colors.warning} />
                    </View>
                  }
                  onPress={() => router.push('/history')}
                />
              </View>
            ))}
          </Card>
        </View>
      ) : null}
      {actions.dialogs}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  hero: { height: 230, overflow: 'hidden' },
  orb: { position: 'absolute', width: 240, height: 240, borderRadius: 120 },
  search: { flexDirection: 'row', alignItems: 'center', minHeight: 54 },
  storageCard: { flexDirection: 'row', alignItems: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { alignItems: 'center' },
  recent: { alignItems: 'flex-start' },
  dotWrap: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
