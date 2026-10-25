/**
 * Storage domain model.
 *
 * Fileora never assumes a permanent absolute path: every item is addressed by the URI the
 * platform gave us (`file://` for paths we may access directly, `content://` for Android
 * Storage Access Framework documents). Parent URIs are tracked explicitly because SAF document
 * URIs cannot be "walked up" by string manipulation.
 */

export type FileCategory = 'folder' | 'image' | 'video' | 'audio' | 'document' | 'archive' | 'code' | 'other';

export type LocationKind =
  /** A mounted storage volume reached through file paths (Android All-files access). */
  | 'volume'
  /** A well-known folder inside a volume (Downloads, Documents, ...). */
  | 'shortcut'
  /** A folder the user granted through the system picker (Android SAF tree / iOS document picker). */
  | 'grantedFolder'
  /** Fileora's own sandbox folder (iOS: visible in Files › On My iPhone › Fileora). */
  | 'appSandbox';

export type LocationStatus = 'available' | 'unavailable' | 'accessExpired';

export type StorageLocation = {
  id: string;
  kind: LocationKind;
  rootUri: string;
  label: string;
  description?: string;
  icon: LocationIcon;
  isRemovable: boolean;
  status: LocationStatus;
  totalBytes?: number | null;
  freeBytes?: number | null;
};

export type LocationIcon =
  | 'phone'
  | 'sd-card'
  | 'usb'
  | 'folder'
  | 'download'
  | 'document'
  | 'image'
  | 'camera'
  | 'music'
  | 'video'
  | 'app';

/** What a given item allows. Derived from provider flags and filesystem permissions. */
export type EntryCapabilities = {
  canRename: boolean;
  canDelete: boolean;
  canMove: boolean;
  /** Files: content can be replaced. Folders: children can be created. */
  canWrite: boolean;
};

export type FileEntry = {
  uri: string;
  parentUri: string;
  locationId: string;
  name: string;
  extension: string;
  isDirectory: boolean;
  /** Bytes; null when the provider cannot report it (and always null for folders). */
  size: number | null;
  /** Epoch milliseconds; null when unknown. */
  modifiedAt: number | null;
  mimeType: string | null;
  category: FileCategory;
  /** Number of children for folders when cheaply available. */
  childCount: number | null;
  isHidden: boolean;
  capabilities: EntryCapabilities;
};

/** Raw listing record returned by providers before enrichment. */
export type RawEntry = {
  name: string;
  uri: string;
  isDirectory: boolean;
  size: number | null;
  modifiedAt: number | null;
  mimeType: string | null;
  childCount: number | null;
  isHidden: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canRename: boolean;
  canMove: boolean;
};

export type CopiedEntry = RawEntry & {
  /** SHA-256 of the bytes read from the source during the copy, when the provider computes it. */
  sha256: string | null;
};

/** Provider-wide abilities; the UI adapts to these rather than assuming all actions exist. */
export type ProviderCapabilities = {
  /** Copy reports byte-level progress events. */
  reportsProgress: boolean;
  /** copyFile itself verifies the written data, so callers need not hash the destination again. */
  verifiesCopies: boolean;
  /** Copy/hash honour cancellation mid-stream. */
  cancellableTransfers: boolean;
  /** Access to user-granted folders survives app restarts. */
  persistentFolderGrants: boolean;
  /** Can browse whole volumes (requires Android All-files access). */
  volumeBrowsing: boolean;
};

export type TransferProgress = {
  operationId: string;
  bytesProcessed: number;
  totalBytes: number | null;
};

export interface StorageProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** Lists a folder. Hidden in-progress copies (".fileora-partial-*") are excluded unless requested. */
  listChildren(directoryUri: string, options?: { includePartials?: boolean }): Promise<RawEntry[]>;
  stat(uri: string): Promise<RawEntry | null>;
  createDirectory(parentUri: string, name: string): Promise<RawEntry>;
  rename(uri: string, newName: string): Promise<RawEntry>;
  delete(uri: string): Promise<void>;
  /** Streams one file into `destinationParentUri/name`. Never leaves a partial file under `name`. */
  copyFile(
    operationId: string,
    sourceUri: string,
    destinationParentUri: string,
    name: string,
    mimeType: string | null,
    overwrite: boolean,
  ): Promise<CopiedEntry>;
  /** Metadata-only move when possible; resolves null when the caller must copy → verify → delete. */
  tryFastMove(
    sourceUri: string,
    sourceParentUri: string,
    destinationParentUri: string,
    name: string,
  ): Promise<RawEntry | null>;
  hash(uri: string, operationId?: string): Promise<string>;
  cancel(operationId: string): void;
  onProgress(listener: (progress: TransferProgress) => void): () => void;
}
