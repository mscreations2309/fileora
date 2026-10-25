import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';

import { toFileoraError } from '@/core/errors/FileoraError';
import { formatBytes, formatDateTime } from '@/core/format/format';
import type { FileEntry } from '@/core/storage/types';
import { useTheme } from '@/core/theme/ThemeProvider';
import { shareTextFile } from '@/features/library/library';
import { showToast } from '@/shared/components/overlays';
import { AppText, Button, Card, Chip, EmptyState, Icon } from '@/shared/components/primitives';

import { compareFiles, comparisonReport, describeComparison, type Comparison } from './compare';
import { diffWords, withContext, type DiffOp } from './diff';

/** "Compare with…": the first file is remembered while the user picks the second in Browse. */
export const useCompareBase = create<{ base: FileEntry | null; set: (entry: FileEntry | null) => void }>()((set) => ({
  base: null,
  set: (entry) => set({ base: entry }),
}));

function MetaRow({ label, left, right }: { label: string; left: string; right: string }) {
  const theme = useTheme();
  const changed = left !== right;
  return (
    <View style={[styles.metaRow, { paddingVertical: theme.spacing.xs, gap: theme.spacing.sm }]}>
      <AppText variant="caption" tone="tertiary" style={styles.metaLabel}>
        {label}
      </AppText>
      <AppText variant="meta" style={styles.flex} tone={changed ? 'danger' : 'secondary'} numberOfLines={2}>
        {left}
      </AppText>
      <AppText variant="meta" style={styles.flex} tone={changed ? 'success' : 'secondary'} numberOfLines={2}>
        {right}
      </AppText>
    </View>
  );
}

function LineView({ ops }: { ops: DiffOp[] }) {
  const theme = useTheme();
  const view = withContext(ops, 2).slice(0, 1500);
  // Pair a removal directly followed by an addition so changed words can be highlighted inline.
  return (
    <Card>
      {view.map((op, index) => {
        if (op.type === 'gap') {
          return (
            <AppText key={index} variant="caption" tone="tertiary" style={{ padding: theme.spacing.xs, textAlign: 'center', backgroundColor: theme.colors.surfaceSunken }}>
              {`⋯ ${op.hidden} unchanged ${op.hidden === 1 ? 'line' : 'lines'}`}
            </AppText>
          );
        }
        const next = view[index + 1];
        const previous = view[index - 1];
        const partner = op.type === 'remove' && next?.type === 'add' ? next : op.type === 'add' && previous?.type === 'remove' ? previous : null;
        const words = partner && 'text' in partner ? (op.type === 'remove' ? diffWords(op.text, partner.text) : diffWords(partner.text, op.text)) : null;
        const bg = op.type === 'add' ? theme.colors.successSubtle : op.type === 'remove' ? theme.colors.dangerSubtle : 'transparent';
        const sign = op.type === 'add' ? '+' : op.type === 'remove' ? '−' : ' ';
        const lineNo = op.type === 'add' ? op.right : op.left;
        return (
          <View key={index} style={{ flexDirection: 'row', backgroundColor: bg, paddingHorizontal: theme.spacing.sm, paddingVertical: 2 }} accessible accessibilityLabel={`${op.type === 'add' ? 'Added' : op.type === 'remove' ? 'Removed' : 'Unchanged'} line ${lineNo}: ${op.text}`}>
            <Text style={[styles.mono, { color: theme.colors.textTertiary, width: 44 }]}>{`${lineNo ?? ''}`}</Text>
            <Text style={[styles.mono, { color: theme.colors.textSecondary, width: 14 }]}>{sign}</Text>
            <Text style={[styles.mono, styles.flex, { color: theme.colors.textPrimary }]}>
              {words
                ? words
                    .filter((w) => w.type === 'equal' || (op.type === 'add' ? w.type === 'add' : w.type === 'remove'))
                    .map((w, i) => (
                      <Text key={i} style={w.type !== 'equal' ? { fontWeight: '700', textDecorationLine: op.type === 'remove' ? 'line-through' : 'underline' } : undefined}>
                        {w.text}
                      </Text>
                    ))
                : op.text || ' '}
            </Text>
          </View>
        );
      })}
    </Card>
  );
}

