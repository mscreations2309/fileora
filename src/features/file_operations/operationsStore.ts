import { randomUUID } from 'expo-crypto';
import { PARTIAL_FILE_PREFIX } from 'fileora-storage';
import { create } from 'zustand';

import { toFileoraError } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';
import { trashDirectoryUri } from '@/core/storage/locations';
import { storage } from '@/core/storage/storage';

import type { EngineDeps, RunContext } from './engine';
import { sqliteJournal, takeInterruptedOperations } from './journal';
import type { OperationProgress, OperationResult, OperationType } from './types';

export type ActiveOperation = {
  id: string;
  type: OperationType;
  title: string;
  status: 'running' | OperationResult['status'];
  progress: OperationProgress | null;
  result: OperationResult | null;
  startedAt: number;
  cancelRequested: boolean;
};

type OperationsState = {
  operations: Record<string, ActiveOperation>;
  /** Bumped whenever an operation finishes, so visible listings can refresh. */
  revision: number;
  dismiss: (id: string) => void;
  cancel: (id: string) => void;
};

const PROGRESS_THROTTLE_MS = 150;

export const useOperations = create<OperationsState>()((set, get) => ({
  operations: {},
  revision: 0,
  dismiss: (id) =>
    set((state) => {
      const { [id]: _removed, ...rest } = state.operations;
      return { operations: rest };
    }),
  cancel: (id) => {
    const operation = get().operations[id];
    if (!operation || operation.status !== 'running') return;
    storage.cancel(id);
    set((state) => ({ operations: { ...state.operations, [id]: { ...operation, cancelRequested: true } } }));
  },
}));

export const engineDeps: EngineDeps = {
  storage,
  journal: sqliteJournal,
  trashDirectoryUri,
  newId: () => randomUUID(),
  now: () => Date.now(),
};

/**
 * Runs an engine operation with UI tracking. Progress is throttled so large copies do not flood
 * React with updates; the final state is always delivered.
 */
export async function track<T extends OperationResult>(
  type: OperationType,
  title: string,
  body: (deps: EngineDeps, ctx: RunContext) => Promise<T>,
): Promise<T & { operationId: string }> {
  const id = randomUUID();
  const store = useOperations;
  store.setState((state) => ({
    operations: {
      ...state.operations,
      [id]: { id, type, title, status: 'running', progress: null, result: null, startedAt: Date.now(), cancelRequested: false },
    },
  }));
  let lastEmit = 0;
  const ctx: RunContext = {
    operationId: id,
    isCancelled: () => store.getState().operations[id]?.cancelRequested ?? false,
    onProgress: (progress) => {
      const now = Date.now();
      if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
      lastEmit = now;
      store.setState((state) => {
        const current = state.operations[id];
        return current ? { operations: { ...state.operations, [id]: { ...current, progress } } } : state;
      });
    },
  };
  let result: T;
  try {
    result = await body(engineDeps, ctx);
  } catch (error) {
    // The engine reports failures as results; reaching here means the journal itself failed.
    const failure = toFileoraError(error);
    logger.error('operations', `Operation ${type} could not run`, failure);
    // Callers of rename/createFolder read `entry`; null signals that nothing was created.
    result = { status: 'failed', failures: [], skipped: 0, error: failure, entry: null } as unknown as T;
  }
  // The caller reports the outcome (toast); the progress panel only shows running operations.
  store.setState((state) => {
    const { [id]: _finished, ...running } = state.operations;
    return { revision: state.revision + 1, operations: running };
  });
  return { ...result, operationId: id };
}

/** Cleans hidden partial files left by operations that were running when the app was killed. */
export async function recoverInterruptedOperations(): Promise<number> {
  const interrupted = await takeInterruptedOperations();
  for (const operation of interrupted) {
    for (const folder of operation.folders) {
      try {
        const children = await storage.listChildren(folder, { includePartials: true });
        for (const child of children) {
          if (child.name.startsWith(`${PARTIAL_FILE_PREFIX}${operation.id}`)) await storage.delete(child.uri);
        }
      } catch (error) {
        logger.warn('operations', 'Could not inspect a folder after an interrupted operation', error);
      }
    }
  }
  if (interrupted.length > 0) logger.info('operations', `Marked ${interrupted.length} interrupted operation(s)`);
  return interrupted.length;
}
