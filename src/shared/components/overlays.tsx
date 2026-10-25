import { useEffect, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  FadeOutDown,
  interpolateColor,
  SlideInDown,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { create } from 'zustand';

import { useTheme } from '@/core/theme/ThemeProvider';
import { haptics } from '@/shared/motion/haptics';
import { PressableScale } from '@/shared/motion/PressableScale';

import { AppText, Button, Icon, type IconName } from './primitives';

/**
 * Bottom sheet: springs up from the bottom, scrim fades in, and it can be dragged down to dismiss.
 * Stays mounted while animating out so closing is smooth.
 */
export function Sheet({ visible, onClose, title, subtitle, children }: { visible: boolean; onClose: () => void; title?: string; subtitle?: string; children: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const translate = useSharedValue(height);
  const scrim = useSharedValue(0);

  if (visible && !mounted) setMounted(true);

  useEffect(() => {
    if (!mounted) return;
    if (visible) {
      translate.value = reduceMotion ? 0 : withSpring(0, theme.springs.snappy);
      scrim.value = withTiming(1, { duration: theme.durations.normal });
    } else {
      scrim.value = withTiming(0, { duration: theme.durations.fast });
      translate.value = withTiming(height, { duration: theme.durations.normal, easing: Easing.in(Easing.cubic) }, (finished) => {
        if (finished) scheduleOnRN(setMounted, false);
      });
    }
  }, [visible, mounted, height, reduceMotion, translate, scrim, theme.springs.snappy, theme.durations.normal, theme.durations.fast]);

  const drag = usePanGesture({
    onUpdate: (e) => {
      translate.set(Math.max(0, e.translationY));
    },
    onDeactivate: (e) => {
      if (e.translationY > 120 || e.velocityY > 900) scheduleOnRN(onClose);
      else translate.set(withSpring(0, theme.springs.snappy));
    },
  });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translate.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrim.value }));

  if (!mounted) return null;
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <View style={styles.sheetRoot}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.scrim }, scrimStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.surfaceRaised,
              borderTopLeftRadius: theme.radii.xxl,
              borderTopRightRadius: theme.radii.xxl,
              paddingBottom: insets.bottom + theme.spacing.sm,
            },
            theme.elevation('high'),
            sheetStyle,
          ]}
        >
          <GestureDetector gesture={drag}>
            <View style={{ paddingTop: theme.spacing.sm }}>
              <View style={[styles.grabber, { backgroundColor: theme.colors.borderStrong }]} />
              {title ? (
                <View style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.md }}>
                  <AppText variant="title" numberOfLines={2} accessibilityRole="header">
                    {title}
                  </AppText>
                  {subtitle ? (
                    <AppText variant="meta" tone="secondary" numberOfLines={2}>
                      {subtitle}
                    </AppText>
                  ) : null}
                </View>
              ) : null}
            </View>
          </GestureDetector>
          <ScrollView bounces={false}>{children}</ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

export function SheetAction({
  icon,
  label,
  onPress,
  destructive = false,
  disabledReason,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  /** When set, the action is disabled and the reason is shown instead of failing silently. */
  disabledReason?: string | null;
}) {
  const theme = useTheme();
  const disabled = Boolean(disabledReason);
  const color = disabled ? theme.colors.textTertiary : destructive ? theme.colors.danger : theme.colors.textPrimary;
  return (
    <PressableScale
      scaleTo={0.98}
      haptic
      accessibilityRole="button"
      accessibilityLabel={disabled ? `${label}, unavailable: ${disabledReason}` : label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.sheetAction,
        { minHeight: 56, paddingHorizontal: theme.spacing.xl, gap: theme.spacing.lg, backgroundColor: pressed ? theme.colors.surfaceSunken : 'transparent' },
      ]}
    >
      <View style={[styles.actionIcon, { backgroundColor: destructive ? theme.colors.dangerSubtle : theme.colors.surfaceSunken, borderRadius: theme.radii.md }]}>
        <Icon name={icon} size={theme.iconSizes.md} color={destructive ? theme.colors.danger : disabled ? theme.colors.textTertiary : theme.colors.primary} />
      </View>
      <View style={styles.flex}>
        <AppText variant="bodyStrong" style={{ color }}>
          {label}
        </AppText>
        {disabledReason ? (
          <AppText variant="helper" tone="tertiary">
            {disabledReason}
          </AppText>
        ) : null}
      </View>
    </PressableScale>
  );
}

