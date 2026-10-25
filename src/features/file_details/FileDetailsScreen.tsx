import { randomUUID } from 'expo-crypto';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isCancellation, presentError, toFileoraError, type FileoraError } from '@/core/errors/FileoraError';
import { formatBytes, formatDateTime, formatItemCount } from '@/core/format/format';
import { CATEGORY_LABELS } from '@/core/storage/fileTypes';
import { storage, toFileEntry } from '@/core/storage/storage';
import type { FileEntry } from '@/core/storage/types';
import { displayPathOf } from '@/core/storage/uri';
import { useTheme } from '@/core/theme/ThemeProvider';
import { findLocation } from '@/features/browse/locationsStore';
import { openFolderDirect, showInFolder } from '@/features/browse/navigation';
import { useSmartActions } from '@/features/browse/smartActions';
import { operationsForUri } from '@/features/file_operations/journal';
import { useOperations } from '@/features/file_operations/operationsStore';
import type { OperationRecord } from '@/features/file_operations/types';
import { useFileActions } from '@/features/file_operations/useFileActions';
import { isFavorite, setFavorite } from '@/features/library/library';
import { FileIcon } from '@/shared/components/FileIcon';
import { showToast } from '@/shared/components/overlays';
import { AppText, Button, Card, Divider, EmptyState, ListItem, SectionHeader } from '@/shared/components/primitives';

function Field({ label, value, selectable = false }: { label: string; value: string; selectable?: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md, gap: 2 }} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="caption" tone="tertiary">
        {label}
      </AppText>
      <AppText variant="body" selectable={selectable}>
        {value}
      </AppText>
    </View>
  );
}

type HashState = { status: 'idle' } | { status: 'running'; operationId: string } | { status: 'done'; value: string } | { status: 'error'; error: FileoraError };

