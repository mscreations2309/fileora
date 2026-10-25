import { View } from 'react-native';

import type { FileCategory, LocationIcon } from '@/core/storage/types';
import { useTheme } from '@/core/theme/ThemeProvider';
import type { FileColorKey } from '@/core/theme/tokens';

import { Icon, type IconName } from './primitives';

const CATEGORY_ICON: Record<FileCategory, IconName> = {
  folder: 'folder',
  image: 'file-image-outline',
  video: 'file-video-outline',
  audio: 'file-music-outline',
  document: 'file-document-outline',
  archive: 'zip-box-outline',
  code: 'file-code-outline',
  other: 'file-outline',
};

const CATEGORY_COLOR: Record<FileCategory, FileColorKey> = {
  folder: 'fileFolder',
  image: 'fileImage',
  video: 'fileVideo',
  audio: 'fileAudio',
  document: 'fileDocument',
  archive: 'fileArchive',
  code: 'fileCode',
  other: 'fileOther',
};

const LOCATION_ICON: Record<LocationIcon, IconName> = {
  phone: 'cellphone',
  'sd-card': 'sd',
  usb: 'usb-flash-drive-outline',
  folder: 'folder-key-outline',
  download: 'download-outline',
  document: 'file-document-outline',
  image: 'image-outline',
  camera: 'camera-outline',
  music: 'music-note-outline',
  video: 'filmstrip',
  app: 'folder-home-outline',
};

export function iconForCategory(category: FileCategory, extension = ''): IconName {
  if (extension === 'pdf') return 'file-pdf-box';
  return CATEGORY_ICON[category];
}

export function FileIcon({ category, extension, size = 40 }: { category: FileCategory; extension?: string; size?: number }) {
  const theme = useTheme();
  const color = theme.colors[CATEGORY_COLOR[category]];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        alignItems: 'center',
        justifyContent: 'center',
        // Category-tinted tile: the hue tells the type at a glance; the icon carries the meaning.
        backgroundColor: `${color}${theme.scheme === 'dark' ? '26' : '1A'}`,
      }}
    >
      <Icon name={iconForCategory(category, extension)} size={size * 0.56} color={color} />
    </View>
  );
}

export function LocationGlyph({ icon, size = 40, muted = false }: { icon: LocationIcon; size?: number; muted?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: muted ? theme.colors.surfaceSunken : theme.colors.primarySubtle,
      }}
    >
      <Icon name={LOCATION_ICON[icon]} size={size * 0.55} color={muted ? theme.colors.textTertiary : theme.colors.primary} />
    </View>
  );
}
