import { Platform, type TextStyle, type ViewStyle } from 'react-native';

/**
 * Fileora design tokens v2.
 *
 * Neutrals are cool-tinted ("ink" on "mist" in light, "nebula" navy in dark) so the accent colours
 * glow without fighting the content. Five accent themes share the same neutrals. Every text/surface
 * pair keeps WCAG AA (4.5:1) contrast; dark mode puts dark text on its brighter accents.
 */

export type ColorScheme = 'light' | 'dark';
export type AccentTheme = 'iris' | 'ocean' | 'emerald' | 'sunset' | 'graphite';
export const ACCENT_THEMES: AccentTheme[] = ['iris', 'ocean', 'emerald', 'sunset', 'graphite'];

export type ThemeColors = {
  background: string;
  backgroundAlt: string;
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  surfaceGlass: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textOnPrimary: string;
  textOnGradient: string;
  primary: string;
  primaryPressed: string;
  primarySubtle: string;
  primaryGlow: string;
  gradient: [string, string, string];
  heroGradient: [string, string];
  accent: string;
  accentSubtle: string;
  warm: string;
  success: string;
  successSubtle: string;
  warning: string;
  warningSubtle: string;
  danger: string;
  dangerSubtle: string;
  scrim: string;
  selection: string;
  shadow: string;
  skeleton: string;
  skeletonHighlight: string;
  fileFolder: string;
  fileImage: string;
  fileVideo: string;
  fileAudio: string;
  fileDocument: string;
  fileArchive: string;
  fileCode: string;
  fileOther: string;
};

export type FileColorKey = 'fileFolder' | 'fileImage' | 'fileVideo' | 'fileAudio' | 'fileDocument' | 'fileArchive' | 'fileCode' | 'fileOther';

type AccentKeys = 'primary' | 'primaryPressed' | 'primarySubtle' | 'primaryGlow' | 'gradient' | 'heroGradient' | 'textOnPrimary' | 'selection' | 'fileFolder';
type Neutrals = Omit<ThemeColors, AccentKeys>;
type AccentSet = Pick<ThemeColors, AccentKeys>;

const lightNeutrals: Neutrals = {
  background: '#F5F6FB',
  backgroundAlt: '#ECEEF8',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#ECEEF5',
  surfaceGlass: 'rgba(255,255,255,0.86)',
  border: '#E3E6F0',
  borderStrong: '#C8CDDB',
  textPrimary: '#0E1121',
  textSecondary: '#474D66',
  textTertiary: '#666C86',
  textOnGradient: '#FFFFFF',
  accent: '#00897C',
  accentSubtle: '#D9F4F0',
  warm: '#E2553A',
  success: '#167A45',
  successSubtle: '#DDF3E6',
  warning: '#8F5A00',
  warningSubtle: '#FCEFD3',
  danger: '#C2261C',
  dangerSubtle: '#FDE5E2',
  scrim: 'rgba(10, 12, 26, 0.48)',
  shadow: '#1B1F3B',
  skeleton: '#E7E9F2',
  skeletonHighlight: '#F6F7FC',
  fileImage: '#00897C',
  fileVideo: '#8B3FD9',
  fileAudio: '#D9480F',
  fileDocument: '#2563EB',
  fileArchive: '#A16207',
  fileCode: '#475569',
  fileOther: '#666C86',
};

const darkNeutrals: Neutrals = {
  background: '#090B16',
  backgroundAlt: '#0E1122',
  surface: '#12152A',
  surfaceRaised: '#191D36',
  surfaceSunken: '#070811',
  surfaceGlass: 'rgba(22,26,48,0.88)',
  border: '#22274A',
  borderStrong: '#343B66',
  textPrimary: '#EEF0FB',
  textSecondary: '#ABB1CC',
  textTertiary: '#8189A8',
  textOnGradient: '#FFFFFF',
  accent: '#3EE6D2',
  accentSubtle: '#0F3533',
  warm: '#FF8A6B',
  success: '#4ADE80',
  successSubtle: '#0F2E1E',
  warning: '#FBBF24',
  warningSubtle: '#33270B',
  danger: '#FF7A70',
  dangerSubtle: '#3A1513',
  scrim: 'rgba(0, 0, 0, 0.62)',
  shadow: '#000000',
  skeleton: '#1A1E37',
  skeletonHighlight: '#252A4A',
  fileImage: '#3EE6D2',
  fileVideo: '#C49BFF',
  fileAudio: '#FF9A6B',
  fileDocument: '#7DB3FF',
  fileArchive: '#FBBF24',
  fileCode: '#AAB4CC',
  fileOther: '#8189A8',
};

