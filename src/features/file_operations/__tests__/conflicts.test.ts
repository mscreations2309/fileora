import { splitName, uniqueName, validateFileName } from '../conflicts';

describe('uniqueName', () => {
  it('returns the name when free and reserves it', () => {
    const taken = new Set<string>();
    expect(uniqueName('a.txt', false, taken)).toBe('a.txt');
    expect(uniqueName('a.txt', false, taken)).toBe('a (1).txt');
  });

  it('is case-insensitive', () => {
    expect(uniqueName('Photo.JPG', false, new Set(['photo.jpg']))).toBe('Photo (1).JPG');
  });

  it('continues an existing counter', () => {
    expect(uniqueName('report (1).pdf', false, new Set(['report (1).pdf', 'report (2).pdf']))).toBe('report (3).pdf');
  });

  it('keeps compound extensions together', () => {
    expect(uniqueName('backup.tar.gz', false, new Set(['backup.tar.gz']))).toBe('backup (1).tar.gz');
  });

  it('does not treat dots in folder names as extensions', () => {
    expect(uniqueName('v1.2', true, new Set(['v1.2']))).toBe('v1.2 (1)');
  });

  it('handles dotfiles', () => {
    expect(splitName('.nomedia', false)).toEqual({ base: '.nomedia', extension: '' });
    expect(uniqueName('.nomedia', false, new Set(['.nomedia']))).toBe('.nomedia (1)');
  });
});

describe('validateFileName', () => {
  it.each([
    ['', 'Enter a name.'],
    ['..', 'This name is reserved.'],
    ['a/b', 'Names cannot contain / or \\.'],
    [' padded', 'Names cannot start or end with spaces.'],
    ['x'.repeat(256), 'This name is too long.'],
  ])('rejects %p', (name, message) => {
    expect(validateFileName(name)).toBe(message);
  });

  it('accepts unicode names within 255 bytes', () => {
    expect(validateFileName('Résumé – 2026.pdf')).toBeNull();
  });
});
