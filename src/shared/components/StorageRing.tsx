import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedProps, useAnimatedReaction, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient as SvgGradient, Stop } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';

import { formatPercent } from '@/core/format/format';
import { useTheme } from '@/core/theme/ThemeProvider';

import { AppText } from './primitives';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Gradient progress ring that sweeps to its value with a counting percentage in the middle. */
export function StorageRing({ fraction, size = 132, stroke = 14, label, onGradient = false }: { fraction: number; size?: number; stroke?: number; label?: string; onGradient?: boolean }) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = useSharedValue(0);
  const [shown, setShown] = useState(0);
  const target = Math.min(1, Math.max(0, fraction));

  useEffect(() => {
    progress.value = reduceMotion ? target : withTiming(target, { duration: 1100, easing: Easing.out(Easing.cubic) });
  }, [target, reduceMotion, progress]);

  useAnimatedReaction(
    () => Math.round(progress.value * 100),
    (value, previous) => {
      if (value !== previous) scheduleOnRN(setShown, value / 100);
    },
  );

  const animatedProps = useAnimatedProps(() => ({ strokeDashoffset: circumference * (1 - progress.value) }));
  const track = onGradient ? 'rgba(255,255,255,0.22)' : theme.colors.surfaceSunken;
  const warn = target > 0.9;
  return (
    <View style={{ width: size, height: size }} accessible accessibilityRole="progressbar" accessibilityLabel={`${label ?? 'Storage'} ${formatPercent(target)} used`}>
      <Svg width={size} height={size}>
        <Defs>
          <SvgGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={onGradient ? '#FFFFFF' : theme.colors.gradient[0]} />
            <Stop offset="1" stopColor={warn ? theme.colors.warm : onGradient ? '#C7F9F1' : theme.colors.gradient[2]} />
          </SvgGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={radius} stroke={track} strokeWidth={stroke} fill="none" />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="url(#ring)"
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          animatedProps={animatedProps}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <AppText variant="numeric" tone={onGradient ? 'onGradient' : 'primary'}>
          {formatPercent(shown)}
        </AppText>
        {label ? (
          <AppText variant="caption" tone={onGradient ? 'onGradient' : 'secondary'} style={onGradient ? { opacity: 0.85 } : undefined}>
            {label}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
