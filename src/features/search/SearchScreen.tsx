import { FlashList } from '@shopify/flash-list';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { METHOD_LABELS } from '@/core/content/extract';
import { formatBytes, formatCount, formatShortDate } from '@/core/format/format';
import { usePreferences } from '@/core/preferences/preferences';
import { storage, toFileEntry } from '@/core/storage/storage';
import type { FileCategory } from '@/core/storage/types';
import { useTheme } from '@/core/theme/ThemeProvider';
import { findLocation, useLocations } from '@/features/browse/locationsStore';
import { openDetails, openFolderDirect, showInFolder } from '@/features/browse/navigation';
import { useFileActions } from '@/features/file_operations/useFileActions';
import { FileIcon } from '@/shared/components/FileIcon';
import { SearchField, showToast } from '@/shared/components/overlays';
import { AppText, Badge, Chip, EmptyState, IconButton, SectionHeader } from '@/shared/components/primitives';

import { searchContent, useIndexer, type ContentHit } from './contentIndex';
import { recentSearches, recordSearch, searchFileNames, type SearchFilters, type SearchHit, type SearchProgress } from './filenameSearch';
import { IndexPanel } from './IndexPanel';
import { parseQuery } from './queryUnderstanding';

const CATEGORY_FILTERS: { value: FileCategory | 'any'; label: string }[] = [
  { value: 'any', label: 'All types' },
  { value: 'document', label: 'Documents' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'audio', label: 'Audio' },
  { value: 'archive', label: 'Archives' },
  { value: 'folder', label: 'Folders' },
];

const DATE_FILTERS: { value: number | null; label: string }[] = [
  { value: null, label: 'Any time' },
  { value: 7, label: 'Past week' },
  { value: 30, label: 'Past month' },
  { value: 365, label: 'Past year' },
];

type Row =
  | { kind: 'header'; key: string; title: string; note?: string }
  | { kind: 'content'; key: string; hit: ContentHit }
  | { kind: 'name'; key: string; hit: SearchHit };

/** Renders text where `[start, end)` ranges or \u0001…\u0002 markers are highlighted. */
function Highlighted({ text, ranges, numberOfLines, variant }: { text: string; ranges?: [number, number][]; numberOfLines: number; variant: 'fileName' | 'meta' }) {
  const theme = useTheme();
  const parts: { text: string; match: boolean }[] = [];
  if (ranges) {
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start > cursor) parts.push({ text: text.slice(cursor, start), match: false });
      parts.push({ text: text.slice(Math.max(start, cursor), end), match: true });
      cursor = Math.max(cursor, end);
    }
    if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  } else {
    text.split('\u0001').forEach((chunk, index) => {
      if (index === 0) {
        parts.push({ text: chunk, match: false });
        return;
      }
      const [hit = '', rest = ''] = chunk.split('\u0002');
      parts.push({ text: hit, match: true }, { text: rest, match: false });
    });
  }
  return (
    <Text numberOfLines={numberOfLines} ellipsizeMode="tail" maxFontSizeMultiplier={1.8} style={[theme.typography[variant], { color: variant === 'meta' ? theme.colors.textSecondary : theme.colors.textPrimary }]}>
      {parts.map((part, index) => (
        <Text key={index} style={part.match ? { color: theme.colors.primary, fontWeight: '700', backgroundColor: theme.colors.primarySubtle } : undefined}>
          {part.text}
        </Text>
      ))}
    </Text>
  );
}

