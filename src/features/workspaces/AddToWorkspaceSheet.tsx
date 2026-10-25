import { useEffect, useState } from 'react';

import type { FileEntry } from '@/core/storage/types';
import { useTheme } from '@/core/theme/ThemeProvider';
import { PromptDialog, Sheet, SheetAction, showToast } from '@/shared/components/overlays';
import { AppText } from '@/shared/components/primitives';

import { addItems, createWorkspace, listWorkspaces, validateWorkspaceName, workspacesContaining, type Workspace } from './repository';

/** Adds references (never copies) of files to a workspace. */
export function AddToWorkspaceSheet({ entries, onClose }: { entries: FileEntry[] | null; onClose: () => void }) {
  const theme = useTheme();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [containing, setContaining] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!entries) return;
    void listWorkspaces().then(setWorkspaces);
    const first = entries[0];
    if (entries.length === 1 && first) void workspacesContaining(first.uri).then(setContaining);
  }, [entries]);

  if (!entries) return null;
  const add = async (workspace: { id: string; name: string }) => {
    onClose();
    const added = await addItems(workspace.id, entries);
    showToast(
      added === 0 ? `Already in “${workspace.name}”` : `Added ${added} to “${workspace.name}”. Originals stay where they are.`,
      'success',
    );
  };

  return (
    <>
      <Sheet visible={!creating} onClose={onClose} title="Add to workspace" subtitle={entries.length === 1 ? entries[0]?.name : `${entries.length} items`}>
        {workspaces.map((workspace) => (
          <SheetAction
            key={workspace.id}
            icon={containing.has(workspace.id) ? 'check-circle' : 'briefcase-outline'}
            label={workspace.name}
            onPress={() => void add(workspace)}
          />
        ))}
        {workspaces.length === 0 ? (
          <AppText variant="helper" tone="tertiary" style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
            No workspaces yet. Workspaces group files by project without moving them.
          </AppText>
        ) : null}
        <SheetAction icon="plus" label="New workspace…" onPress={() => setCreating(true)} />
      </Sheet>
      {creating ? (
        <PromptDialog
          visible
          title="New workspace"
          initialValue=""
          confirmLabel="Create and add"
          validate={validateWorkspaceName}
          onCancel={() => {
            setCreating(false);
            onClose();
          }}
          onSubmit={(value) => {
            setCreating(false);
            void createWorkspace(value).then((id) => add({ id, name: value.trim() }));
          }}
        />
      ) : null}
    </>
  );
}
