import createQr from 'qrcode-generator';
import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

const QUIET_ZONE = 4;

/**
 * Renders `value` as a QR code. Always dark-on-white regardless of theme — scanners need the contrast —
 * and drawn as one SVG path so even dense codes stay cheap to render.
 */
export function QrCode({ value, size = 220, accessibilityLabel }: { value: string; size?: number; accessibilityLabel: string }) {
  const { path, count } = useMemo(() => {
    const qr = createQr(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    const modules = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < modules; row++) {
      for (let col = 0; col < modules; col++) {
        if (qr.isDark(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return { path: d, count: modules + QUIET_ZONE * 2 };
  }, [value]);

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel} style={{ width: size, height: size, borderRadius: 16, overflow: 'hidden' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${count} ${count}`}>
        <Rect width={count} height={count} fill="#FFFFFF" />
        <Path d={path} fill="#0B0F19" />
      </Svg>
    </View>
  );
}