/** Centered dialog that scales and fades in. */
function DialogFrame({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = visible ? (reduceMotion ? 1 : withSpring(1, theme.springs.snappy)) : 0;
  }, [visible, reduceMotion, progress, theme.springs.snappy]);
  const card = useAnimatedStyle(() => ({ opacity: Math.min(1, progress.value * 1.4), transform: [{ scale: 0.92 + progress.value * 0.08 }] }));
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.dialogRoot, { backgroundColor: theme.colors.scrim }]}>
        <Animated.View
          accessibilityViewIsModal
          style={[styles.dialog, { backgroundColor: theme.colors.surfaceRaised, borderRadius: theme.radii.xxl, padding: theme.spacing.xl, gap: theme.spacing.md }, theme.elevation('high'), card]}
        >
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
  secondary,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  secondary?: { label: string; onPress: () => void };
}) {
  const theme = useTheme();
  useEffect(() => {
    if (visible && destructive) haptics.warning();
  }, [visible, destructive]);
  return (
    <DialogFrame visible={visible} onClose={onCancel}>
      <AppText variant="title" accessibilityRole="header">
        {title}
      </AppText>
      <AppText variant="body" tone="secondary">
        {message}
      </AppText>
      <View style={[styles.dialogButtons, { gap: theme.spacing.sm }]}>
        <Button label={confirmLabel} variant={destructive ? 'danger' : 'primary'} onPress={onConfirm} />
        {secondary ? <Button label={secondary.label} variant="secondary" onPress={secondary.onPress} /> : null}
        <Button label="Cancel" variant="ghost" onPress={onCancel} />
      </View>
    </DialogFrame>
  );
}

