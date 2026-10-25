import type { FileCategory } from './types';

/** Extension → MIME type for common formats. Used when the platform does not report a type. */
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  apk: 'application/vnd.android.package-archive',
  js: 'text/javascript',
  ts: 'text/plain',
  py: 'text/x-python',
  java: 'text/x-java',
  kt: 'text/plain',
  swift: 'text/plain',
  c: 'text/x-c',
  cpp: 'text/x-c',
  h: 'text/x-c',
  css: 'text/css',
  sh: 'text/x-shellscript',
  yml: 'text/yaml',
  yaml: 'text/yaml',
};

const CODE_EXTENSIONS = new Set(['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'css', 'sh', 'json', 'xml', 'yml', 'yaml', 'html', 'htm']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'apk']);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'md', 'csv', 'epub', 'pages', 'numbers', 'key']);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // Leading-dot names (".nomedia") have no extension.
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function mimeTypeFor(name: string, reported?: string | null): string | null {
  if (reported && reported !== 'application/octet-stream') return reported;
  return MIME_BY_EXTENSION[extensionOf(name)] ?? reported ?? null;
}

export function categorize(name: string, isDirectory: boolean, mimeType: string | null): FileCategory {
  if (isDirectory) return 'folder';
  const ext = extensionOf(name);
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  const mime = mimeType ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/') || mime === 'application/pdf') return 'document';
  return 'other';
}

/** Human label for a category, used in metadata and accessibility descriptions. */
export const CATEGORY_LABELS: Record<FileCategory, string> = {
  folder: 'Folder',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  archive: 'Archive',
  code: 'Code',
  other: 'File',
};
