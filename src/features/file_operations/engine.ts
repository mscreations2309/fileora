import { FileoraError, toFileoraError, type ErrorCode } from '@/core/errors/FileoraError';
import { mimeTypeFor } from '@/core/storage/fileTypes';
import type { RawEntry, StorageProvider } from '@/core/storage/types';
import { isSameOrDescendant } from '@/core/storage/uri';

import { nameKey, splitName, uniqueName } from './conflicts';
import type {
  ItemFailure,
  Journal,
  JournalItem,
  JournalItemKind,
  OperationProgress,
  OperationResult,
  OperationType,
  SourceItem,
  TrashRecord,
} from './types';

/**
 * File operation engine.
 *
 * Guarantees:
 * - A move never deletes a source file until its copy was written completely and (unless the
 *   provider verifies copies itself) its SHA-256 matched the source.
 * - Per-item failures do not abort the whole operation; storage-wide failures (no space, read-only,
 *   cancellation) do. The result always reports exactly what succeeded and what did not.
 * - Every top-level item is journaled before it is touched and updated after, so history, undo and
 *   interrupted-operation recovery reflect reality.
 */

export type EngineDeps = {
  storage: StorageProvider;
  journal: Journal;
  trashDirectoryUri: () => string;
  newId: () => string;
  now: () => number;
};

export type RunContext = {
  operationId: string;
  isCancelled: () => boolean;
  onProgress: (progress: OperationProgress) => void;
};

/** A top-level item with its resolved destination name. */
export type RootPlan = {
  source: SourceItem;
  targetName: string;
  /** Existing destination file to replace. Moved to trash first when `useTrash` is on. */
  replace: RawEntry | null;
};

type Tree = { item: SourceItem; children: Tree[] | null };

const FATAL_CODES: ReadonlySet<ErrorCode> = new Set(['ERR_CANCELLED', 'ERR_NO_SPACE', 'ERR_READ_ONLY']);
const INVERTIBLE: ReadonlySet<JournalItemKind> = new Set(['copy', 'move', 'trash', 'rename', 'mkdir', 'restore']);
const MAX_NAME_BYTES = 255;

class Run {
  readonly failures: ItemFailure[] = [];
  skipped = 0;
  /** Files (or fast-moved items) that completed successfully, for partial-vs-failed reporting. */
  succeededUnits = 0;
  private completedBytes = 0;
  private readonly progress: OperationProgress = {
    phase: 'scanning',
    totalBytes: null,
    processedBytes: 0,
    totalFiles: 0,
    processedFiles: 0,
    currentName: null,
  };
  private readonly unsubscribe: () => void;

  constructor(
    readonly deps: EngineDeps,
    readonly ctx: RunContext,
  ) {
    this.unsubscribe = deps.storage.onProgress((event) => {
      if (event.operationId !== ctx.operationId || this.progress.phase !== 'transferring') return;
      this.progress.processedBytes = this.completedBytes + event.bytesProcessed;
      this.emit();
    });
  }

  get storage(): StorageProvider {
    return this.deps.storage;
  }

  get processedBytes(): number {
    return this.completedBytes;
  }

  dispose(): void {
    this.unsubscribe();
  }

  checkCancelled(): void {
    if (this.ctx.isCancelled()) throw new FileoraError('ERR_CANCELLED', 'Operation cancelled');
  }

  phase(phase: OperationProgress['phase'], currentName: string | null = this.progress.currentName): void {
    this.progress.phase = phase;
    this.progress.currentName = currentName;
    this.emit();
  }

  planned(tree: Tree): void {
    const { files, bytes } = measure(tree);
    this.progress.totalFiles += files;
    this.progress.totalBytes = (this.progress.totalBytes ?? 0) + bytes;
    this.emit();
  }

  filesDone(files: number, bytes: number): void {
    this.completedBytes += bytes;
    this.progress.processedFiles += files;
    this.progress.processedBytes = this.completedBytes;
    this.emit();
  }

