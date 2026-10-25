import { FlashList } from '@shopify/flash-list';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatBytes, formatCount, formatShortDate } from '@/core/format/format';
import { categorize, mimeTypeFor } from '@/core/storage/fileTypes';
import { useTheme } from '@/core/theme/ThemeProvider';
import { findLocation } from '@/features/browse/locationsStore';
import { deleteFromTrash, restoreFromTrash } from '@/features/file_operations/actions';
import { reportResult } from '@/features/file_operations/feedback';
import { listTrash } from '@/features/file_operations/journal';
import { useOperations } from '@/features/file_operations/operationsStore';
import type { TrashRecord } from '@/features/file_operations/types';
import { FileIcon } from '@/shared/components/FileIcon';
import { ConfirmDialog } from '@/shared/components/overlays';
import { AppText, Button, EmptyState, IconButton } from '@/shared/components/primitives';

export function TrashScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const revision = useOperations((s) => s.revision);
  const [items, setItems] = useState<TrashRecord[] | null>(null);
  const [confirm, setConfirm] = useState<TrashRecord[] | null>(null);

  const load = useCallback(() => {
    void listTrash().then(setItems);
  }, []);
  useEffect(load, [load, revision]);

  const total = (items ?? []).reduce((sum, item) => sum + (item.size ?? 0), 0);

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <Stack.Screen
        options={{
          headerRight: () => (items && items.length > 0 ? <Button label="Empty" variant="ghost" compact onPress={() => setConfirm(items)} /> : null),
        }}
      />
      <View style={{ padding: theme.spacing.lg, gap: theme.spacing.xs }}>
        <AppText variant="body" tone="secondary">
          {items && items.length > 0 ? `${formatCount(items.length)} ${items.length === 1 ? 'item' : 'items'} · at least ${formatBytes(total)}` : 'Deleted items stay here until you empty the Trash.'}
        </AppText>
        <AppText variant="helper" tone="tertiary">
          {Platform.OS === 'android'
            ? 'Trash is stored in Fileora’s app storage. Android removes it if you uninstall Fileora.'
            : 'Trash is stored inside Fileora. It is removed if you delete the app.'}
        </AppText>
      </View>
      <FlashList
        data={items ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + theme.spacing.xxl }}
        ListEmptyComponent={items ? <EmptyState icon="trash-can-outline" title="Trash is empty" message="Items you delete in Fileora can be restored from here." /> : null}
        renderItem={({ item }) => (
          <View style={[styles.row, { paddingStart: theme.spacing.lg, gap: theme.spacing.md, minHeight: 68 }]}>
            <FileIcon category={categorize(item.name, item.isDirectory, mimeTypeFor(item.name))} />
            <View style={styles.flex}>
              <AppText variant="fileName" numberOfLines={1} ellipsizeMode="middle">
                {item.name}
              </AppText>
              <AppText variant="meta" tone="secondary" numberOfLines={1}>
                {[`Deleted ${formatShortDate(item.deletedAt)}`, findLocation(item.originalLocationId)?.label, item.isDirectory ? 'Folder' : formatBytes(item.size)].filter(Boolean).join(' · ')}
              </AppText>
            </View>
            <IconButton icon="restore" label={`Restore ${item.name}`} onPress={() => void restoreFromTrash([item]).then((r) => reportResult('restore', 1, r))} />
            <IconButton icon="delete-outline" label={`Delete ${item.name} permanently`} color={theme.colors.danger} onPress={() => setConfirm([item])} />
          </View>
        )}
      />
      <ConfirmDialog
        visible={confirm !== null}
        destructive
        title={confirm && confirm.length === 1 ? 'Delete permanently?' : 'Empty Trash?'}
        message={
          confirm && confirm.length === 1
            ? `“${confirm[0]?.name}” will be deleted. This cannot be undone.`
            : `${formatCount(confirm?.length ?? 0)} items will be deleted. This cannot be undone.`
        }
        confirmLabel="Delete permanently"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const records = confirm ?? [];
          setConfirm(null);
          void deleteFromTrash(records).then((r) => reportResult('delete', records.length, r, false));
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
