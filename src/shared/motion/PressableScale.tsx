import { useState, type ReactNode } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';

import { springs } from '@/core/theme/tokens';

import { haptics } from './haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Pressable with a spring "squish" on the UI thread and optional haptic tick. The scale never blocks
 * the JS thread, so taps feel instant even while lists are rendering.
 */
export function PressableScale({
  children,
  style,
  scaleTo = 0.96,
  haptic = false,
  onPressIn,
  onPressOut,
  onPress,
  disabled,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
  scaleTo?: number;
  haptic?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  // Reanimated drops function-form styles on animated components, so resolve them with React state.
  const [pressed, setPressed] = useState(false);
  const trackPressed = typeof style === 'function';
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={(event) => {
        if (!reduceMotion) scale.set(withSpring(scaleTo, springs.press));
        if (trackPressed) setPressed(true);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        scale.set(withSpring(1, springs.snappy));
        if (trackPressed) setPressed(false);
        onPressOut?.(event);
      }}
      onPress={(event) => {
        if (haptic) haptics.tap();
        onPress?.(event);
      }}
      style={[typeof style === 'function' ? style({ pressed }) : style, animated]}
    >
      {children}
    </AnimatedPressable>
  );
}