  fail(name: string, error: unknown): FileoraError {
    const classified = toFileoraError(error);
    if (FATAL_CODES.has(classified.code)) throw classified;
    this.failures.push({ name, error: classified });
    return classified;
  }

  private emit(): void {
    this.ctx.onProgress({ ...this.progress });
  }
}

function measure(tree: Tree): { files: number; bytes: number } {
  if (!tree.children) return { files: 1, bytes: tree.item.size ?? 0 };
  return tree.children.reduce(
    (acc, child) => {
      const m = measure(child);
      return { files: acc.files + m.files, bytes: acc.bytes + m.bytes };
    },
    { files: 0, bytes: 0 },
  );
}

function childItem(raw: RawEntry, parent: SourceItem): SourceItem {
  return {
    uri: raw.uri,
    parentUri: parent.uri,
    name: raw.name,
    isDirectory: raw.isDirectory,
    size: raw.isDirectory ? null : raw.size,
    mimeType: raw.isDirectory ? null : mimeTypeFor(raw.name, raw.mimeType),
    locationId: parent.locationId,
  };
}

async function scan(run: Run, item: SourceItem): Promise<Tree> {
  run.checkCancelled();
  if (!item.isDirectory) return { item, children: null };
  const raws = await run.storage.listChildren(item.uri);
  const children: Tree[] = [];
  for (const raw of raws) children.push(await scan(run, childItem(raw, item)));
  return { item, children };
}

function containsFolder(tree: Tree, uri: string): boolean {
  if (!tree.children) return false;
  if (tree.item.uri === uri) return true;
  return tree.children.some((child) => containsFolder(child, uri));
}

function assertNotIntoItself(tree: Tree, destinationUri: string): void {
  if (tree.item.isDirectory && (isSameOrDescendant(destinationUri, tree.item.uri) || containsFolder(tree, destinationUri))) {
    throw new FileoraError('ERR_UNSUPPORTED', `Cannot place "${tree.item.name}" inside itself`);
  }
}

async function copyTree(run: Run, tree: Tree, destinationParentUri: string, name: string, overwrite: boolean): Promise<{ entry: RawEntry | null; ok: boolean }> {
  run.checkCancelled();
  if (!tree.children) {
    try {
      run.phase('transferring', name);
      const copied = await run.storage.copyFile(run.ctx.operationId, tree.item.uri, destinationParentUri, name, tree.item.mimeType, overwrite);
      run.filesDone(1, tree.item.size ?? copied.size ?? 0);
      run.succeededUnits += 1;
      return { entry: copied, ok: true };
    } catch (error) {
      run.fail(name, error);
      run.filesDone(1, tree.item.size ?? 0);
      return { entry: null, ok: false };
    }
  }
  let created: RawEntry;
  try {
    created = await run.storage.createDirectory(destinationParentUri, name);
  } catch (error) {
    run.fail(name, error);
    const skipped = measure(tree);
    run.filesDone(skipped.files, skipped.bytes);
    return { entry: null, ok: false };
  }
  let ok = true;
  for (const child of tree.children) {
    const result = await copyTree(run, child, created.uri, child.item.name, false);
    ok = ok && result.ok;
  }
  return { entry: created, ok };
}

