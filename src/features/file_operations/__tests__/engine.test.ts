import { MemoryJournal, MemoryStorage } from '@/test/memoryStorage';

import {
  findConflicts,
  planRoots,
  runCopy,
  runCreateFolder,
  runDelete,
  runMove,
  runRename,
  runRestore,
  runTrash,
  runUndo,
  type EngineDeps,
  type RunContext,
} from '../engine';
import type { SourceItem } from '../types';

let ids = 0;

function setup(spec: Record<string, string | null>) {
  const storage = new MemoryStorage();
  storage.seed({ '.trash/': null, ...spec });
  const journal = new MemoryJournal();
  const deps: EngineDeps = {
    storage,
    journal,
    trashDirectoryUri: () => storage.uriOf('.trash'),
    newId: () => `id-${(ids += 1)}`,
    now: () => 1000,
  };
  return { storage, journal, deps };
}

function ctx(operationId = `op-${(ids += 1)}`, cancelled = () => false): RunContext {
  return { operationId, isCancelled: cancelled, onProgress: () => undefined };
}

async function item(storage: MemoryStorage, path: string): Promise<SourceItem> {
  const uri = storage.uriOf(path);
  const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const entry = await storage.stat(uri);
  if (!entry) throw new Error(`missing ${path}`);
  return {
    uri,
    parentUri: storage.uriOf(parentPath),
    name: entry.name,
    isDirectory: entry.isDirectory,
    size: entry.size,
    mimeType: null,
    locationId: 'test',
  };
}

describe('copy', () => {
  it('copies a folder tree and journals a reversible operation', async () => {
    const { storage, journal, deps } = setup({ 'src/a.txt': 'A', 'src/sub/b.txt': 'BB', 'dest/': null });
    const source = await item(storage, 'src');
    const { roots } = await planRoots(storage, 'copy', [source], storage.uriOf('dest'), 'keepBoth');
    const c = ctx();
    const result = await runCopy(deps, c, roots, { uri: storage.uriOf('dest'), locationId: 'test' }, true);

    expect(result.status).toBe('completed');
    expect(storage.read('dest/src/a.txt')).toBe('A');
    expect(storage.read('dest/src/sub/b.txt')).toBe('BB');
    expect(storage.read('src/a.txt')).toBe('A');
    expect(journal.operations.get(c.operationId)?.reversible).toBe(true);
  });

  it('keeps both when copying into the same folder', async () => {
    const { storage, deps } = setup({ 'docs/report.pdf': 'R' });
    const source = await item(storage, 'docs/report.pdf');
    const { roots } = await planRoots(storage, 'copy', [source], storage.uriOf('docs'), 'keepBoth');
    expect(roots[0]?.targetName).toBe('report (1).pdf');
    await runCopy(deps, ctx(), roots, { uri: storage.uriOf('docs'), locationId: 'test' }, true);
    expect(storage.names('docs')).toEqual(['report (1).pdf', 'report.pdf']);
  });

  it('reports partial success and keeps going when one file fails', async () => {
    const { storage, deps } = setup({ 'src/ok.txt': 'ok', 'src/bad.txt': 'bad', 'src/ok2.txt': 'ok2', 'dest/': null });
    storage.failCopyNames.add('bad.txt');
    const { roots } = await planRoots(storage, 'copy', [await item(storage, 'src')], storage.uriOf('dest'), 'keepBoth');
    const result = await runCopy(deps, ctx(), roots, { uri: storage.uriOf('dest'), locationId: 'test' }, true);

    expect(result.status).toBe('partial');
    expect(result.failures.map((f) => f.name)).toEqual(['bad.txt']);
    expect(storage.read('dest/src/ok.txt')).toBe('ok');
    expect(storage.read('dest/src/ok2.txt')).toBe('ok2');
    expect(storage.read('src/bad.txt')).toBe('bad');
  });

  it('refuses to copy a folder into itself', async () => {
    const { storage, deps } = setup({ 'src/inner/': null });
    const roots = [{ source: await item(storage, 'src'), targetName: 'src', replace: null }];
    const result = await runCopy(deps, ctx(), roots, { uri: storage.uriOf('src/inner'), locationId: 'test' }, true);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('ERR_UNSUPPORTED');
    expect(storage.exists('src/inner/src')).toBe(false);
  });

  it('aborts on a full destination and reports what finished', async () => {
    const { storage, deps } = setup({ 'src/1.txt': '1', 'src/2.txt': '2', 'src/3.txt': '3', 'dest/': null });
    storage.noSpaceAfterCopies = 1;
    const { roots } = await planRoots(storage, 'copy', [await item(storage, 'src')], storage.uriOf('dest'), 'keepBoth');
    const result = await runCopy(deps, ctx(), roots, { uri: storage.uriOf('dest'), locationId: 'test' }, true);
    expect(result.error?.code).toBe('ERR_NO_SPACE');
    expect(result.status).toBe('partial');
    expect(storage.names('dest/src')).toHaveLength(1);
  });

  it('stops when cancelled, keeping completed files', async () => {
    const { storage, deps } = setup({ 'src/1.txt': '1', 'src/2.txt': '2', 'dest/': null });
    let cancelled = false;
    storage.onBeforeCopy = (name) => {
      if (name === '2.txt') cancelled = true;
    };
    const { roots } = await planRoots(storage, 'copy', [await item(storage, 'src')], storage.uriOf('dest'), 'keepBoth');
    const c = ctx(undefined, () => cancelled);
    storage.onBeforeCopy = (name) => {
      if (name === '2.txt') storage.cancel(c.operationId);
    };
    const result = await runCopy(deps, c, roots, { uri: storage.uriOf('dest'), locationId: 'test' }, true);
    expect(result.status).toBe('cancelled');
    expect(storage.read('dest/src/1.txt')).toBe('1');
    expect(storage.exists('dest/src/2.txt')).toBe(false);
  });

  it('replaces by moving the existing file to trash first', async () => {
    const { storage, journal, deps } = setup({ 'a/note.txt': 'new', 'b/note.txt': 'old' });
    const sourceItem = await item(storage, 'a/note.txt');
    expect(await findConflicts(storage, [sourceItem], storage.uriOf('b'))).toHaveLength(1);
    const { roots } = await planRoots(storage, 'copy', [sourceItem], storage.uriOf('b'), 'replace');
    const result = await runCopy(deps, ctx(), roots, { uri: storage.uriOf('b'), locationId: 'test' }, true);
    expect(result.status).toBe('completed');
    expect(storage.read('b/note.txt')).toBe('new');
    expect([...journal.trash.values()].map((t) => t.name)).toEqual(['note.txt']);
  });
});

