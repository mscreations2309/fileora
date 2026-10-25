import { FlashList } from '@shopify/flash-list';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatBytes, formatCount, formatShortDate } from '@/core/format/format';
import { storage, toFileEntry } from '@/core/storage/storage';
import { useTheme } from '@/core/theme/ThemeProvider';
import { findLocation } from '@/features/browse/locationsStore';
import { deleteItems } from '@/features/file_operations/actions';
import { reportResult } from '@/features/file_operations/feedback';
import { openFile } from '@/features/library/library';
import { FileIcon } from '@/shared/components/FileIcon';
import { ConfirmDialog, showToast } from '@/shared/components/overlays';
import { AppText, Badge, Button, EmptyState, Icon } from '@/shared/components/primitives';

import type { ScannedFile } from './analysis';
import { forgetFiles, useDetective } from './scanner';
import type { ReviewKind } from './StorageDetectiveScreen';

const TITLES: Record<ReviewKind, string> = {
  duplicates: 'Exact duplicates',
  similar: 'Similar photos',
  largest: 'Largest files',
  old: 'Old downloads',
  repeated: 'Repeated exports',
};

const EXPLANATIONS: Record<ReviewKind, string> = {
  duplicates: 'Each group has byte-identical content (same SHA-256). Extra copies are pre-selected; the oldest copy is kept. Review before moving anything to Trash.',
  similar: 'These images look alike but are not identical. Nothing is selected — choose what to remove.',
  largest: 'The biggest files Fileora can see. Nothing is selected.',
  old: 'Files in Downloads that have not changed for 90 days or more. Nothing is selected.',
  repeated: 'Files in the same folder with similar names. Their contents differ, so check before removing. Newest first.',
};

type Row = { kind: 'group'; key: string; title: string; subtitle: string } | { kind: 'file'; key: string; file: ScannedFile; keepSuggested: boolean };