/** Copy → verify → delete, recursively. Sources are only removed after their data is verified at the destination. */
async function relocateTree(run: Run, tree: Tree, destinationParentUri: string, name: string, overwrite: boolean): Promise<{ entry: RawEntry | null; ok: boolean }> {
  run.checkCancelled();
  if (!tree.children) {
    let copied;
    try {
      run.phase('transferring', name);
      copied = await run.storage.copyFile(run.ctx.operationId, tree.item.uri, destinationParentUri, name, tree.item.mimeType, overwrite);
    } catch (error) {
      run.fail(name, error);
      run.filesDone(1, tree.item.size ?? 0);
      return { entry: null, ok: false };
    }
    try {
      if (!run.storage.capabilities.verifiesCopies) {
        run.phase('verifying', name);
        const sourceHash = copied.sha256 ?? (await run.storage.hash(tree.item.uri));
        const destinationHash = await run.storage.hash(copied.uri);
        if (sourceHash !== destinationHash) {
          await run.storage.delete(copied.uri).catch(() => undefined);
          throw new FileoraError('ERR_VERIFICATION_FAILED', 'Copied data does not match the original');
        }
      }
      await run.storage.delete(tree.item.uri);
      run.filesDone(1, tree.item.size ?? copied.size ?? 0);
      run.succeededUnits += 1;
      return { entry: copied, ok: true };
    } catch (error) {
      const failure = run.fail(name, error);
      run.filesDone(1, tree.item.size ?? 0);
      // After a verification failure the copy was removed; otherwise both copies exist and the source is kept.
      return { entry: failure.code === "ERR_VERIFICATION_FAILED" ? null : copied, ok: false };
    }
  }
  let created: RawEntry;
  try {
    created = await run.storage.createDirectory(destinationParentUri, name);
  } catch (error) {
    run.fail(name, error);
    const skipped = measure(tree);
    run.filesDone(skipped.files, skipped.bytes);
    return { entry: null, ok: false };
  }
  let ok = true;
  for (const child of tree.children) {
    const result = await relocateTree(run, child, created.uri, child.item.name, false);
    ok = ok && result.ok;
  }
  if (ok) {
    try {
      // Every descendant was verified and removed; only the (now empty) folder remains.
      await run.storage.delete(tree.item.uri);
    } catch (error) {
      run.fail(tree.item.name, error);
      ok = false;
    }
  }
  return { entry: created, ok };
}

/** Moves one item: instant rename when the platform allows it, otherwise copy → verify → delete. */
async function moveItem(run: Run, item: SourceItem, destinationParentUri: string, name: string, overwrite: boolean): Promise<{ entry: RawEntry | null; ok: boolean }> {
  run.checkCancelled();
  if (!overwrite) {
    try {
      const moved = await run.storage.tryFastMove(item.uri, item.parentUri, destinationParentUri, name);
      if (moved) {
        run.filesDone(item.isDirectory ? 0 : 1, item.size ?? 0);
        run.succeededUnits += 1;
        return { entry: moved, ok: true };
      }
    } catch (error) {
      run.fail(name, error);
      return { entry: null, ok: false };
    }
  }
  run.phase('scanning', name);
  const tree = await scan(run, item);
  assertNotIntoItself(tree, destinationParentUri);
  run.planned(tree);
  return relocateTree(run, tree, destinationParentUri, name, overwrite);
}

function trashName(id: string, name: string): string {
  const candidate = `${id}-${name}`;
  if (new TextEncoder().encode(candidate).length <= MAX_NAME_BYTES) return candidate;
  const { extension } = splitName(name, false);
  let base = name.slice(0, Math.max(1, name.length - extension.length));
  while (base.length > 1 && new TextEncoder().encode(`${id}-${base}${extension}`).length > MAX_NAME_BYTES) {
    base = base.slice(0, -1);
  }
  return `${id}-${base}${extension}`;
}

async function sendToTrash(run: Run, item: SourceItem): Promise<{ entry: RawEntry | null; ok: boolean; record: TrashRecord | null }> {
  const id = run.deps.newId().replace(/-/g, '').slice(0, 12);
  const trashUri = run.deps.trashDirectoryUri();
  const result = await moveItem(run, item, trashUri, trashName(id, item.name), false);
  if (!result.ok || !result.entry) return { ...result, record: null };
  const record: TrashRecord = {
    id,
    operationId: run.ctx.operationId,
    name: item.name,
    isDirectory: item.isDirectory,
    size: item.size,
    originalParentUri: item.parentUri,
    originalLocationId: item.locationId,
    trashUri: result.entry.uri,
    sha256: null,
    deletedAt: run.deps.now(),
  };
  await run.deps.journal.addTrash(record);
  return { ...result, record };
}

async function takenNames(storage: StorageProvider, folderUri: string): Promise<Set<string>> {
  const children = await storage.listChildren(folderUri);
  return new Set(children.map((child) => nameKey(child.name)));
}

