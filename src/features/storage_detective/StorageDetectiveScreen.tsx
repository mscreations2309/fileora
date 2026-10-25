import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatBytes, formatCount, formatPercent, formatShortDate } from '@/core/format/format';
import { CATEGORY_LABELS } from '@/core/storage/fileTypes';
import { hasNativeStorage } from '@/core/storage/storage';
import { useTheme } from '@/core/theme/ThemeProvider';
import type { FileColorKey } from '@/core/theme/tokens';
import { useLocations } from '@/features/browse/locationsStore';
import { ProgressBar } from '@/shared/components/overlays';
import { AppText, Button, Card, Divider, EmptyState, Icon, ListItem, SectionHeader, type IconName } from '@/shared/components/primitives';

import { cancelScan, findSimilarImages, runScan, useDetective } from './scanner';

const CATEGORY_COLOR: Record<string, FileColorKey> = {
  image: 'fileImage',
  video: 'fileVideo',
  audio: 'fileAudio',
  document: 'fileDocument',
  archive: 'fileArchive',
  code: 'fileCode',
  other: 'fileOther',
  folder: 'fileFolder',
};

export type ReviewKind = 'duplicates' | 'similar' | 'largest' | 'old' | 'repeated';

function Recommendation({ icon, title, detail, explanation, onPress, disabled }: { icon: IconName; title: string; detail: string; explanation: string; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <ListItem
      title={title}
      subtitle={`${detail} — ${explanation}`}
      leading={<Icon name={icon} color={disabled ? theme.colors.textTertiary : theme.colors.primary} />}
      trailing={<Icon name="chevron-right" color={theme.colors.textTertiary} />}
      onPress={onPress}
      disabled={disabled}
    />
  );
}

