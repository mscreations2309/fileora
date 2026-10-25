import { NativeModule, requireOptionalNativeModule } from 'expo';

export type NativeEntry = {
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

export type NativeCopyResult = NativeEntry & { sha256: string };

export type NativeVolume = {
  id: string;
  uri: string;
  label: string | null;
  isPrimary: boolean;
  isRemovable: boolean;
  isMounted: boolean;
  isReadOnly: boolean;
  totalBytes: number | null;
  freeBytes: number | null;
};

export type NativeAllFilesAccessStatus = { mode: 'manage' | 'legacy'; granted: boolean };

export type NativePersistedPermission = {
  uri: string;
  read: boolean;
  write: boolean;
  persistedAt: number;
};

export type NativeOfficeDocument = {
  kind: 'docx' | 'xlsx' | 'pptx' | 'unknown';
  text: string;
  metadata: Record<string, string>;
  hiddenSheets: string[];
  trackedInsertions: number;
  trackedDeletions: number;
  comments: number;
};

export type TransferProgressEvent = {
  operationId: string;
  bytesProcessed: number;
  totalBytes: number | null;
};

export type HandoffEvent = {
  session: string;
  event: 'listening' | 'pairing' | 'rejected' | 'receiving' | 'accepted' | 'preparing' | 'progress' | 'fileVerified' | 'fileFailed' | 'completed' | 'cancelled' | 'error';
  code?: string;
  peer?: string;
  transferId?: string;
  fileCount?: number;
  totalBytes?: number;
  files?: string[];
  file?: number;
  bytes?: number;
  path?: string;
  stagedUri?: string;
  size?: number;
  sha256?: string;
  message?: string;
};

/** Fileora Web (laptop access) events from the phone's local server. */
export type RemoteEvent =
  | { type: 'request'; id: string; op: 'roots' | 'list' | 'import' | 'rename' | 'mkdir' | 'delete'; deviceId: string; deviceName: string; args: string }
  | { type: 'pair'; pairId: string; name: string; code: string }
  | { type: 'seen'; deviceId: string }
  | { type: 'activity'; deviceId: string; action: 'download'; uri: string }
  | { type: 'stopped' };

export type RemoteDevice = { id: string; name: string; tokenHash: string };

type FileoraStorageEvents = {
  onTransferProgress: (event: TransferProgressEvent) => void;
  onHandoff: (event: HandoffEvent) => void;
  onRemote: (event: RemoteEvent) => void;
};

declare class FileoraStorageNativeModule extends NativeModule<FileoraStorageEvents> {
  getAllFilesAccessStatus(): NativeAllFilesAccessStatus;
  getAppStorageRoots(): { internalFiles: string; externalFiles: string | null };
  getStorageVolumes(): Promise<NativeVolume[]>;
  resolveTreeRoot(treeUri: string): Promise<NativeEntry>;
  listChildren(uri: string): Promise<NativeEntry[]>;
  stat(uri: string): Promise<NativeEntry | null>;
  createDirectory(parentUri: string, name: string): Promise<NativeEntry>;
  rename(uri: string, newName: string): Promise<NativeEntry>;
  delete(uri: string): Promise<boolean>;
  tryFastMove(
    sourceUri: string,
    sourceParentUri: string,
    destinationParentUri: string,
    name: string,
  ): Promise<NativeEntry | null>;
  copyFile(
    operationId: string,
    sourceUri: string,
    destinationParentUri: string,
    name: string,
    mimeType: string | null,
    overwrite: boolean,
  ): Promise<NativeCopyResult>;
  hash(uri: string, algorithm: 'SHA-256' | 'SHA-1' | 'MD5', operationId: string | null): Promise<string>;
  cancel(operationId: string): void;
  /** Opens the file in another app via ACTION_VIEW with a temporary read grant. */
  openFile(uri: string, mimeType: string | null): Promise<void>;
  /** Shows the system share sheet for one or more files with temporary read grants. */
  shareFiles(uris: string[], mimeType: string | null): Promise<void>;
  getPersistedPermissions(): NativePersistedPermission[];
  releasePersistedPermission(uri: string): boolean;
  /** Reads up to `maxBytes` of a file as UTF-8 text. */
  readText(uri: string, maxBytes: number): Promise<{ text: string; truncated: boolean }>;
  /** Reads a byte range, base64-encoded. */
  readBytes(uri: string, offset: number, length: number): Promise<string>;
  /** On-device OCR (ML Kit, bundled model). */
  recognizeText(uri: string): Promise<{ text: string; lines: string[] }>;
  /** Renders up to `maxPages` PDF pages and runs OCR on each. */
  extractPdfText(uri: string, maxPages: number): Promise<{ pageCount: number; pages: string[] }>;
  /** Text and privacy-relevant structure of docx/xlsx/pptx files. */
  extractOfficeDocument(uri: string): Promise<NativeOfficeDocument>;
  /** 64-bit perceptual difference hash (hex). */
  imageHash(uri: string): Promise<string>;
  /** Creates a new file (never overwrites). */
  writeFile(parentUri: string, name: string, base64: string, mimeType: string | null): Promise<NativeEntry>;
  /** Starts listening for one incoming Smart Handoff connection at a time. */
  handoffStartReceiving(sessionId: string, deviceName: string): Promise<{ port: number; addresses: string[]; emulator?: boolean }>;
  /** Accepts or declines a pairing after the user compared the 6-digit code. */
  handoffRespond(sessionId: string, accept: boolean): void;
  handoffStopReceiving(sessionId: string): void;
  /** `host` may be a comma-separated list of addresses; the first that answers is used. */
  handoffSend(sessionId: string, host: string, port: number, transferId: string, deviceName: string, files: { uri: string; path: string; size: number }[]): void;
  handoffCancel(sessionId: string): void;
  /** Deletes staged (received but not yet imported) data of a transfer. */
  handoffDiscard(transferId: string): void;
  /** Starts a local-only hotspot (random name/password, no internet) for a direct link. */
  hotspotStart(): Promise<{ ssid: string; passphrase: string; addresses: string[] }>;
  hotspotStop(): void;
  /** Joins another device's hotspot (Android 10+; the system asks the user to confirm). Sends then use that link. */
  hotspotJoin(ssid: string, passphrase: string): Promise<{ joined: boolean }>;
  hotspotLeave(): void;
  /** Starts Fileora Web (local HTTP server + foreground service). Only approved devices can use it. */
  remoteStart(port: number, devices: RemoteDevice[]): Promise<{ port: number; addresses: string[] }>;
  remoteStop(): void;
  remoteSetDevices(devices: RemoteDevice[]): void;
  /** Answers a `request` event with a JSON string (`{ ok: true, ... }` or `{ ok: false, error }`). */
  remoteRespond(requestId: string, json: string): void;
  /** Approves or declines a laptop; returns the new device (to persist) when approved. */
  remoteResolvePairing(pairId: string, accept: boolean): RemoteDevice | null;
  /** Pushes a live "something changed" event to connected browsers. */
  remoteNotifyChange(parentUri: string | null): void;
  /** PBKDF2-HMAC-SHA256; returns the derived key base64-encoded. */
  deriveKey(password: string, saltBase64: string, iterations: number, lengthBytes: number): Promise<string>;
  /** Writes a copy of a JPEG without EXIF/XMP/IPTC/comment segments. */
  stripJpegMetadata(sourceUri: string, parentUri: string, name: string): Promise<NativeEntry & { removedSegments: number }>;
}

/** Android only. `null` on iOS and in environments without the native build (e.g. Expo Go, Jest). */
export const FileoraStorage = requireOptionalNativeModule<FileoraStorageNativeModule>('FileoraStorage');

export const PARTIAL_FILE_PREFIX = '.fileora-partial-';