export function ChoiceDialog<T extends string>({
  visible,
  title,
  message,
  choices,
  onChoose,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  choices: { value: T; label: string; description: string; destructive?: boolean }[];
  onChoose: (value: T) => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  return (
    <DialogFrame visible={visible} onClose={onCancel}>
      <AppText variant="title" accessibilityRole="header">
        {title}
      </AppText>
      <AppText variant="body" tone="secondary">
        {message}
      </AppText>
      <View style={{ gap: theme.spacing.sm }}>
        {choices.map((choice) => (
          <PressableScale
            key={choice.value}
            haptic
            scaleTo={0.98}
            accessibilityRole="button"
            accessibilityLabel={`${choice.label}. ${choice.description}`}
            onPress={() => onChoose(choice.value)}
            style={({ pressed }) => ({
              borderWidth: 1,
              borderColor: pressed ? theme.colors.primary : theme.colors.border,
              borderRadius: theme.radii.lg,
              padding: theme.spacing.md,
              minHeight: theme.touchTarget,
              backgroundColor: pressed ? theme.colors.primarySubtle : theme.colors.surface,
            })}
          >
            <AppText variant="bodyStrong" tone={choice.destructive ? 'danger' : 'primary'}>
              {choice.label}
            </AppText>
            <AppText variant="helper" tone="secondary">
              {choice.description}
            </AppText>
          </PressableScale>
        ))}
      </View>
      <Button label="Cancel" variant="ghost" onPress={onCancel} />
    </DialogFrame>
  );
}

export function PromptDialog({
  visible,
  title,
  initialValue,
  confirmLabel,
  validate,
  onSubmit,
  onCancel,
  selectStem = false,
}: {
  visible: boolean;
  title: string;
  initialValue: string;
  confirmLabel: string;
  validate: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** Pre-select the name without its extension, as desktop file managers do. */
  selectStem?: boolean;
}) {
  const theme = useTheme();
  // Callers mount the dialog only while it is shown, so state starts fresh each time.
  const [value, setValue] = useState(initialValue);
  const [touched, setTouched] = useState(false);
  const error = validate(value);
  const dot = initialValue.lastIndexOf('.');
  const stemEnd = selectStem && dot > 0 ? dot : initialValue.length;
  const submit = () => {
    setTouched(true);
    if (!error) {
      haptics.tap();
      onSubmit(value);
    } else {
      haptics.error();
    }
  };
  return (
    <DialogFrame visible={visible} onClose={onCancel}>
      <AppText variant="title" accessibilityRole="header">
        {title}
      </AppText>
      <TextInput
        autoFocus
        value={value}
        onChangeText={(text) => {
          setValue(text);
          setTouched(true);
        }}
        selection={touched ? undefined : { start: 0, end: stemEnd }}
        onSubmitEditing={submit}
        returnKeyType="done"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={title}
        placeholderTextColor={theme.colors.textTertiary}
        selectionColor={theme.colors.primary}
        style={[
          theme.typography.body,
          {
            color: theme.colors.textPrimary,
            backgroundColor: theme.colors.surfaceSunken,
            borderWidth: theme.borderWidths.focus,
            borderColor: touched && error ? theme.colors.danger : theme.colors.primary,
            borderRadius: theme.radii.lg,
            paddingHorizontal: theme.spacing.md,
            minHeight: 52,
          },
        ]}
      />
      {touched && error ? (
        <AppText variant="helper" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
      <View style={[styles.dialogButtons, { gap: theme.spacing.sm }]}>
        <Button label={confirmLabel} onPress={submit} disabled={Boolean(error) && touched} />
        <Button label="Cancel" variant="ghost" onPress={onCancel} />
      </View>
    </DialogFrame>
  );
}

/** Determinate bars ease to their value; indeterminate bars sweep (static when motion is reduced). */
export function ProgressBar({ progress, height = 6 }: { progress: number | null; height?: number }) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const sweep = useSharedValue(0);
  const fill = useSharedValue(0);
  const width = useSharedValue(0);
  const indeterminate = progress === null;
  useEffect(() => {
    if (indeterminate && !reduceMotion) sweep.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }), -1, false);
    else sweep.value = 0;
  }, [indeterminate, reduceMotion, sweep]);
  useEffect(() => {
    if (!indeterminate) fill.value = withTiming(Math.min(1, Math.max(0, progress ?? 0)), { duration: reduceMotion ? 0 : 280, easing: Easing.out(Easing.cubic) });
  }, [progress, indeterminate, reduceMotion, fill]);
  const sliding = useAnimatedStyle(() => ({ transform: [{ translateX: (sweep.value * 1.4 - 0.4) * width.value }] }));
  const filled = useAnimatedStyle(() => ({ width: fill.value * width.value }));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={indeterminate ? undefined : { min: 0, max: 100, now: Math.round((progress ?? 0) * 100) }}
      onLayout={(event) => {
        width.value = event.nativeEvent.layout.width;
      }}
      style={{ height, borderRadius: height, backgroundColor: theme.colors.surfaceSunken, overflow: 'hidden' }}
    >
      <Animated.View style={[{ position: 'absolute', top: 0, bottom: 0, left: 0, borderRadius: height, backgroundColor: theme.colors.primary }, indeterminate ? [{ width: '40%' }, sliding] : filled]} />
    </View>
  );
}

export function SearchField({
  value,
  onChangeText,
  placeholder,
  autoFocus,
  onSubmit,
  onFocus,
  editable = true,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  onFocus?: () => void;
  editable?: boolean;
}) {
  const theme = useTheme();
  const focus = useSharedValue(0);
  const ring = useAnimatedStyle(() => ({
    borderColor: interpolateColor(focus.value, [0, 1], [theme.colors.border, theme.colors.primary]),
    backgroundColor: interpolateColor(focus.value, [0, 1], [theme.colors.surface, theme.colors.surfaceRaised]),
  }));
  return (
    <Animated.View style={[styles.search, { borderRadius: theme.radii.lg, paddingHorizontal: theme.spacing.md, minHeight: 52, gap: theme.spacing.sm, borderWidth: 1.5 }, theme.elevation('low'), ring]}>
      <Icon name="magnify" size={theme.iconSizes.md} color={theme.colors.primary} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textTertiary}
        selectionColor={theme.colors.primary}
        autoFocus={autoFocus}
        onFocus={() => {
          focus.set(withTiming(1, { duration: theme.durations.fast }));
          onFocus?.();
        }}
        onBlur={() => {
          focus.set(withTiming(0, { duration: theme.durations.fast }));
        }}
        editable={editable}
        returnKeyType="search"
        onSubmitEditing={onSubmit}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={placeholder}
        style={[theme.typography.body, styles.flex, { color: theme.colors.textPrimary, paddingVertical: theme.spacing.sm }]}
      />
      {value ? (
        <PressableScale accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={12} onPress={() => onChangeText('')} scaleTo={0.8}>
          <Icon name="close-circle" size={theme.iconSizes.md} color={theme.colors.textTertiary} />
        </PressableScale>
      ) : null}
    </Animated.View>
  );
}