export function DetectiveReviewScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { kind = 'largest' } = useLocalSearchParams<{ kind: ReviewKind }>();
  const result = useDetective((s) => s.result);

  const rows = useMemo<Row[]>(() => {
    if (!result) return [];
    const out: Row[] = [];
    const groups =
      kind === 'duplicates'
        ? result.duplicates.map((g) => ({ files: g.files, subtitle: `${formatCount(g.files.length)} copies · ${formatBytes(g.size)} each · ${formatBytes(g.reclaimable)} reclaimable` }))
        : kind === 'similar'
          ? (result.similar ?? []).map((files) => ({ files, subtitle: `${formatCount(files.length)} similar images` }))
          : kind === 'repeated'
            ? result.repeated.map((files) => ({ files, subtitle: `${formatCount(files.length)} versions · ${formatBytes(files.reduce((s, f) => s + f.size, 0))}` }))
            : null;
    if (groups) {
      groups.forEach((group, index) => {
        out.push({ kind: 'group', key: `g${index}`, title: `Group ${index + 1}`, subtitle: group.subtitle });
        group.files.forEach((file, fileIndex) => out.push({ kind: 'file', key: `${index}-${file.uri}`, file, keepSuggested: kind === 'duplicates' && fileIndex === 0 }));
      });
    } else {
      const files = kind === 'old' ? result.oldDownloads : result.largest;
      files.forEach((file) => out.push({ kind: 'file', key: file.uri, file, keepSuggested: false }));
    }
    return out;
  }, [result, kind]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => {
    if (kind !== 'duplicates' || !result) return new Set();
    return new Set(result.duplicates.flatMap((g) => g.files.slice(1).map((f) => f.uri)));
  });
  const [confirm, setConfirm] = useState(false);
  const files = rows.filter((r): r is Extract<Row, { kind: 'file' }> => r.kind === 'file').map((r) => r.file);
  const chosen = files.filter((f) => selected.has(f.uri));
  const chosenBytes = chosen.reduce((s, f) => s + f.size, 0);

  // Guard: never let every copy of an exact-duplicate group be selected.
  const wipesGroup =
    kind === 'duplicates' && result ? result.duplicates.some((g) => g.files.every((f) => selected.has(f.uri))) : false;

  const toggle = (uri: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });

  const open = async (file: ScannedFile) => {
    const raw = await storage.stat(file.uri).catch(() => null);
    if (!raw) {
      showToast(`“${file.name}” is no longer there.`, 'error');
      return;
    }
    void openFile(toFileEntry(raw, file.parentUri, file.locationId)).catch(() => showToast('No app can open this file', 'error'));
  };

  const trash = async () => {
    setConfirm(false);
    const entries = [];
    for (const file of chosen) {
      const raw = await storage.stat(file.uri).catch(() => null);
      if (raw) entries.push(toFileEntry(raw, file.parentUri, file.locationId));
    }
    const outcome = await deleteItems(entries, false);
    reportResult('trash', entries.length, outcome);
    forgetFiles(new Set(entries.map((e) => e.uri)));
    setSelected(new Set());
  };

  if (!result) {
    return <EmptyState icon="database-search-outline" title="No scan results" message="Run a scan first." action={{ label: 'Back', onPress: () => router.back() }} />;
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <Stack.Screen options={{ title: TITLES[kind] }} />
      <AppText variant="helper" tone="secondary" style={{ padding: theme.spacing.lg }}>
        {EXPLANATIONS[kind]}
      </AppText>
      <FlashList
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        contentContainerStyle={{ paddingBottom: 140 }}
        ListEmptyComponent={<EmptyState icon="check-circle-outline" title="Nothing here" message="No files in this category." />}
        renderItem={({ item: row }) => {
          if (row.kind === 'group') {
            return (
              <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg, paddingBottom: theme.spacing.xs }}>
                <AppText variant="sectionLabel" tone="secondary">
                  {row.title.toUpperCase()}
                </AppText>
                <AppText variant="caption" tone="tertiary">
                  {row.subtitle}
                </AppText>
              </View>
            );
          }
          const isSelected = selected.has(row.file.uri);
          const location = findLocation(row.file.locationId);
          return (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
              accessibilityLabel={`${row.file.name}, ${formatBytes(row.file.size)}, ${row.file.path}`}
              onPress={() => toggle(row.file.uri)}
              onLongPress={() => void open(row.file)}
              style={({ pressed }) => [styles.row, { minHeight: 68, paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: isSelected ? theme.colors.selection : pressed ? theme.colors.surfaceSunken : 'transparent' }]}
            >
              <Icon name={isSelected ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'} color={isSelected ? theme.colors.primary : theme.colors.textTertiary} />
              <FileIcon category={row.file.category} extension={row.file.extension} size={36} />
              <View style={styles.flex}>
                <AppText variant="fileName" numberOfLines={1} ellipsizeMode="middle">
                  {row.file.name}
                </AppText>
                <AppText variant="meta" tone="secondary" numberOfLines={1} ellipsizeMode="head">
                  {`${formatBytes(row.file.size)} · ${formatShortDate(row.file.modifiedAt)} · ${location?.label ?? ''}/${row.file.path}`}
                </AppText>
              </View>
              {row.keepSuggested ? <Badge label="Keep" tone="success" /> : null}
            </Pressable>
          );
        }}
      />
      <View style={[styles.bar, { paddingBottom: insets.bottom + theme.spacing.md, padding: theme.spacing.md, backgroundColor: theme.colors.surfaceRaised, borderTopColor: theme.colors.border, gap: theme.spacing.sm }]}>
        <AppText variant="helper" tone={wipesGroup ? 'danger' : 'secondary'}>
          {wipesGroup
            ? 'Every copy of a group is selected. Keep at least one copy.'
            : `${formatCount(chosen.length)} selected · ${formatBytes(chosenBytes)} · long-press a file to open it`}
        </AppText>
        <Button label={`Move ${formatCount(chosen.length)} to Trash`} icon="trash-can-outline" variant="danger" disabled={chosen.length === 0 || wipesGroup} onPress={() => setConfirm(true)} />
      </View>
      <ConfirmDialog
        visible={confirm}
        title={`Move ${formatCount(chosen.length)} files to Trash?`}
        message={`${formatBytes(chosenBytes)} will be moved to Fileora Trash, where you can restore them. Space is freed when you empty the Trash.`}
        confirmLabel="Move to Trash"
        onCancel={() => setConfirm(false)}
        onConfirm={() => void trash()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: 1 },
});
