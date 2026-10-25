import type { ErrorCode, FileoraError } from '@/core/errors/FileoraError';

export type OperationType = 'copy' | 'move' | 'trash' | 'delete' | 'restore' | 'rename' | 'createFolder' | 'undo';

export type OperationStatus =
  | 'running'
  | 'completed'
  /** Some items succeeded and some failed or were skipped. */
  | 'partial'
  | 'failed'
  | 'cancelled'
  /** The app was closed while the operation ran; detected on next launch. */
  | 'interrupted';

/** One top-level item of an operation, as stored in the journal. Inverted for undo. */
export type JournalItemKind = 'copy' | 'move' | 'trash' | 'delete' | 'rename' | 'mkdir' | 'restore';

export type JournalItemStatus = 'pending' | 'done' | 'failed' | 'skipped';

export type JournalItem = {
  position: number;
  kind: JournalItemKind;
  sourceUri: string | null;
  sourceParentUri: string | null;
  destinationUri: string | null;
  destinationParentUri: string | null;
  /** Original name of the item (before rename / before moving into trash). */
  name: string;
  isDirectory: boolean;
  size: number | null;
  sha256: string | null;
  status: JournalItemStatus;
  errorCode: ErrorCode | null;
};

export type OperationRecord = {
  id: string;
  type: OperationType;
  status: OperationStatus;
  title: string;
  locationId: string | null;
  destinationUri: string | null;
  itemCount: number;
  totalBytes: number | null;
  processedBytes: number;
  reversible: boolean;
  undoOperationId: string | null;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  createdAt: number;
  finishedAt: number | null;
};

export type TrashRecord = {
  id: string;
  operationId: string;
  name: string;
  isDirectory: boolean;
  size: number | null;
  originalParentUri: string;
  originalLocationId: string | null;
  trashUri: string;
  sha256: string | null;
  deletedAt: number;
};

/** Item to operate on. `parentUri` is required because SAF URIs cannot be walked upwards. */
export type SourceItem = {
  uri: string;
  parentUri: string;
  name: string;
  isDirectory: boolean;
  size: number | null;
  mimeType: string | null;
  locationId: string | null;
};

export type ItemFailure = { name: string; error: FileoraError };

export type OperationPhase = 'scanning' | 'transferring' | 'verifying' | 'finishing';

export type OperationProgress = {
  phase: OperationPhase;
  totalBytes: number | null;
  processedBytes: number;
  totalFiles: number;
  processedFiles: number;
  currentName: string | null;
};

export type OperationResult = {
  status: Exclude<OperationStatus, 'running' | 'interrupted'>;
  failures: ItemFailure[];
  skipped: number;
  error: FileoraError | null;
};

export interface Journal {
  begin(record: Omit<OperationRecord, 'status' | 'processedBytes' | 'reversible' | 'undoOperationId' | 'errorCode' | 'errorMessage' | 'finishedAt'>): Promise<void>;
  addItem(operationId: string, item: Omit<JournalItem, 'position'>): Promise<number>;
  updateItem(operationId: string, position: number, patch: Partial<Pick<JournalItem, 'status' | 'destinationUri' | 'sha256' | 'errorCode'>>): Promise<void>;
  finish(operationId: string, patch: Pick<OperationRecord, 'status' | 'processedBytes' | 'reversible' | 'errorCode' | 'errorMessage'>): Promise<void>;
  linkUndo(operationId: string, undoOperationId: string): Promise<void>;
  addTrash(record: TrashRecord): Promise<void>;
  removeTrash(id: string): Promise<void>;
  findTrashByUri(trashUri: string): Promise<TrashRecord | null>;
}