const ACCENTS: Record<AccentTheme, Record<ColorScheme, AccentSet>> = {
  iris: {
    light: { primary: '#5243E8', primaryPressed: '#4234CF', primarySubtle: '#ECEAFF', primaryGlow: 'rgba(82,67,232,0.28)', gradient: ['#6A5AFF', '#5243E8', '#2F8CFF'], heroGradient: ['#5243E8', '#2F8CFF'], textOnPrimary: '#FFFFFF', selection: '#E4E1FF', fileFolder: '#5243E8' },
    dark: { primary: '#A497FF', primaryPressed: '#B9AFFF', primarySubtle: '#241F55', primaryGlow: 'rgba(164,151,255,0.30)', gradient: ['#7C6CFF', '#5B4BF0', '#2AA9FF'], heroGradient: ['#3B2FB8', '#1A6FD6'], textOnPrimary: '#0B0D1C', selection: '#2A2564', fileFolder: '#A497FF' },
  },
  ocean: {
    light: { primary: '#0B63D8', primaryPressed: '#0952B4', primarySubtle: '#E2EEFF', primaryGlow: 'rgba(11,99,216,0.26)', gradient: ['#1E7BFF', '#0B63D8', '#00B3C7'], heroGradient: ['#0B63D8', '#00A3B8'], textOnPrimary: '#FFFFFF', selection: '#D9E8FF', fileFolder: '#0B63D8' },
    dark: { primary: '#6EB0FF', primaryPressed: '#8CC1FF', primarySubtle: '#10294D', primaryGlow: 'rgba(110,176,255,0.30)', gradient: ['#2E86FF', '#1460D6', '#00C2D6'], heroGradient: ['#0E3F8F', '#007E8F'], textOnPrimary: '#06101F', selection: '#14305A', fileFolder: '#6EB0FF' },
  },
  emerald: {
    light: { primary: '#077A55', primaryPressed: '#056444', primarySubtle: '#DDF5EB', primaryGlow: 'rgba(7,122,85,0.26)', gradient: ['#10B981', '#077A55', '#0EA5E9'], heroGradient: ['#077A55', '#0B8FB0'], textOnPrimary: '#FFFFFF', selection: '#D3F1E4', fileFolder: '#077A55' },
    dark: { primary: '#4FE0A6', primaryPressed: '#73E9BA', primarySubtle: '#0E3326', primaryGlow: 'rgba(79,224,166,0.28)', gradient: ['#22C58E', '#0E8F66', '#0EA5E9'], heroGradient: ['#075E44', '#0A6D86'], textOnPrimary: '#05150F', selection: '#123D2E', fileFolder: '#4FE0A6' },
  },
  sunset: {
    light: { primary: '#C2410C', primaryPressed: '#A3360A', primarySubtle: '#FFE9DC', primaryGlow: 'rgba(194,65,12,0.26)', gradient: ['#FF7A3D', '#E3461B', '#DB2777'], heroGradient: ['#C2410C', '#BE185D'], textOnPrimary: '#FFFFFF', selection: '#FFE0CF', fileFolder: '#C2410C' },
    dark: { primary: '#FF9466', primaryPressed: '#FFAD8A', primarySubtle: '#3D1C0E', primaryGlow: 'rgba(255,148,102,0.30)', gradient: ['#FF7A3D', '#E3461B', '#E0368A'], heroGradient: ['#8F2D08', '#8A1347'], textOnPrimary: '#1F0B03', selection: '#47220F', fileFolder: '#FF9466' },
  },
  graphite: {
    light: { primary: '#2E3548', primaryPressed: '#20263A', primarySubtle: '#E7EAF2', primaryGlow: 'rgba(46,53,72,0.24)', gradient: ['#4A5571', '#2E3548', '#64748B'], heroGradient: ['#2E3548', '#55627F'], textOnPrimary: '#FFFFFF', selection: '#DEE2EC', fileFolder: '#2E3548' },
    dark: { primary: '#C9D1E6', primaryPressed: '#DCE2F1', primarySubtle: '#232A40', primaryGlow: 'rgba(201,209,230,0.22)', gradient: ['#5A6788', '#3A4459', '#8392B4'], heroGradient: ['#2A3247', '#46526E'], textOnPrimary: '#0B0E17', selection: '#2A3249', fileFolder: '#C9D1E6' },
  },
};

