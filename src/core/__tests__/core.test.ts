import { toFileoraError } from '@/core/errors/FileoraError';
import { redact } from '@/core/logging/logger';
import { categorize, extensionOf, mimeTypeFor } from '@/core/storage/fileTypes';
import { displayPathOf, isSameOrDescendant, joinFileUri, parentFileUri } from '@/core/storage/uri';
import type { FileEntry } from '@/core/storage/types';
import { sortEntries } from '@/features/browse/sort';

function entry(name: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    uri: `file:///x/${name}`,
    parentUri: 'file:///x',
    locationId: 'x',
    name,
    extension: extensionOf(name),
    isDirectory: false,
    size: null,
    modifiedAt: null,
    mimeType: null,
    category: 'other',
    childCount: null,
    isHidden: false,
    capabilities: { canRename: true, canDelete: true, canMove: true, canWrite: true },
    ...extra,
  };
}

describe('file types', () => {
  it('extracts extensions', () => {
    expect(extensionOf('a.PDF')).toBe('pdf');
    expect(extensionOf('.nomedia')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });

  it('prefers reported MIME types except octet-stream', () => {
    expect(mimeTypeFor('a.jpg', 'application/octet-stream')).toBe('image/jpeg');
    expect(mimeTypeFor('a.bin', 'application/x-custom')).toBe('application/x-custom');
  });

  it('categorizes by extension and MIME', () => {
    expect(categorize('a.zip', false, 'application/zip')).toBe('archive');
    expect(categorize('photo.heic', false, 'image/heic')).toBe('image');
    expect(categorize('Folder', true, null)).toBe('folder');
    expect(categorize('notes.md', false, null)).toBe('document');
  });
});

describe('uri helpers', () => {
  it('joins and walks file URIs with encoding', () => {
    const uri = joinFileUri('file:///storage/emulated/0/', 'My File (1).txt');
    expect(uri).toBe('file:///storage/emulated/0/My%20File%20(1).txt');
    expect(parentFileUri(uri)).toBe('file:///storage/emulated/0');
    expect(displayPathOf(uri)).toBe('/storage/emulated/0/My File (1).txt');
  });

  it('detects descendants without prefix false-positives', () => {
    expect(isSameOrDescendant('file:///a/b/c', 'file:///a/b')).toBe(true);
    expect(isSameOrDescendant('file:///a/bc', 'file:///a/b')).toBe(false);
  });
});

describe('sortEntries', () => {
  const items = [
    entry('file10.txt', { size: 10, modifiedAt: 3 }),
    entry('file2.txt', { size: null, modifiedAt: 1 }),
    entry('Folder', { isDirectory: true }),
    entry('alpha.pdf', { size: 5, modifiedAt: null }),
  ];

  it('sorts naturally with folders first', () => {
    expect(sortEntries(items, { field: 'name', direction: 'asc', foldersFirst: true }).map((e) => e.name)).toEqual([
      'Folder',
      'alpha.pdf',
      'file2.txt',
      'file10.txt',
    ]);
  });

  it('keeps unknown sizes last in both directions', () => {
    const desc = sortEntries(items, { field: 'size', direction: 'desc', foldersFirst: false }).map((e) => e.name);
    expect(desc.slice(0, 2)).toEqual(['file10.txt', 'alpha.pdf']);
    const asc = sortEntries(items, { field: 'size', direction: 'asc', foldersFirst: false }).map((e) => e.name);
    expect(asc.slice(0, 2)).toEqual(['alpha.pdf', 'file10.txt']);
  });
});

describe('errors and logging', () => {
  it('maps native codes and classifies plain errors', () => {
    expect(toFileoraError(Object.assign(new Error('x'), { code: 'ERR_NO_SPACE' })).code).toBe('ERR_NO_SPACE');
    expect(toFileoraError(new Error('Permission denied')).code).toBe('ERR_ACCESS_DENIED');
    expect(toFileoraError('weird').code).toBe('ERR_INTERNAL');
  });

  it('redacts URIs and paths', () => {
    expect(redact('failed file:///storage/emulated/0/secret.pdf and /storage/emulated/0/x')).toBe('failed <uri> and <path>');
    expect(redact('content://com.android.externalstorage.documents/tree/primary%3ADocs')).toBe('<uri>');
  });
});
