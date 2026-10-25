import { FlashList } from '@shopify/flash-list';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { presentError, FileoraError } from '@/core/errors/FileoraError';
import { formatBytes, formatDateTime, formatShortDate } from '@/core/format/format';
import { useTheme } from '@/core/theme/ThemeProvider';
import { undoOperation } from '@/features/file_operations/actions';
import { reportResult } from '@/features/file_operations/feedback';
import { getOperation, listOperations } from '@/features/file_operations/journal';
import { useOperations } from '@/features/file_operations/operationsStore';
import type { JournalItem, OperationRecord, OperationStatus, OperationType } from '@/features/file_operations/types';
import { ConfirmDialog, Sheet } from '@/shared/components/overlays';
import { AppText, Badge, Button, Chip, EmptyState, Icon, type IconName } from '@/shared/components/primitives';

const TYPE_ICON: Record<OperationType, IconName> = {
  copy: 'content-copy',
  move: 'content-cut',
  trash: 'trash-can-outline',
  delete: 'delete-outline',
  restore: 'restore',
  rename: 'pencil-outline',
  createFolder: 'folder-plus-outline',
  undo: 'undo',
};

const TYPE_FILTERS: { value: OperationType | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'copy', label: 'Copy' },
  { value: 'move', label: 'Move' },
  { value: 'rename', label: 'Rename' },
  { value: 'trash', label: 'Trash' },
  { value: 'delete', label: 'Deleted' },
  { value: 'restore', label: 'Restored' },
];

const STATUS_BADGE: Record<OperationStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'brand' }> = {
  running: { label: 'Running', tone: 'brand' },
  completed: { label: 'Completed', tone: 'success' },
  partial: { label: 'Partly completed', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
};

const ITEM_STATUS: Record<JournalItem['status'], string> = { pending: 'Not started', done: 'Done', failed: 'Failed', skipped: 'Skipped' };

function reversibility(operation: OperationRecord): string {
  if (operation.undoOperationId) return 'Undone';
  if (operation.reversible) return 'Can be undone';
  if (operation.type === 'delete') return 'Permanent — cannot be undone';
  if (operation.type === 'undo') return 'Undo operation';
  return 'Cannot be undone';
}

export function HistoryScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const revision = useOperations((s) => s.revision);
  const [type, setType] = useState<OperationType | null>(null);
  const [operations, setOperations] = useState<OperationRecord[] | null>(null);
  const [detail, setDetail] = useState<{ record: OperationRecord; items: JournalItem[] } | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<OperationRecord | null>(null);

  const load = useCallback(() => {
    void listOperations({ type }, 200).then(setOperations);
  }, [type]);
  useEffect(load, [load, revision]);

  const undo = (operation: OperationRecord) => {
    setConfirmUndo(null);
    setDetail(null);
    void undoOperation(operation.id).then((result) => reportResult('undo', 1, result, false));
  };

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={{ gap: theme.spacing.sm, padding: theme.spacing.lg }}>
        {TYPE_FILTERS.map((filter) => (
          <Chip key={filter.label} label={filter.label} selected={type === filter.value} onPress={() => setType(filter.value)} />
        ))}
      </ScrollView>
      <AppText variant="helper" tone="tertiary" style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
        Fileora records the operations it performs. Changes made by other apps are not recorded.
      </AppText>
      <FlashList
        data={operations ?? []}
        keyExtractor={(op) => op.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + theme.spacing.xxl }}
        ListEmptyComponent={operations ? <EmptyState icon="history" title="No activity yet" message="Copies, moves, renames and deletions you make in Fileora appear here." /> : null}
        renderItem={({ item: operation }) => {
          const badge = STATUS_BADGE[operation.status];
          const canUndo = operation.reversible && !operation.undoOperationId && operation.status !== 'running';
          return (
            <View style={[styles.item, { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md, gap: theme.spacing.md, borderBottomColor: theme.colors.border }]}>
              <View style={[styles.timeline, { backgroundColor: theme.colors.primarySubtle, borderRadius: theme.radii.pill }]}>
                <Icon name={TYPE_ICON[operation.type]} size={theme.iconSizes.md} color={theme.colors.primary} />
              </View>
              <View style={[styles.flex, { gap: 4 }]}>
                <AppText variant="bodyStrong" numberOfLines={2} onPress={() => void getOperation(operation.id).then(setDetail)} accessibilityRole="button" accessibilityHint="Shows the affected items">
                  {operation.title}
                </AppText>
                <View style={[styles.row, { gap: theme.spacing.sm, flexWrap: 'wrap' }]}>
                  <Badge label={badge.label} tone={badge.tone} />
                  <AppText variant="caption" tone="tertiary">
                    {formatShortDate(operation.createdAt)}
                  </AppText>
                  <AppText variant="caption" tone={operation.type === 'delete' ? 'danger' : 'tertiary'}>
                    {reversibility(operation)}
                  </AppText>
                </View>
                {operation.errorCode && operation.status !== 'completed' ? (
                  <AppText variant="helper" tone="secondary" numberOfLines={2}>
                    {presentError(new FileoraError(operation.errorCode, '')).title}
                  </AppText>
                ) : null}
              </View>
              {canUndo ? <Button label="Undo" icon="undo" variant="secondary" compact onPress={() => setConfirmUndo(operation)} /> : null}
            </View>
          );
        }}
      />

      <Sheet visible={detail !== null} onClose={() => setDetail(null)} title={detail?.record.title} subtitle={detail ? `${formatDateTime(detail.record.createdAt)} · ${reversibility(detail.record)}` : undefined}>
        {detail?.items.map((item) => (
          <View key={item.position} style={{ paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm }}>
            <AppText variant="body" numberOfLines={1}>
              {item.name}
            </AppText>
            <AppText variant="caption" tone={item.status === 'failed' ? 'danger' : 'tertiary'}>
              {[ITEM_STATUS[item.status], item.isDirectory ? 'Folder' : formatBytes(item.size), item.errorCode ? presentError(new FileoraError(item.errorCode, '')).title : null].filter(Boolean).join(' · ')}
            </AppText>
          </View>
        ))}
        {detail?.record.errorMessage && detail.record.status === 'interrupted' ? (
          <AppText variant="helper" tone="secondary" style={{ padding: theme.spacing.lg }}>
            {`${detail.record.errorMessage} Items marked Done were completed; unfinished copies were removed where Fileora could find them.`}
          </AppText>
        ) : null}
        {detail && detail.record.reversible && !detail.record.undoOperationId ? (
          <View style={{ padding: theme.spacing.lg }}>
            <Button label="Undo this operation" icon="undo" onPress={() => setConfirmUndo(detail.record)} />
          </View>
        ) : null}
      </Sheet>

      <ConfirmDialog
        visible={confirmUndo !== null}
        title="Undo this operation?"
        message={`Fileora will reverse “${confirmUndo?.title ?? ''}”. Items changed by other apps since then are left untouched, and name clashes keep both items.`}
        confirmLabel="Undo"
        onCancel={() => setConfirmUndo(null)}
        onConfirm={() => confirmUndo && undo(confirmUndo)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chips: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  item: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  timeline: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
