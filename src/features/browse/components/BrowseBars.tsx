import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';

import { formatCount } from '@/core/format/format';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useClipboard } from '@/features/file_operations/actions';
import { AppText, Button, Icon, IconButton } from '@/shared/components/primitives';

import type { Crumb } from '../navigation';

export function Breadcrumbs({ trail, onSelect }: { trail: Crumb[]; onSelect: (index: number) => void }) {
  const theme = useTheme();
  const scroll = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: false }), 0);
    return () => clearTimeout(timer);
  }, [trail.length]);
  return (
    <ScrollView
      ref={scroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="toolbar"
      accessibilityLabel="Folder path"
      contentContainerStyle={{ paddingHorizontal: theme.spacing.md, alignItems: 'center' }}
      style={{ flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border }}
    >
      {trail.map((crumb, index) => {
        const last = index === trail.length - 1;
        return (
          <View key={`${crumb.uri}-${index}`} style={styles.crumbRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={last ? `${crumb.name}, current folder` : `Go to ${crumb.name}`}
              disabled={last}
              onPress={() => onSelect(index)}
              style={({ pressed }) => ({
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: theme.spacing.sm,
                borderRadius: theme.radii.sm,
                backgroundColor: pressed ? theme.colors.surfaceSunken : 'transparent',
              })}
            >
              <AppText variant="caption" tone={last ? 'primary' : 'brand'} numberOfLines={1} style={{ maxWidth: 180 }}>
                {crumb.name}
              </AppText>
            </Pressable>
            {last ? null : <Icon name="chevron-right" size={theme.iconSizes.sm} color={theme.colors.textTertiary} />}
          </View>
        );
      })}
    </ScrollView>
  );
}

export type SelectionCommand = 'copy' | 'move' | 'share' | 'delete' | 'more';

export function SelectionBar({ count, onCommand, canShare }: { count: number; onCommand: (command: SelectionCommand) => void; canShare: boolean }) {
  const theme = useTheme();
  return (
    <Animated.View
      entering={SlideInDown.springify().damping(18).stiffness(220)}
      exiting={SlideOutDown.duration(160)}
      accessibilityRole="toolbar"
      style={[styles.bar, { backgroundColor: theme.colors.surfaceRaised, borderTopColor: theme.colors.border, paddingHorizontal: theme.spacing.sm }]}
    >
      <IconButton icon="content-copy" label={`Copy ${count} selected`} onPress={() => onCommand('copy')} disabled={count === 0} />
      <IconButton icon="content-cut" label={`Move ${count} selected`} onPress={() => onCommand('move')} disabled={count === 0} />
      <IconButton icon="share-variant-outline" label={`Share ${count} selected`} onPress={() => onCommand('share')} disabled={count === 0 || !canShare} />
      <IconButton icon="delete-outline" label={`Delete ${count} selected`} onPress={() => onCommand('delete')} disabled={count === 0} color={theme.colors.danger} />
      <IconButton icon="dots-vertical" label="More actions for selection" onPress={() => onCommand('more')} disabled={count === 0} />
    </Animated.View>
  );
}

/** Shown while items are staged for copy/move: the user navigates to a folder and pastes. */
export function ClipboardBar({ onPaste, canPaste, disabledReason }: { onPaste: () => void; canPaste: boolean; disabledReason?: string }) {
  const theme = useTheme();
  const { mode, items, clear } = useClipboard();
  if (!mode || items.length === 0) return null;
  const label = `${mode === 'copy' ? 'Copy' : 'Move'} ${formatCount(items.length)} ${items.length === 1 ? 'item' : 'items'}`;
  return (
    <Animated.View entering={SlideInDown.springify().damping(18).stiffness(220)} exiting={SlideOutDown.duration(160)} style={[styles.bar, { backgroundColor: theme.colors.primarySubtle, borderTopColor: theme.colors.primary, paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md }]}>
      <Icon name="clipboard-outline" color={theme.colors.primary} />
      <View style={styles.flex}>
        <AppText variant="bodyStrong" tone="brand" numberOfLines={1}>
          {label}
        </AppText>
        <AppText variant="helper" tone="secondary" numberOfLines={2}>
          {canPaste ? 'Paste into this folder, or open another one.' : (disabledReason ?? 'Open a folder to paste.')}
        </AppText>
      </View>
      <Button label="Cancel" variant="ghost" compact onPress={clear} />
      <Button label="Paste" compact onPress={onPaste} disabled={!canPaste} icon="content-paste" />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  crumbRow: { flexDirection: 'row', alignItems: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', minHeight: 64, borderTopWidth: 1, paddingVertical: 6 },
});
