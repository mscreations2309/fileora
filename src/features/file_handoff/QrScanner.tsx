import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { Linking, Modal, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, FadeIn, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/core/theme/ThemeProvider';
import { AppText, Button, GradientTile, IconButton } from '@/shared/components/primitives';
import { haptics } from '@/shared/motion/haptics';

import { parsePairingText, type HandoffTarget } from './pairing';

const SCRIM = 'rgba(5, 8, 18, 0.72)';

function Corner({ position, color }: { position: 'tl' | 'tr' | 'bl' | 'br'; color: string }) {
  const top = position[0] === 't';
  const left = position[1] === 'l';
  return (
    <View
      style={[
        styles.corner,
        { borderColor: color },
        top ? { top: -3, borderTopWidth: 5 } : { bottom: -3, borderBottomWidth: 5 },
        left ? { left: -3, borderLeftWidth: 5, borderTopLeftRadius: top ? 22 : 0, borderBottomLeftRadius: top ? 0 : 22 } : { right: -3, borderRightWidth: 5, borderTopRightRadius: top ? 22 : 0, borderBottomRightRadius: top ? 0 : 22 },
      ]}
    />
  );
}

function Viewfinder({ size, invalid }: { size: number; invalid: boolean }) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const sweep = useSharedValue(0);
  const breathe = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) return;
    sweep.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.quad) }), -1, true);
    breathe.value = withRepeat(withSequence(withTiming(1.03, { duration: 900 }), withTiming(1, { duration: 900 })), -1);
  }, [reduceMotion, sweep, breathe]);

  const line = useAnimatedStyle(() => ({ transform: [{ translateY: sweep.value * (size - 24) }] }));
  const frame = useAnimatedStyle(() => ({ transform: [{ scale: breathe.value }] }));
  const color = invalid ? theme.colors.danger : '#FFFFFF';

  return (
    <Animated.View entering={ZoomIn.springify().damping(14)} style={[{ width: size, height: size }, frame]}>
      {(['tl', 'tr', 'bl', 'br'] as const).map((p) => (
        <Corner key={p} position={p} color={color} />
      ))}
      {reduceMotion ? null : <Animated.View style={[styles.line, { backgroundColor: theme.colors.primary, shadowColor: theme.colors.primary }, line]} />}
    </Animated.View>
  );
}

/** Full-screen QR scanner for Smart Handoff pairing codes. Calls `onScanned` once, then closes. */
export function QrScanner({ visible, onClose, onScanned }: { visible: boolean; onClose: () => void; onScanned: (target: HandoffTarget) => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [permission, requestPermission] = useCameraPermissions();
  const [invalid, setInvalid] = useState(false);
  const handled = useRef(false);
  const lastInvalid = useRef('');
  const size = Math.min(width * 0.72, 300);
  const top = (height - size) / 2 - 40;

  useEffect(() => {
    if (!visible) return;
    handled.current = false;
    lastInvalid.current = '';
  }, [visible]);

  const onBarcode = ({ data }: BarcodeScanningResult) => {
    if (handled.current) return;
    const target = parsePairingText(data);
    if (target) {
      handled.current = true;
      haptics.success();
      onScanned(target);
      onClose();
    } else if (data !== lastInvalid.current) {
      lastInvalid.current = data;
      haptics.warning();
      setInvalid(true);
      setTimeout(() => setInvalid(false), 1600);
    }
  };

  const granted = permission?.granted === true;

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View style={[styles.fill, { backgroundColor: '#05070D' }]}>
        {granted ? (
          <>
            <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onBarcode} />
            {/* Dim everything except the viewfinder window. */}
            <View pointerEvents="none" style={[styles.scrim, { top: 0, height: top }]} />
            <View pointerEvents="none" style={[styles.scrim, { top: top + size, bottom: 0 }]} />
            <View pointerEvents="none" style={[styles.scrim, { top, height: size, left: 0, width: (width - size) / 2 }]} />
            <View pointerEvents="none" style={[styles.scrim, { top, height: size, right: 0, width: (width - size) / 2 }]} />
            <View pointerEvents="none" style={{ position: 'absolute', top, left: (width - size) / 2 }}>
              <Viewfinder size={size} invalid={invalid} />
            </View>
            <Animated.View entering={FadeIn.delay(200)} pointerEvents="none" style={{ position: 'absolute', top: top + size + theme.spacing.xl, left: theme.spacing.xl, right: theme.spacing.xl, alignItems: 'center', gap: theme.spacing.xs }}>
              <AppText variant="heading" tone="onGradient" style={{ textAlign: 'center' }}>
                {invalid ? 'That’s not a Fileora code' : 'Scan the receiver’s code'}
              </AppText>
              <AppText variant="body" tone="onGradient" style={{ textAlign: 'center', opacity: 0.8 }}>
                {invalid ? 'Open Smart Handoff › Receive on the other device.' : 'On the other device, open Smart Handoff › Receive.'}
              </AppText>
            </Animated.View>
          </>
        ) : (
          <View style={[styles.fill, { alignItems: 'center', justifyContent: 'center', padding: theme.spacing.xl, gap: theme.spacing.lg }]}>
            <GradientTile icon="qrcode-scan" size={88} />
            <AppText variant="title" tone="onGradient" style={{ textAlign: 'center' }}>
              Allow the camera to scan
            </AppText>
            <AppText variant="body" tone="onGradient" style={{ textAlign: 'center', opacity: 0.8 }}>
              Fileora uses the camera only while this screen is open, only to read the pairing code. Nothing is recorded or uploaded.
            </AppText>
            {permission && !permission.canAskAgain ? (
              <Button label="Open settings" icon="cog-outline" onPress={() => void Linking.openSettings()} />
            ) : (
              <Button label="Allow camera" icon="camera-outline" onPress={() => void requestPermission()} />
            )}
          </View>
        )}
        <View style={{ position: 'absolute', top: insets.top + theme.spacing.sm, left: theme.spacing.md }}>
          <IconButton icon="close" label="Close scanner" color="#FFFFFF" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { position: 'absolute', left: 0, right: 0, backgroundColor: SCRIM },
  corner: { position: 'absolute', width: 44, height: 44 },
  line: { position: 'absolute', left: 14, right: 14, top: 12, height: 3, borderRadius: 2, shadowOpacity: 0.9, shadowRadius: 8, elevation: 6 },
});
