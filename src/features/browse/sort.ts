import type { SortDirection, SortField } from '@/core/preferences/preferences';
import type { FileEntry } from '@/core/storage/types';

export type SortOptions = {
  field: SortField;
  direction: SortDirection;
  foldersFirst: boolean;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Unknown values (null size/date) always sort last regardless of direction. */
function compareNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return 0;
  if (a === null) return null;
  if (b === null) return null;
  return a - b;
}

export function sortEntries(entries: readonly FileEntry[], options: SortOptions): FileEntry[] {
  const factor = options.direction === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (options.foldersFirst && a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let result = 0;
    switch (options.field) {
      case 'size': {
        const compared = compareNullable(a.size, b.size);
        if (compared === null) return a.size === null ? 1 : -1;
        result = compared;
        break;
      }
      case 'modified': {
        const compared = compareNullable(a.modifiedAt, b.modifiedAt);
        if (compared === null) return a.modifiedAt === null ? 1 : -1;
        result = compared;
        break;
      }
      case 'type':
        result = collator.compare(a.extension, b.extension);
        break;
      case 'name':
        break;
    }
    if (result === 0) result = collator.compare(a.name, b.name);
    return result * factor;
  });
}

export function filterHidden(entries: readonly FileEntry[], showHidden: boolean): readonly FileEntry[] {
  return showHidden ? entries : entries.filter((entry) => !entry.isHidden);
}