type ItemSpec = Omit<JournalItem, 'position' | 'status' | 'errorCode' | 'sha256' | 'destinationUri'> & { destinationUri?: string | null };

/** Shared lifecycle: journal begin → items → finish, with consistent status computation. */
async function execute(
  deps: EngineDeps,
  ctx: RunContext,
  meta: { type: OperationType; title: string; locationId: string | null; destinationUri: string | null; itemCount: number },
  body: (run: Run, record: (spec: ItemSpec) => Promise<(outcome: { ok: boolean; skipped?: boolean; destinationUri?: string | null }) => Promise<void>>) => Promise<void>,
): Promise<OperationResult> {
  await deps.journal.begin({
    id: ctx.operationId,
    type: meta.type,
    title: meta.title,
    locationId: meta.locationId,
    destinationUri: meta.destinationUri,
    itemCount: meta.itemCount,
    totalBytes: null,
    createdAt: deps.now(),
  });
  const run = new Run(deps, ctx);
  const done: JournalItemKind[] = [];
  let succeeded = 0;
  let fatal: FileoraError | null = null;
  try {
    await body(run, async (spec) => {
      const position = await deps.journal.addItem(ctx.operationId, {
        ...spec,
        destinationUri: spec.destinationUri ?? null,
        sha256: null,
        status: 'pending',
        errorCode: null,
      });
      return async (outcome) => {
        if (outcome.skipped) {
          run.skipped += 1;
          await deps.journal.updateItem(ctx.operationId, position, { status: 'skipped' });
          return;
        }
        if (outcome.ok) {
          succeeded += 1;
          done.push(spec.kind);
        }
        await deps.journal.updateItem(ctx.operationId, position, {
          status: outcome.ok ? 'done' : 'failed',
          destinationUri: outcome.destinationUri ?? null,
          errorCode: outcome.ok ? null : (run.failures[run.failures.length - 1]?.error.code ?? 'ERR_INTERNAL'),
        });
      };
    });
  } catch (error) {
    fatal = toFileoraError(error);
  } finally {
    run.dispose();
  }

  const anySuccess = succeeded > 0 || run.succeededUnits > 0;
  const status: OperationResult['status'] = fatal
    ? fatal.code === 'ERR_CANCELLED'
      ? 'cancelled'
      : anySuccess
        ? 'partial'
        : 'failed'
    : run.failures.length === 0
      ? 'completed'
      : anySuccess
        ? 'partial'
        : 'failed';
  const firstError = fatal ?? run.failures[0]?.error ?? null;
  await deps.journal.finish(ctx.operationId, {
    status,
    processedBytes: run.processedBytes,
    reversible: meta.type !== 'undo' && done.length > 0 && done.every((kind) => INVERTIBLE.has(kind)),
    errorCode: firstError?.code ?? null,
    errorMessage: firstError?.message ?? null,
  });
  return { status, failures: run.failures, skipped: run.skipped, error: firstError };
}

export type Destination = { uri: string; locationId: string | null };

export function runCopy(deps: EngineDeps, ctx: RunContext, roots: RootPlan[], destination: Destination, useTrash: boolean): Promise<OperationResult> {
  return execute(
    deps,
    ctx,
    { type: 'copy', title: describe('Copy', roots.map((r) => r.source)), locationId: destination.locationId, destinationUri: destination.uri, itemCount: roots.length },
    async (run, record) => {
      const trees: Tree[] = [];
      for (const root of roots) {
        run.phase('scanning', root.source.name);
        const tree = await scan(run, root.source);
        assertNotIntoItself(tree, destination.uri);
        trees.push(tree);
        run.planned(tree);
      }
      for (const [index, root] of roots.entries()) {
        const tree = trees[index];
        if (!tree) continue;
        const overwrite = await prepareReplace(run, root, destination, useTrash, record);
        if (overwrite === null) continue;
        const finish = await record({
          kind: 'copy',
          sourceUri: root.source.uri,
          sourceParentUri: root.source.parentUri,
          destinationParentUri: destination.uri,
          name: root.targetName,
          isDirectory: root.source.isDirectory,
          size: root.source.size,
        });
        const result = await copyTree(run, tree, destination.uri, root.targetName, overwrite);
        await finish({ ok: result.ok, destinationUri: result.entry?.uri ?? null });
      }
    },
  );
}

