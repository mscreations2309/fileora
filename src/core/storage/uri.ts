/**
 * URI helpers. Only `file://` URIs can be manipulated as paths; `content://` URIs are opaque and
 * must be obtained from the provider (listings, create/rename results).
 */

export function isFileUri(uri: string): boolean {
  return uri.startsWith('file://');
}

export function isContentUri(uri: string): boolean {
  return uri.startsWith('content://');
}

export function stripTrailingSlash(uri: string): string {
  return uri.length > 'file:///'.length && uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

/** Appends an encoded child name to a `file://` directory URI. */
export function joinFileUri(directoryUri: string, name: string): string {
  if (!isFileUri(directoryUri)) throw new Error('joinFileUri requires a file:// URI');
  return `${stripTrailingSlash(directoryUri)}/${encodeURIComponent(name)}`;
}

/** Parent of a `file://` URI, or null at the filesystem root. */
export function parentFileUri(uri: string): string | null {
  if (!isFileUri(uri)) return null;
  const trimmed = stripTrailingSlash(uri);
  const index = trimmed.lastIndexOf('/');
  if (index <= 'file://'.length) return null;
  return trimmed.slice(0, index) || null;
}

/** Decoded absolute path for display (file URIs only). */
export function displayPathOf(uri: string): string | null {
  if (!isFileUri(uri)) return null;
  try {
    return decodeURIComponent(stripTrailingSlash(uri).slice('file://'.length));
  } catch {
    return stripTrailingSlash(uri).slice('file://'.length);
  }
}

/** Whether `candidate` is `ancestor` or inside it (file URIs only; content URIs compare exactly). */
export function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  const a = stripTrailingSlash(ancestor);
  const c = stripTrailingSlash(candidate);
  if (c === a) return true;
  return isFileUri(a) && c.startsWith(`${a}/`);
}

/** Stable short identifier derived from a string (FNV-1a), used for location ids. */
export function stableId(prefix: string, value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}:${(hash >>> 0).toString(36)}`;
}
