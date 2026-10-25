import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  FadeInDown,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/core/theme/ThemeProvider';
import type { Elevation, ThemeColors, TypographyVariant } from '@/core/theme/tokens';
import { haptics } from '@/shared/motion/haptics';
import { PressableScale } from '@/shared/motion/PressableScale';

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({ name, size, color }: { name: IconName; size?: number; color?: string }) {
  const theme = useTheme();
  return (
    <MaterialCommunityIcons
      name={name}
      size={size ?? theme.iconSizes.lg}
      color={color ?? theme.colors.textSecondary}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}

type Tone = 'primary' | 'secondary' | 'tertiary' | 'accent' | 'danger' | 'warning' | 'success' | 'onPrimary' | 'brand' | 'onGradient';

const TONE_TO_COLOR: Record<Tone, keyof ThemeColors> = {
  primary: 'textPrimary',
  secondary: 'textSecondary',
  tertiary: 'textTertiary',
  accent: 'accent',
  danger: 'danger',
  warning: 'warning',
  success: 'success',
  onPrimary: 'textOnPrimary',
  brand: 'primary',
  onGradient: 'textOnGradient',
};

export function AppText({
  variant = 'body',
  tone = 'primary',
  style,
  ...rest
}: TextProps & { variant?: TypographyVariant; tone?: Tone; style?: StyleProp<TextStyle> }) {
  const theme = useTheme();
  return <Text maxFontSizeMultiplier={1.8} {...rest} style={[theme.typography[variant], { color: theme.colors[TONE_TO_COLOR[tone]] as string }, style]} />;
}

/** Fades and lifts children in on mount. Only the first screenful animates, so long lists stay instant. */
export function FadeIn({ index = 0, children, style }: { index?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  if (index > 14) return <View style={style}>{children}</View>;
  return (
    <Animated.View style={style} entering={FadeInDown.delay(Math.min(index, 10) * 32).duration(320).springify().damping(18).stiffness(180)}>
      {children}
    </Animated.View>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'tonal';

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  loading = false,
  disabled = false,
  accessibilityHint,
  style,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const inactive = disabled || loading;
  const dangerText = theme.scheme === 'dark' ? '#1A0606' : '#FFFFFF';
  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: colors.primary, fg: colors.textOnGradient, border: 'transparent' },
    secondary: { bg: colors.surface, fg: colors.textPrimary, border: colors.borderStrong },
    tonal: { bg: colors.primarySubtle, fg: colors.primary, border: 'transparent' },
    ghost: { bg: 'transparent', fg: colors.primary, border: 'transparent' },
    danger: { bg: colors.danger, fg: dangerText, border: colors.danger },
  };
  const { bg, fg, border } = palette[variant];
  const height = compact ? 40 : 52;
  const content = (
    <>
      {loading ? <ActivityIndicator color={fg} size="small" /> : icon ? <Icon name={icon} size={theme.iconSizes.md} color={fg} /> : null}
      <Text maxFontSizeMultiplier={1.6} style={[theme.typography.button, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </>
  );
  return (
    <PressableScale
      haptic
      scaleTo={0.97}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={[
        {
          minHeight: height,
          borderRadius: theme.radii.lg,
          opacity: inactive ? 0.55 : 1,
          overflow: 'hidden',
        },
        variant === 'primary' && !inactive ? theme.elevation('medium') : null,
        variant === 'primary' && !inactive ? { shadowColor: colors.primary } : null,
        style,
      ]}
    >
      {variant === 'primary' ? (
        <LinearGradient colors={colors.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.button, { minHeight: height, paddingHorizontal: compact ? theme.spacing.md : theme.spacing.xl }]}>
          {content}
        </LinearGradient>
      ) : (
        <View style={[styles.button, { minHeight: height, paddingHorizontal: compact ? theme.spacing.md : theme.spacing.xl, backgroundColor: bg, borderColor: border, borderWidth: 1, borderRadius: theme.radii.lg }]}>{content}</View>
      )}
    </PressableScale>
  );
}

export function IconButton({
  icon,
  label,
  onPress,
  color,
  disabled = false,
  size,
  tone = 'plain',
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  color?: string;
  disabled?: boolean;
  size?: number;
  tone?: 'plain' | 'tinted';
}) {
  const theme = useTheme();
  return (
    <PressableScale
      haptic
      scaleTo={0.86}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={[
        styles.iconButton,
        {
          width: theme.touchTarget,
          height: theme.touchTarget,
          borderRadius: theme.radii.pill,
          backgroundColor: tone === 'tinted' ? theme.colors.primarySubtle : 'transparent',
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Icon name={icon} size={size ?? theme.iconSizes.lg} color={color ?? (tone === 'tinted' ? theme.colors.primary : theme.colors.textPrimary)} />
    </PressableScale>
  );
}

export function ListItem({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  onLongPress,
  selected = false,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  titleTone = 'primary',
  ...rest
}: {
  title: string;
  subtitle?: string | null;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  titleTone?: Tone;
} & Pick<PressableProps, 'accessibilityActions' | 'onAccessibilityAction'>) {
  const theme = useTheme();
  return (
    <PressableScale
      scaleTo={0.985}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected, disabled }}
      disabled={disabled || (!onPress && !onLongPress)}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      {...rest}
      style={({ pressed }) => [
        styles.listItem,
        {
          minHeight: 64,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.sm,
          gap: theme.spacing.md,
          backgroundColor: selected ? theme.colors.selection : pressed ? theme.colors.surfaceSunken : 'transparent',
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      {leading}
      <View style={styles.listItemText}>
        <AppText variant="fileName" tone={titleTone} numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="meta" tone="secondary" numberOfLines={2}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {trailing}
    </PressableScale>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: { label: string; onPress: () => void } }) {
  const theme = useTheme();
  return (
    <View style={[styles.sectionHeader, { paddingHorizontal: theme.spacing.xs, paddingTop: theme.spacing.xl, paddingBottom: theme.spacing.sm }]}>
      <AppText variant="sectionLabel" tone="tertiary" accessibilityRole="header" style={styles.flex}>
        {title.toUpperCase()}
      </AppText>
      {action ? (
        <PressableScale accessibilityRole="button" onPress={action.onPress} hitSlop={12} haptic>
          <AppText variant="caption" tone="brand">
            {action.label}
          </AppText>
        </PressableScale>
      ) : null}
    </View>
  );
}

export function Card({ children, style, elevation = 'low' }: { children: ReactNode; style?: StyleProp<ViewStyle>; elevation?: Elevation }) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.xl,
          borderWidth: theme.scheme === 'dark' ? 1 : StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
        },
        theme.elevation(elevation),
        style,
      ]}
    >
      <View style={[{ borderRadius: theme.radii.xl, overflow: 'hidden' }, innerLayout(style)]}>{children}</View>
    </View>
  );
}

/** Flex/gap props apply to a Card's children, which live in the inner clipping view. */
function innerLayout(style: StyleProp<ViewStyle>): ViewStyle {
  const { gap, rowGap, columnGap, flexDirection, alignItems, justifyContent, flexWrap } = StyleSheet.flatten(style) ?? {};
  return { gap, rowGap, columnGap, flexDirection, alignItems, justifyContent, flexWrap };
}

export function Divider({ inset = 0 }: { inset?: number }) {
  const theme = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border, marginStart: inset }} />;
}

