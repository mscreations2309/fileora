import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { usePreferences, type SortField } from '@/core/preferences/preferences';
import type { FileEntry } from '@/core/storage/types';
import { useTheme } from '@/core/theme/ThemeProvider';
import { isFavorite, setFavorite } from '@/features/library/library';
import { Sheet, SheetAction, showToast } from '@/shared/components/overlays';
import { Chip, Divider, SectionHeader } from '@/shared/components/primitives';

import { describeEntry } from './FileItem';

export type ItemAction =
  | 'open'
  | 'share'
  | 'copy'
  | 'move'
  | 'rename'
  | 'details'
  | 'delete'
  | 'workspace'
  | 'exclude'
  | 'privacy'
  | 'compare'
  | 'expiry'
  | 'related'
  | 'vault'
  | 'send'
  | 'snapshot';

export function ItemActionsSheet({ entry, onClose, onAction }: { entry: FileEntry | null; onClose: () => void; onAction: (action: ItemAction, entry: FileEntry) => void }) {
  const [favorite, setFavoriteState] = useState(false);
  const indexEnabled = usePreferences((s) => s.contentIndexEnabled);
  useEffect(() => {
    if (entry) void isFavorite(entry.uri).then(setFavoriteState);
  }, [entry]);
  if (!entry) return null;
  const act = (action: ItemAction) => {
    onClose();
    onAction(action, entry);
  };
  const caps = entry.capabilities;
  return (
    <Sheet visible onClose={onClose} title={entry.name} subtitle={describeEntry(entry)}>
      <SheetAction icon={entry.isDirectory ? 'folder-open-outline' : 'open-in-app'} label={entry.isDirectory ? 'Open folder' : 'Open with…'} onPress={() => act('open')} />
      {!entry.isDirectory ? <SheetAction icon="share-variant-outline" label="Share" onPress={() => act('share')} /> : null}
      <SheetAction icon="content-copy" label="Copy to…" onPress={() => act('copy')} />
      <SheetAction icon="content-cut" label="Move to…" onPress={() => act('move')} disabledReason={caps.canMove || caps.canDelete ? null : 'This location does not allow moving items out.'} />
      <SheetAction icon="pencil-outline" label="Rename" onPress={() => act('rename')} disabledReason={caps.canRename ? null : 'This location does not allow renaming.'} />
      <SheetAction
        icon={favorite ? 'star' : 'star-outline'}
        label={favorite ? 'Remove from Favorites' : 'Add to Favorites'}
        onPress={() => {
          onClose();
          void setFavorite(entry, !favorite).then(() => showToast(favorite ? 'Removed from Favorites' : 'Added to Favorites', 'success'));
        }}
      />
      <SheetAction icon="briefcase-plus-outline" label="Add to workspace" onPress={() => act('workspace')} />
      {!entry.isDirectory ? (
        <>
          <SheetAction icon="eye-off-outline" label="Privacy check" onPress={() => act('privacy')} />
          <SheetAction icon="file-compare" label="Compare with…" onPress={() => act('compare')} />
          <SheetAction icon="calendar-clock" label="Check for expiry date" onPress={() => act('expiry')} />
          <SheetAction icon="graph-outline" label="Related files" onPress={() => act('related')} />
          <SheetAction icon="shield-lock-outline" label="Move to Private Vault" onPress={() => act('vault')} />
        </>
      ) : (
        <SheetAction icon="folder-clock-outline" label="Record for Change radar" onPress={() => act('snapshot')} />
      )}
      <SheetAction icon="cellphone-arrow-down" label="Send to another device" onPress={() => act('send')} />
      {entry.isDirectory && indexEnabled ? <SheetAction icon="text-search" label="Exclude from content search" onPress={() => act('exclude')} /> : null}
      <SheetAction icon="information-outline" label="Details" onPress={() => act('details')} />
      <Divider />
      <SheetAction icon="delete-outline" label="Delete" destructive onPress={() => act('delete')} disabledReason={caps.canDelete ? null : 'This location does not allow deleting.'} />
    </Sheet>
  );
}

const SORT_FIELDS: { field: SortField; label: string }[] = [
  { field: 'name', label: 'Name' },
  { field: 'modified', label: 'Date modified' },
  { field: 'size', label: 'Size' },
  { field: 'type', label: 'Type' },
];

export function ViewOptionsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const prefs = usePreferences();
  return (
    <Sheet visible={visible} onClose={onClose} title="View options">
      <SectionHeader title="Sort by" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg }}>
        {SORT_FIELDS.map(({ field, label }) => (
          <Chip key={field} label={label} selected={prefs.sortField === field} onPress={() => prefs.setPreference('sortField', field)} />
        ))}
      </View>
      <SectionHeader title="Order" />
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg }}>
        <Chip label="Ascending" icon="sort-ascending" selected={prefs.sortDirection === 'asc'} onPress={() => prefs.setPreference('sortDirection', 'asc')} />
        <Chip label="Descending" icon="sort-descending" selected={prefs.sortDirection === 'desc'} onPress={() => prefs.setPreference('sortDirection', 'desc')} />
      </View>
      <SectionHeader title="Layout" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg }}>
        <Chip label="List" icon="view-list" selected={prefs.viewMode === 'list'} onPress={() => prefs.setPreference('viewMode', 'list')} />
        <Chip label="Grid" icon="view-grid-outline" selected={prefs.viewMode === 'grid'} onPress={() => prefs.setPreference('viewMode', 'grid')} />
        <Chip label="Folders first" selected={prefs.foldersFirst} onPress={() => prefs.setPreference('foldersFirst', !prefs.foldersFirst)} />
        <Chip label="Show hidden files" selected={prefs.showHiddenFiles} onPress={() => prefs.setPreference('showHiddenFiles', !prefs.showHiddenFiles)} />
      </View>
    </Sheet>
  );
}
