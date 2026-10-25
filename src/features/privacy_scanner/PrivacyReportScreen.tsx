import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { presentError, toFileoraError } from '@/core/errors/FileoraError';
import { formatCount } from '@/core/format/format';
import { mimeTypeFor } from '@/core/storage/fileTypes';
import { storage, toFileEntry } from '@/core/storage/storage';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useOperations } from '@/features/file_operations/operationsStore';
import { shareFiles } from '@/features/library/library';
import { showToast } from '@/shared/components/overlays';
import { AppText, Badge, Button, Card, EmptyState, Icon, IconButton, type IconName } from '@/shared/components/primitives';

import type { Confidence, FindingCategory } from './detectors';
import { dismissFinding, restoreDismissed, saveImageWithoutMetadata, saveRedactedCopy, scanForPrivacy, type PrivacyReport } from './scan';

const CATEGORY_ICON: Record<FindingCategory, IconName> = {
  'payment-card': 'credit-card-outline',
  'national-id': 'card-account-details-outline',
  'tax-id': 'file-document-outline',
  bank: 'bank-outline',
  email: 'email-outline',
  phone: 'phone-outline',
  secret: 'key-variant',
  'date-of-birth': 'cake-variant-outline',
  'ip-address': 'ip-network-outline',
  location: 'map-marker-outline',
  metadata: 'tag-outline',
  'hidden-content': 'eye-off-outline',
};

const CONFIDENCE: Record<Confidence, { label: string; tone: 'danger' | 'warning' | 'neutral' }> = {
  high: { label: 'Likely', tone: 'danger' },
  medium: { label: 'Possible', tone: 'warning' },
  low: { label: 'Low confidence', tone: 'neutral' },
};