export function Chip({ label, selected, onPress, icon }: { label: string; selected: boolean; onPress: () => void; icon?: IconName }) {
  const theme = useTheme();
  const progress = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    progress.value = withTiming(selected ? 1 : 0, { duration: theme.durations.fast });
  }, [selected, progress, theme.durations.fast]);
  const animated = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [theme.colors.surface, theme.colors.primarySubtle]),
    borderColor: interpolateColor(progress.value, [0, 1], [theme.colors.border, theme.colors.primary]),
  }));
  return (
    <PressableScale
      scaleTo={0.94}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={() => {
        haptics.select();
        onPress();
      }}
    >
      <Animated.View style={[styles.chip, { minHeight: 38, paddingHorizontal: theme.spacing.md, borderRadius: theme.radii.pill, gap: theme.spacing.xs }, animated]}>
        {selected ? <Icon name="check" size={theme.iconSizes.sm} color={theme.colors.primary} /> : icon ? <Icon name={icon} size={theme.iconSizes.sm} /> : null}
        <AppText variant="caption" tone={selected ? 'brand' : 'primary'}>
          {label}
        </AppText>
      </Animated.View>
    </PressableScale>
  );
}

/** Icon on a gradient tile — the signature visual for tools and empty states. */
export function GradientTile({ icon, size = 48, colors, iconColor }: { icon: IconName; size?: number; colors?: readonly [string, string, ...string[]]; iconColor?: string }) {
  const theme = useTheme();
  return (
    <LinearGradient
      colors={colors ?? theme.colors.gradient}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ width: size, height: size, borderRadius: size * 0.32, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon name={icon} size={size * 0.5} color={iconColor ?? theme.colors.textOnGradient} />
    </LinearGradient>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
  tone = 'neutral',
}: {
  icon: IconName;
  title: string;
  message?: string;
  action?: { label: string; onPress: () => void; icon?: IconName };
  tone?: 'neutral' | 'error';
}) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const float = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    float.value = withRepeat(withSequence(withTiming(-6, { duration: 1600, easing: Easing.inOut(Easing.sin) }), withTiming(0, { duration: 1600, easing: Easing.inOut(Easing.sin) })), -1, false);
  }, [float, reduceMotion]);
  const floating = useAnimatedStyle(() => ({ transform: [{ translateY: float.value }] }));
  return (
    <Animated.View entering={FadeInDown.duration(380)} style={[styles.empty, { padding: theme.spacing.xxl, gap: theme.spacing.md }]} accessibilityRole={tone === 'error' ? 'alert' : undefined}>
      <Animated.View style={floating}>
        <View style={[styles.halo, { backgroundColor: tone === 'error' ? theme.colors.dangerSubtle : theme.colors.primarySubtle }]}>
          {tone === 'error' ? <Icon name={icon} size={theme.iconSizes.xl} color={theme.colors.danger} /> : <GradientTile icon={icon} size={60} />}
        </View>
      </Animated.View>
      <AppText variant="title" style={styles.centerText}>
        {title}
      </AppText>
      {message ? (
        <AppText variant="body" tone="secondary" style={[styles.centerText, { maxWidth: 360 }]}>
          {message}
        </AppText>
      ) : null}
      {action ? <Button label={action.label} icon={action.icon} onPress={action.onPress} variant={tone === 'error' ? 'secondary' : 'primary'} /> : null}
    </Animated.View>
  );
}

