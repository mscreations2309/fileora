import { FileoraError } from '@/core/errors/FileoraError';
import type { CopiedEntry, RawEntry, StorageProvider, TransferProgress } from '@/core/storage/types';
import { nameKey } from '@/features/file_operations/conflicts';
import type { Journal, JournalItem, OperationRecord, TrashRecord } from '@/features/file_operations/types';

type Node = { name: string; content: string | null; children: Map<string, string> | null; modifiedAt: number };

/**
 * In-memory `file://` filesystem implementing StorageProvider, with fault injection,
 * for exercising the operation engine without devices.
 */
export class MemoryStorage implements StorageProvider {
  readonly name = 'memory';
  readonly capabilities = {
    reportsProgress: true,
    verifiesCopies: false,
    cancellableTransfers: true,
    persistentFolderGrants: true,
    volumeBrowsing: true,
  };
  private readonly nodes = new Map<string, Node>();
  private readonly listeners = new Set<(p: TransferProgress) => void>();
  private readonly cancelled = new Set<string>();
  fastMoves = true;
  failCopyNames = new Set<string>();
  corruptCopyNames = new Set<string>();
  noSpaceAfterCopies: number | null = null;
  onBeforeCopy: ((name: string) => void) | null = null;
  copies = 0;

  constructor() {
    this.nodes.set('file:///root', { name: 'root', content: null, children: new Map(), modifiedAt: 0 });
  }

  /** Creates folders/files from a spec: { 'a/b.txt': 'content', 'empty/': null }. */
  seed(spec: Record<string, string | null>): void {
    for (const [path, content] of Object.entries(spec)) {
      const parts = path.split('/').filter(Boolean);
      let parent = 'file:///root';
      parts.forEach((part, index) => {
        const isLast = index === parts.length - 1;
        const uri = `${parent}/${encodeURIComponent(part)}`;
        if (!this.nodes.has(uri)) {
          const isFile = isLast && !path.endsWith('/');
          this.attach(parent, uri, { name: part, content: isFile ? (content ?? '') : null, children: isFile ? null : new Map(), modifiedAt: 1 });
        }
        parent = uri;
      });
    }
  }

  uriOf(path: string): string {
    return `file:///root${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`;
  }

  read(path: string): string | null {
    return this.nodes.get(this.uriOf(path))?.content ?? null;
  }

  exists(path: string): boolean {
    return this.nodes.has(this.uriOf(path));
  }

  names(path: string): string[] {
    const node = this.nodes.get(this.uriOf(path));
    return node?.children ? [...node.children.values()].map((uri) => this.nodes.get(uri)?.name ?? '').sort() : [];
  }

  private attach(parentUri: string, uri: string, node: Node): void {
    const parent = this.nodes.get(parentUri);
    if (!parent?.children) throw new FileoraError('ERR_NOT_FOUND', 'parent missing');
    parent.children.set(nameKey(node.name), uri);
    this.nodes.set(uri, node);
  }

  private require(uri: string): Node {
    const node = this.nodes.get(uri);
    if (!node) throw new FileoraError('ERR_NOT_FOUND', `missing ${uri}`);
    return node;
  }

  private entry(uri: string): RawEntry {
    const node = this.require(uri);
    return {
      name: node.name,
      uri,
      isDirectory: node.children !== null,
      size: node.content === null ? null : node.content.length,
      modifiedAt: node.modifiedAt,
      mimeType: null,
      childCount: node.children?.size ?? null,
      isHidden: node.name.startsWith('.'),
      canWrite: true,
      canDelete: true,
      canRename: true,
      canMove: true,
    };
  }

  private parentOf(uri: string): string {
    return uri.slice(0, uri.lastIndexOf('/'));
  }

  private detach(uri: string): void {
    const node = this.require(uri);
    this.nodes.get(this.parentOf(uri))?.children?.delete(nameKey(node.name));
    for (const key of [...this.nodes.keys()]) if (key === uri || key.startsWith(`${uri}/`)) this.nodes.delete(key);
  }

  private childUri(parentUri: string, name: string): string {
    const parent = this.require(parentUri);
    if (!parent.children) throw new FileoraError('ERR_UNSUPPORTED', 'not a folder');
    if (parent.children.has(nameKey(name))) throw new FileoraError('ERR_ALREADY_EXISTS', name);
    return `${parentUri}/${encodeURIComponent(name)}`;
  }

  async listChildren(uri: string): Promise<RawEntry[]> {
    const node = this.require(uri);
    if (!node.children) throw new FileoraError('ERR_UNSUPPORTED', 'not a folder');
    return [...node.children.values()].map((child) => this.entry(child));
  }

  async stat(uri: string): Promise<RawEntry | null> {
    return this.nodes.has(uri) ? this.entry(uri) : null;
  }

  async createDirectory(parentUri: string, name: string): Promise<RawEntry> {
    const uri = this.childUri(parentUri, name);
    this.attach(parentUri, uri, { name, content: null, children: new Map(), modifiedAt: 2 });
    return this.entry(uri);
  }

