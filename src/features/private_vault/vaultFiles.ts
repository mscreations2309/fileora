import { AESSealedData, aesDecryptAsync, aesEncryptAsync, randomUUID, type AESEncryptionKey } from 'expo-crypto';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { FileoraStorage } from 'fileora-storage';
import { create } from 'zustand';

import { getDatabase } from '@/core/database/database';
import { FileoraError, toFileoraError } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';
import { fromBase64, fromUtf8, toBase64, utf8 } from '@/core/security/bytes';
import { categorize, mimeTypeFor } from '@/core/storage/fileTypes';
import { storage } from '@/core/storage/storage';
import type { FileCategory } from '@/core/storage/types';

import { useVault } from './vaultKeys';

/**
 * Encrypted blob format (".fvault"):
 *   magic "FVLT1\n" (6 bytes)
 *   repeated chunks: [u32 big-endian length][AES-GCM combined: 12-byte IV | ciphertext | 16-byte tag]
 * Each chunk's additional authenticated data is "<entryId>:<index>:<last 0|1>", so chunks cannot be
 * reordered, swapped between files, or truncated without failing authentication.
 */
const MAGIC = utf8('FVLT1\n');
export const CHUNK_SIZE = 1024 * 1024;

export type VaultEntry = {
  id: string;
  name: string;
  category: FileCategory;
  size: number;
  chunkCount: number;
  sha256: string;
  collection: string;
  createdAt: number;
};

