import { LinearGradient } from 'expo-linear-gradient';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';

import { useTheme } from '@/core/theme/ThemeProvider';
import { haptics } from '@/shared/motion/haptics';
import { PressableScale } from '@/shared/motion/PressableScale';

/**
 * Floating tab bar: a gradient pill springs to the active tab, the active icon pops, labels stay
 * visible for clarity. All motion runs on the UI thread.
 */
export function AnimatedTabBar({ state, descriptors, navigateToTab, insets }: BottomTabBarProps) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const count = state.routes.length;
  const tabWidth = count > 0 ? width / count : 0;
  const position = useSharedValue(state.index);

  useEffect(() => {
    position.value = reduceMotion ? state.index : withSpring(state.index, theme.springs.snappy);
  }, [state.index, position, reduceMotion, theme.springs.snappy]);

  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: position.value * tabWidth }], width: tabWidth }));

  return (
    <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: Math.max(insets.bottom, theme.spacing.sm), paddingTop: theme.spacing.xs, backgroundColor: theme.colors.background }}>
      <View
        accessibilityRole="tablist"
        onLayout={(e) => setWidth(e.nativeEvent.layout.width - theme.spacing.sm * 2)}
        style={[
          styles.bar,
          { backgroundColor: theme.colors.surfaceGlass, borderRadius: theme.radii.xxl, borderColor: theme.colors.border, padding: theme.spacing.sm },
          theme.elevation('medium'),
        ]}
      >
        {width > 0 ? (
          <Animated.View style={[styles.pill, { top: theme.spacing.sm, bottom: theme.spacing.sm, left: theme.spacing.sm }, pill]} pointerEvents="none">
            <View style={[StyleSheet.absoluteFill, { margin: 2, borderRadius: theme.radii.xl, overflow: 'hidden' }]}>
              <LinearGradient colors={theme.colors.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
            </View>
          </Animated.View>
        ) : null}
        {state.routes.map((route, index) => {
          const descriptor = descriptors[route.key];
          const options = descriptor?.options;
          const focused = state.index === index;
          const label = typeof options?.title === 'string' ? options.title : route.name;
          const color = focused ? theme.colors.textOnGradient : theme.colors.textSecondary;
          return (
            <TabButton
              key={route.key}
              focused={focused}
              label={label}
              accessibilityLabel={options?.tabBarAccessibilityLabel ?? label}
              onPress={() => {
                if (!focused) {
                  haptics.select();
                  navigateToTab(route.key);
                }
              }}
              icon={options?.tabBarIcon?.({ focused, color, size: 22 }) ?? null}
              color={color}
            />
          );
        })}
      </View>
    </View>
  );
}

function TabButton({ focused, label, accessibilityLabel, onPress, icon, color }: { focused: boolean; label: string; accessibilityLabel: string; onPress: () => void; icon: React.ReactNode; color: string }) {
  const theme = useTheme();
  const pop = useSharedValue(1);
  useEffect(() => {
    if (focused) pop.value = withSequence(withTiming(1.18, { duration: 110 }), withSpring(1, theme.springs.bouncy));
  }, [focused, pop, theme.springs.bouncy]);
  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  return (
    <PressableScale
      scaleTo={0.9}
      accessibilityRole="tab"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: focused }}
      onPress={onPress}
      style={styles.tab}
    >
      <Animated.View style={iconStyle}>{icon}</Animated.View>
      <Animated.Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={[theme.typography.caption, { color, fontSize: 11, marginTop: 2 }]}>
        {label}
      </Animated.Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth },
  pill: { position: 'absolute' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 54 },
});