type Toast = { id: number; message: string; tone: 'neutral' | 'success' | 'error'; action?: { label: string; onPress: () => void } };

const useToasts = create<{ toast: Toast | null; show: (toast: Omit<Toast, 'id'>) => void; hide: () => void }>()((set) => ({
  toast: null,
  show: (toast) => set({ toast: { ...toast, id: Date.now() } }),
  hide: () => set({ toast: null }),
}));

/** Shows a transient status message, announces it to screen readers and gives a matching haptic. */
export function showToast(message: string, tone: Toast['tone'] = 'neutral', action?: Toast['action']): void {
  useToasts.getState().show({ message, tone, action });
  if (tone === 'success') haptics.success();
  else if (tone === 'error') haptics.error();
  AccessibilityInfo.announceForAccessibility(message);
}

function ToastCard({ toast, onHide }: { toast: Toast; onHide: () => void }) {
  const theme = useTheme();
  const dx = useSharedValue(0);
  const swipe = usePanGesture({
    onUpdate: (e) => {
      dx.set(e.translationX);
    },
    onDeactivate: (e) => {
      if (Math.abs(e.translationX) > 100 || Math.abs(e.velocityX) > 900) scheduleOnRN(onHide);
      else dx.set(withSpring(0, theme.springs.snappy));
    },
  });
  const swiping = useAnimatedStyle(() => ({ transform: [{ translateX: dx.value }], opacity: 1 - Math.min(0.6, Math.abs(dx.value) / 300) }));
  const icon: IconName = toast.tone === 'success' ? 'check-circle' : toast.tone === 'error' ? 'alert-circle' : 'information';
  const iconColor = toast.tone === 'success' ? '#4ADE80' : toast.tone === 'error' ? '#FF8A80' : '#A5B4FC';
  return (
    <GestureDetector gesture={swipe}>
      <Animated.View
        entering={SlideInDown.springify().damping(18).stiffness(220)}
        exiting={FadeOutDown.duration(180)}
        accessibilityLiveRegion="polite"
        style={[styles.toast, { backgroundColor: theme.scheme === 'dark' ? '#20254A' : '#14172E', borderRadius: theme.radii.xl, padding: theme.spacing.md, gap: theme.spacing.md }, theme.elevation('high'), swiping]}
      >
        <Icon name={icon} size={theme.iconSizes.md} color={iconColor} />
        <AppText variant="body" style={[styles.flex, { color: '#FFFFFF' }]} numberOfLines={3}>
          {toast.message}
        </AppText>
        {toast.action ? (
          <PressableScale
            accessibilityRole="button"
            haptic
            onPress={() => {
              toast.action?.onPress();
              onHide();
            }}
            hitSlop={12}
            style={{ paddingHorizontal: theme.spacing.sm, paddingVertical: theme.spacing.xs, borderRadius: theme.radii.pill, backgroundColor: 'rgba(255,255,255,0.12)' }}
          >
            <AppText variant="button" style={{ color: '#C7D2FE' }}>
              {toast.action.label}
            </AppText>
          </PressableScale>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}

export function ToastHost({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const theme = useTheme();
  const toast = useToasts((state) => state.toast);
  const hide = useToasts((state) => state.hide);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(hide, toast.action ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [toast, hide]);
  return (
    <View pointerEvents="box-none" style={[styles.toastHost, { bottom: bottomOffset + theme.spacing.lg, paddingHorizontal: theme.spacing.lg }]}>
      {toast ? <ToastCard key={toast.id} toast={toast} onHide={hide} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '88%' },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, marginBottom: 14 },
  sheetAction: { flexDirection: 'row', alignItems: 'center' },
  actionIcon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  dialogRoot: { flex: 1, justifyContent: 'center', padding: 24 },
  dialog: { width: '100%', maxWidth: 440, alignSelf: 'center' },
  dialogButtons: { marginTop: 8 },
  search: { flexDirection: 'row', alignItems: 'center' },
  toastHost: { position: 'absolute', left: 0, right: 0 },
  toast: { flexDirection: 'row', alignItems: 'center' },
});
