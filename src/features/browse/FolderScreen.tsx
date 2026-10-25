import { FlashList } from '@shopify/flash-list';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { BackHandler, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { presentError } from '@/core/errors/FileoraError';
import { formatCount } from '@/core/format/format';
import { usePreferences } from '@/core/preferences/preferences';
import type { FileEntry } from '@/core/storage/types';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useCompareBase } from '@/features/change_radar/CompareScreen';
import { useClipboard } from '@/features/file_operations/actions';
import { useFileActions } from '@/features/file_operations/useFileActions';
import { canShareMultiple } from '@/features/library/library';
import { addExclusion } from '@/features/search/contentIndex';
import { AddToWorkspaceSheet } from '@/features/workspaces/AddToWorkspaceSheet';
import { Sheet, SheetAction, showToast } from '@/shared/components/overlays';
import { AppText, EmptyState, FadeIn, IconButton, SkeletonList } from '@/shared/components/primitives';

import { Breadcrumbs, ClipboardBar, SelectionBar, type SelectionCommand } from './components/BrowseBars';
import { ItemActionsSheet, ViewOptionsSheet, type ItemAction } from './components/BrowseSheets';
import { FileGridCell, FileRow } from './components/FileItem';
import { openDetails, openSubfolder, parseTrail } from './navigation';
import { useSmartActions } from './smartActions';
import { useDirectory } from './useDirectory';

