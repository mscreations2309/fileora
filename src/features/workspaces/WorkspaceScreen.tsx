import { File } from 'expo-file-system';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { presentError, toFileoraError } from '@/core/errors/FileoraError';
import { formatBytes, formatCount, formatShortDate } from '@/core/format/format';
import { categorize, mimeTypeFor } from '@/core/storage/fileTypes';
import { storage, toFileEntry } from '@/core/storage/storage';
import { useTheme } from '@/core/theme/ThemeProvider';
import { findLocation, useLocations } from '@/features/browse/locationsStore';
import { openFolderDirect, showInFolder } from '@/features/browse/navigation';
import { openFile, shareTextFile } from '@/features/library/library';
import { FileIcon } from '@/shared/components/FileIcon';
import { ConfirmDialog, PromptDialog, Sheet, SheetAction, showToast } from '@/shared/components/overlays';
import { AppText, Badge, Button, Card, Divider, EmptyState, Icon, IconButton, ListItem, SectionHeader } from '@/shared/components/primitives';

import {
  addItems,
  buildManifest,
  checkItems,
  deleteWorkspace,
  getWorkspace,
  listItems,
  removeItems,
  updateItem,
  updateWorkspace,
  useWorkspaceRevision,
  validateWorkspaceName,
  WORKSPACE_COLORS,
  type Workspace,
  type WorkspaceItem,
} from './repository';
import { suggestForWorkspace, type Suggestion } from './suggestions';
import { workspaceColor } from './WorkspacesScreen';

type Prompt =
  | { kind: 'rename' }
  | { kind: 'note' }
  | { kind: 'labels' }
  | { kind: 'collection'; item: WorkspaceItem }
  | { kind: 'itemNote'; item: WorkspaceItem };

