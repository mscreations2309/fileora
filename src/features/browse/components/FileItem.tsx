import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated';

import { formatBytes, formatItemCount, formatShortDate } from '@/core/format/format';
import { CATEGORY_LABELS } from '@/core/storage/fileTypes';
import type { FileEntry } from '@/core/storage/types';
import { useTheme } from '@/core/theme/ThemeProvider';
import { FileIcon } from '@/shared/components/FileIcon';
import { AppText, Icon, IconButton } from '@/shared/components/primitives';
import { PressableScale } from '@/shared/motion/PressableScale';

type ItemProps = {
  entry: FileEntry;
  selected: boolean;
  selecting: boolean;
  onPress: (entry: FileEntry) => void;
  onLongPress: (entry: FileEntry) => void;
  onMore: (entry: FileEntry) => void;
};

export function describeEntry(entry: FileEntry): string {
  const parts: string[] = [];
  if (entry.isDirectory) {
    if (entry.childCount !== null) parts.push(formatItemCount(entry.childCount));
  } else {
    parts.push(formatBytes(entry.size));
  }
  const date = formatShortDate(entry.modifiedAt);
  if (date) parts.push(date);
  return parts.join(' · ');
}

function accessibilityLabelFor(entry: FileEntry, selected: boolean): string {
  const kind = entry.isDirectory ? 'Folder' : CATEGORY_LABELS[entry.category];
  return `${entry.name}, ${kind}, ${describeEntry(entry)}${selected ? ', selected' : ''}`;
}

/** List row. Memoized: FlashList recycles rows and props are stable between renders. */
export const FileRow = memo(function FileRow({ entry, selected, selecting, onPress, onLongPress, onMore }: ItemProps) {
  const theme = useTheme();
  return (
    <PressableScale
      scaleTo={0.985}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabelFor(entry, selected)}
      accessibilityHint={selecting ? 'Toggles selection' : entry.isDirectory ? 'Opens folder' : 'Opens file'}
      accessibilityState={{ selected }}
      accessibilityActions={[{ name: 'longpress', label: 'Select' }, { name: 'more', label: 'More actions' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'longpress') onLongPress(entry);
        else onMore(entry);
      }}
      onPress={() => onPress(entry)}
      onLongPress={() => onLongPress(entry)}
      delayLongPress={300}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: 64,
          paddingStart: theme.spacing.lg,
          gap: theme.spacing.md,
          backgroundColor: selected ? theme.colors.selection : pressed ? theme.colors.surfaceSunken : 'transparent',
        },
      ]}
    >
      <View>
        <FileIcon category={entry.category} extension={entry.extension} />
        {selecting ? (
          <Animated.View entering={ZoomIn.springify().damping(14)} exiting={ZoomOut.duration(120)} style={[styles.check, { backgroundColor: theme.colors.surface, borderRadius: theme.radii.pill }]}>
            <Icon
              name={selected ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'}
              size={theme.iconSizes.md}
              color={selected ? theme.colors.primary : theme.colors.textTertiary}
            />
          </Animated.View>
        ) : null}
      </View>
      <View style={styles.text}>
        <AppText variant="fileName" numberOfLines={1} ellipsizeMode="middle" tone={entry.isHidden ? 'secondary' : 'primary'}>
          {entry.name}
        </AppText>
        <AppText variant="meta" tone="secondary" numberOfLines={1}>
          {describeEntry(entry)}
        </AppText>
      </View>
      {selecting ? <View style={{ width: theme.spacing.lg }} /> : <IconButton icon="dots-vertical" label={`More actions for ${entry.name}`} onPress={() => onMore(entry)} color={theme.colors.textSecondary} size={theme.iconSizes.md} />}
    </PressableScale>
  );
});

export const FileGridCell = memo(function FileGridCell({ entry, selected, selecting, onPress, onLongPress, onMore }: ItemProps) {
  const theme = useTheme();
  return (
    <PressableScale
      scaleTo={0.95}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabelFor(entry, selected)}
      accessibilityState={{ selected }}
      accessibilityActions={[{ name: 'longpress', label: 'Select' }, { name: 'more', label: 'More actions' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'longpress') onLongPress(entry);
        else onMore(entry);
      }}
      onPress={() => onPress(entry)}
      onLongPress={() => onLongPress(entry)}
      delayLongPress={300}
      style={({ pressed }) => [
        styles.cell,
        {
          margin: theme.spacing.xs,
          padding: theme.spacing.sm,
          borderRadius: theme.radii.xl,
          gap: theme.spacing.xs,
          backgroundColor: selected ? theme.colors.selection : pressed ? theme.colors.surfaceSunken : theme.colors.surface,
          borderColor: selected ? theme.colors.primary : theme.colors.border,
        },
      ]}
    >
      <FileIcon category={entry.category} extension={entry.extension} size={56} />
      <AppText variant="caption" numberOfLines={2} ellipsizeMode="middle" style={styles.cellText}>
        {entry.name}
      </AppText>
      <AppText variant="caption" tone="tertiary" numberOfLines={1}>
        {entry.isDirectory ? (entry.childCount !== null ? formatItemCount(entry.childCount) : '') : formatBytes(entry.size)}
      </AppText>
      {selecting ? (
        <View style={styles.cellCheck}>
          <Icon name={selected ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'} size={theme.iconSizes.md} color={selected ? theme.colors.primary : theme.colors.textTertiary} />
        </View>
      ) : null}
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1, minWidth: 0 },
  check: { position: 'absolute', right: -6, bottom: -6 },
  cell: { flex: 1, alignItems: 'center', borderWidth: 1, minHeight: 132 },
  cellText: { textAlign: 'center' },
  cellCheck: { position: 'absolute', top: 6, right: 6 },
});