export function SearchScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const locations = useLocations((state) => state.locations);
  const showHidden = usePreferences((state) => state.showHiddenFiles);
  const contentEnabled = usePreferences((state) => state.contentIndexEnabled);
  const indexerPhase = useIndexer((state) => state.phase);
  const actions = useFileActions();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({ category: 'any', modifiedWithinDays: null });
  const [nameHits, setNameHits] = useState<SearchHit[]>([]);
  const [contentHits, setContentHits] = useState<ContentHit[]>([]);
  const [searchProgress, setProgress] = useState<SearchProgress | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const handle = useRef<{ cancel: () => void } | null>(null);

  const trimmed = query.trim();
  const parsed = useMemo(() => (trimmed ? parseQuery(trimmed) : null), [trimmed]);

  useEffect(() => {
    void recentSearches().then(setHistory);
  }, []);

  useEffect(() => {
    handle.current?.cancel();
    if (!parsed) return;
    let active = true;
    const timer = setTimeout(() => {
      setNameHits([]);
      setContentHits([]);
      setProgress({ foldersScanned: 0, done: false, truncated: false, unreadable: 0 });
      const effective: SearchFilters = {
        ...filters,
        categories: parsed.categories,
        extensions: parsed.extensions,
        modifiedAfter: parsed.modifiedAfter,
        modifiedBefore: parsed.modifiedBefore,
      };
      handle.current = searchFileNames(locations, parsed.terms.join(' '), effective, { includeHidden: showHidden }, (batch, next) => {
        if (batch.length > 0) {
          setNameHits((current) =>
            [...current, ...batch].sort((a, b) =>
              parsed.preferLatest ? (b.entry.modifiedAt ?? 0) - (a.entry.modifiedAt ?? 0) : b.match.score - a.match.score,
            ),
          );
        }
        setProgress(next);
      });
      if (contentEnabled) {
        void searchContent(parsed).then((hits) => {
          if (!active) return;
          const filtered = hits.filter((hit) => {
            const entryCategory = hit.category;
            if (filters.category !== 'any' && entryCategory !== filters.category) return false;
            if (filters.modifiedWithinDays && (hit.modifiedAt ?? 0) < Date.now() - filters.modifiedWithinDays * 86_400_000) return false;
            return true;
          });
          setContentHits(filtered);
        });
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
      handle.current?.cancel();
    };
  }, [parsed, filters, locations, showHidden, contentEnabled, indexerPhase]);

  const searchable = locations.filter((l) => l.status === 'available');
  const progress = parsed ? searchProgress : null;
  const contentUris = new Set(contentHits.map((h) => h.uri));

  const rows: Row[] = [];
  if (parsed) {
    const visibleContent = contentHits;
    const visibleNames = nameHits.filter((hit) => !contentUris.has(hit.entry.uri));
    if (visibleContent.length > 0) {
      rows.push({ kind: 'header', key: 'h-content', title: `Inside documents · ${formatCount(visibleContent.length)}` });
      visibleContent.forEach((hit) => rows.push({ kind: 'content', key: `c-${hit.uri}`, hit }));
    }
    if (visibleNames.length > 0) {
      rows.push({ kind: 'header', key: 'h-names', title: `${parsed.terms.length ? 'File names' : 'Matching files'} · ${formatCount(visibleNames.length)}` });
      visibleNames.forEach((hit) => rows.push({ kind: 'name', key: `n-${hit.entry.uri}`, hit }));
    }
  }

  const status = !progress
    ? null
    : progress.done
      ? `${formatCount(progress.foldersScanned)} folders searched${contentEnabled ? ' · content index included' : ''}`
      : `Searching… ${formatCount(progress.foldersScanned)} folders`;

  const openContentHit = async (hit: ContentHit) => {
    void recordSearch(query);
    const raw = await storage.stat(hit.uri).catch(() => null);
    if (!raw) {
      showToast(`“${hit.name}” is no longer available. Update the index to remove it.`, 'error');
      return;
    }
    actions.open(toFileEntry(raw, hit.parentUri, hit.locationId ?? ''));
  };

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background, paddingTop: insets.top + theme.spacing.md }]}>
      <View style={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm }}>
        <AppText variant="display" accessibilityRole="header">
          Search
        </AppText>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder={contentEnabled ? 'Describe the file you need' : 'Search file names'}
          autoFocus
          onSubmit={() => void recordSearch(query).then(() => recentSearches().then(setHistory))}
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={{ gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm }}>
        {CATEGORY_FILTERS.map((filter) => (
          <Chip key={filter.value} label={filter.label} selected={filters.category === filter.value} onPress={() => setFilters((f) => ({ ...f, category: filter.value }))} />
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={{ gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
        {DATE_FILTERS.map((filter) => (
          <Chip key={filter.label} label={filter.label} selected={filters.modifiedWithinDays === filter.value} onPress={() => setFilters((f) => ({ ...f, modifiedWithinDays: filter.value }))} />
        ))}
      </ScrollView>
      {parsed && parsed.interpretations.length > 0 ? (
        <View style={[styles.row, { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.xs, flexWrap: 'wrap', paddingBottom: theme.spacing.xs }]} accessibilityLabel={`Understood as: ${parsed.interpretations.join(', ')}`}>
          <AppText variant="caption" tone="tertiary">
            Understood as:
          </AppText>
          {parsed.interpretations.map((item) => (
            <Badge key={item} label={item} tone="brand" />
          ))}
        </View>
      ) : null}
      {status ? (
        <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xs }} accessibilityLiveRegion="polite">
          <AppText variant="caption" tone="secondary">
            {status}
          </AppText>
          {progress?.truncated ? (
            <AppText variant="caption" tone="warning">
              Search stopped early to stay fast. Add filters or more words to narrow results.
            </AppText>
          ) : null}
        </View>
      ) : null}

      {!parsed ? (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}>
          {searchable.length === 0 ? (
            <EmptyState icon="folder-search-outline" title="Nothing to search yet" message="Grant storage access or add a folder in Browse first." />
          ) : (
            <>
              <IndexPanel />
              {history.length > 0 ? (
                <>
                  <SectionHeader title="Recent searches" />
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg }}>
                    {history.map((item) => (
                      <Chip key={item} label={item} icon="history" selected={false} onPress={() => setQuery(item)} />
                    ))}
                  </View>
                </>
              ) : null}
              <SectionHeader title="Try" />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg }}>
                {['invoice for my laptop', 'PDFs mentioning payment due', 'screenshots with an order number', 'documents modified last month'].map((example) => (
                  <Chip key={example} label={example} selected={false} onPress={() => setQuery(example)} />
                ))}
              </View>
            </>
          )}
        </ScrollView>
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.kind}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
          ListEmptyComponent={
            progress?.done ? (
              <EmptyState
                icon="magnify-close"
                title="Nothing matched"
                message={contentEnabled ? 'Try other words or remove filters. Files added recently may need an index update.' : 'Try other words, or set up content search to look inside documents.'}
              />
            ) : null
          }
          renderItem={({ item: row }) => {
            if (row.kind === 'header') return <SectionHeader title={row.title} />;
            if (row.kind === 'content') {
              const { hit } = row;
              const location = findLocation(hit.locationId);
              const basis = hit.approximate
                ? `Related word${hit.related.length > 1 ? 's' : ''} ${hit.related.map((w) => `“${w}”`).join(', ') || ''} · approximate match`
                : `Matched ${hit.method ? METHOD_LABELS[hit.method] : 'document text'}`;
              return (
                <View style={[styles.row, { paddingStart: theme.spacing.lg, gap: theme.spacing.md, minHeight: 84 }]}>
                  <FileIcon category={hit.category} />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${hit.name}. ${basis}. In ${location?.label ?? 'unknown location'}`}
                    style={({ pressed }) => [styles.flex, { opacity: pressed ? 0.6 : 1, paddingVertical: theme.spacing.sm }]}
                    onPress={() => void openContentHit(hit)}
                  >
                    <AppText variant="fileName" numberOfLines={1} ellipsizeMode="middle">
                      {hit.name}
                    </AppText>
                    <AppText variant="caption" tone={hit.approximate ? 'warning' : 'accent'} numberOfLines={1}>
                      {basis}
                    </AppText>
                    <Highlighted text={hit.snippet} numberOfLines={2} variant="meta" />
                  </Pressable>
                  <IconButton icon="folder-open-outline" label={`Show ${hit.name} in its folder`} onPress={() => void showInFolder({ parentUri: hit.parentUri, locationId: hit.locationId ?? '' })} size={theme.iconSizes.md} />
                </View>
              );
            }
            const { entry, match } = row.hit;
            const location = findLocation(entry.locationId);
            return (
              <View style={[styles.row, { paddingStart: theme.spacing.lg, gap: theme.spacing.md, minHeight: 68 }]}>
                <FileIcon category={entry.category} extension={entry.extension} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${entry.name}. ${match.reason}. In ${location?.label ?? 'unknown location'}`}
                  style={({ pressed }) => [styles.flex, { opacity: pressed ? 0.6 : 1, paddingVertical: theme.spacing.sm }]}
                  onPress={() => {
                    void recordSearch(query);
                    if (entry.isDirectory) openFolderDirect(entry.locationId, entry.uri, entry.name);
                    else actions.open(entry);
                  }}
                >
                  <Highlighted text={entry.name} ranges={match.ranges} numberOfLines={1} variant="fileName" />
                  <AppText variant="meta" tone="secondary" numberOfLines={1}>
                    {[match.reason, location?.label, entry.isDirectory ? null : formatBytes(entry.size), formatShortDate(entry.modifiedAt)].filter(Boolean).join(' · ')}
                  </AppText>
                </Pressable>
                <IconButton icon="folder-open-outline" label={`Show ${entry.name} in its folder`} onPress={() => void showInFolder(entry)} size={theme.iconSizes.md} />
                <IconButton icon="information-outline" label={`Details for ${entry.name}`} onPress={() => openDetails(entry)} size={theme.iconSizes.md} />
              </View>
            );
          }}
        />
      )}
      {actions.dialogs}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chips: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