export function PrivacyReportScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ uri: string; loc: string; parent: string; name: string; share?: string }>();
  const [report, setReport] = useState<PrivacyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [working, setWorking] = useState(false);
  const preShare = params.share === '1';

  const [attempt, setAttempt] = useState(0);
  const scan = () => {
    setReport(null);
    setError(null);
    setAttempt((n) => n + 1);
  };
  useEffect(() => {
    const uri = params.uri ?? '';
    let active = true;
    storage
      .stat(uri)
      .then((raw) => {
        if (!raw) throw new Error('This file is no longer available');
        return scanForPrivacy({ uri, parentUri: params.parent ?? '', name: raw.name, mimeType: mimeTypeFor(raw.name, raw.mimeType), size: raw.size });
      })
      .then((result) => {
        if (!active) return;
        setReport(result);
        setSelected(new Set(result.findings.filter((f) => f.start !== undefined && f.confidence !== 'low').map((f) => f.key)));
      })
      .catch((e: unknown) => active && setError(toFileoraError(e).message));
    return () => {
      active = false;
    };
  }, [params.uri, params.parent, attempt]);

  const act = async (task: () => Promise<string>) => {
    setWorking(true);
    try {
      showToast(await task(), 'success', { label: 'Show', onPress: () => router.back() });
      useOperations.setState((s) => ({ revision: s.revision + 1 }));
    } catch (e) {
      const failure = toFileoraError(e);
      showToast(failure.code === 'ERR_VERIFICATION_FAILED' || failure.code === 'ERR_UNSUPPORTED' ? failure.message : presentError(failure).title, 'error');
    } finally {
      setWorking(false);
    }
  };

  const shareOriginal = async () => {
    const raw = await storage.stat(params.uri ?? '').catch(() => null);
    if (!raw) return;
    await shareFiles([toFileEntry(raw, params.parent ?? '', params.loc ?? '')]).catch(() => showToast('Could not open the share sheet', 'error'));
  };

  if (error) {
    return <EmptyState tone="error" icon="alert-circle-outline" title="Could not check this file" message={error} action={{ label: 'Try again', onPress: scan }} />;
  }
  if (!report) {
    return (
      <View style={[styles.center, { backgroundColor: theme.colors.background, gap: theme.spacing.md }]}>
        <Stack.Screen options={{ title: 'Privacy check' }} />
        <ActivityIndicator color={theme.colors.primary} />
        <AppText variant="body" tone="secondary">
          Checking on this device…
        </AppText>
      </View>
    );
  }

  const redactable = report.findings.filter((f) => f.start !== undefined);
  const chosen = redactable.filter((f) => selected.has(f.key));
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Stack.Screen options={{ title: 'Privacy check' }} />
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: insets.bottom + theme.spacing.xxxl }}>
        <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
          <View style={[styles.row, { gap: theme.spacing.md }]}>
            <Icon name={report.findings.length ? 'shield-alert-outline' : 'shield-check-outline'} size={theme.iconSizes.xl} color={report.findings.length ? theme.colors.warning : theme.colors.success} />
            <View style={styles.flex}>
              <AppText variant="heading" numberOfLines={2}>
                {report.findings.length ? `${formatCount(report.findings.length)} possible ${report.findings.length === 1 ? 'issue' : 'issues'}` : 'Nothing found'}
              </AppText>
              <AppText variant="meta" tone="secondary" numberOfLines={1}>
                {report.file.name}
              </AppText>
            </View>
          </View>
          <AppText variant="helper" tone="secondary">
            {`Checked: ${report.checked.join(' · ') || 'nothing readable'}`}
          </AppText>
          {report.limitations.map((limit) => (
            <AppText key={limit} variant="helper" tone="tertiary">
              {`• ${limit}`}
            </AppText>
          ))}
          {report.findings.length === 0 ? (
            <AppText variant="helper" tone="tertiary">
              Not finding anything does not guarantee the file contains no personal information.
            </AppText>
          ) : null}
        </Card>

        {report.findings.map((finding) => {
          const isSelectable = finding.start !== undefined && report.canRedactText;
          const isSelected = selected.has(finding.key);
          const confidence = CONFIDENCE[finding.confidence];
          return (
            <Card key={finding.key} style={{ padding: theme.spacing.md, gap: theme.spacing.xs }}>
              <View style={[styles.row, { gap: theme.spacing.sm }]}>
                {isSelectable ? (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected }}
                    accessibilityLabel={`Redact ${finding.label}`}
                    hitSlop={12}
                    onPress={() => setSelected((cur) => { const next = new Set(cur); if (next.has(finding.key)) next.delete(finding.key); else next.add(finding.key); return next; })}
                  >
                    <Icon name={isSelected ? 'checkbox-marked' : 'checkbox-blank-outline'} color={isSelected ? theme.colors.primary : theme.colors.textTertiary} />
                  </Pressable>
                ) : (
                  <Icon name={CATEGORY_ICON[finding.category]} color={theme.colors.textSecondary} />
                )}
                <AppText variant="bodyStrong" style={styles.flex}>
                  {finding.label}
                </AppText>
                <Badge label={confidence.label} tone={confidence.tone} />
                <IconButton
                  icon="close"
                  label={`Dismiss ${finding.label} as a false positive`}
                  size={theme.iconSizes.md}
                  onPress={() => void dismissFinding(report.file.uri, finding.key).then(() => setReport({ ...report, findings: report.findings.filter((f) => f.key !== finding.key), dismissedCount: report.dismissedCount + 1 }))}
                />
              </View>
              <AppText variant="meta" tone="secondary">{`${finding.location} · ${finding.preview}`}</AppText>
              <AppText variant="helper">{finding.explanation}</AppText>
              <AppText variant="helper" tone="accent">{finding.suggestion}</AppText>
            </Card>
          );
        })}

        {report.dismissedCount > 0 ? (
          <Button label={`Show ${report.dismissedCount} dismissed`} variant="ghost" compact onPress={() => void restoreDismissed(report.file.uri).then(scan)} />
        ) : null}

        {report.canRedactText && redactable.length > 0 ? (
          <Button
            label={`Save redacted copy (${chosen.length})`}
            icon="file-hidden"
            loading={working}
            disabled={chosen.length === 0}
            onPress={() => void act(async () => {
              const entry = await saveRedactedCopy(report, new Set(chosen.map((f) => f.key)));
              return `Saved “${entry.name}” next to the original and verified the selected values are gone.`;
            })}
          />
        ) : null}
        {report.canStripMetadata ? (
          <Button
            label="Save copy without photo metadata"
            icon="map-marker-off-outline"
            loading={working}
            onPress={() => void act(async () => {
              const entry = await saveImageWithoutMetadata(report);
              return `Saved “${entry.name}” without location or camera details (verified). The picture itself is unchanged.`;
            })}
          />
        ) : null}
        {!report.canRedactText && redactable.length > 0 ? (
          <AppText variant="helper" tone="tertiary">
            Fileora does not redact this file type. Drawing a box over text does not remove it, so edit the document in its own app before sharing.
          </AppText>
        ) : null}
        {preShare ? <Button label="Share anyway" variant="secondary" icon="share-variant-outline" onPress={() => void shareOriginal()} /> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