describe('move', () => {
  it('uses copy → verify → delete when a fast move is impossible', async () => {
    const { storage, deps } = setup({ 'src/a.txt': 'A', 'src/sub/b.txt': 'B', 'dest/': null });
    storage.fastMoves = false;
    const { roots } = await planRoots(storage, 'move', [await item(storage, 'src')], storage.uriOf('dest'), 'keepBoth');
    const result = await runMove(deps, ctx(), roots, { uri: storage.uriOf('dest'), locationId: 'test' }, true);
    expect(result.status).toBe('completed');
    expect(storage.exists('src')).toBe(false);
    expect(storage.read('dest/src/sub/b.txt')).toBe('B');
  });

  it('keeps the source when verification fails', async () => {
    const { storage, deps } = setup({ 'src/a.txt': 'A', 'src/b.txt': 'B', 'dest/': null });
    storage.fastMoves = false;
    storage.corruptCopyNames.add('b.txt');
    const { roots } = await planRoots(storage, 'move', [await item(storage, 'src')], storage.uriOf('dest'), 'keepBoth');
    const result = await runMove(deps, ctx(), roots, { uri: storage.uriOf('dest'), locationId: 'test' }, true);

    expect(result.status).toBe('partial');
    expect(result.failures[0]?.error.code).toBe('ERR_VERIFICATION_FAILED');
    expect(storage.read('src/b.txt')).toBe('B');
    expect(storage.exists('dest/src/b.txt')).toBe(false);
    expect(storage.exists('src/a.txt')).toBe(false);
    expect(storage.read('dest/src/a.txt')).toBe('A');
  });

  it('treats moving into the same folder as a no-op', async () => {
    const { storage } = setup({ 'docs/a.txt': 'A' });
    const plan = await planRoots(storage, 'move', [await item(storage, 'docs/a.txt')], storage.uriOf('docs'), 'keepBoth');
    expect(plan.roots).toHaveLength(0);
    expect(plan.unchanged).toHaveLength(1);
  });

  it('undoes a move back to the original folder', async () => {
    const { storage, journal, deps } = setup({ 'src/a.txt': 'A', 'dest/': null });
    const c = ctx();
    const { roots } = await planRoots(storage, 'move', [await item(storage, 'src/a.txt')], storage.uriOf('dest'), 'keepBoth');
    await runMove(deps, c, roots, { uri: storage.uriOf('dest'), locationId: 'test' }, true);
    expect(storage.exists('dest/a.txt')).toBe(true);

    const undo = await runUndo(deps, ctx(), { id: c.operationId, title: 'Move' }, journal.items.get(c.operationId) ?? []);
    expect(undo.status).toBe('completed');
    expect(storage.read('src/a.txt')).toBe('A');
    expect(journal.operations.get(c.operationId)?.reversible).toBe(false);
  });
});