export function CompareScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { left = '', right = '' } = useLocalSearchParams<{ left: string; right: string }>();
  const [result, setResult] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swap, setSwap] = useState(false);

  useEffect(() => {
    let active = true;
    compareFiles(swap ? right : left, swap ? left : right)
      .then((c) => active && setResult(c))
      .catch((e: unknown) => active && setError(toFileoraError(e).message));
    return () => {
      active = false;
    };
  }, [left, right, swap]);

  if (error) return <EmptyState tone="error" icon="alert-circle-outline" title="Could not compare" message={error} />;
  if (!result) {
    return (
      <View style={[styles.center, { backgroundColor: theme.colors.background, gap: theme.spacing.md }]}>
        <Stack.Screen options={{ title: 'Compare' }} />
        <ActivityIndicator color={theme.colors.primary} />
        <AppText variant="body" tone="secondary">
          Comparing contents…
        </AppText>
      </View>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: insets.bottom + theme.spacing.xxxl }}>
      <Stack.Screen options={{ title: 'Compare' }} />
      <Card style={{ padding: theme.spacing.md, gap: theme.spacing.xs }}>
        <View style={[styles.metaRow, { gap: theme.spacing.sm }]}>
          <View style={styles.metaLabel} />
          <AppText variant="caption" tone="danger" style={styles.flex}>
            BEFORE
          </AppText>
          <AppText variant="caption" tone="success" style={styles.flex}>
            AFTER
          </AppText>
        </View>
        <MetaRow label="Name" left={result.left.name} right={result.right.name} />
        <MetaRow label="Size" left={formatBytes(result.left.size)} right={formatBytes(result.right.size)} />
        <MetaRow label="Modified" left={formatDateTime(result.left.modifiedAt)} right={formatDateTime(result.right.modifiedAt)} />
        <MetaRow label="SHA-256" left={result.left.sha256.slice(0, 12)} right={result.right.sha256.slice(0, 12)} />
      </Card>
      <View style={[styles.row, { gap: theme.spacing.sm }]}>
        <Icon name={result.kind === 'identical' ? 'check-circle' : 'file-compare'} color={result.kind === 'identical' ? theme.colors.success : theme.colors.primary} />
        <AppText variant="heading" style={styles.flex}>
          {describeComparison(result)}
        </AppText>
      </View>
      <View style={[styles.row, { gap: theme.spacing.sm }]}>
        <Chip label="Swap before/after" icon="swap-horizontal" selected={false} onPress={() => { setResult(null); setSwap((s) => !s); }} />
        <Button
          label="Export report"
          variant="secondary"
          compact
          icon="export-variant"
          onPress={() => void shareTextFile('Fileora change report.txt', comparisonReport(result), 'text/plain').catch(() => showToast('Could not share the report', 'error'))}
        />
      </View>

      {result.kind === 'identical' ? (
        <AppText variant="body" tone="secondary">
          Both files have exactly the same content (same SHA-256), even if their names or dates differ.
        </AppText>
      ) : null}
      {result.kind === 'text' ? (
        <>
          {result.note ? (
            <AppText variant="helper" tone="warning">
              {result.note}
            </AppText>
          ) : null}
          {result.summary.added + result.summary.removed === 0 ? (
            <AppText variant="body" tone="secondary">
              The readable text is the same. Differences are in formatting, images or embedded data, which Fileora does not compare.
            </AppText>
          ) : (
            <LineView ops={result.ops} />
          )}
        </>
      ) : null}
      {result.kind === 'json' ? (
        <>
          {result.changes.slice(0, 300).map((change, i) => (
            <Card key={i} style={{ padding: theme.spacing.md, gap: 2 }}>
              <AppText variant="caption" tone={change.kind === 'added' ? 'success' : change.kind === 'removed' ? 'danger' : 'warning'}>
                {`${change.kind.toUpperCase()} · ${change.path}`}
              </AppText>
              {change.kind !== 'added' ? <Text style={[styles.mono, { color: theme.colors.danger }]}>{`− ${JSON.stringify(change.before)}`}</Text> : null}
              {change.kind !== 'removed' ? <Text style={[styles.mono, { color: theme.colors.success }]}>{`+ ${JSON.stringify(change.after)}`}</Text> : null}
            </Card>
          ))}
          {result.changes.length === 0 ? <AppText variant="helper" tone="tertiary">Could not parse one side as JSON; showing a line comparison.</AppText> : null}
          {result.changes.length === 0 ? <LineView ops={result.ops} /> : null}
        </>
      ) : null}
      {result.kind === 'csv' ? (
        <>
          {result.diff.headerChanged ? <AppText variant="helper" tone="warning">The header row changed, so column meanings may have shifted.</AppText> : null}
          {result.diff.addedRows.length ? <AppText variant="body">{`Rows added: ${result.diff.addedRows.join(', ')}`}</AppText> : null}
          {result.diff.removedRows.length ? <AppText variant="body">{`Rows removed: ${result.diff.removedRows.join(', ')}`}</AppText> : null}
          <Card>
            {result.diff.changedCells.slice(0, 500).map((cell) => (
              <View key={cell.cell} style={[styles.row, { padding: theme.spacing.sm, gap: theme.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border }]}>
                <AppText variant="bodyStrong" style={{ width: 56 }}>
                  {cell.cell}
                </AppText>
                <View style={styles.flex}>
                  {cell.header ? <AppText variant="caption" tone="tertiary">{`Column “${cell.header}”, row ${cell.row}`}</AppText> : null}
                  <AppText variant="meta">
                    <Text style={{ color: theme.colors.danger, textDecorationLine: 'line-through' }}>{cell.before || '(empty)'}</Text>
                    {'  →  '}
                    <Text style={{ color: theme.colors.success }}>{cell.after || '(empty)'}</Text>
                  </AppText>
                </View>
              </View>
            ))}
          </Card>
          <AppText variant="helper" tone="tertiary">
            Cells are compared by position. If rows were inserted in the middle, later rows show as changed.
          </AppText>
        </>
      ) : null}
      {result.kind === 'image' ? (
        <AppText variant="body" tone="secondary">
          {result.distance === null
            ? 'These images could not be compared visually. Their content differs.'
            : `Visual fingerprints differ by ${result.distance} of 64 bits. Fileora compares a small grayscale version of each image, so it detects edits, crops and re-saves but not tiny pixel changes.`}
        </AppText>
      ) : null}
      {result.kind === 'binary' ? (
        <AppText variant="body" tone="secondary">
          The contents differ, but Fileora cannot show what changed inside this file type. Sizes and dates are shown above.
        </AppText>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'flex-start' },
  metaLabel: { width: 64 },
  mono: { fontFamily: 'monospace', fontSize: 12, lineHeight: 17 },
});