export const ACCENT_LABELS: Record<AccentTheme, string> = { iris: 'Iris', ocean: 'Ocean', emerald: 'Emerald', sunset: 'Sunset', graphite: 'Graphite' };

export function accentSwatch(accent: AccentTheme): [string, string] {
  const g = ACCENTS[accent].light.gradient;
  return [g[0], g[2]];
}

export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const radii = { sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, pill: 999 } as const;

export const iconSizes = { sm: 16, md: 20, lg: 24, xl: 32, hero: 56 } as const;

/** Minimum interactive size (Android 48dp, iOS 44pt); we use the larger everywhere. */
export const touchTarget = 48;

export const durations = { instant: 90, fast: 160, normal: 240, slow: 380, shimmer: 1200 } as const;

/** Spring presets (Reanimated `withSpring` configs). Snappy for presses, gentle for layout. */
export const springs = {
  press: { damping: 16, stiffness: 420, mass: 0.5 },
  snappy: { damping: 20, stiffness: 300, mass: 0.7 },
  gentle: { damping: 22, stiffness: 170, mass: 0.9 },
  bouncy: { damping: 11, stiffness: 220, mass: 0.7 },
} as const;

export const borderWidths = { hairline: 1, focus: 2 } as const;

const fontFamily = Platform.select({ ios: 'System', default: undefined });

type TypeToken = Pick<TextStyle, 'fontSize' | 'lineHeight' | 'fontWeight' | 'letterSpacing' | 'fontFamily' | 'fontVariant'>;

export const typography = {
  hero: { fontFamily, fontSize: 34, lineHeight: 40, fontWeight: '800', letterSpacing: -0.8 },
  display: { fontFamily, fontSize: 30, lineHeight: 36, fontWeight: '800', letterSpacing: -0.6 },
  title: { fontFamily, fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.3 },
  heading: { fontFamily, fontSize: 17, lineHeight: 22, fontWeight: '700', letterSpacing: -0.1 },
  sectionLabel: { fontFamily, fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 0.8 },
  body: { fontFamily, fontSize: 15, lineHeight: 21, fontWeight: '400' },
  bodyStrong: { fontFamily, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  fileName: { fontFamily, fontSize: 15, lineHeight: 20, fontWeight: '600', letterSpacing: -0.1 },
  meta: { fontFamily, fontSize: 13, lineHeight: 18, fontWeight: '400' },
  helper: { fontFamily, fontSize: 13, lineHeight: 18, fontWeight: '400' },
  button: { fontFamily, fontSize: 15, lineHeight: 20, fontWeight: '700', letterSpacing: 0.1 },
  numeric: { fontFamily, fontSize: 26, lineHeight: 32, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -0.5 },
  caption: { fontFamily, fontSize: 12, lineHeight: 16, fontWeight: '600' },
} as const satisfies Record<string, TypeToken>;

export type TypographyVariant = keyof typeof typography;

export type Elevation = 'none' | 'low' | 'medium' | 'high';

export type Theme = {
  scheme: ColorScheme;
  accent: AccentTheme;
  colors: ThemeColors;
  spacing: typeof spacing;
  radii: typeof radii;
  iconSizes: typeof iconSizes;
  typography: typeof typography;
  durations: typeof durations;
  springs: typeof springs;
  borderWidths: typeof borderWidths;
  touchTarget: number;
  elevation: (level: Elevation) => ViewStyle;
};

export function buildTheme(scheme: ColorScheme, accent: AccentTheme = 'iris'): Theme {
  const colors: ThemeColors = { ...(scheme === 'dark' ? darkNeutrals : lightNeutrals), ...ACCENTS[accent][scheme] };
  const elevation = (level: Elevation): ViewStyle => {
    if (level === 'none') return {};
    const [y, radius, opacity, android] = ({ low: [2, 6, 0.06, 2], medium: [6, 16, 0.1, 6], high: [12, 28, 0.16, 12] } as const)[level];
    return {
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: y },
      shadowRadius: radius,
      shadowOpacity: scheme === 'dark' ? Math.min(0.5, opacity * 2.2) : opacity,
      elevation: android,
    };
  };
  return { scheme, accent, colors, spacing, radii, iconSizes, typography, durations, springs, borderWidths, touchTarget, elevation };
}
