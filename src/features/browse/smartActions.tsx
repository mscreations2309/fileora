import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';

import { presentError, toFileoraError } from '@/core/errors/FileoraError';
import type { FileEntry } from '@/core/storage/types';
import { useCompareBase } from '@/features/change_radar/CompareScreen';
import { detectInFile } from '@/features/expiry_radar/repository';
import { deleteItems } from '@/features/file_operations/actions';
import { reportResult } from '@/features/file_operations/feedback';
import { collectFiles, setOutgoing } from '@/features/file_handoff/handoff';
import { importToVault } from '@/features/private_vault/vaultFiles';
import { useVault } from '@/features/private_vault/vaultKeys';
import { ConfirmDialog, showToast } from '@/shared/components/overlays';

export type SmartAction = 'privacy' | 'compare' | 'expiry' | 'related' | 'vault' | 'send' | 'snapshot';

function params(entry: FileEntry) {
  return { uri: entry.uri, parent: entry.parentUri, name: entry.name, loc: entry.locationId };
}

/** Feature actions available from any file: privacy, compare, expiry, relationships, vault, handoff, snapshots. */
export function useSmartActions(): { run: (action: SmartAction, entries: FileEntry[]) => void; dialogs: ReactNode } {
  const [deleteOriginal, setDeleteOriginal] = useState<FileEntry | null>(null);

  const run = (action: SmartAction, entries: FileEntry[]) => {
    const [entry] = entries;
    if (!entry) return;
    switch (action) {
      case 'privacy':
        router.push({ pathname: '/privacy', params: params(entry) });
        return;
      case 'related':
        router.push({ pathname: '/related', params: params(entry) });
        return;
      case 'compare': {
        const [first, second] = entries;
        if (first && second) {
          router.push({ pathname: '/compare', params: { left: first.uri, right: second.uri } });
        } else {
          useCompareBase.getState().set(entry);
          showToast(`Now tap the file to compare with “${entry.name}”.`);
        }
        return;
      }
      case 'expiry':
        showToast(`Reading “${entry.name}” on this device…`);
        void detectInFile(entry)
          .then(({ added, readable }) =>
            !readable
              ? showToast('Fileora cannot read text from this file type.', 'error')
              : added > 0
                ? showToast(`Found ${added} possible expiry ${added === 1 ? 'date' : 'dates'}. Confirm in Expiry radar.`, 'success', { label: 'Review', onPress: () => router.push('/expiry') })
                : showToast('No expiry date was found. You can add one in Expiry radar.', 'neutral'),
          )
          .catch((e: unknown) => showToast(presentError(toFileoraError(e)).title, 'error'));
        return;
      case 'vault':
        if (!useVault.getState().key) {
          showToast('Open the Private Vault and unlock it first, then try again.', 'neutral', { label: 'Open vault', onPress: () => router.push('/vault') });
          return;
        }
        showToast(`Encrypting “${entry.name}”…`);
        void importToVault({ uri: entry.uri, name: entry.name, size: entry.size, mimeType: entry.mimeType })
          .then(() => setDeleteOriginal(entry))
          .catch((e: unknown) => showToast(presentError(toFileoraError(e)).title, 'error'));
        return;
      case 'send':
        void collectFiles(entries)
          .then((files) => {
            setOutgoing(files);
            router.push('/handoff');
          })
          .catch((e: unknown) => showToast(toFileoraError(e).message, 'error'));
        return;
      case 'snapshot':
        router.push({ pathname: '/changes', params: { record: entry.uri, name: entry.name, loc: entry.locationId } });
        return;
    }
  };

  const dialogs = (
    <ConfirmDialog
      visible={deleteOriginal !== null}
      title="Encrypted and verified"
      message={`“${deleteOriginal?.name ?? ''}” is now in your Private Vault. The unencrypted original is still here. Delete it permanently? It will not go to Trash, because Trash would keep an unencrypted copy. Flash storage may retain traces of deleted data until it is overwritten.`}
      confirmLabel="Delete original permanently"
      destructive
      onCancel={() => setDeleteOriginal(null)}
      onConfirm={() => {
        const entry = deleteOriginal;
        setDeleteOriginal(null);
        if (entry) void deleteItems([entry], true).then((r) => reportResult('delete', 1, r, false));
      }}
    />
  );

  return { run, dialogs };
}
