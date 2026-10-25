import { useCallback, useState, type ReactNode } from 'react';

import { router } from 'expo-router';

import { extractionMethodFor } from '@/core/content/extract';
import { presentError, toFileoraError } from '@/core/errors/FileoraError';
import { formatBytes, formatCount } from '@/core/format/format';
import { usePreferences } from '@/core/preferences/preferences';
import type { FileEntry } from '@/core/storage/types';
import { openFile, shareFiles } from '@/features/library/library';
import { ChoiceDialog, ConfirmDialog, PromptDialog, showToast } from '@/shared/components/overlays';

import { conflictsFor, createFolder, deleteItems, paste, renameItem, useClipboard, type ClipboardMode } from './actions';
import { validateFileName, type ConflictResolution } from './conflicts';
import type { Destination } from './engine';
import { reportResult } from './feedback';
import type { SourceItem } from './types';

type DialogState =
  | { kind: 'none' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'newFolder'; destination: Destination }
  | { kind: 'delete'; entries: FileEntry[] }
  | { kind: 'deletePermanent'; entries: FileEntry[] }
  | { kind: 'conflict'; mode: ClipboardMode; items: SourceItem[]; destination: Destination; conflicts: SourceItem[] }
  | { kind: 'shareCheck'; entry: FileEntry };

function totalSize(entries: FileEntry[]): string {
  const known = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  return known > 0 ? ` (${formatBytes(known)}${entries.some((e) => e.isDirectory) ? ' plus folder contents' : ''})` : '';
}

