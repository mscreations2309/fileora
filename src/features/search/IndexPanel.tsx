import { useCallback, useEffect, useState } from 'react';
import { Switch, View } from 'react-native';

import { formatCount, formatShortDate } from '@/core/format/format';
import { usePreferences } from '@/core/preferences/preferences';
import { hasNativeStorage } from '@/core/storage/storage';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useLocations } from '@/features/browse/locationsStore';
import { ConfirmDialog, ProgressBar, Sheet, SheetAction, showToast } from '@/shared/components/overlays';
import { AppText, Button, Card, Divider, IconButton, ListItem, SectionHeader } from '@/shared/components/primitives';

import { cancelIndexing, clearIndex, indexStats, listExclusions, removeExclusion, runIndexing, useIndexer } from './contentIndex';

/** Opt-in, explain-first controls for the on-device content index. */
export function IndexPanel() {
  const theme = useTheme();
  const enabled = usePreferences((s) => s.contentIndexEnabled);
  const indexImages = usePreferences((s) => s.indexImages);
  const setPreference = usePreferences((s) => s.setPreference);
  const locations = useLocations((s) => s.locations);
  const indexer = useIndexer();
  const [stats, setStats] = useState<{ documents: number; failed: number; lastIndexedAt: number | null } | null>(null);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [settings, setSettings] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exclusions, setExclusions] = useState<{ uri: string; label: string }[]>([]);

  const refresh = useCallback(() => {
    void indexStats().then(setStats);
    void listExclusions().then(setExclusions);
  }, []);
  useEffect(refresh, [refresh, indexer.phase]);

  const start = () => void runIndexing(locations);

  if (!enabled) {
    return (
      <Card style={{ margin: theme.spacing.lg, padding: theme.spacing.lg, gap: theme.spacing.sm }}>
        <AppText variant="heading">Search inside documents</AppText>
        <AppText variant="body" tone="secondary">
          Find files by what they say — invoices, policies, notes and scans — even when you forget the name.
        </AppText>
        <Button label="Set up content search" icon="text-search" onPress={() => setConfirmEnable(true)} />
        <ConfirmDialog
          visible={confirmEnable}
          title="Read documents on this device?"
          message={
            hasNativeStorage
              ? 'Fileora will read the text of documents in your locations — text files, Word/Excel/PowerPoint, and the first 5 pages of PDFs using on-device text recognition — and store it in a private index on this phone. Nothing is uploaded. Photos are not read unless you turn that on. You can delete the index at any time.'
              : 'Fileora will read the text of text-based files in your locations and store it in a private index on this device. Nothing is uploaded. You can delete the index at any time.'
          }
          confirmLabel="Enable and build index"
          onCancel={() => setConfirmEnable(false)}
          onConfirm={() => {
            setConfirmEnable(false);
            setPreference('contentIndexEnabled', true);
            start();
          }}
        />
      </Card>
    );
  }

  return (
    <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md }}>
      <Card style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <View style={{ flex: 1 }}>
            <AppText variant="bodyStrong">Content index</AppText>
            <AppText variant="helper" tone="secondary">
              {indexer.running
                ? `Reading ${indexer.currentName ? `“${indexer.currentName}”` : 'files'} · ${formatCount(indexer.indexed)} new, ${formatCount(indexer.unchanged)} unchanged`
                : stats
                  ? `${formatCount(stats.documents)} documents indexed${stats.lastIndexedAt ? ` · updated ${formatShortDate(stats.lastIndexedAt)}` : ''}${stats.failed ? ` · ${formatCount(stats.failed)} could not be read` : ''}`
                  : 'Loading…'}
            </AppText>
          </View>
          {indexer.running ? (
            <Button label="Stop" variant="ghost" compact onPress={cancelIndexing} />
          ) : (
            <Button label="Update" variant="secondary" compact icon="refresh" onPress={start} />
          )}
          <IconButton icon="cog-outline" label="Content index settings" onPress={() => setSettings(true)} />
        </View>
        {indexer.running ? <ProgressBar progress={null} /> : null}
        {indexer.truncated && !indexer.running ? (
          <AppText variant="caption" tone="warning">
            Stopped at the scan limit. Exclude large folders you don&apos;t need, then update again.
          </AppText>
        ) : null}
      </Card>

      <Sheet visible={settings} onClose={() => setSettings(false)} title="Content index" subtitle="Stored only on this device">
        <ListItem
          title="Read text in photos"
          subtitle="Run text recognition on images and screenshots. Slower; photos never leave the device."
          onPress={() => setPreference('indexImages', !indexImages)}
          trailing={<Switch value={indexImages} onValueChange={(v) => setPreference('indexImages', v)} accessibilityLabel="Read text in photos" />}
        />
        <Divider />
        <SectionHeader title="Excluded folders" />
        {exclusions.length === 0 ? (
          <AppText variant="helper" tone="tertiary" style={{ paddingHorizontal: theme.spacing.lg }}>
            Exclude a folder from its ⋮ menu in Browse.
          </AppText>
        ) : (
          exclusions.map((ex) => (
            <ListItem
              key={ex.uri}
              title={ex.label}
              trailing={
                <IconButton
                  icon="close"
                  label={`Include ${ex.label} again`}
                  onPress={() => void removeExclusion(ex.uri).then(refresh)}
                />
              }
            />
          ))
        )}
        <Divider />
        <SheetAction icon="refresh" label="Rebuild from scratch" onPress={() => void clearIndex().then(() => { setSettings(false); setPreference('contentIndexEnabled', true); start(); })} />
        <SheetAction icon="delete-outline" label="Delete index and turn off" destructive onPress={() => setConfirmDelete(true)} />
      </Sheet>
      <ConfirmDialog
        visible={confirmDelete}
        destructive
        title="Delete the content index?"
        message="All text Fileora extracted from your documents is deleted from this device. Your files are not touched."
        confirmLabel="Delete index"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          setSettings(false);
          cancelIndexing();
          void clearIndex().then(() => {
            setPreference('contentIndexEnabled', false);
            refresh();
            showToast('Content index deleted', 'success');
          });
        }}
      />
    </View>
  );
}