export function runMove(deps: EngineDeps, ctx: RunContext, roots: RootPlan[], destination: Destination, useTrash: boolean): Promise<OperationResult> {
  return execute(
    deps,
    ctx,
    { type: 'move', title: describe('Move', roots.map((r) => r.source)), locationId: destination.locationId, destinationUri: destination.uri, itemCount: roots.length },
    async (run, record) => {
      for (const root of roots) {
        const overwrite = await prepareReplace(run, root, destination, useTrash, record);
        if (overwrite === null) continue;
        const finish = await record({
          kind: 'move',
          sourceUri: root.source.uri,
          sourceParentUri: root.source.parentUri,
          destinationParentUri: destination.uri,
          name: root.source.name,
          isDirectory: root.source.isDirectory,
          size: root.source.size,
        });
        const result = await moveItem(run, root.source, destination.uri, root.targetName, overwrite);
        await finish({ ok: result.ok, destinationUri: result.entry?.uri ?? null });
      }
    },
  );
}

type RecordFn = (spec: ItemSpec) => Promise<(outcome: { ok: boolean; destinationUri?: string | null }) => Promise<void>>;

/**
 * For "replace": moves the existing destination file to trash so the replacement is recoverable.
 * Returns whether the copy must overwrite in place (trash disabled; the provider replaces the old file only
 * after the new data was fully written), or null when the item must be skipped because trashing failed.
 */
async function prepareReplace(run: Run, root: RootPlan, destination: Destination, useTrash: boolean, record: RecordFn): Promise<boolean | null> {
  if (!root.replace) return false;
  if (!useTrash) return true;
  const existing: SourceItem = {
    uri: root.replace.uri,
    parentUri: destination.uri,
    name: root.replace.name,
    isDirectory: root.replace.isDirectory,
    size: root.replace.size,
    mimeType: root.replace.mimeType,
    locationId: destination.locationId,
  };
  const finish = await record({
    kind: 'trash',
    sourceUri: existing.uri,
    sourceParentUri: existing.parentUri,
    destinationParentUri: run.deps.trashDirectoryUri(),
    name: existing.name,
    isDirectory: existing.isDirectory,
    size: existing.size,
  });
  const result = await sendToTrash(run, existing);
  await finish({ ok: result.ok, destinationUri: result.entry?.uri ?? null });
  // If the existing file could not be moved to trash, keep it: never discard data without a recovery path.
  return result.ok ? false : null;
}

export function runTrash(deps: EngineDeps, ctx: RunContext, items: SourceItem[]): Promise<OperationResult> {
  return execute(
    deps,
    ctx,
    { type: 'trash', title: describe('Move to Trash', items), locationId: items[0]?.locationId ?? null, destinationUri: deps.trashDirectoryUri(), itemCount: items.length },
    async (run, record) => {
      for (const item of items) {
        const finish = await record({
          kind: 'trash',
          sourceUri: item.uri,
          sourceParentUri: item.parentUri,
          destinationParentUri: deps.trashDirectoryUri(),
          name: item.name,
          isDirectory: item.isDirectory,
          size: item.size,
        });
        const result = await sendToTrash(run, item);
        await finish({ ok: result.ok, destinationUri: result.entry?.uri ?? null });
      }
    },
  );
}

