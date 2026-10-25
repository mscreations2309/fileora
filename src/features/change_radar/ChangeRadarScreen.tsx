import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { presentError, toFileoraError } from '@/core/errors/FileoraError';
import { formatBytes, formatCount, formatShortDate } from '@/core/format/format';
import { pickFolderUri } from '@/core/storage/locations';
import { useTheme } from '@/core/theme/ThemeProvider';
import { shareTextFile } from '@/features/library/library';
import { ConfirmDialog, ProgressBar, Sheet, SheetAction, showToast } from '@/shared/components/overlays';
import { AppText, Badge, Button, Card, Divider, EmptyState, Icon, IconButton, ListItem, SectionHeader } from '@/shared/components/primitives';

import { recentComparisons } from './compare';
import type { FolderChange } from './diff';
import { compareWithNow, deleteSnapshot, listSnapshots, takeSnapshot, useSnapshotRevision, type Snapshot } from './snapshots';

function changeLine(change: FolderChange): { icon: 'plus-circle-outline' | 'minus-circle-outline' | 'swap-horizontal' | 'pencil-circle-outline'; text: string; detail: string } {
  switch (change.kind) {
    case 'added':
      return { icon: 'plus-circle-outline', text: change.path, detail: `Added · ${formatBytes(change.size)}` };
    case 'removed':
      return { icon: 'minus-circle-outline', text: change.path, detail: `Removed · ${formatBytes(change.size)}` };
    case 'renamed':
      return { icon: 'swap-horizontal', text: change.to, detail: `Renamed or moved from ${change.from}${change.basis === 'content' ? '' : ' (matched by size and date)'}` };
    case 'modified':
      return {
        icon: 'pencil-circle-outline',
        text: change.path,
        detail: `Modified · ${formatBytes(change.sizeBefore)} → ${formatBytes(change.sizeAfter)} · ${change.basis === 'content' ? 'content changed' : change.basis === 'size' ? 'size changed' : 'only the date changed; content not verified'}`,
      };
  }
}