describe('trash and restore', () => {
  it('moves items to trash and restores them to their original folder', async () => {
    const { storage, journal, deps } = setup({ 'docs/a.txt': 'A' });
    const result = await runTrash(deps, ctx(), [await item(storage, 'docs/a.txt')]);
    expect(result.status).toBe('completed');
    expect(storage.exists('docs/a.txt')).toBe(false);
    const records = [...journal.trash.values()];
    expect(records).toHaveLength(1);

    const restored = await runRestore(deps, ctx(), records);
    expect(restored.status).toBe('completed');
    expect(storage.read('docs/a.txt')).toBe('A');
    expect(journal.trash.size).toBe(0);
  });

  it('restores with a new name when the original name is taken', async () => {
    const { storage, journal, deps } = setup({ 'docs/a.txt': 'old' });
    await runTrash(deps, ctx(), [await item(storage, 'docs/a.txt')]);
    storage.seed({ 'docs/a.txt': 'newer' });
    await runRestore(deps, ctx(), [...journal.trash.values()]);
    expect(storage.read('docs/a.txt')).toBe('newer');
    expect(storage.read('docs/a (1).txt')).toBe('old');
  });

  it('fails clearly when the original folder is gone', async () => {
    const { storage, journal, deps } = setup({ 'docs/a.txt': 'A' });
    await runTrash(deps, ctx(), [await item(storage, 'docs/a.txt')]);
    await storage.delete(storage.uriOf('docs'));
    const result = await runRestore(deps, ctx(), [...journal.trash.values()]);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('ERR_NOT_FOUND');
    expect(journal.trash.size).toBe(1);
  });

  it('marks permanent deletion as irreversible', async () => {
    const { storage, journal, deps } = setup({ 'docs/a.txt': 'A' });
    const c = ctx();
    const result = await runDelete(deps, c, [await item(storage, 'docs/a.txt')]);
    expect(result.status).toBe('completed');
    expect(storage.exists('docs/a.txt')).toBe(false);
    expect(journal.operations.get(c.operationId)?.reversible).toBe(false);
  });
});

describe('rename and folders', () => {
  it('renames and undoes the rename', async () => {
    const { storage, journal, deps } = setup({ 'docs/a.txt': 'A' });
    const c = ctx();
    const renamed = await runRename(deps, c, await item(storage, 'docs/a.txt'), 'b.txt');
    expect(renamed.status).toBe('completed');
    expect(storage.read('docs/b.txt')).toBe('A');
    await runUndo(deps, ctx(), { id: c.operationId, title: 'Rename' }, journal.items.get(c.operationId) ?? []);
    expect(storage.read('docs/a.txt')).toBe('A');
  });

  it('reports a name clash on rename without touching either file', async () => {
    const { storage, deps } = setup({ 'docs/a.txt': 'A', 'docs/b.txt': 'B' });
    const result = await runRename(deps, ctx(), await item(storage, 'docs/a.txt'), 'b.txt');
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('ERR_ALREADY_EXISTS');
    expect(storage.read('docs/a.txt')).toBe('A');
    expect(storage.read('docs/b.txt')).toBe('B');
  });

  it('only undoes folder creation while the folder is still empty', async () => {
    const { storage, journal, deps } = setup({ 'docs/': null });
    const c = ctx();
    await runCreateFolder(deps, c, { uri: storage.uriOf('docs'), locationId: 'test' }, 'New');
    storage.seed({ 'docs/New/keep.txt': 'K' });
    const undo = await runUndo(deps, ctx(), { id: c.operationId, title: 'New folder' }, journal.items.get(c.operationId) ?? []);
    expect(undo.status).toBe('failed');
    expect(storage.read('docs/New/keep.txt')).toBe('K');
  });
});