export function runDelete(deps: EngineDeps, ctx: RunContext, items: SourceItem[], title?: string): Promise<OperationResult> {
  return execute(
    deps,
    ctx,
    { type: 'delete', title: title ?? describe('Delete permanently', items), locationId: items[0]?.locationId ?? null, destinationUri: null, itemCount: items.length },
    async (run, record) => {
      for (const item of items) {
        run.checkCancelled();
        const finish = await record({
          kind: 'delete',
          sourceUri: item.uri,
          sourceParentUri: item.parentUri,
          destinationParentUri: null,
          name: item.name,
          isDirectory: item.isDirectory,
          size: item.size,
        });
        let ok = false;
        try {
          run.phase('finishing', item.name);
          await run.storage.delete(item.uri);
          const trashed = await deps.journal.findTrashByUri(item.uri);
          if (trashed) await deps.journal.removeTrash(trashed.id);
          ok = true;
        } catch (error) {
          run.fail(item.name, error);
        }
        run.filesDone(item.isDirectory ? 0 : 1, item.size ?? 0);
        await finish({ ok });
      }
    },
  );
}

export function runRestore(deps: EngineDeps, ctx: RunContext, records: TrashRecord[]): Promise<OperationResult> {
  return execute(
    deps,
    ctx,
    { type: 'restore', title: describe('Restore', records), locationId: records[0]?.originalLocationId ?? null, destinationUri: null, itemCount: records.length },
    async (run, record) => {
      for (const trashed of records) {
        const finish = await record({
          kind: 'restore',
          sourceUri: trashed.trashUri,
          sourceParentUri: deps.trashDirectoryUri(),
          destinationParentUri: trashed.originalParentUri,
          name: trashed.name,
          isDirectory: trashed.isDirectory,
          size: trashed.size,
        });
        const result = await restoreOne(run, trashed);
        await finish({ ok: result.ok, destinationUri: result.entry?.uri ?? null });
      }
    },
  );
}

async function restoreOne(run: Run, trashed: TrashRecord): Promise<{ entry: RawEntry | null; ok: boolean }> {
  try {
    const parent = await run.storage.stat(trashed.originalParentUri);
    if (!parent?.isDirectory) {
      throw new FileoraError('ERR_NOT_FOUND', `The original folder of "${trashed.name}" is no longer available`);
    }
    const name = uniqueName(trashed.name, trashed.isDirectory, await takenNames(run.storage, trashed.originalParentUri));
    const source: SourceItem = {
      uri: trashed.trashUri,
      parentUri: run.deps.trashDirectoryUri(),
      name: trashed.name,
      isDirectory: trashed.isDirectory,
      size: trashed.size,
      mimeType: trashed.isDirectory ? null : mimeTypeFor(trashed.name),
      locationId: trashed.originalLocationId,
    };
    const result = await moveItem(run, source, trashed.originalParentUri, name, false);
    if (result.ok) await run.deps.journal.removeTrash(trashed.id);
    return result;
  } catch (error) {
    run.fail(trashed.name, error);
    return { entry: null, ok: false };
  }
}

export async function runRename(deps: EngineDeps, ctx: RunContext, item: SourceItem, newName: string): Promise<OperationResult & { entry: RawEntry | null }> {
  let entry: RawEntry | null = null;
  const result = await execute(
    deps,
    ctx,
    { type: 'rename', title: `Rename “${item.name}” to “${newName}”`, locationId: item.locationId, destinationUri: null, itemCount: 1 },
    async (run, record) => {
      const finish = await record({
        kind: 'rename',
        sourceUri: item.uri,
        sourceParentUri: item.parentUri,
        destinationParentUri: item.parentUri,
        name: item.name,
        isDirectory: item.isDirectory,
        size: item.size,
      });
      try {
        entry = await run.storage.rename(item.uri, newName);
        await finish({ ok: true, destinationUri: entry.uri });
      } catch (error) {
        run.fail(item.name, error);
        await finish({ ok: false });
      }
    },
  );
  return { ...result, entry };
}

export async function runCreateFolder(deps: EngineDeps, ctx: RunContext, parent: Destination, name: string): Promise<OperationResult & { entry: RawEntry | null }> {
  let entry: RawEntry | null = null;
  const result = await execute(
    deps,
    ctx,
    { type: 'createFolder', title: `New folder “${name}”`, locationId: parent.locationId, destinationUri: parent.uri, itemCount: 1 },
    async (run, record) => {
      const finish = await record({
        kind: 'mkdir',
        sourceUri: null,
        sourceParentUri: null,
        destinationParentUri: parent.uri,
        name,
        isDirectory: true,
        size: null,
      });
      try {
        entry = await run.storage.createDirectory(parent.uri, name);
        await finish({ ok: true, destinationUri: entry.uri });
      } catch (error) {
        run.fail(name, error);
        await finish({ ok: false });
      }
    },
  );
  return { ...result, entry };
}