export function ChangeRadarScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const revision = useSnapshotRevision((s) => s.revision);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [comparisons, setComparisons] = useState<Awaited<ReturnType<typeof recentComparisons>>>([]);
  const [hash, setHash] = useState(true);
  const [busy, setBusy] = useState<{ label: string; count: number } | null>(null);
  const [result, setResult] = useState<{ snapshot: Snapshot; changes: FolderChange[] } | null>(null);
  const [menu, setMenu] = useState<Snapshot | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Snapshot | null>(null);
  const cancelled = useRef(false);
  const params = useLocalSearchParams<{ record?: string; name?: string; loc?: string }>();
  const [pendingRecord, setPendingRecord] = useState(params.record ? { uri: params.record, label: params.name ?? 'Folder', locationId: params.loc ?? null } : null);

  const load = useCallback(() => {
    void listSnapshots().then(setSnapshots);
    void recentComparisons().then(setComparisons);
  }, []);
  useEffect(load, [load, revision]);

  const run = async (label: string, task: () => Promise<void>) => {
    cancelled.current = false;
    setBusy({ label, count: 0 });
    try {
      await task();
    } catch (error) {
      const failure = toFileoraError(error);
      if (failure.code !== 'ERR_CANCELLED') showToast(failure.code === 'ERR_UNSUPPORTED' ? failure.message : presentError(failure).title, 'error');
    } finally {
      setBusy(null);
    }
  };

  const snapshotFolder = () =>
    void run('Recording folder', async () => {
      const folder = await pickFolderUri();
      if (!folder) return;
      const snap = await takeSnapshot({ uri: folder.uri, locationId: null, label: folder.name }, hash, () => cancelled.current, (count) => setBusy({ label: 'Recording folder', count }));
      showToast(`Recorded ${formatCount(snap.itemCount)} items in “${snap.label}”`, 'success');
    });

  const compare = (snapshot: Snapshot) =>
    void run('Comparing with now', async () => {
      const changes = await compareWithNow(snapshot, () => cancelled.current, (count) => setBusy({ label: 'Comparing with now', count }));
      setResult({ snapshot, changes });
    });

  const exportResult = () => {
    if (!result) return;
    const text = [
      'Fileora folder change report',
      `Folder: ${result.snapshot.label}`,
      `Snapshot: ${new Date(result.snapshot.createdAt).toISOString()} · compared ${new Date().toISOString()}`,
      `Evidence: ${result.snapshot.hashed ? 'content hashes (SHA-256)' : 'sizes and dates'}`,
      '',
      ...result.changes.map((c) => {
        const line = changeLine(c);
        return `${line.detail.split(' · ')[0]}: ${line.text}${c.kind === 'renamed' ? ` (from ${c.from})` : ''}`;
      }),
    ].join('\n');
    void shareTextFile('Fileora folder changes.txt', text, 'text/plain').catch(() => showToast('Could not share the report', 'error'));
  };

  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: insets.bottom + theme.spacing.xxxl }}>
      <AppText variant="body" tone="secondary">
        Record a folder now, compare it later to see what was added, removed, renamed or changed. To compare two files, select both in Browse and choose Compare.
      </AppText>
      <Card>
        <ListItem title="Check file contents" subtitle="Hash every file so changes are confirmed by content, not dates. Slower for large folders." trailing={<Switch value={hash} onValueChange={setHash} accessibilityLabel="Check file contents" />} />
      </Card>
      {pendingRecord ? (
        <Card style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
          <AppText variant="bodyStrong">{`Record “${pendingRecord.label}” now?`}</AppText>
          <Button
            label="Record folder"
            icon="folder-clock-outline"
            onPress={() => {
              const folder = pendingRecord;
              setPendingRecord(null);
              void run('Recording folder', async () => {
                const snap = await takeSnapshot(folder, hash, () => cancelled.current, (count) => setBusy({ label: 'Recording folder', count }));
                showToast(`Recorded ${formatCount(snap.itemCount)} items in “${snap.label}”`, 'success');
              });
            }}
          />
        </Card>
      ) : null}
      <Button label="Record a folder…" icon="folder-clock-outline" onPress={snapshotFolder} disabled={busy !== null} />
      <AppText variant="helper" tone="tertiary">
        Fileora does not watch folders in the background — Android and iOS do not allow reliable continuous monitoring. Changes are found when you compare.
      </AppText>
      {busy ? (
        <Card style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
          <AppText variant="helper">{`${busy.label}… ${formatCount(busy.count)} files`}</AppText>
          <ProgressBar progress={null} />
          <Button label="Stop" variant="ghost" compact onPress={() => { cancelled.current = true; }} />
        </Card>
      ) : null}

      {result ? (
        <View style={{ gap: theme.spacing.sm }}>
          <View style={[{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }]}>
            <AppText variant="heading" style={{ flex: 1 }}>
              {`${result.snapshot.label}: ${result.changes.length === 0 ? 'no changes' : `${formatCount(result.changes.length)} changes`}`}
            </AppText>
            {result.changes.length ? <IconButton icon="export-variant" label="Export change report" onPress={exportResult} /> : null}
            <IconButton icon="close" label="Close results" onPress={() => setResult(null)} />
          </View>
          <Card>
            {result.changes.slice(0, 500).map((change, i) => {
              const line = changeLine(change);
              return (
                <View key={i}>
                  {i > 0 ? <Divider inset={56} /> : null}
                  <ListItem title={line.text} subtitle={line.detail} leading={<Icon name={line.icon} color={change.kind === 'added' ? theme.colors.success : change.kind === 'removed' ? theme.colors.danger : theme.colors.warning} />} />
                </View>
              );
            })}
          </Card>
        </View>
      ) : null}

      <SectionHeader title="Recorded folders" />
      {snapshots.length === 0 ? <EmptyState icon="folder-clock-outline" title="No recordings yet" message="Record a folder to compare it with its future state." /> : null}
      <Card>
        {snapshots.map((snap, i) => (
          <View key={snap.id}>
            {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
            <ListItem
              title={snap.label}
              subtitle={`${formatCount(snap.itemCount)} items · ${formatShortDate(snap.createdAt)}`}
              trailing={<View style={{ flexDirection: 'row', alignItems: 'center' }}>{snap.hashed ? <Badge label="Content" tone="success" /> : <Badge label="Dates" tone="neutral" />}<IconButton icon="dots-vertical" label={`Options for ${snap.label}`} onPress={() => setMenu(snap)} size={theme.iconSizes.md} /></View>}
              onPress={() => compare(snap)}
              accessibilityHint="Compares this recording with the folder now"
            />
          </View>
        ))}
      </Card>

      {comparisons.length ? (
        <>
          <SectionHeader title="Recent file comparisons" />
          <Card>
            {comparisons.map((c, i) => (
              <View key={c.id}>
                {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                <ListItem title={`${c.leftName} → ${c.rightName}`} subtitle={`${c.summary} · ${formatShortDate(c.createdAt)}`} />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <Sheet visible={menu !== null} onClose={() => setMenu(null)} title={menu?.label}>
        <SheetAction icon="compare" label="Compare with now" onPress={() => { const s = menu; setMenu(null); if (s) compare(s); }} />
        <SheetAction icon="delete-outline" label="Delete recording" destructive onPress={() => { const s = menu; setMenu(null); setConfirmDelete(s); }} />
      </Sheet>
      <ConfirmDialog visible={confirmDelete !== null} title="Delete this recording?" message="Only Fileora's record is removed; the folder is not touched." confirmLabel="Delete" destructive onCancel={() => setConfirmDelete(null)} onConfirm={() => { const s = confirmDelete; setConfirmDelete(null); if (s) void deleteSnapshot(s.id); }} />
    </ScrollView>
  );
}