export function FolderScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ loc: string; uri: string; trail: string }>();
  const folderUri = params.uri ?? '';
  const locationId = params.loc ?? '';
  const trail = useMemo(() => parseTrail(params.trail), [params.trail]);
  const title = trail[trail.length - 1]?.name ?? 'Folder';

  const { entries, status, error, refreshing, refresh } = useDirectory(folderUri, locationId);
  const viewMode = usePreferences((state) => state.viewMode);
  const clipboard = useClipboard();
  const actions = useFileActions();
  const smart = useSmartActions();
  const compareBase = useCompareBase((s) => s.base);

  const [selectedUris, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [actionsFor, setActionsFor] = useState<FileEntry | null>(null);
  const [viewOptions, setViewOptions] = useState(false);
  const [selectionMenu, setSelectionMenu] = useState(false);
  const [workspaceEntries, setWorkspaceEntries] = useState<FileEntry[] | null>(null);
  // Items that disappeared after a refresh are dropped from the selection by derivation.
  const selectedEntries = useMemo(() => entries.filter((entry) => selectedUris.has(entry.uri)), [entries, selectedUris]);
  const selected = useMemo(() => new Set(selectedEntries.map((entry) => entry.uri)), [selectedEntries]);
  const selecting = selected.size > 0;

  // Android back clears the selection before leaving the folder.
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (!selecting) return false;
        setSelected(new Set());
        return true;
      });
      return () => subscription.remove();
    }, [selecting]),
  );

  const toggle = useCallback((entry: FileEntry) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(entry.uri)) next.delete(entry.uri);
      else next.add(entry.uri);
      return next;
    });
  }, []);

  const onPress = useCallback(
    (entry: FileEntry) => {
      if (selecting) toggle(entry);
      else if (entry.isDirectory) openSubfolder(entry, trail);
      else if (compareBase && compareBase.uri !== entry.uri) {
        useCompareBase.getState().set(null);
        router.push({ pathname: '/compare', params: { left: compareBase.uri, right: entry.uri } });
      } else actions.open(entry);
    },
    [selecting, toggle, trail, actions, compareBase],
  );

  const onItemAction = (action: ItemAction, entry: FileEntry) => {
    switch (action) {
      case 'open':
        onPress(entry);
        break;
      case 'share':
        actions.share([entry]);
        break;
      case 'copy':
      case 'move':
        actions.stage(action, [entry]);
        break;
      case 'rename':
        actions.rename(entry);
        break;
      case 'details':
        openDetails(entry);
        break;
      case 'delete':
        actions.remove([entry]);
        break;
      case 'workspace':
        setWorkspaceEntries([entry]);
        break;
      case 'privacy':
      case 'compare':
      case 'expiry':
      case 'related':
      case 'vault':
      case 'send':
      case 'snapshot':
        smart.run(action, [entry]);
        break;
      case 'exclude':
        void addExclusion(entry.uri, entry.name).then(() => showToast(`“${entry.name}” is excluded from content search and its text was removed from the index.`, 'success'));
        break;
    }
  };

  const onSelectionCommand = (command: SelectionCommand) => {
    switch (command) {
      case 'copy':
      case 'move':
        actions.stage(command, selectedEntries);
        setSelected(new Set());
        break;
      case 'share':
        actions.share(selectedEntries);
        break;
      case 'delete':
        actions.remove(selectedEntries);
        setSelected(new Set());
        break;
      case 'more':
        setSelectionMenu(true);
        break;
    }
  };

  const destination = { uri: folderUri, locationId };
  const pasteBlocked =
    clipboard.mode === 'move' && clipboard.items.length > 0 && clipboard.items.every((item) => item.parentUri === folderUri)
      ? 'The items are already in this folder.'
      : clipboard.items.some((item) => item.isDirectory && (item.uri === folderUri || trail.some((crumb) => crumb.uri === item.uri)))
        ? 'A folder cannot be placed inside itself.'
        : undefined;

  const columns = Math.max(2, Math.floor(width / 128));
  const renderItem = ({ item, index }: { item: FileEntry; index: number }) => {
    const props = { entry: item, selected: selected.has(item.uri), selecting, onPress, onLongPress: toggle, onMore: setActionsFor };
    // Only the first screenful animates in; recycled rows render instantly.
    return <FadeIn index={index}>{viewMode === 'grid' ? <FileGridCell {...props} /> : <FileRow {...props} />}</FadeIn>;
  };

  let body: React.ReactNode;
  if (status === 'loading') {
    body = <SkeletonList rows={9} />;
  } else if (status === 'error' && error) {
    // Android keeps every app's Android/data and Android/obb folders private, even from file managers.
    const decodedPath = `${decodeURIComponent(folderUri).toLowerCase()}/`;
    const appPrivate = decodedPath.includes('/android/data/') || decodedPath.includes('/android/obb/');
    const presentation = appPrivate
      ? { title: 'Private to other apps', guidance: 'Android keeps each app’s data folder private. No file manager can open it; this is not a Fileora permission problem.', retryable: false }
      : presentError(error);
    body = (
      <EmptyState
        tone="error"
        icon="alert-circle-outline"
        title={presentation.title}
        message={presentation.guidance}
        action={
          error.code === 'ERR_ACCESS_DENIED' && !appPrivate
            ? { label: 'Manage storage access', icon: 'folder-key-outline', onPress: () => router.push('/storage-access') }
            : presentation.retryable || error.code === 'ERR_NOT_FOUND'
              ? { label: 'Try again', icon: 'refresh', onPress: refresh }
              : undefined
        }
      />
    );
  } else {
    body = (
      <FlashList
        key={viewMode === 'grid' ? `grid-${columns}` : 'list'}
        data={entries}
        numColumns={viewMode === 'grid' ? columns : 1}
        keyExtractor={(item) => item.uri}
        renderItem={renderItem}
        extraData={{ selected, selecting }}
        refreshing={refreshing}
        onRefresh={refresh}
        contentContainerStyle={{ paddingBottom: insets.bottom + 160, paddingHorizontal: viewMode === 'grid' ? theme.spacing.sm : 0 }}
        ListEmptyComponent={<EmptyState icon="folder-open-outline" title="This folder is empty" message="Paste items here or create a folder." />}
      />
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <Stack.Screen
        options={{
          title: selecting ? `${formatCount(selected.size)} selected` : title,
          headerRight: () =>
            selecting ? (
              <View style={styles.headerActions}>
                <IconButton icon="select-all" label="Select all" onPress={() => setSelected(new Set(entries.map((e) => e.uri)))} />
                <IconButton icon="close" label="Clear selection" onPress={() => setSelected(new Set())} />
              </View>
            ) : (
              <View style={styles.headerActions}>
                <IconButton icon="folder-plus-outline" label="New folder" onPress={() => actions.newFolder(destination)} />
                <IconButton icon="sort" label="View options" onPress={() => setViewOptions(true)} />
              </View>
            ),
        }}
      />
      <Breadcrumbs trail={trail} onSelect={(index) => router.dismiss(trail.length - 1 - index)} />
      {status === 'ready' && entries.length > 0 ? (
        <AppText variant="caption" tone="tertiary" style={{ paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.xs }}>
          {`${formatCount(entries.length)} ${entries.length === 1 ? 'item' : 'items'}`}
        </AppText>
      ) : null}
      <View style={styles.flex}>{body}</View>
      <View style={{ paddingBottom: insets.bottom, backgroundColor: theme.colors.surfaceRaised }}>
        {compareBase && !selecting ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, padding: theme.spacing.md, backgroundColor: theme.colors.primarySubtle }}>
            <AppText variant="helper" tone="brand" style={{ flex: 1 }} numberOfLines={2}>
              {`Tap a file to compare with “${compareBase.name}”`}
            </AppText>
            <IconButton icon="close" label="Cancel comparing" onPress={() => useCompareBase.getState().set(null)} />
          </View>
        ) : null}
        {selecting ? (
          <SelectionBar count={selected.size} onCommand={onSelectionCommand} canShare={selectedEntries.every((e) => !e.isDirectory) && (selectedEntries.length === 1 || canShareMultiple())} />
        ) : (
          <ClipboardBar onPaste={() => actions.pasteInto(destination)} canPaste={status === 'ready' && !pasteBlocked} disabledReason={pasteBlocked} />
        )}
      </View>

      <ItemActionsSheet entry={actionsFor} onClose={() => setActionsFor(null)} onAction={onItemAction} />
      <ViewOptionsSheet visible={viewOptions} onClose={() => setViewOptions(false)} />
      <Sheet visible={selectionMenu} onClose={() => setSelectionMenu(false)} title={`${formatCount(selected.size)} selected`}>
        <SheetAction
          icon="pencil-outline"
          label="Rename"
          disabledReason={selectedEntries.length === 1 ? (selectedEntries[0]?.capabilities.canRename ? null : 'This location does not allow renaming.') : 'Select a single item to rename.'}
          onPress={() => {
            setSelectionMenu(false);
            const [entry] = selectedEntries;
            if (entry) actions.rename(entry);
            setSelected(new Set());
          }}
        />
        <SheetAction
          icon="file-compare"
          label="Compare"
          disabledReason={selectedEntries.length === 2 && selectedEntries.every((e) => !e.isDirectory) ? null : 'Select exactly two files to compare.'}
          onPress={() => {
            setSelectionMenu(false);
            smart.run('compare', selectedEntries);
            setSelected(new Set());
          }}
        />
        <SheetAction
          icon="cellphone-arrow-down"
          label="Send to another device"
          onPress={() => {
            setSelectionMenu(false);
            smart.run('send', selectedEntries);
            setSelected(new Set());
          }}
        />
        <SheetAction
          icon="briefcase-plus-outline"
          label="Add to workspace"
          onPress={() => {
            setSelectionMenu(false);
            setWorkspaceEntries(selectedEntries);
            setSelected(new Set());
          }}
        />
        <SheetAction
          icon="information-outline"
          label="Details"
          disabledReason={selectedEntries.length === 1 ? null : 'Select a single item to see details.'}
          onPress={() => {
            setSelectionMenu(false);
            const [entry] = selectedEntries;
            if (entry) openDetails(entry);
          }}
        />
      </Sheet>
      <AddToWorkspaceSheet entries={workspaceEntries} onClose={() => setWorkspaceEntries(null)} />
      {smart.dialogs}
      {actions.dialogs}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
});