/** Inverts the completed items of an operation, newest first. */
export function runUndo(deps: EngineDeps, ctx: RunContext, original: { id: string; title: string }, items: JournalItem[]): Promise<OperationResult> {
  const invertible = items.filter((item) => item.status === 'done' && INVERTIBLE.has(item.kind) && item.destinationUri).reverse();
  return execute(
    deps,
    ctx,
    { type: 'undo', title: `Undo: ${original.title}`, locationId: null, destinationUri: null, itemCount: invertible.length },
    async (run, record) => {
      if (invertible.length === 0) throw new FileoraError('ERR_UNSUPPORTED', 'Nothing in this operation can be undone');
      for (const item of invertible) {
        run.checkCancelled();
        await undoItem(run, record, item);
      }
      await deps.journal.linkUndo(original.id, ctx.operationId);
    },
  );
}

async function undoItem(
  run: Run,
  record: RecordFn,
  item: JournalItem,
): Promise<void> {
  const current = await run.storage.stat(item.destinationUri ?? '').catch(() => null);
  const asSource = (entry: RawEntry): SourceItem => ({
    uri: entry.uri,
    parentUri: item.destinationParentUri ?? '',
    name: entry.name,
    isDirectory: entry.isDirectory,
    size: entry.size,
    mimeType: entry.isDirectory ? null : mimeTypeFor(entry.name, entry.mimeType),
    locationId: null,
  });
  const missing = (name: string) =>
    run.fail(name, new FileoraError('ERR_NOT_FOUND', `"${name}" changed or was removed since this operation, so it was left as is`));

  switch (item.kind) {
    case 'copy': {
      const finish = await record({ kind: 'trash', sourceUri: item.destinationUri, sourceParentUri: item.destinationParentUri, destinationParentUri: run.deps.trashDirectoryUri(), name: current?.name ?? item.name, isDirectory: item.isDirectory, size: item.size });
      if (!current) {
        missing(item.name);
        await finish({ ok: false });
        return;
      }
      const result = await sendToTrash(run, asSource(current));
      await finish({ ok: result.ok, destinationUri: result.entry?.uri ?? null });
      return;
    }
    case 'move':
    case 'restore': {
      const finish = await record({ kind: 'move', sourceUri: item.destinationUri, sourceParentUri: item.destinationParentUri, destinationParentUri: item.sourceParentUri, name: item.name, isDirectory: item.isDirectory, size: item.size });
      if (!current || !item.sourceParentUri) {
        missing(item.name);
        await finish({ ok: false });
        return;
      }
      try {
        const name = uniqueName(item.name, item.isDirectory, await takenNames(run.storage, item.sourceParentUri));
        const result = await moveItem(run, asSource(current), item.sourceParentUri, name, false);
        if (result.ok && item.kind === 'restore') {
          // Undoing a restore puts the item back in trash; keep the trash index consistent.
          await run.deps.journal.addTrash({
            id: run.deps.newId().replace(/-/g, '').slice(0, 12),
            operationId: run.ctx.operationId,
            name: item.name,
            isDirectory: item.isDirectory,
            size: item.size,
            originalParentUri: item.destinationParentUri ?? '',
            originalLocationId: null,
            trashUri: result.entry?.uri ?? '',
            sha256: null,
            deletedAt: run.deps.now(),
          });
        }
        await finish({ ok: result.ok, destinationUri: result.entry?.uri ?? null });
      } catch (error) {
        run.fail(item.name, error);
        await finish({ ok: false });
      }
      return;
    }
    case 'trash': {
      const finish = await record({ kind: 'restore', sourceUri: item.destinationUri, sourceParentUri: item.destinationParentUri, destinationParentUri: item.sourceParentUri, name: item.name, isDirectory: item.isDirectory, size: item.size });
      const trashed = await run.deps.journal.findTrashByUri(item.destinationUri ?? '');
      if (!trashed || !current) {
        missing(item.name);
        await finish({ ok: false });
        return;
      }
      const result = await restoreOne(run, trashed);
      await finish({ ok: result.ok, destinationUri: result.entry?.uri ?? null });
      return;
    }
    case 'rename': {
      const finish = await record({ kind: 'rename', sourceUri: item.destinationUri, sourceParentUri: item.sourceParentUri, destinationParentUri: item.sourceParentUri, name: current?.name ?? item.name, isDirectory: item.isDirectory, size: item.size });
      if (!current) {
        missing(item.name);
        await finish({ ok: false });
        return;
      }
      try {
        const renamed = await run.storage.rename(current.uri, item.name);
        await finish({ ok: true, destinationUri: renamed.uri });
      } catch (error) {
        run.fail(item.name, error);
        await finish({ ok: false });
      }
      return;
    }
    case 'mkdir': {
      const finish = await record({ kind: 'delete', sourceUri: item.destinationUri, sourceParentUri: item.destinationParentUri, destinationParentUri: null, name: item.name, isDirectory: true, size: null });
      try {
        if (!current) throw new FileoraError('ERR_NOT_FOUND', `"${item.name}" no longer exists`);
        if ((await run.storage.listChildren(current.uri)).length > 0) {
          throw new FileoraError('ERR_UNSUPPORTED', `"${item.name}" is no longer empty, so it was kept`);
        }
        await run.storage.delete(current.uri);
        await finish({ ok: true });
      } catch (error) {
        run.fail(item.name, error);
        await finish({ ok: false });
      }
      return;
    }
    case 'delete':
      return;
  }
}

