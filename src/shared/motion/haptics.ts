import * as Haptics from 'expo-haptics';

import { usePreferences } from '@/core/preferences/preferences';

/** Subtle haptic feedback. Fire-and-forget; respects the user's Haptics setting. */
const enabled = () => usePreferences.getState().haptics;

export const haptics = {
  tap: () => {
    if (enabled()) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  },
  select: () => {
    if (enabled()) void Haptics.selectionAsync().catch(() => undefined);
  },
  success: () => {
    if (enabled()) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  },
  warning: () => {
    if (enabled()) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
  },
  error: () => {
    if (enabled()) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
  },
  heavy: () => {
    if (enabled()) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
  },
};