export function StorageDetectiveScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const locations = useLocations((s) => s.locations);
  const detective = useDetective();
  const { result } = detective;
  const busy = detective.status === 'scanning' || detective.status === 'hashing' || detective.status === 'imaging';
  const primary = locations.find((l) => l.kind === 'volume' && l.totalBytes);
  const review = (kind: ReviewKind) => router.push({ pathname: '/detective-review', params: { kind } });

  const reclaimable = result?.duplicates.reduce((sum, g) => sum + g.reclaimable, 0) ?? 0;
  const progressLine =
    detective.status === 'scanning'
      ? `Scanning · ${formatCount(detective.foldersScanned)} folders · ${formatCount(detective.filesFound)} files · ${formatBytes(detective.bytesFound)}`
      : detective.status === 'hashing'
        ? `Checking ${formatCount(detective.toProcess)} same-size files for identical content${detective.currentName ? ` · ${detective.currentName}` : ''}`
        : detective.status === 'imaging'
          ? `Comparing photos · ${formatCount(detective.processed)} of ${formatCount(detective.toProcess)}`
          : null;

  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: insets.bottom + theme.spacing.xxxl, gap: theme.spacing.md }}>
      {primary?.totalBytes && primary.freeBytes != null ? (
        <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
          <AppText variant="bodyStrong">{primary.label}</AppText>
          <ProgressBar progress={(primary.totalBytes - primary.freeBytes) / primary.totalBytes} height={10} />
          <AppText variant="helper" tone="secondary">
            {`${formatBytes(primary.totalBytes - primary.freeBytes)} used of ${formatBytes(primary.totalBytes)} · ${formatBytes(primary.freeBytes)} free`}
          </AppText>
          {result ? (
            <AppText variant="helper" tone="tertiary">
              {`Fileora can see ${formatBytes(result.totalBytes)} of it (${formatCount(result.files.length)} files). The rest is the system, apps and their private data, which no file manager can inspect.`}
            </AppText>
          ) : null}
        </Card>
      ) : null}

      {busy ? (
        <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
          <AppText variant="bodyStrong">Investigating…</AppText>
          <AppText variant="helper" tone="secondary" numberOfLines={2}>
            {progressLine}
          </AppText>
          <ProgressBar progress={detective.status === 'scanning' || detective.toProcess === 0 ? null : detective.processed / detective.toProcess} />
          <Button label="Stop" variant="ghost" compact onPress={cancelScan} />
        </Card>
      ) : null}

      {!result && !busy ? (
        <EmptyState
          icon="database-search-outline"
          title="Find what's using your storage"
          message="Fileora scans the locations you can browse, finds identical copies by comparing content, and lists large and old files. Nothing is deleted without your review."
          action={{ label: detective.status === 'cancelled' ? 'Scan again' : 'Start scan', icon: 'magnify', onPress: () => void runScan(locations) }}
        />
      ) : null}

      {result && !busy ? (
        <>
          <View style={[styles.row, { gap: theme.spacing.sm }]}>
            <AppText variant="helper" tone="tertiary" style={styles.flex}>
              {`Scanned ${formatShortDate(result.finishedAt)} · ${result.locations.join(', ')}${detective.truncated ? ' · stopped at scan limit' : ''}`}
            </AppText>
            <Button label="Rescan" variant="ghost" compact icon="refresh" onPress={() => void runScan(locations)} />
          </View>

          <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
            <AppText variant="bodyStrong">By type</AppText>
            <View style={[styles.stack, { borderRadius: theme.radii.sm }]} accessibilityElementsHidden>
              {result.categories.map((c) => (
                <View key={c.category} style={{ flex: Math.max(c.bytes, 1), backgroundColor: theme.colors[CATEGORY_COLOR[c.category] ?? 'fileOther'] }} />
              ))}
            </View>
            {result.categories.map((c) => (
              <View key={c.category} style={[styles.row, { gap: theme.spacing.sm }]} accessible accessibilityLabel={`${CATEGORY_LABELS[c.category]}: ${formatBytes(c.bytes)}, ${formatCount(c.count)} files`}>
                <View style={[styles.dot, { backgroundColor: theme.colors[CATEGORY_COLOR[c.category] ?? 'fileOther'] }]} />
                <AppText variant="body" style={styles.flex}>
                  {CATEGORY_LABELS[c.category]}
                </AppText>
                <AppText variant="meta" tone="secondary">
                  {`${formatBytes(c.bytes)} · ${formatPercent(result.totalBytes ? c.bytes / result.totalBytes : 0)}`}
                </AppText>
              </View>
            ))}
          </Card>

          <SectionHeader title="Recommendations" />
          <Card>
            <Recommendation
              icon="content-duplicate"
              title={`Exact duplicates · ${formatBytes(reclaimable)} reclaimable`}
              detail={`${formatCount(result.duplicates.length)} groups`}
              explanation="identical content (SHA-256) in more than one place"
              onPress={() => review('duplicates')}
              disabled={result.duplicates.length === 0}
            />
            <Divider inset={56} />
            <Recommendation
              icon="image-multiple-outline"
              title="Similar photos"
              detail={result.similar === null ? 'Not checked yet' : `${formatCount(result.similar.length)} groups`}
              explanation="look-alike images such as bursts and edits — review, they are not identical"
              onPress={() => (result.similar === null ? void findSimilarImages() : review('similar'))}
              disabled={!hasNativeStorage}
            />
            <Divider inset={56} />
            <Recommendation icon="file-download-outline" title="Old downloads" detail={`${formatCount(result.oldDownloads.length)} files · ${formatBytes(result.oldDownloads.reduce((s, f) => s + f.size, 0))}`} explanation="in Downloads and untouched for 90+ days" onPress={() => review('old')} disabled={result.oldDownloads.length === 0} />
            <Divider inset={56} />
            <Recommendation icon="file-multiple-outline" title="Repeated exports" detail={`${formatCount(result.repeated.length)} groups`} explanation="similar names like “report (1)” and “report final” in one folder; contents differ" onPress={() => review('repeated')} disabled={result.repeated.length === 0} />
            <Divider inset={56} />
            <Recommendation icon="arrow-expand-all" title="Largest files" detail={`Top ${formatCount(result.largest.length)}`} explanation="the biggest files Fileora can see" onPress={() => review('largest')} disabled={result.largest.length === 0} />
          </Card>

          <SectionHeader title="Biggest folders" />
          <Card>
            {result.topFolders.map((folder, index) => (
              <View key={folder.folder}>
                {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                <ListItem title={folder.folder} subtitle={formatBytes(folder.bytes)} />
              </View>
            ))}
          </Card>
          {result.hashFailures > 0 ? (
            <AppText variant="helper" tone="tertiary">
              {`${formatCount(result.hashFailures)} files could not be read, so they were not compared.`}
            </AppText>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  stack: { flexDirection: 'row', height: 14, overflow: 'hidden' },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
