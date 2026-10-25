/** Pure rules for Fileora Web, kept separate so they can be unit-tested. */

const PARTIAL_PREFIX = '.fileora-partial-';
const INVALID_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

export type WebEntry = { uri: string; name: string; isDirectory: boolean; size: number | null; modifiedAt: number | null; mimeType: string | null; childCount: number | null };

/** What a laptop may see in a folder: no in-progress partial files, no hidden files unless the user shows them. */
export function visibleEntries<T extends { name: string; isDirectory: boolean; isHidden?: boolean }>(entries: T[], showHidden: boolean): T[] {
  return entries
    .filter((e) => !e.name.startsWith(PARTIAL_PREFIX) && (showHidden || !(e.isHidden ?? e.name.startsWith('.'))))
    .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.isDirectory ? -1 : 1));
}

/** A file or folder name a laptop may create or rename to. Returns a reason when it is not allowed. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name';
  if (trimmed === '.' || trimmed === '..') return 'That name is reserved';
  if (trimmed.length > 255) return 'Name is too long';
  if (INVALID_NAME.test(trimmed)) return 'Names cannot contain \\ / : * ? " < > |';
  return null;
}

/** True when `uri` is one of `roots` or inside one of them (never outside, never the trash folder). */
export function insideRoots(uri: string, roots: string[], excluded: string[] = []): boolean {
  const normalized = uri.replace(/\/+$/, '');
  if (excluded.some((x) => normalized === x.replace(/\/+$/, '') || normalized.startsWith(`${x.replace(/\/+$/, '')}/`))) return false;
  return roots.some((root) => {
    const r = root.replace(/\/+$/, '');
    if (normalized === r) return true;
    // SAF tree documents encode the path after the tree id ("…/document/primary%3ADownload%2Fx"), so match on the encoded prefix too.
    return normalized.startsWith(`${r}/`) || normalized.startsWith(`${r}%2F`);
  });
}

/** Rough device name for a laptop, from its browser's user agent. */
export function laptopName(userAgent: string): string {
  const os = /Windows/i.test(userAgent) ? 'Windows' : /Mac OS X|Macintosh/i.test(userAgent) ? 'Mac' : /CrOS/i.test(userAgent) ? 'Chromebook' : /Linux/i.test(userAgent) ? 'Linux' : 'Computer';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'browser';
  return `${os} · ${browser}`;
}