export function FileDetailsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ uri: string; loc: string; parent: string; name: string }>();
  const uri = params.uri ?? '';
  const [entry, setEntry] = useState<FileEntry | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [error, setError] = useState<FileoraError | null>(null);
  const [favorite, setFavoriteState] = useState(false);
  const [history, setHistory] = useState<OperationRecord[]>([]);
  const [hash, setHash] = useState<HashState>({ status: 'idle' });
  const revision = useOperations((s) => s.revision);
  const actions = useFileActions();
  const smart = useSmartActions();
  const hashOperation = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const raw = await storage.stat(uri);
        if (!active) return;
        if (!raw) {
          setState('missing');
          return;
        }
        setEntry(toFileEntry(raw, params.parent ?? '', params.loc ?? ''));
        setState('ready');
        setFavoriteState(await isFavorite(uri));
        setHistory(await operationsForUri(uri));
      } catch (cause) {
        if (!active) return;
        setError(toFileoraError(cause));
        setState('error');
      }
    })();
    return () => {
      active = false;
    };
  }, [uri, params.parent, params.loc, revision]);

  useEffect(
    () => () => {
      if (hashOperation.current) storage.cancel(hashOperation.current);
    },
    [],
  );

  const calculateHash = useCallback(() => {
    const operationId = randomUUID();
    hashOperation.current = operationId;
    setHash({ status: 'running', operationId });
    storage
      .hash(uri, operationId)
      .then((value) => setHash({ status: 'done', value }))
      .catch((cause: unknown) => setHash(isCancellation(cause) ? { status: 'idle' } : { status: 'error', error: toFileoraError(cause) }))
      .finally(() => {
        hashOperation.current = null;
      });
  }, [uri]);

  if (state === 'loading') {
    return (
      <View style={[styles.center, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator color={theme.colors.primary} accessibilityLabel="Loading details" />
      </View>
    );
  }
  if (state !== 'ready' || !entry) {
    const presentation = error ? presentError(error) : null;
    return (
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        <Stack.Screen options={{ title: params.name ?? 'Details' }} />
        <EmptyState
          tone="error"
          icon="alert-circle-outline"
          title={presentation?.title ?? 'This item is no longer here'}
          message={presentation?.guidance ?? 'It may have been moved, renamed or deleted by another app.'}
          action={{ label: 'Go back', onPress: () => router.back() }}
        />
      </View>
    );
  }

  const location = findLocation(entry.locationId);
  const path = displayPathOf(entry.uri);
  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <Stack.Screen options={{ title: 'Details' }} />
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: insets.bottom + theme.spacing.xxl, gap: theme.spacing.lg }}>
        <View style={[styles.hero, { gap: theme.spacing.md }]}>
          <FileIcon category={entry.category} extension={entry.extension} size={72} />
          <AppText variant="title" selectable style={styles.centerText}>
            {entry.name}
          </AppText>
          <View style={[styles.row, { gap: theme.spacing.sm, flexWrap: 'wrap', justifyContent: 'center' }]}>
            {entry.isDirectory ? (
              <Button label="Open folder" icon="folder-open-outline" compact onPress={() => openFolderDirect(entry.locationId, entry.uri, entry.name)} />
            ) : (
              <Button label="Open" icon="open-in-app" compact onPress={() => actions.open(entry)} />
            )}
            {!entry.isDirectory ? <Button label="Share" icon="share-variant-outline" variant="secondary" compact onPress={() => actions.share([entry])} /> : null}
            <Button
              label={favorite ? 'Favorite' : 'Add to Favorites'}
              icon={favorite ? 'star' : 'star-outline'}
              variant="secondary"
              compact
              onPress={() => {
                void setFavorite(entry, !favorite).then(() => {
                  setFavoriteState(!favorite);
                  showToast(favorite ? 'Removed from Favorites' : 'Added to Favorites', 'success');
                });
              }}
            />
          </View>
        </View>

        <Card>
          <Field label="Type" value={`${CATEGORY_LABELS[entry.category]}${entry.mimeType ? ` · ${entry.mimeType}` : ''}`} />
          <Divider inset={theme.spacing.lg} />
          <Field label={entry.isDirectory ? 'Contents' : 'Size'} value={entry.isDirectory ? (entry.childCount !== null ? formatItemCount(entry.childCount) : 'Unknown') : entry.size !== null ? `${formatBytes(entry.size)} (${entry.size.toLocaleString()} bytes)` : 'Unknown'} />
          <Divider inset={theme.spacing.lg} />
          <Field label="Modified" value={formatDateTime(entry.modifiedAt)} />
          <Divider inset={theme.spacing.lg} />
          <Field label="Location" value={location?.label ?? 'Unknown location'} />
          {path ? (
            <>
              <Divider inset={theme.spacing.lg} />
              <Field label="Path" value={path} selectable />
            </>
          ) : null}
          <Divider inset={theme.spacing.lg} />
          <Field label="Permissions" value={[entry.capabilities.canWrite ? 'Writable' : 'Read-only', entry.capabilities.canRename ? 'can rename' : 'cannot rename', entry.capabilities.canDelete ? 'can delete' : 'cannot delete'].join(' · ')} />
        </Card>

        {!entry.isDirectory ? (
          <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
            <AppText variant="bodyStrong">SHA-256 checksum</AppText>
            {hash.status === 'done' ? (
              <AppText variant="meta" selectable style={{ fontFamily: 'monospace' }}>
                {hash.value}
              </AppText>
            ) : hash.status === 'error' ? (
              <AppText variant="helper" tone="danger">
                {presentError(hash.error).title}
              </AppText>
            ) : (
              <AppText variant="helper" tone="secondary">
                A fingerprint of the file contents, useful to verify copies. Calculated on this device; large files take a moment.
              </AppText>
            )}
            {hash.status === 'running' ? (
              <View style={[styles.row, { gap: theme.spacing.md }]}>
                <ActivityIndicator color={theme.colors.primary} />
                <Button label="Cancel" variant="ghost" compact onPress={() => storage.cancel(hash.operationId)} />
              </View>
            ) : hash.status !== 'done' ? (
              <Button label="Calculate" variant="secondary" compact icon="pound" onPress={calculateHash} />
            ) : null}
          </Card>
        ) : null}

        <Card>
          <ListItem title="Show in folder" leading={null} onPress={() => void showInFolder(entry)} />
          <Divider />
          <ListItem title="Copy to…" onPress={() => actions.stage('copy', [entry])} />
          <Divider />
          <ListItem title="Move to…" onPress={() => actions.stage('move', [entry])} disabled={!entry.capabilities.canDelete} />
          <Divider />
          <ListItem title="Rename" onPress={() => actions.rename(entry)} disabled={!entry.capabilities.canRename} />
          <Divider />
          <ListItem title="Delete" titleTone="danger" onPress={() => actions.remove([entry])} disabled={!entry.capabilities.canDelete} />
        </Card>

        {!entry.isDirectory ? (
          <Card>
            <ListItem title="Privacy check" subtitle="Find personal data, hidden content and photo location" onPress={() => smart.run('privacy', [entry])} />
            <Divider />
            <ListItem title="Related files" subtitle="Receipts, photos and documents connected to this one" onPress={() => smart.run('related', [entry])} />
            <Divider />
            <ListItem title="Check for expiry date" onPress={() => smart.run('expiry', [entry])} />
            <Divider />
            <ListItem title="Compare with…" onPress={() => smart.run('compare', [entry])} />
            <Divider />
            <ListItem title="Move to Private Vault" onPress={() => smart.run('vault', [entry])} />
          </Card>
        ) : null}

        <View>
          <SectionHeader title="History in Fileora" />
          {history.length === 0 ? (
            <AppText variant="helper" tone="tertiary">
              No operations recorded for this item. Changes made by other apps are not tracked.
            </AppText>
          ) : (
            <Card>
              {history.map((operation, index) => (
                <View key={operation.id}>
                  {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                  <ListItem title={operation.title} subtitle={`${formatDateTime(operation.createdAt)} · ${operation.status}`} onPress={() => router.push('/history')} />
                </View>
              ))}
            </Card>
          )}
        </View>
      </ScrollView>
      {actions.dialogs}
      {smart.dialogs}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centerText: { textAlign: 'center' },
  hero: { alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
});