export const useVaultRevision = create<{ revision: number; bump: () => void }>()((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

function vaultDirectory(): Directory {
  const directory = new Directory(Paths.document, '.vault');
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  return directory;
}

function viewDirectory(): Directory {
  const directory = new Directory(Paths.cache, 'vault-view');
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  return directory;
}

function requireKey(): AESEncryptionKey {
  const { key } = useVault.getState();
  if (!key) throw new FileoraError('ERR_ACCESS_DENIED', 'The vault is locked');
  return key;
}

function blobFile(id: string): File {
  return new File(vaultDirectory(), `${id}.fvault`);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function readU32(bytes: Uint8Array): number {
  return (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
}

async function sealName(key: AESEncryptionKey, id: string, name: string): Promise<string> {
  const sealed = await aesEncryptAsync(utf8(name), key, { additionalData: utf8(`name:${id}`) });
  return toBase64(await sealed.combined());
}

async function openName(key: AESEncryptionKey, id: string, sealedName: string): Promise<string> {
  const plain = await aesDecryptAsync(AESSealedData.fromCombined(fromBase64(sealedName)), key, { additionalData: utf8(`name:${id}`) });
  return fromUtf8(plain);
}

/** Streams `source` into an encrypted blob. Plaintext is never written to disk. */
async function encryptStream(key: AESEncryptionKey, id: string, readChunk: () => Promise<Uint8Array>, target: File, onProgress?: (bytes: number) => void): Promise<number> {
  if (target.exists) target.delete();
  target.create();
  const out = target.open(FileMode.WriteOnly);
  let chunks = 0;
  let processed = 0;
  try {
    out.writeBytesSync(MAGIC);
    let current = await readChunk();
    for (;;) {
      const next = current.length === CHUNK_SIZE ? await readChunk() : new Uint8Array(0);
      const last = next.length === 0;
      const sealed = await aesEncryptAsync(current, key, { additionalData: utf8(`${id}:${chunks}:${last ? 1 : 0}`) });
      const combined = await sealed.combined();
      await out.writeBytes(u32(combined.length));
      await out.writeBytes(combined);
      chunks += 1;
      processed += current.length;
      onProgress?.(processed);
      if (last) break;
      current = next;
    }
  } finally {
    out.close();
  }
  return chunks;
}

/** Decrypts a blob chunk by chunk, handing plaintext to `sink`. Fails on any tampering or truncation. */
async function decryptStream(key: AESEncryptionKey, id: string, source: File, sink: (plain: Uint8Array, last: boolean) => Promise<void> | void): Promise<number> {
  const input = source.open(FileMode.ReadOnly);
  let index = 0;
  let total = 0;
  try {
    const magic = input.readBytesSync(MAGIC.length);
    if (fromUtf8(magic) !== 'FVLT1\n') throw new FileoraError('ERR_VERIFICATION_FAILED', 'Not a Fileora vault file');
    const size = input.size ?? 0;
    for (;;) {
      const header = input.readBytesSync(4);
      if (header.length < 4) throw new FileoraError('ERR_VERIFICATION_FAILED', 'Encrypted file is truncated');
      const length = readU32(header);
      if (length > CHUNK_SIZE + 64) throw new FileoraError('ERR_VERIFICATION_FAILED', 'Encrypted file is damaged');
      const combined = await input.readBytes(length);
      if (combined.length !== length) throw new FileoraError('ERR_VERIFICATION_FAILED', 'Encrypted file is truncated');
      const last = (input.offset ?? 0) >= size;
      let plain: Uint8Array;
      try {
        plain = await aesDecryptAsync(AESSealedData.fromCombined(combined), key, { additionalData: utf8(`${id}:${index}:${last ? 1 : 0}`) });
      } catch {
        throw new FileoraError('ERR_VERIFICATION_FAILED', 'Encrypted file failed its integrity check');
      }
      await sink(plain, last);
      total += plain.length;
      index += 1;
      if (last) break;
    }
  } finally {
    input.close();
  }
  return total;
}

/** Streams a blob from one key/id to another without holding more than one chunk in memory. */
async function transcode(fromKey: AESEncryptionKey, fromId: string, source: File, toKey: AESEncryptionKey, toId: string, target: File): Promise<number> {
  if (target.exists) target.delete();
  target.create();
  const out = target.open(FileMode.WriteOnly);
  let index = 0;
  try {
    out.writeBytesSync(MAGIC);
    await decryptStream(fromKey, fromId, source, async (plain, last) => {
      const sealed = await aesEncryptAsync(plain, toKey, { additionalData: utf8(`${toId}:${index}:${last ? 1 : 0}`) });
      const combined = await sealed.combined();
      await out.writeBytes(u32(combined.length));
      await out.writeBytes(combined);
      index += 1;
    });
  } catch (error) {
    out.close();
    target.delete();
    throw error;
  }
  out.close();
  return index;
}

function sourceReader(uri: string): { read: () => Promise<Uint8Array>; close: () => void } {
  const handle = new File(uri).open(FileMode.ReadOnly);
  return {
    read: async () => {
      // Fill a full chunk even if the provider returns short reads.
      const parts: Uint8Array[] = [];
      let length = 0;
      while (length < CHUNK_SIZE) {
        const part = await handle.readBytes(CHUNK_SIZE - length);
        if (part.length === 0) break;
        parts.push(part);
        length += part.length;
      }
      if (parts.length === 1 && parts[0]) return parts[0];
      const out = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    },
    close: () => handle.close(),
  };
}

export async function listVault(): Promise<VaultEntry[]> {
  const key = requireKey();
  const rows = await getDatabase().getAllAsync<{ id: string; sealed_name: string; category: string; size: number; chunk_count: number; sha256: string; collection: string; created_at: number }>(
    'SELECT * FROM vault_entries ORDER BY created_at DESC',
  );
  const entries: VaultEntry[] = [];
  for (const row of rows) {
    let name = 'Unreadable item';
    try {
      name = await openName(key, row.id, row.sealed_name);
    } catch {
      logger.warn('vault', 'An entry name could not be decrypted');
    }
    entries.push({ id: row.id, name, category: row.category as FileCategory, size: row.size, chunkCount: row.chunk_count, sha256: row.sha256, collection: row.collection, createdAt: row.created_at });
  }
  return entries;
}

/**
 * Encrypts a file into the vault, verifies the blob by decrypting it fully, and records it.
 * The original is left untouched; the caller asks whether to delete it.
 */
export async function importToVault(source: { uri: string; name: string; size: number | null; mimeType: string | null }, onProgress?: (bytes: number) => void): Promise<VaultEntry> {
  const key = requireKey();
  const id = randomUUID();
  const target = blobFile(id);
  try {
    const sha256 = await storage.hash(source.uri);
    const reader = sourceReader(source.uri);
    let chunks: number;
    try {
      chunks = await encryptStream(key, id, reader.read, target, onProgress);
    } finally {
      reader.close();
    }
    const size = await decryptStream(key, id, target, () => undefined);
    const mimeType = mimeTypeFor(source.name, source.mimeType);
    const entry: VaultEntry = { id, name: source.name, category: categorize(source.name, false, mimeType), size, chunkCount: chunks, sha256, collection: '', createdAt: Date.now() };
    await getDatabase().runAsync(
      'INSERT INTO vault_entries (id, sealed_name, category, size, chunk_count, sha256, collection, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      await sealName(key, id, source.name),
      entry.category,
      size,
      chunks,
      sha256,
      '',
      entry.createdAt,
    );
    useVaultRevision.getState().bump();
    return entry;
  } catch (error) {
    if (target.exists) target.delete();
    throw toFileoraError(error);
  }
}

async function decryptToFile(entry: VaultEntry, target: File): Promise<void> {
  const key = requireKey();
  if (target.exists) target.delete();
  target.create();
  const out = target.open(FileMode.WriteOnly);
  try {
    await decryptStream(key, entry.id, blobFile(entry.id), async (plain) => {
      await out.writeBytes(plain);
    });
  } catch (error) {
    out.close();
    target.delete();
    throw toFileoraError(error);
  }
  out.close();
}

/**
 * Decrypts to a temporary file for viewing in another app. Temporary copies live in Fileora's cache
 * and are deleted when the vault locks or Fileora starts. Another app could keep its own copy.
 */
export async function decryptForViewing(entry: VaultEntry): Promise<File> {
  const folder = new Directory(viewDirectory(), entry.id);
  if (!folder.exists) folder.create({ idempotent: true });
  const target = new File(folder, entry.name);
  await decryptToFile(entry, target);
  return target;
}

export function clearViewingCopies(): void {
  try {
    const directory = new Directory(Paths.cache, 'vault-view');
    if (directory.exists) directory.delete();
  } catch (error) {
    logger.warn('vault', 'Could not remove temporary vault files', error);
  }
}

/** Exports a decrypted copy into a folder and verifies it against the original SHA-256. */
export async function exportFromVault(entry: VaultEntry, destinationFolderUri: string): Promise<void> {
  const temp = await decryptForViewing(entry);
  try {
    const operationId = randomUUID();
    const copied = await storage.copyFile(operationId, temp.uri, destinationFolderUri, entry.name, mimeTypeFor(entry.name), false);
    const hash = copied.sha256 ?? (await storage.hash(copied.uri));
    if (hash !== entry.sha256) {
      await storage.delete(copied.uri).catch(() => undefined);
      throw new FileoraError('ERR_VERIFICATION_FAILED', 'The exported copy did not match the original');
    }
  } finally {
    if (temp.exists) temp.delete();
  }
}

/** Deletes the encrypted blob. Without the key the data was already unreadable; deleting frees space. */
export async function deleteFromVault(entry: VaultEntry): Promise<void> {
  const blob = blobFile(entry.id);
  if (blob.exists) blob.delete();
  await getDatabase().runAsync('DELETE FROM vault_entries WHERE id = ?', entry.id);
  useVaultRevision.getState().bump();
}

export async function renameInVault(entry: VaultEntry, name: string, collection: string): Promise<void> {
  const key = requireKey();
  await getDatabase().runAsync('UPDATE vault_entries SET sealed_name = ?, collection = ? WHERE id = ?', await sealName(key, entry.id, name), collection, entry.id);
  useVaultRevision.getState().bump();
}

export async function wipeVaultFiles(): Promise<void> {
  const directory = new Directory(Paths.document, '.vault');
  if (directory.exists) directory.delete();
  await getDatabase().runAsync('DELETE FROM vault_entries');
  clearViewingCopies();
  useVaultRevision.getState().bump();
}

// region Encrypted backup

type BackupManifest = {
  format: 'fileora-vault-backup';
  version: 1;
  createdAt: string;
  envelope: { salt: string; iterations: number; wrapped: string; check: string };
  entries: { id: string; sealedName: string; category: string; size: number; chunkCount: number; sha256: string; collection: string; createdAt: number }[];
};

/**
 * Writes an encrypted backup folder: a manifest plus the encrypted blobs. Opening it requires the
 * recovery key. File contents and names stay encrypted inside the backup.
 */
export async function createBackup(destinationFolderUri: string, envelope: BackupManifest['envelope']): Promise<{ folderName: string; count: number }> {
  requireKey();
  const rows = await getDatabase().getAllAsync<{ id: string; sealed_name: string; category: string; size: number; chunk_count: number; sha256: string; collection: string; created_at: number }>('SELECT * FROM vault_entries');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
  const folderName = `Fileora Vault Backup ${stamp}`;
  const folder = await storage.createDirectory(destinationFolderUri, folderName);
  const manifest: BackupManifest = {
    format: 'fileora-vault-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    envelope,
    entries: rows.map((r) => ({ id: r.id, sealedName: r.sealed_name, category: r.category, size: r.size, chunkCount: r.chunk_count, sha256: r.sha256, collection: r.collection, createdAt: r.created_at })),
  };
  for (const row of rows) {
    const copied = await storage.copyFile(randomUUID(), blobFile(row.id).uri, folder.uri, `${row.id}.fvault`, 'application/octet-stream', false);
    const blobHash = await storage.hash(blobFile(row.id).uri);
    if ((copied.sha256 ?? (await storage.hash(copied.uri))) !== blobHash) {
      throw new FileoraError('ERR_VERIFICATION_FAILED', 'A backup file did not copy correctly');
    }
  }
  const json = JSON.stringify(manifest);
  if (FileoraStorage) {
    await FileoraStorage.writeFile(folder.uri, 'manifest.json', toBase64(utf8(json)), 'application/json');
  } else {
    new File(new Directory(folder.uri), 'manifest.json').write(json);
  }
  return { folderName, count: rows.length };
}

/**
 * Restores a backup folder. Every blob is fully decrypted with the backup's key before it is accepted;
 * if the current vault uses a different key, items are re-encrypted with the current key.
 */
export async function restoreBackup(folderUri: string, backupKey: AESEncryptionKey, manifest: BackupManifest, onProgress?: (done: number, total: number) => void): Promise<{ restored: number; failed: number; skipped: number }> {
  const key = requireKey();
  const children = await storage.listChildren(folderUri);
  const existing = new Set((await getDatabase().getAllAsync<{ sha256: string }>('SELECT sha256 FROM vault_entries')).map((r) => r.sha256));
  let restored = 0;
  let failed = 0;
  let skipped = 0;
  for (const [index, item] of manifest.entries.entries()) {
    onProgress?.(index, manifest.entries.length);
    if (existing.has(item.sha256)) {
      skipped += 1;
      continue;
    }
    const blob = children.find((c) => c.name === `${item.id}.fvault`);
    if (!blob) {
      failed += 1;
      continue;
    }
    const staging = new File(Paths.cache, `restore-${item.id}.fvault`);
    try {
      if (staging.exists) staging.delete();
      await storage.copyFile(randomUUID(), blob.uri, Paths.cache.uri, staging.name, 'application/octet-stream', true);
      const name = await openName(backupKey, item.id, item.sealedName);
      const id = randomUUID();
      // Re-encrypt chunk by chunk under the current key (and a new id); every source chunk is authenticated.
      const chunks = await transcode(backupKey, item.id, staging, key, id, blobFile(id));
      await getDatabase().runAsync(
        'INSERT INTO vault_entries (id, sealed_name, category, size, chunk_count, sha256, collection, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        await sealName(key, id, name),
        item.category,
        item.size,
        chunks,
        item.sha256,
        item.collection,
        item.createdAt,
      );
      restored += 1;
    } catch (error) {
      logger.warn('vault', 'A backup item failed verification', error);
      failed += 1;
    } finally {
      if (staging.exists) staging.delete();
    }
  }
  useVaultRevision.getState().bump();
  return { restored, failed, skipped };
}

export async function readBackupManifest(folderUri: string): Promise<BackupManifest> {
  const children = await storage.listChildren(folderUri);
  const manifestEntry = children.find((c) => c.name === 'manifest.json');
  if (!manifestEntry) throw new FileoraError('ERR_NOT_FOUND', 'This folder is not a Fileora vault backup');
  const text = FileoraStorage ? (await FileoraStorage.readText(manifestEntry.uri, 8 * 1024 * 1024)).text : await new File(manifestEntry.uri).text();
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(text) as BackupManifest;
  } catch {
    throw new FileoraError('ERR_VERIFICATION_FAILED', 'The backup manifest is damaged');
  }
  if (manifest.format !== 'fileora-vault-backup' || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new FileoraError('ERR_UNSUPPORTED', 'This backup was made by an unsupported version of Fileora');
  }
  return manifest;
}

// endregion
