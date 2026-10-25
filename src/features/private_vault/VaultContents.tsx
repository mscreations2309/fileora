import { File } from 'expo-file-system';
import { FlashList } from '@shopify/flash-list';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { presentError, toFileoraError } from '@/core/errors/FileoraError';
import { formatBytes, formatCount, formatShortDate } from '@/core/format/format';
import { usePreferences } from '@/core/preferences/preferences';
import { mimeTypeFor } from '@/core/storage/fileTypes';
import { pickFolderUri } from '@/core/storage/locations';
import { hasNativeStorage } from '@/core/storage/storage';
import { useTheme } from '@/core/theme/ThemeProvider';
import { openFile } from '@/features/library/library';
import { FileIcon } from '@/shared/components/FileIcon';
import { ConfirmDialog, ProgressBar, PromptDialog, SearchField, Sheet, SheetAction, showToast } from '@/shared/components/overlays';
import { AppText, Button, Card, Chip, Divider, EmptyState, IconButton, ListItem, SectionHeader } from '@/shared/components/primitives';

import { SecretDialog } from './SecretDialog';
import {
  clearViewingCopies,
  createBackup,
  decryptForViewing,
  deleteFromVault,
  exportFromVault,
  importToVault,
  listVault,
  readBackupManifest,
  renameInVault,
  restoreBackup,
  useVaultRevision,
  wipeVaultFiles,
  type VaultEntry,
} from './vaultFiles';
import { changePasscode, destroyVaultKeys, keyFromEnvelope, lockVault, passcodeSupported, recoveryEnvelope, setBiometricUnlock, touchVault, useVault, validatePasscode } from './vaultKeys';

type Busy = { label: string; fraction: number | null } | null;