export function WorkspaceScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const revision = useWorkspaceRevision((s) => s.revision);
  const locations = useLocations((s) => s.locations);
  const [workspace, setWorkspace] = useState<Workspace | null | undefined>(undefined);
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [menu, setMenu] = useState(false);
  const [itemMenu, setItemMenu] = useState<WorkspaceItem | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportOptions, setExportOptions] = useState({ includeLocations: false, includeNotes: false });
  const [checking, setChecking] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(() => {
    void getWorkspace(id).then(setWorkspace);
    void listItems(id).then(setItems);
  }, [id]);
  useEffect(load, [load, revision]);

  const groups = useMemo(() => {
    const map = new Map<string, WorkspaceItem[]>();
    for (const item of items) {
      const key = item.collection || '';
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [items]);
  const collections = groups.map(([name]) => name).filter(Boolean);

  if (workspace === undefined) return null;
  if (workspace === null) {
    return <EmptyState icon="briefcase-outline" title="Workspace not found" action={{ label: 'Back', onPress: () => router.back() }} />;
  }

  const openItem = async (item: WorkspaceItem) => {
    const raw = await storage.stat(item.uri).catch(() => null);
    if (!raw) {
      showToast(`“${item.name}” is missing. It may have been moved, renamed or deleted, or access was removed.`, 'error');
      void checkItems(workspace.id);
      return;
    }
    if (raw.isDirectory) openFolderDirect(item.locationId ?? '', item.uri, item.name);
    else void openFile(toFileEntry(raw, item.parentUri, item.locationId ?? '')).catch((e: unknown) => showToast(presentError(toFileoraError(e)).title, 'error'));
  };

  const addFiles = async () => {
    try {
      const result = await File.pickFileAsync({ multipleFiles: true });
      if (result.canceled) return;
      const entries = result.result.map((file) => ({
        uri: file.uri,
        parentUri: '',
        locationId: null,
        name: file.name,
        isDirectory: false,
        size: file.size,
        mimeType: mimeTypeFor(file.name, file.type || null),
      }));
      const added = await addItems(workspace.id, entries);
      showToast(`Added ${added} ${added === 1 ? 'file' : 'files'}`, 'success');
    } catch (error) {
      showToast(presentError(toFileoraError(error)).title, 'error');
    }
  };

  const findSuggestions = async () => {
    setSuggesting(true);
    try {
      const found = await suggestForWorkspace(workspace, locations, new Set(items.map((i) => i.uri)));
      setPicked(new Set());
      setSuggestions(found);
    } finally {
      setSuggesting(false);
    }
  };

  const check = async () => {
    setChecking(true);
    const result = await checkItems(workspace.id);
    setChecking(false);
    showToast(
      result.missing === 0 && result.relinked === 0
        ? 'All files are where they should be'
        : `${result.missing} missing${result.relinked ? ` · ${result.relinked} renamed file${result.relinked === 1 ? '' : 's'} found again` : ''}`,
      result.missing ? 'error' : 'success',
    );
  };

  const color = workspaceColor(theme, workspace.color);

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <Stack.Screen options={{ title: workspace.name, headerRight: () => <IconButton icon="dots-vertical" label="Workspace options" onPress={() => setMenu(true)} /> }} />
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: insets.bottom + theme.spacing.xxxl, gap: theme.spacing.md }}>
        <View style={[styles.row, { gap: theme.spacing.sm, flexWrap: 'wrap' }]}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <AppText variant="meta" tone="secondary">
            {`${formatCount(items.length)} items · updated ${formatShortDate(workspace.updatedAt)}`}
          </AppText>
          {workspace.labels.map((label) => (
            <Badge key={label} label={label} tone="brand" />
          ))}
          {workspace.archived ? <Badge label="Archived" tone="neutral" /> : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Edit workspace note" onPress={() => setPrompt({ kind: 'note' })}>
          <Card style={{ padding: theme.spacing.md }}>
            <AppText variant="body" tone={workspace.note ? 'primary' : 'tertiary'}>
              {workspace.note || 'Add a note…'}
            </AppText>
          </Card>
        </Pressable>
        <View style={[styles.row, { gap: theme.spacing.sm, flexWrap: 'wrap' }]}>
          <Button label="Add files" icon="file-plus-outline" compact onPress={() => void addFiles()} />
          <Button label="Find related" icon="lightbulb-on-outline" variant="secondary" compact loading={suggesting} onPress={() => void findSuggestions()} />
          <Button label="Check files" icon="refresh" variant="secondary" compact loading={checking} onPress={() => void check()} />
        </View>
        <AppText variant="helper" tone="tertiary">
          Tip: in Browse or Search, use ⋮ › Add to workspace. Workspaces store references; your files are never moved or copied.
        </AppText>

        {items.length === 0 ? <EmptyState icon="briefcase-plus-outline" title="No files yet" message="Add files from this screen, Browse or Search." /> : null}
        {groups.map(([collection, groupItems]) => (
          <View key={collection || '_none'}>
            <SectionHeader title={collection || (collections.length ? 'Other' : 'Files')} />
            <Card>
              {groupItems.map((item, index) => (
                <View key={item.uri}>
                  {index > 0 ? <Divider inset={72} /> : null}
                  <ListItem
                    title={item.name}
                    subtitle={[item.missing ? 'Missing' : null, item.isDirectory ? 'Folder' : formatBytes(item.size), findLocation(item.locationId)?.label, item.note || null].filter(Boolean).join(' · ')}
                    titleTone={item.missing ? 'secondary' : 'primary'}
                    leading={<FileIcon category={categorize(item.name, item.isDirectory, item.mimeType)} />}
                    trailing={
                      <View style={styles.row}>
                        {item.missing ? <Icon name="alert-circle-outline" color={theme.colors.warning} /> : null}
                        <IconButton icon="dots-vertical" label={`Options for ${item.name}`} onPress={() => setItemMenu(item)} size={theme.iconSizes.md} />
                      </View>
                    }
                    onPress={() => void openItem(item)}
                  />
                </View>
              ))}
            </Card>
          </View>
        ))}
      </ScrollView>

      <Sheet visible={menu} onClose={() => setMenu(false)} title={workspace.name}>
        <SheetAction icon="pencil-outline" label="Rename" onPress={() => { setMenu(false); setPrompt({ kind: 'rename' }); }} />
        <SheetAction icon="tag-outline" label="Edit labels" onPress={() => { setMenu(false); setPrompt({ kind: 'labels' }); }} />
        <SheetAction icon={workspace.pinned ? 'pin-off-outline' : 'pin-outline'} label={workspace.pinned ? 'Unpin' : 'Pin to top'} onPress={() => { setMenu(false); void updateWorkspace(workspace.id, { pinned: !workspace.pinned }); }} />
        <SheetAction icon="export-variant" label="Export manifest…" onPress={() => { setMenu(false); setExporting(true); }} />
        <SheetAction icon={workspace.archived ? 'archive-arrow-up-outline' : 'archive-outline'} label={workspace.archived ? 'Unarchive' : 'Archive'} onPress={() => { setMenu(false); void updateWorkspace(workspace.id, { archived: !workspace.archived }); }} />
        <View style={[styles.row, { gap: theme.spacing.sm, padding: theme.spacing.lg }]}>
          {WORKSPACE_COLORS.map((c) => (
            <Pressable
              key={c}
              accessibilityRole="button"
              accessibilityLabel={`Color ${c}`}
              accessibilityState={{ selected: workspace.color === c }}
              onPress={() => void updateWorkspace(workspace.id, { color: c })}
              style={[styles.colorChoice, { backgroundColor: workspaceColor(theme, c), borderColor: workspace.color === c ? theme.colors.textPrimary : 'transparent' }]}
            />
          ))}
        </View>
        <Divider />
        <SheetAction icon="delete-outline" label="Delete workspace" destructive onPress={() => { setMenu(false); setConfirmDelete(true); }} />
      </Sheet>

      <Sheet visible={itemMenu !== null} onClose={() => setItemMenu(null)} title={itemMenu?.name}>
        <SheetAction icon="open-in-app" label="Open" onPress={() => { const item = itemMenu; setItemMenu(null); if (item) void openItem(item); }} />
        <SheetAction
          icon="folder-open-outline"
          label="Show in folder"
          disabledReason={itemMenu?.parentUri ? null : 'Added from the file picker; its folder is not available to Fileora.'}
          onPress={() => { const item = itemMenu; setItemMenu(null); if (item) void showInFolder({ parentUri: item.parentUri, locationId: item.locationId ?? '' }); }}
        />
        <SheetAction icon="folder-outline" label="Set collection" onPress={() => { const item = itemMenu; setItemMenu(null); if (item) setPrompt({ kind: 'collection', item }); }} />
        <SheetAction icon="note-edit-outline" label="Edit note" onPress={() => { const item = itemMenu; setItemMenu(null); if (item) setPrompt({ kind: 'itemNote', item }); }} />
        <SheetAction icon="link-variant-off" label="Remove from workspace" destructive onPress={() => { const item = itemMenu; setItemMenu(null); if (item) void removeItems(workspace.id, [item.uri]).then(() => showToast('Removed from workspace. The file was not deleted.', 'success')); }} />
      </Sheet>

      <Sheet visible={suggestions !== null} onClose={() => setSuggestions(null)} title="Related files" subtitle={`Based on “${workspace.name}”${workspace.labels.length ? ` and its labels` : ''}. Choose what to add.`}>
        {suggestions?.length === 0 ? (
          <AppText variant="helper" tone="tertiary" style={{ padding: theme.spacing.lg }}>
            Nothing related was found. Turning on content search in Search finds files by what they contain.
          </AppText>
        ) : null}
        {suggestions?.map((s) => {
          const isPicked = picked.has(s.uri);
          return (
            <ListItem
              key={s.uri}
              title={s.name}
              subtitle={s.reason}
              selected={isPicked}
              leading={<Icon name={isPicked ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'} color={isPicked ? theme.colors.primary : theme.colors.textTertiary} />}
              onPress={() => setPicked((cur) => { const next = new Set(cur); if (next.has(s.uri)) next.delete(s.uri); else next.add(s.uri); return next; })}
            />
          );
        })}
        {suggestions && suggestions.length > 0 ? (
          <View style={{ padding: theme.spacing.lg }}>
            <Button
              label={`Add ${picked.size} to workspace`}
              disabled={picked.size === 0}
              onPress={() => {
                const chosen = (suggestions ?? []).filter((s) => picked.has(s.uri));
                setSuggestions(null);
                void addItems(workspace.id, chosen).then((n) => showToast(`Added ${n} ${n === 1 ? 'file' : 'files'}`, 'success'));
              }}
            />
          </View>
        ) : null}
      </Sheet>

      <Sheet visible={exporting} onClose={() => setExporting(false)} title="Export manifest" subtitle="A JSON list of this workspace's files to share or keep as a record.">
        <ListItem title="Include file locations" subtitle="Off by default: locations can reveal private folder names." trailing={<Switch value={exportOptions.includeLocations} onValueChange={(v) => setExportOptions((o) => ({ ...o, includeLocations: v }))} />} />
        <ListItem title="Include notes" subtitle="Your workspace and file notes." trailing={<Switch value={exportOptions.includeNotes} onValueChange={(v) => setExportOptions((o) => ({ ...o, includeNotes: v }))} />} />
        <AppText variant="helper" tone="tertiary" style={{ paddingHorizontal: theme.spacing.lg }}>
          The manifest never contains file contents. Sharing it does not share the files themselves.
        </AppText>
        <View style={{ padding: theme.spacing.lg }}>
          <Button
            label="Share manifest"
            icon="share-variant-outline"
            onPress={() => {
              setExporting(false);
              const json = buildManifest(workspace, items, exportOptions);
              const safeName = workspace.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'workspace';
              void shareTextFile(`${safeName}.fileora-workspace.json`, json, 'application/json').catch((e: unknown) => showToast(presentError(toFileoraError(e)).title, 'error'));
            }}
          />
        </View>
      </Sheet>

      {prompt ? (
        <PromptDialog
          visible
          title={prompt.kind === 'rename' ? 'Rename workspace' : prompt.kind === 'note' ? 'Workspace note' : prompt.kind === 'labels' ? 'Labels (comma-separated)' : prompt.kind === 'collection' ? (collections.length ? `Collection (e.g. ${collections.slice(0, 3).join(', ')})` : 'Collection') : 'File note'}
          initialValue={
            prompt.kind === 'rename' ? workspace.name : prompt.kind === 'note' ? workspace.note : prompt.kind === 'labels' ? workspace.labels.join(', ') : prompt.kind === 'collection' ? prompt.item.collection : prompt.item.note
          }
          confirmLabel="Save"
          validate={(value) => (prompt.kind === 'rename' ? validateWorkspaceName(value) : value.length > 500 ? 'Keep it under 500 characters.' : null)}
          onCancel={() => setPrompt(null)}
          onSubmit={(value) => {
            const current = prompt;
            setPrompt(null);
            if (current.kind === 'rename') void updateWorkspace(workspace.id, { name: value });
            else if (current.kind === 'note') void updateWorkspace(workspace.id, { note: value.trim() });
            else if (current.kind === 'labels') void updateWorkspace(workspace.id, { labels: value.split(',').map((l) => l.trim()).filter(Boolean) });
            else if (current.kind === 'collection') void updateItem(workspace.id, current.item.uri, { collection: value.trim() });
            else void updateItem(workspace.id, current.item.uri, { note: value.trim() });
          }}
        />
      ) : null}
      <ConfirmDialog
        visible={confirmDelete}
        destructive
        title={`Delete “${workspace.name}”?`}
        message="The workspace, its notes and its file list are removed. Your files are not deleted."
        confirmLabel="Delete workspace"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void deleteWorkspace(workspace.id).then(() => router.back());
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  colorChoice: { width: 32, height: 32, borderRadius: 16, borderWidth: 3 },
});
