import type { ReactNode } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import Animated, { Extrapolation, interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/core/theme/ThemeProvider';

import { AppText } from './primitives';

/**
 * Top-level tab screen with a large title that collapses into a compact glass bar as you scroll.
 * The scroll-to-header link runs entirely on the UI thread (no re-renders while scrolling).
 */
export function TabScreen({
  title,
  subtitle,
  headerAccessory,
  children,
  refreshing,
  onRefresh,
  hero,
}: {
  title: string;
  subtitle?: string;
  headerAccessory?: ReactNode;
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Optional element rendered behind the large title (e.g. a gradient). */
  hero?: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  const largeTitle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [0, 60], [1, 0], Extrapolation.CLAMP),
    transform: [
      { translateY: interpolate(scrollY.value, [-100, 0, 80], [20, 0, -12], Extrapolation.CLAMP) },
      { scale: interpolate(scrollY.value, [-120, 0], [1.08, 1], Extrapolation.CLAMP) },
    ],
  }));
  const compactBar = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [40, 80], [0, 1], Extrapolation.CLAMP) }));
  const compactTitle = useAnimatedStyle(() => ({ transform: [{ translateY: interpolate(scrollY.value, [40, 90], [8, 0], Extrapolation.CLAMP) }] }));

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: insets.top + theme.spacing.lg, paddingBottom: theme.spacing.xxxl * 2 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing ?? false} onRefresh={onRefresh} tintColor={theme.colors.primary} colors={[theme.colors.primary]} progressViewOffset={insets.top} /> : undefined}
      >
        {hero}
        <Animated.View style={[styles.header, { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md }, largeTitle]}>
          <View style={styles.flex}>
            <AppText variant="display" accessibilityRole="header" tone={hero ? 'onGradient' : 'primary'}>
              {title}
            </AppText>
            {subtitle ? (
              <AppText variant="body" tone={hero ? 'onGradient' : 'secondary'} style={hero ? { opacity: 0.85 } : undefined}>
                {subtitle}
              </AppText>
            ) : null}
          </View>
          {headerAccessory}
        </Animated.View>
        {children}
      </Animated.ScrollView>
      <Animated.View
        pointerEvents="none"
        style={[styles.compact, { paddingTop: insets.top, height: insets.top + 52, backgroundColor: theme.colors.surfaceGlass, borderBottomColor: theme.colors.border }, compactBar]}
      >
        <Animated.View style={compactTitle}>
          <AppText variant="heading">{title}</AppText>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center' },
  compact: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
});