export function Badge({ label, tone }: { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'brand' }) {
  const theme = useTheme();
  const colors = {
    neutral: [theme.colors.surfaceSunken, theme.colors.textSecondary],
    success: [theme.colors.successSubtle, theme.colors.success],
    warning: [theme.colors.warningSubtle, theme.colors.warning],
    danger: [theme.colors.dangerSubtle, theme.colors.danger],
    brand: [theme.colors.primarySubtle, theme.colors.primary],
  }[tone];
  return (
    <View style={{ backgroundColor: colors[0], borderRadius: theme.radii.pill, paddingHorizontal: theme.spacing.sm + 2, paddingVertical: 3 }}>
      <AppText variant="caption" style={{ color: colors[1] }}>
        {label}
      </AppText>
    </View>
  );
}

/** Shimmering placeholder that matches the shape of the content it stands in for. */
export function Skeleton({ width, height, radius }: { width: number | `${number}%`; height: number; radius?: number }) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const shift = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    shift.value = withRepeat(withTiming(1, { duration: theme.durations.shimmer, easing: Easing.inOut(Easing.quad) }), -1, false);
  }, [shift, reduceMotion, theme.durations.shimmer]);
  const sweep = useAnimatedStyle(() => ({ transform: [{ translateX: shift.value * 400 - 200 }] }));
  return (
    <View style={{ width, height, borderRadius: radius ?? theme.radii.sm, backgroundColor: theme.colors.skeleton, overflow: 'hidden' }} accessibilityElementsHidden>
      <Animated.View style={[StyleSheet.absoluteFill, { width: 200 }, sweep]}>
        <LinearGradient colors={['transparent', theme.colors.skeletonHighlight, 'transparent']} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </View>
  );
}

/** Row-shaped skeleton list used while folders and lists load. */
export function SkeletonList({ rows = 8 }: { rows?: number }) {
  const theme = useTheme();
  return (
    <View style={{ padding: theme.spacing.lg, gap: theme.spacing.lg }} accessibilityLabel="Loading" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.listItem, { gap: theme.spacing.md, opacity: 1 - i * 0.08 }]}>
          <Skeleton width={44} height={44} radius={theme.radii.md} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width={`${60 + ((i * 13) % 30)}%`} height={14} />
            <Skeleton width={`${30 + ((i * 7) % 20)}%`} height={10} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Springs a value change into view: used for selected-state pops. */
export function usePop(trigger: unknown) {
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.value = withSequence(withTiming(1.12, { duration: 90 }), withSpring(1, { damping: 10, stiffness: 260 }));
  }, [trigger, scale]);
  return useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  iconButton: { alignItems: 'center', justifyContent: 'center' },
  listItem: { flexDirection: 'row', alignItems: 'center' },
  listItemText: { flex: 1, minWidth: 0 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  empty: { alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
  halo: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center' },
  centerText: { textAlign: 'center' },
});