/** Shared file actions with their dialogs. Render `dialogs` once in the screen. */
export function useFileActions(): {
  dialogs: ReactNode;
  open: (entry: FileEntry) => void;
  share: (entries: FileEntry[]) => void;
  rename: (entry: FileEntry) => void;
  remove: (entries: FileEntry[]) => void;
  newFolder: (destination: Destination) => void;
  pasteInto: (destination: Destination) => void;
  stage: (mode: ClipboardMode, entries: FileEntry[]) => void;
} {
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const useTrash = usePreferences((state) => state.useTrash);
  const close = useCallback(() => setDialog({ kind: 'none' }), []);

  const open = useCallback((entry: FileEntry) => {
    openFile(entry).catch((error: unknown) => {
      const presentation = presentError(toFileoraError(error));
      showToast(`${presentation.title}. ${presentation.guidance}`, 'error');
    });
  }, []);

  const shareNow = useCallback((entries: FileEntry[]) => {
    shareFiles(entries).catch((error: unknown) => {
      const failure = toFileoraError(error);
      showToast(failure.code === 'ERR_UNSUPPORTED' ? failure.message : presentError(failure).title, 'error');
    });
  }, []);

  // Before sharing a single readable file, offer a privacy check (it never blocks sharing).
  const share = useCallback(
    (entries: FileEntry[]) => {
      const [first] = entries;
      const checkable = first && entries.length === 1 && !first.isDirectory && (extractionMethodFor(first.name, first.mimeType) !== null || ['jpg', 'jpeg'].includes(first.extension));
      if (checkable && first) setDialog({ kind: 'shareCheck', entry: first });
      else shareNow(entries);
    },
    [shareNow],
  );

  const stage = useCallback((mode: ClipboardMode, entries: FileEntry[]) => {
    useClipboard.getState().set(mode, entries);
    showToast(`${mode === 'copy' ? 'Copy' : 'Move'} ${formatCount(entries.length)} ${entries.length === 1 ? 'item' : 'items'}: open the destination folder and tap Paste.`);
  }, []);

  const runPaste = useCallback(async (mode: ClipboardMode, items: SourceItem[], destination: Destination, resolution: ConflictResolution) => {
    const result = await paste(mode, items, destination, resolution);
    if (mode === 'move' && result.status !== 'failed') useClipboard.getState().clear();
    reportResult(mode, items.length, result);
  }, []);

  const pasteInto = useCallback(
    (destination: Destination) => {
      const { mode, items } = useClipboard.getState();
      if (!mode || items.length === 0) return;
      conflictsFor(items, destination.uri)
        .then((conflicts) => {
          if (conflicts.length > 0) setDialog({ kind: 'conflict', mode, items, destination, conflicts });
          else void runPaste(mode, items, destination, 'keepBoth');
        })
        .catch((error: unknown) => showToast(presentError(toFileoraError(error)).title, 'error'));
    },
    [runPaste],
  );

  let dialogs: ReactNode = null;
  switch (dialog.kind) {
    case 'rename':
      dialogs = (
        <PromptDialog
          visible
          title={dialog.entry.isDirectory ? 'Rename folder' : 'Rename file'}
          initialValue={dialog.entry.name}
          confirmLabel="Rename"
          selectStem={!dialog.entry.isDirectory}
          validate={(value) => (value === dialog.entry.name ? 'Enter a different name.' : validateFileName(value))}
          onCancel={close}
          onSubmit={(value) => {
            const entry = dialog.entry;
            close();
            void renameItem(entry, value).then((result) => reportResult('rename', 1, result));
          }}
        />
      );
      break;
    case 'newFolder':
      dialogs = (
        <PromptDialog
          visible
          title="New folder"
          initialValue="New folder"
          confirmLabel="Create"
          validate={validateFileName}
          onCancel={close}
          onSubmit={(value) => {
            const destination = dialog.destination;
            close();
            void createFolder(destination, value).then((result) => reportResult('createFolder', 1, result));
          }}
        />
      );
      break;
    case 'delete':
      dialogs = (
        <ConfirmDialog
          visible
          title={`Move ${dialog.entries.length === 1 ? `“${dialog.entries[0]?.name}”` : `${formatCount(dialog.entries.length)} items`} to Trash?`}
          message={`You can restore items from Fileora Trash until you empty it${totalSize(dialog.entries)}. Items in shared folders may need to be copied into Trash first, which takes longer for large files.`}
          confirmLabel="Move to Trash"
          onCancel={close}
          onConfirm={() => {
            const entries = dialog.entries;
            close();
            void deleteItems(entries, false).then((result) => reportResult('trash', entries.length, result));
          }}
          secondary={{ label: 'Delete permanently…', onPress: () => setDialog({ kind: 'deletePermanent', entries: dialog.entries }) }}
        />
      );
      break;
    case 'deletePermanent':
      dialogs = (
        <ConfirmDialog
          visible
          destructive
          title="Delete permanently?"
          message={`${dialog.entries.length === 1 ? `“${dialog.entries[0]?.name}”` : `${formatCount(dialog.entries.length)} items`} will be deleted${totalSize(dialog.entries)}. This cannot be undone.`}
          confirmLabel="Delete permanently"
          onCancel={close}
          onConfirm={() => {
            const entries = dialog.entries;
            close();
            void deleteItems(entries, true).then((result) => reportResult('delete', entries.length, result, false));
          }}
        />
      );
      break;
    case 'conflict': {
      const first = dialog.conflicts[0];
      const onlyFolders = dialog.conflicts.every((item) => item.isDirectory);
      dialogs = (
        <ChoiceDialog<ConflictResolution>
          visible
          title={dialog.conflicts.length === 1 ? `“${first?.name}” already exists` : `${formatCount(dialog.conflicts.length)} names already exist`}
          message="Choose what to do with items that have the same name in this folder."
          choices={[
            { value: 'keepBoth', label: 'Keep both', description: 'New items get a numbered name, like “report (1).pdf”.' },
            { value: 'skip', label: 'Skip', description: 'Leave the existing items and skip these.' },
            ...(onlyFolders
              ? []
              : [
                  {
                    value: 'replace' as const,
                    label: 'Replace files',
                    description: useTrash ? 'Existing files move to Fileora Trash first. Folders are never merged; they keep both.' : 'Existing files are overwritten after the copy completes. Folders keep both.',
                    destructive: true,
                  },
                ]),
          ]}
          onCancel={close}
          onChoose={(resolution) => {
            const { mode, items, destination } = dialog;
            close();
            void runPaste(mode, items, destination, resolution);
          }}
        />
      );
      break;
    }
    case 'shareCheck':
      dialogs = (
        <ChoiceDialog<'check' | 'share'>
          visible
          title={`Share “${dialog.entry.name}”?`}
          message="Fileora can check it for personal data, hidden content and photo location first. The check runs on this device."
          choices={[
            { value: 'check', label: 'Check for private info first', description: 'See what the file reveals before you send it.' },
            { value: 'share', label: 'Share now', description: 'Open the share sheet without checking.' },
          ]}
          onCancel={close}
          onChoose={(choice) => {
            const entry = dialog.entry;
            close();
            if (choice === 'share') shareNow([entry]);
            else router.push({ pathname: '/privacy', params: { uri: entry.uri, parent: entry.parentUri, name: entry.name, loc: entry.locationId, share: '1' } });
          }}
        />
      );
      break;
    case 'none':
      break;
  }

  return {
    dialogs,
    open,
    share,
    rename: (entry) => setDialog({ kind: 'rename', entry }),
    remove: (entries) => setDialog({ kind: useTrash ? 'delete' : 'deletePermanent', entries }),
    newFolder: (destination) => setDialog({ kind: 'newFolder', destination }),
    pasteInto,
    stage,
  };
}
