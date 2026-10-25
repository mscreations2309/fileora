/**
 * Filename-collision handling. Comparisons are case-insensitive because Android shared storage,
 * SD cards (FAT/exFAT) and the default APFS volume on iOS treat "A.txt" and "a.txt" as the same file.
 */

export type ConflictResolution = 'keepBoth' | 'replace' | 'skip';

const COMPOUND_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst'];
const NUMBERED = /^(.*) \((\d+)\)$/;

export function nameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase();
}

export function splitName(name: string, isDirectory: boolean): { base: string; extension: string } {
  if (isDirectory) return { base: name, extension: '' };
  const lower = name.toLowerCase();
  const compound = COMPOUND_EXTENSIONS.find((ext) => lower.endsWith(ext) && lower.length > ext.length);
  if (compound) return { base: name.slice(0, -compound.length), extension: name.slice(-compound.length) };
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { base: name, extension: '' };
  return { base: name.slice(0, dot), extension: name.slice(dot) };
}

/**
 * Returns `name` if free, otherwise the first free "base (n).ext". `taken` holds `nameKey` values;
 * the chosen name is added to it so batch operations never pick the same name twice.
 */
export function uniqueName(name: string, isDirectory: boolean, taken: Set<string>): string {
  if (!taken.has(nameKey(name))) {
    taken.add(nameKey(name));
    return name;
  }
  const { base, extension } = splitName(name, isDirectory);
  const numbered = NUMBERED.exec(base);
  const stem = numbered ? (numbered[1] ?? base) : base;
  let counter = numbered ? Number(numbered[2]) + 1 : 1;
  for (;;) {
    const candidate = `${stem} (${counter})${extension}`;
    if (!taken.has(nameKey(candidate))) {
      taken.add(nameKey(candidate));
      return candidate;
    }
    counter += 1;
  }
}

/** Validates a user-entered name; returns an error message or null. */
export function validateFileName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name.';
  if (trimmed === '.' || trimmed === '..') return 'This name is reserved.';
  if (/[/\\\u0000]/.test(trimmed)) return 'Names cannot contain / or \\.';
  if (/[<>:"|?*]/.test(trimmed)) return 'Avoid < > : " | ? * — some storage cannot store them.';
  if (new TextEncoder().encode(trimmed).length > 255) return 'This name is too long.';
  if (trimmed !== name) return 'Names cannot start or end with spaces.';
  return null;
}