  async rename(uri: string, newName: string): Promise<RawEntry> {
    const node = this.require(uri);
    const parentUri = this.parentOf(uri);
    const target = this.childUri(parentUri, newName);
    this.relocate(uri, parentUri, target, newName, node);
    return this.entry(target);
  }

  private relocate(uri: string, parentUri: string, target: string, newName: string, node: Node): void {
    const moved = [...this.nodes.entries()].filter(([key]) => key === uri || key.startsWith(`${uri}/`));
    this.detach(uri);
    for (const [key, value] of moved) {
      const newKey = target + key.slice(uri.length);
      this.nodes.set(newKey, key === uri ? { ...value, name: newName } : value);
      if (value.children) {
        const remapped = new Map<string, string>();
        for (const [k, childUri] of value.children) remapped.set(k, target + childUri.slice(uri.length));
        value.children = remapped;
      }
    }
    this.nodes.get(parentUri)?.children?.set(nameKey(newName), target);
    void node;
  }

  async delete(uri: string): Promise<void> {
    this.detach(uri);
  }

  async copyFile(operationId: string, sourceUri: string, destinationParentUri: string, name: string, _mime: string | null, overwrite: boolean): Promise<CopiedEntry> {
    this.onBeforeCopy?.(name);
    if (this.cancelled.has(operationId)) throw new FileoraError('ERR_CANCELLED', 'cancelled');
    const source = this.require(sourceUri);
    if (source.content === null) throw new FileoraError('ERR_UNSUPPORTED', 'not a file');
    if (this.failCopyNames.has(source.name)) throw new FileoraError('ERR_IO', 'injected failure');
    if (this.noSpaceAfterCopies !== null && this.copies >= this.noSpaceAfterCopies) throw new FileoraError('ERR_NO_SPACE', 'full');
    const parent = this.require(destinationParentUri);
    const existing = parent.children?.get(nameKey(name));
    if (existing && !overwrite) throw new FileoraError('ERR_ALREADY_EXISTS', name);
    if (existing) this.detach(existing);
    const uri = this.childUri(destinationParentUri, name);
    const content = this.corruptCopyNames.has(source.name) ? `${source.content}!` : source.content;
    this.attach(destinationParentUri, uri, { name, content, children: null, modifiedAt: 3 });
    this.copies += 1;
    this.listeners.forEach((l) => l({ operationId, bytesProcessed: content.length, totalBytes: source.content?.length ?? null }));
    return { ...this.entry(uri), sha256: `sha:${source.content}` };
  }

  async tryFastMove(sourceUri: string, _sourceParentUri: string, destinationParentUri: string, name: string): Promise<RawEntry | null> {
    if (!this.fastMoves) return null;
    const node = this.require(sourceUri);
    const target = this.childUri(destinationParentUri, name);
    this.relocate(sourceUri, destinationParentUri, target, name, node);
    return this.entry(target);
  }

  async hash(uri: string): Promise<string> {
    return `sha:${this.require(uri).content ?? ''}`;
  }

  cancel(operationId: string): void {
    this.cancelled.add(operationId);
  }

  onProgress(listener: (p: TransferProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class MemoryJournal implements Journal {
  operations = new Map<string, OperationRecord>();
  items = new Map<string, JournalItem[]>();
  trash = new Map<string, TrashRecord>();

  async begin(record: Parameters<Journal['begin']>[0]): Promise<void> {
    this.operations.set(record.id, {
      ...record,
      status: 'running',
      processedBytes: 0,
      reversible: false,
      undoOperationId: null,
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
    });
    this.items.set(record.id, []);
  }

  async addItem(operationId: string, item: Omit<JournalItem, 'position'>): Promise<number> {
    const list = this.items.get(operationId) ?? [];
    list.push({ ...item, position: list.length });
    this.items.set(operationId, list);
    return list.length - 1;
  }

  async updateItem(operationId: string, position: number, patch: Partial<JournalItem>): Promise<void> {
    const item = this.items.get(operationId)?.[position];
    if (!item) return;
    if (patch.status) item.status = patch.status;
    if (patch.destinationUri) item.destinationUri = patch.destinationUri;
    if (patch.errorCode) item.errorCode = patch.errorCode;
  }

  async finish(operationId: string, patch: Parameters<Journal['finish']>[1]): Promise<void> {
    const record = this.operations.get(operationId);
    if (record) Object.assign(record, patch, { finishedAt: 1 });
  }

  async linkUndo(operationId: string, undoOperationId: string): Promise<void> {
    const record = this.operations.get(operationId);
    if (record) Object.assign(record, { undoOperationId, reversible: false });
  }

  async addTrash(record: TrashRecord): Promise<void> {
    this.trash.set(record.id, record);
  }

  async removeTrash(id: string): Promise<void> {
    this.trash.delete(id);
  }

  async findTrashByUri(trashUri: string): Promise<TrashRecord | null> {
    return [...this.trash.values()].find((r) => r.trashUri === trashUri) ?? null;
  }
}
