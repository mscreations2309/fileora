import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { formatCount, formatShortDate } from '@/core/format/format';
import { useTheme } from '@/core/theme/ThemeProvider';
import type { Theme } from '@/core/theme/tokens';
import { File } from 'expo-file-system';

import type { FileEntry } from '@/core/storage/types';
import { useLocations } from '@/features/browse/locationsStore';
import { searchFileNames } from '@/features/search/filenameSearch';
import { PromptDialog, showToast } from '@/shared/components/overlays';
import { AppText, Badge, Chip, EmptyState, Icon, IconButton, SectionHeader } from '@/shared/components/primitives';
import { TabScreen } from '@/shared/components/TabScreen';

import { createWorkspace, importManifest, listWorkspaces, useWorkspaceRevision, validateWorkspaceName, type Workspace, type WorkspaceColor } from './repository';

export function workspaceColor(theme: Theme, color: WorkspaceColor): string {
  const map: Record<WorkspaceColor, string> = {
    indigo: theme.colors.primary,
    teal: theme.colors.accent,
    amber: theme.colors.warning,
    rose: theme.colors.danger,
    violet: theme.colors.fileVideo,
    slate: theme.colors.textSecondary,
  };
  return map[color];
}

function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const theme = useTheme();
  const color = workspaceColor(theme, workspace.color);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${workspace.name}, ${workspace.itemCount} items${workspace.missingCount ? `, ${workspace.missingCount} missing` : ''}${workspace.pinned ? ', pinned' : ''}`}
      onPress={() => router.push({ pathname: '/workspace', params: { id: workspace.id } })}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: pressed ? theme.colors.surfaceSunken : theme.colors.surface, borderColor: theme.colors.border, borderRadius: theme.radii.lg, padding: theme.spacing.md, gap: theme.spacing.xs },
      ]}
    >
      <View style={[styles.row, { gap: theme.spacing.sm }]}>
        <View style={[styles.swatch, { backgroundColor: color, borderRadius: theme.radii.sm }]}>
          <Icon name="briefcase-outline" size={theme.iconSizes.md} color="#FFFFFF" />
        </View>
        <View style={styles.flex}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {workspace.name}
          </AppText>
          <AppText variant="meta" tone="secondary">
            {`${formatCount(workspace.itemCount)} ${workspace.itemCount === 1 ? 'item' : 'items'} · updated ${formatShortDate(workspace.updatedAt)}`}
          </AppText>
        </View>
        {workspace.pinned ? <Icon name="pin" size={theme.iconSizes.md} color={theme.colors.textTertiary} /> : null}
      </View>
      {workspace.missingCount > 0 || workspace.labels.length > 0 || workspace.archived ? (
        <View style={[styles.row, { gap: theme.spacing.xs, flexWrap: 'wrap' }]}>
          {workspace.missingCount > 0 ? <Badge label={`${workspace.missingCount} missing`} tone="warning" /> : null}
          {workspace.archived ? <Badge label="Archived" tone="neutral" /> : null}
          {workspace.labels.map((label) => (
            <Badge key={label} label={label} tone="brand" />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

export function WorkspacesScreen() {
  const theme = useTheme();
  const revision = useWorkspaceRevision((s) => s.revision);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void listWorkspaces(showArchived).then(setWorkspaces);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showArchived, revision]),
  );

  const locations = useLocations((s) => s.locations);
  const importFromFile = async () => {
    try {
      const picked = await File.pickFileAsync({ mimeTypes: ['application/json', 'text/plain', '*/*'] });
      if (picked.canceled) return;
      const text = await picked.result.text();
      const result = await importManifest(text, async (name, size) => {
        const found = await new Promise<FileEntry | null>((resolve) => {
          const handle = searchFileNames(locations, name, { category: 'any', modifiedWithinDays: null }, { includeHidden: false }, (batch, progress) => {
            const exact = batch.find((hit) => hit.entry.name === name && (size === null || hit.entry.size === size));
            if (exact) {
              handle.cancel();
              resolve(exact.entry);
            } else if (progress.done) {
              resolve(null);
            }
          });
        });
        return found ? { uri: found.uri, parentUri: found.parentUri, locationId: found.locationId, name: found.name, isDirectory: found.isDirectory, size: found.size, mimeType: found.mimeType } : null;
      });
      showToast(`Imported: ${result.matched} files found${result.missing ? `, ${result.missing} not found on this device (shown as missing)` : ''}`, result.missing ? 'neutral' : 'success');
      router.push({ pathname: '/workspace', params: { id: result.id } });
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not import the manifest', 'error');
    }
  };

  const pinned = (workspaces ?? []).filter((w) => w.pinned && !w.archived);
  const others = (workspaces ?? []).filter((w) => !w.pinned || w.archived);

  return (
    <TabScreen
      title="Workspaces"
      subtitle="Group files by project without moving them."
      headerAccessory={
        <View style={styles.row}>
          <IconButton icon="file-import-outline" label="Import workspace manifest" onPress={() => void importFromFile()} />
          <IconButton icon="plus" label="New workspace" onPress={() => setCreating(true)} />
        </View>
      }
    >
      <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md, flexDirection: 'row' }}>
        <Chip label="Show archived" selected={showArchived} onPress={() => setShowArchived((v) => !v)} />
      </View>
      {workspaces && workspaces.length === 0 ? (
        <EmptyState
          icon="briefcase-outline"
          title="No workspaces yet"
          message="Create one for a car purchase, client project or tax year, then add files from Browse, Search or here. Files stay where they are."
          action={{ label: 'New workspace', icon: 'plus', onPress: () => setCreating(true) }}
        />
      ) : null}
      {pinned.length > 0 ? (
        <View style={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm }}>
          <SectionHeader title="Pinned" />
          {pinned.map((w) => (
            <WorkspaceCard key={w.id} workspace={w} />
          ))}
        </View>
      ) : null}
      {others.length > 0 ? (
        <View style={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm }}>
          <SectionHeader title={pinned.length > 0 ? 'Recent' : 'All workspaces'} />
          {others.map((w) => (
            <WorkspaceCard key={w.id} workspace={w} />
          ))}
        </View>
      ) : null}
      {creating ? (
        <PromptDialog
          visible
          title="New workspace"
          initialValue=""
          confirmLabel="Create"
          validate={validateWorkspaceName}
          onCancel={() => setCreating(false)}
          onSubmit={(value) => {
            setCreating(false);
            void createWorkspace(value).then((id) => router.push({ pathname: '/workspace', params: { id } }));
          }}
        />
      ) : null}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  card: { borderWidth: 1 },
  swatch: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
