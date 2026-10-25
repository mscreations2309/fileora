import { StyleSheet, View } from 'react-native';
import Animated, { FadeOutDown, SlideInDown } from 'react-native-reanimated';
import { useShallow } from 'zustand/react/shallow';

import { formatBytes, formatCount, formatPercent } from '@/core/format/format';
import { useTheme } from '@/core/theme/ThemeProvider';
import { storage } from '@/core/storage/storage';
import { ProgressBar } from '@/shared/components/overlays';
import { AppText, IconButton } from '@/shared/components/primitives';

import { useOperations, type ActiveOperation } from '../operationsStore';

function detail(operation: ActiveOperation): { line: string; fraction: number | null } {
  const progress = operation.progress;
  if (operation.cancelRequested) return { line: 'Cancelling after the current step…', fraction: null };
  if (!progress) return { line: 'Starting…', fraction: null };
  if (progress.phase === 'scanning') {
    return { line: `Preparing${progress.totalFiles ? ` · ${formatCount(progress.totalFiles)} files found` : ''}…`, fraction: null };
  }
  const total = progress.totalBytes;
  const fraction = total && total > 0 ? progress.processedBytes / total : progress.totalFiles > 0 ? progress.processedFiles / progress.totalFiles : null;
  const verb = progress.phase === 'verifying' ? 'Verifying' : progress.phase === 'finishing' ? 'Finishing' : 'Processing';
  const bytes = total ? `${formatBytes(progress.processedBytes)} of ${formatBytes(total)}` : `${formatCount(progress.processedFiles)} files`;
  return {
    line: `${verb}${progress.currentName ? ` “${progress.currentName}”` : ''} · ${bytes}${fraction !== null ? ` · ${formatPercent(fraction)}` : ''}`,
    fraction,
  };
}

/** Floating progress for running operations. Results are reported separately (toast + history). */
export function OperationsPanel({ bottomOffset }: { bottomOffset: number }) {
  const theme = useTheme();
  const running = useOperations(useShallow((state) => Object.values(state.operations).filter((op) => op.status === 'running')));
  const cancel = useOperations((state) => state.cancel);
  if (running.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom: bottomOffset + theme.spacing.sm, paddingHorizontal: theme.spacing.md }]}>
      {running.map((operation) => {
        const { line, fraction } = detail(operation);
        return (
          <Animated.View
            key={operation.id}
            entering={SlideInDown.springify().damping(18)}
            exiting={FadeOutDown.duration(200)}
            accessibilityLiveRegion="polite"
            accessibilityLabel={`${operation.title}. ${line}`}
            style={[
              styles.card,
              { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border, borderRadius: theme.radii.xl, padding: theme.spacing.md, gap: theme.spacing.sm },
              theme.elevation('high'),
            ]}
          >
            <View style={styles.row}>
              <View style={styles.flex}>
                <AppText variant="bodyStrong" numberOfLines={1}>
                  {operation.title}
                </AppText>
                <AppText variant="helper" tone="secondary" numberOfLines={2}>
                  {line}
                </AppText>
              </View>
              <IconButton
                icon="close"
                label={`Cancel ${operation.title}`}
                onPress={() => cancel(operation.id)}
                disabled={operation.cancelRequested}
                size={theme.iconSizes.md}
              />
            </View>
            <ProgressBar progress={fraction} />
            {!storage.capabilities.cancellableTransfers ? (
              <AppText variant="caption" tone="tertiary">
                Cancelling takes effect after the current file.
              </AppText>
            ) : null}
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 0, right: 0, gap: 8 },
  card: { borderWidth: 1, elevation: 4, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