export function VaultContents() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const revision = useVaultRevision((s) => s.revision);
  const { biometricEnabled } = useVault();
  const prefs = usePreferences();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [query, setQuery] = useState('');
  const [collection, setCollection] = useState<string | null>(null);
  const [selected, setSelected] = useState<VaultEntry | null>(null);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [renaming, setRenaming] = useState<VaultEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<VaultEntry | null>(null);
  const [newPasscode, setNewPasscode] = useState(false);
  const [restoreKey, setRestoreKey] = useState<{ folderUri: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(() => {
    void listVault().then(setEntries).catch((e: unknown) => showToast(presentError(toFileoraError(e)).title, 'error'));
  }, []);
  useEffect(load, [load, revision]);

  const collections = useMemo(() => [...new Set(entries.map((e) => e.collection).filter(Boolean))].sort(), [entries]);
  const visible = entries.filter((e) => (!collection || e.collection === collection) && (!query.trim() || e.name.toLowerCase().includes(query.trim().toLowerCase())));
  const total = entries.reduce((s, e) => s + e.size, 0);

  const run = async (label: string, task: (progress: (f: number | null) => void) => Promise<void>) => {
    setBusy({ label, fraction: null });
    try {
      await task((fraction) => setBusy({ label, fraction }));
    } catch (error) {
      showToast(presentError(toFileoraError(error)).title, 'error');
    } finally {
      setBusy(null);
      touchVault();
    }
  };

  const importFiles = () =>
    void run('Encrypting', async (progress) => {
      const picked = await File.pickFileAsync({ multipleFiles: true });
      if (picked.canceled) return;
      let done = 0;
      for (const file of picked.result) {
        progress(picked.result.length > 1 ? done / picked.result.length : null);
        await importToVault({ uri: file.uri, name: file.name, size: file.size, mimeType: file.type || mimeTypeFor(file.name) });
        done += 1;
      }
      showToast(`${formatCount(done)} ${done === 1 ? 'file' : 'files'} encrypted and verified. The originals were not changed — delete them yourself if you no longer need them.`, 'success');
    });

  const view = (entry: VaultEntry) =>
    void run('Decrypting', async () => {
      const file = await decryptForViewing(entry);
      await openFile({
        uri: file.uri,
        parentUri: '',
        locationId: 'vault',
        name: entry.name,
        extension: '',
        isDirectory: false,
        size: entry.size,
        modifiedAt: entry.createdAt,
        mimeType: mimeTypeFor(entry.name),
        category: entry.category,
        childCount: null,
        isHidden: false,
        capabilities: { canRename: false, canDelete: false, canMove: false, canWrite: false },
      }).catch(() => showToast('No app can open this file', 'error'));
    });

  const exportEntry = (entry: VaultEntry) =>
    void run('Exporting', async () => {
      const folder = await pickFolderUri();
      if (!folder) return;
      await exportFromVault(entry, folder.uri);
      showToast(`Saved an unencrypted copy of “${entry.name}” to ${folder.name} and verified it.`, 'success');
    });

  const backup = () =>
    void run('Creating encrypted backup', async () => {
      const folder = await pickFolderUri();
      if (!folder) return;
      const result = await createBackup(folder.uri, await recoveryEnvelope());
      showToast(`Backed up ${formatCount(result.count)} items to “${result.folderName}”. You need your recovery key to restore it.`, 'success');
    });

  const restore = async (code: string) => {
    const target = restoreKey;
    setRestoreKey(null);
    if (!target) return;
    await run('Restoring backup', async (progress) => {
      const manifest = await readBackupManifest(target.folderUri);
      const backupKey = await keyFromEnvelope(manifest.envelope, code);
      const result = await restoreBackup(target.folderUri, backupKey, manifest, (done, all) => progress(all ? done / all : null));
      showToast(
        `Restored ${formatCount(result.restored)}${result.skipped ? `, ${formatCount(result.skipped)} already in vault` : ''}${result.failed ? `, ${formatCount(result.failed)} failed verification and were skipped` : ''}.`,
        result.failed ? 'error' : 'success',
      );
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={{ flexDirection: 'row' }}>
              <IconButton icon="cog-outline" label="Vault settings" onPress={() => setSettings(true)} />
              <IconButton icon="lock-outline" label="Lock vault" onPress={() => { clearViewingCopies(); lockVault(); }} />
            </View>
          ),
        }}
      />
      <View style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
        <AppText variant="meta" tone="secondary">
          {`${formatCount(entries.length)} encrypted ${entries.length === 1 ? 'item' : 'items'} · ${formatBytes(total)}`}
        </AppText>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search the vault" />
        {collections.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs }}>
            <Chip label="All" selected={collection === null} onPress={() => setCollection(null)} />
            {collections.map((c) => (
              <Chip key={c} label={c} selected={collection === c} onPress={() => setCollection(c)} />
            ))}
          </View>
        ) : null}
        <Button label="Add files" icon="file-lock-outline" onPress={importFiles} disabled={busy !== null} />
        {busy ? (
          <Card style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
            <AppText variant="helper">{`${busy.label}…`}</AppText>
            <ProgressBar progress={busy.fraction} />
          </Card>
        ) : null}
      </View>
      <FlashList
        data={visible}
        keyExtractor={(e) => e.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        ListEmptyComponent={<EmptyState icon="shield-lock-outline" title={entries.length ? 'No matches' : 'Your vault is empty'} message={entries.length ? undefined : 'Add files to encrypt them here. Originals are not changed.'} />}
        renderItem={({ item }) => (
          <ListItem
            title={item.name}
            subtitle={`${formatBytes(item.size)} · added ${formatShortDate(item.createdAt)}${item.collection ? ` · ${item.collection}` : ''}`}
            leading={<FileIcon category={item.category} />}
            onPress={() => view(item)}
            trailing={<IconButton icon="dots-vertical" label={`Options for ${item.name}`} onPress={() => setSelected(item)} size={theme.iconSizes.md} />}
          />
        )}
      />

      <Sheet visible={selected !== null} onClose={() => setSelected(null)} title={selected?.name}>
        <SheetAction icon="eye-outline" label="Open" onPress={() => { const e = selected; setSelected(null); if (e) view(e); }} />
        <SheetAction icon="export-variant" label="Export unencrypted copy…" onPress={() => { const e = selected; setSelected(null); if (e) exportEntry(e); }} />
        <SheetAction icon="pencil-outline" label="Rename or set collection" onPress={() => { const e = selected; setSelected(null); setRenaming(e); }} />
        <Divider />
        <SheetAction icon="delete-outline" label="Delete from vault" destructive onPress={() => { const e = selected; setSelected(null); setConfirmDelete(e); }} />
      </Sheet>

      <Sheet visible={settings} onClose={() => setSettings(false)} title="Vault settings">
        <ListItem title="Unlock with biometrics" onPress={() => void setBiometricUnlock(!biometricEnabled).catch((e: unknown) => showToast(presentError(toFileoraError(e)).title, 'error'))} trailing={<Switch value={biometricEnabled} onValueChange={(v) => void setBiometricUnlock(v).catch((e: unknown) => showToast(presentError(toFileoraError(e)).title, 'error'))} />} />
        <ListItem title="Lock when leaving Fileora" subtitle="Also removes temporary decrypted copies." trailing={<Switch value={prefs.vaultLockOnBackground} onValueChange={(v) => prefs.setPreference('vaultLockOnBackground', v)} />} />
        <SectionHeader title="Auto-lock after inactivity" />
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md }}>
          {[1, 2, 5, 15].map((m) => (
            <Chip key={m} label={`${m} min`} selected={prefs.vaultAutoLockMinutes === m} onPress={() => prefs.setPreference('vaultAutoLockMinutes', m)} />
          ))}
        </View>
        {passcodeSupported ? <SheetAction icon="form-textbox-password" label="Change passcode" onPress={() => { setSettings(false); setNewPasscode(true); }} /> : null}
        {hasNativeStorage ? (
          <>
            <SheetAction icon="backup-restore" label="Create encrypted backup…" onPress={() => { setSettings(false); backup(); }} />
            <SheetAction
              icon="restore"
              label="Restore from backup…"
              onPress={() => {
                setSettings(false);
                void pickFolderUri().then((folder) => folder && setRestoreKey({ folderUri: folder.uri }));
              }}
            />
          </>
        ) : null}
        <Divider />
        <SheetAction icon="delete-forever-outline" label="Delete vault and all its files" destructive onPress={() => { setSettings(false); setConfirmReset(true); }} />
      </Sheet>

      {renaming ? (
        <PromptDialog
          visible
          title="Name · collection (optional)"
          initialValue={renaming.collection ? `${renaming.name} · ${renaming.collection}` : renaming.name}
          confirmLabel="Save"
          validate={(v) => (v.split(' · ')[0]?.trim() ? null : 'Enter a name.')}
          onCancel={() => setRenaming(null)}
          onSubmit={(value) => {
            const entry = renaming;
            setRenaming(null);
            const [name = entry.name, coll = ''] = value.split(' · ');
            void renameInVault(entry, name.trim(), coll.trim());
          }}
        />
      ) : null}
      <ConfirmDialog
        visible={confirmDelete !== null}
        destructive
        title={`Delete “${confirmDelete?.name ?? ''}” from the vault?`}
        message="The encrypted file is deleted from this device. It cannot be restored from Fileora Trash."
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const entry = confirmDelete;
          setConfirmDelete(null);
          if (entry) void deleteFromVault(entry).then(() => showToast('Deleted from vault', 'success'));
        }}
      />
      <SecretDialog visible={newPasscode} title="New vault passcode" confirm confirmLabel="Change passcode" validate={validatePasscode} onCancel={() => setNewPasscode(false)} onSubmit={(v) => { setNewPasscode(false); void changePasscode(v).then(() => showToast('Passcode changed', 'success')); }} />
      <SecretDialog visible={restoreKey !== null} title="Backup recovery key" message="Enter the recovery key of the vault that made this backup." masked={false} confirmLabel="Verify and restore" onCancel={() => setRestoreKey(null)} onSubmit={(code) => void restore(code)} />
      <ConfirmDialog
        visible={confirmReset}
        destructive
        title="Delete the vault?"
        message="All encrypted files and keys are deleted from this device. Without a backup and its recovery key, they cannot be recovered."
        confirmLabel="Delete everything"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          void wipeVaultFiles().then(destroyVaultKeys).then(() => showToast('Vault deleted', 'success'));
        }}
      />
    </View>
  );
}