function describe(verb: string, items: readonly { name: string }[]): string {
  const first = items[0];
  if (!first) return verb;
  return items.length === 1 ? `${verb} “${first.name}”` : `${verb} ${items.length} items`;
}

/**
 * Computes destination names for a batch, given the user's conflict choice.
 * Copying into the item's own folder always keeps both; moving into its own folder is a no-op.
 */
export async function planRoots(
  storage: StorageProvider,
  mode: 'copy' | 'move',
  items: SourceItem[],
  destinationUri: string,
  resolution: 'keepBoth' | 'replace' | 'skip',
): Promise<{ roots: RootPlan[]; skipped: SourceItem[]; unchanged: SourceItem[] }> {
  const existing = await storage.listChildren(destinationUri);
  const byKey = new Map(existing.map((entry) => [nameKey(entry.name), entry]));
  const taken = new Set(byKey.keys());
  const roots: RootPlan[] = [];
  const skipped: SourceItem[] = [];
  const unchanged: SourceItem[] = [];
  for (const item of items) {
    if (item.parentUri === destinationUri) {
      if (mode === 'move') unchanged.push(item);
      else roots.push({ source: item, targetName: uniqueName(item.name, item.isDirectory, taken), replace: null });
      continue;
    }
    const clash = byKey.get(nameKey(item.name));
    if (!clash) {
      taken.add(nameKey(item.name));
      roots.push({ source: item, targetName: item.name, replace: null });
      continue;
    }
    if (resolution === 'skip') {
      skipped.push(item);
    } else if (resolution === 'replace' && !item.isDirectory && !clash.isDirectory) {
      roots.push({ source: item, targetName: item.name, replace: clash });
    } else {
      roots.push({ source: item, targetName: uniqueName(item.name, item.isDirectory, taken), replace: null });
    }
  }
  return { roots, skipped, unchanged };
}

/** Names in `items` that already exist in the destination (case-insensitive). */
export async function findConflicts(storage: StorageProvider, items: SourceItem[], destinationUri: string): Promise<SourceItem[]> {
  const existing = await takenNames(storage, destinationUri);
  return items.filter((item) => item.parentUri !== destinationUri && existing.has(nameKey(item.name)));
}
