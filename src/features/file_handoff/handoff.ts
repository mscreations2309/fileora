import { randomUUID } from 'expo-crypto';
import { FileoraStorage, type HandoffEvent } from 'fileora-storage';
import { PermissionsAndroid, Platform } from 'react-native';
import { create } from 'zustand';

import { getDatabase } from '@/core/database/database';
import { FileoraError, toFileoraError } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';
import { mimeTypeFor } from '@/core/storage/fileTypes';
import { storage } from '@/core/storage/storage';
import type { FileEntry } from '@/core/storage/types';
import { nameKey, uniqueName } from '@/features/file_operations/conflicts';
import { useOperations } from '@/features/file_operations/operationsStore';

import { rankAddresses, type HandoffTarget } from './pairing';

export type HandoffFile = { uri: string; path: string; size: number };
export type FileResult = { path: string; status: 'pending' | 'verified' | 'failed' | 'imported' | 'importFailed'; detail?: string };

type Phase = 'idle' | 'joining' | 'preparing' | 'listening' | 'pairing' | 'transferring' | 'completed' | 'rejected' | 'failed' | 'cancelled';

type HandoffState = {
  role: 'send' | 'receive' | null;
  phase: Phase;
  sessionId: string | null;
  transferId: string | null;
  code: string | null;
  peer: string | null;
  addresses: string[];
  port: number | null;
  /** True when receiving on an emulator, which other devices cannot reach. */
  emulator: boolean;
  /** The receiver's own hotspot (direct link, no shared Wi-Fi needed), or why it could not start. */
  hotspot: { ssid: string; passphrase: string } | null;
  hotspotError: string | null;
  destination: { uri: string; label: string } | null;
  incoming: { fileCount: number; totalBytes: number; files: string[] } | null;
  outgoing: HandoffFile[];
  target: HandoffTarget | null;
  bytes: number;
  totalBytes: number;
  startedAt: number | null;
  results: FileResult[];
  message: string | null;
};

const INITIAL: HandoffState = {
  role: null,
  phase: 'idle',
  sessionId: null,
  transferId: null,
  code: null,
  peer: null,
  addresses: [],
  port: null,
  emulator: false,
  hotspot: null,
  hotspotError: null,
  destination: null,
  incoming: null,
  outgoing: [],
  target: null,
  bytes: 0,
  totalBytes: 0,
  startedAt: null,
  results: [],
  message: null,
};

export const useHandoff = create<HandoffState>()(() => ({ ...INITIAL }));

export const handoffSupported = FileoraStorage !== null;

export function deviceName(): string {
  const constants = Platform.constants as { Manufacturer?: string; Model?: string };
  const name = [constants.Manufacturer, constants.Model].filter(Boolean).join(' ');
  return name || (Platform.OS === 'ios' ? 'iPhone' : 'Android device');
}

let subscription: { remove: () => void } | null = null;
let importQueue: Promise<void> = Promise.resolve();

function listen(): void {
  if (subscription || !FileoraStorage) return;
  subscription = FileoraStorage.addListener('onHandoff', (event) => handle(event));
}

function setResult(index: number, patch: Partial<FileResult>): void {
  useHandoff.setState((s) => {
    const results = [...s.results];
    const current = results[index] ?? { path: '', status: 'pending' as const };
    results[index] = { ...current, ...patch };
    return { results };
  });
}

function handle(event: HandoffEvent): void {
  const state = useHandoff.getState();
  if (event.session !== state.sessionId) return;
  switch (event.event) {
    case 'listening':
      if (state.phase !== 'completed') useHandoff.setState({ phase: 'listening', code: null, peer: null, incoming: null });
      break;
    case 'preparing':
      useHandoff.setState({ phase: 'preparing' });
      break;
    case 'pairing':
      useHandoff.setState({
        phase: 'pairing',
        code: event.code ?? null,
        peer: event.peer ?? null,
        transferId: event.transferId ?? state.transferId,
        incoming: state.role === 'receive' ? { fileCount: event.fileCount ?? 0, totalBytes: event.totalBytes ?? 0, files: event.files ?? [] } : null,
        totalBytes: state.role === 'receive' ? (event.totalBytes ?? 0) : state.totalBytes,
        results: state.role === 'receive' ? (event.files ?? []).map((path) => ({ path, status: 'pending' })) : state.results,
      });
      break;
    case 'accepted':
    case 'receiving':
      useHandoff.setState({ phase: 'transferring', startedAt: Date.now(), bytes: 0 });
      break;
    case 'progress':
      useHandoff.setState({ bytes: event.bytes ?? state.bytes });
      break;
    case 'fileVerified':
      if (state.role === 'receive' && event.file !== undefined && event.stagedUri && event.path && event.sha256) {
        setResult(event.file, { path: event.path, status: 'verified' });
        const index = event.file;
        const staged = { uri: event.stagedUri, path: event.path, sha256: event.sha256 };
        importQueue = importQueue.then(() => importStaged(index, staged));
      } else if (event.file !== undefined) {
        setResult(event.file, { status: 'verified' });
      }
      break;
    case 'fileFailed':
      if (event.file !== undefined) setResult(event.file, { status: 'failed', detail: 'Checksum did not match; retry to send it again' });
      break;
    case 'completed':
      void importQueue.then(() => finish('completed'));
      break;
    case 'rejected':
      useHandoff.setState({ phase: state.role === 'receive' ? 'listening' : 'rejected', message: state.role === 'send' ? 'The other device declined the transfer.' : null });
      break;
    case 'cancelled':
      void finish('cancelled');
      break;
    case 'error':
      if (state.role === 'send') void finish('failed', event.message ?? 'Connection failed');
      else useHandoff.setState({ message: event.message ?? 'Connection failed' });
      break;
  }
}

/** Creates (or finds) the sub-folders of `path` under the destination and returns the parent folder URI. */
async function ensureFolders(rootUri: string, segments: string[]): Promise<string> {
  let current = rootUri;
  for (const segment of segments) {
    const children = await storage.listChildren(current);
    const existing = children.find((c) => c.isDirectory && nameKey(c.name) === nameKey(segment));
    current = existing ? existing.uri : (await storage.createDirectory(current, segment)).uri;
  }
  return current;
}

async function importStaged(index: number, staged: { uri: string; path: string; sha256: string }): Promise<void> {
  const destination = useHandoff.getState().destination;
  if (!destination) return;
  try {
    const parts = staged.path.split('/');
    const fileName = parts.pop() ?? 'file';
    const parent = await ensureFolders(destination.uri, parts);
    const taken = new Set((await storage.listChildren(parent)).map((c) => nameKey(c.name)));
    const name = uniqueName(fileName, false, taken);
    const copied = await storage.copyFile(randomUUID(), staged.uri, parent, name, mimeTypeFor(name), false);
    if (copied.sha256 && copied.sha256 !== staged.sha256) {
      await storage.delete(copied.uri).catch(() => undefined);
      throw new FileoraError('ERR_VERIFICATION_FAILED', 'The saved copy did not match');
    }
    setResult(index, { status: 'imported', detail: name !== fileName ? `Saved as ${name}` : undefined });
  } catch (error) {
    logger.warn('handoff', 'Could not save a received file', error);
    setResult(index, { status: 'importFailed', detail: toFileoraError(error).message });
  }
}

async function finish(phase: 'completed' | 'failed' | 'cancelled', message: string | null = null): Promise<void> {
  const state = useHandoff.getState();
  const verified = state.results.filter((r) => r.status === 'verified' || r.status === 'imported').length;
  const failed = state.results.filter((r) => r.status === 'failed' || r.status === 'importFailed').length;
  useHandoff.setState({ phase, message });
  if (state.role === 'send') FileoraStorage?.hotspotLeave();
  if (state.role === 'receive' && state.transferId && phase === 'completed' && failed === 0) FileoraStorage?.handoffDiscard(state.transferId);
  if (state.transferId) {
    await getDatabase()
      .runAsync(
        `INSERT OR REPLACE INTO transfers (id, direction, peer, status, file_count, total_bytes, verified_count, failed_count, destination_uri, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `${state.transferId}:${state.role}`,
        state.role ?? 'send',
        state.peer ?? 'Unknown device',
        phase,
        state.results.length,
        state.totalBytes,
        verified,
        failed,
        state.destination?.uri ?? null,
        state.startedAt ?? Date.now(),
        Date.now(),
      )
      .catch(() => undefined);
  }
  useOperations.setState((s) => ({ revision: s.revision + 1 }));
}

// region Receiving

export async function startReceiving(destination: { uri: string; label: string }): Promise<void> {
  if (!FileoraStorage) throw new FileoraError('ERR_UNSUPPORTED', 'Smart Handoff is available on Android');
  listen();
  const sessionId = randomUUID();
  useHandoff.setState({ ...INITIAL, role: 'receive', sessionId, destination, phase: 'listening' });
  const link = await startHotspot();
  const info = await FileoraStorage.handoffStartReceiving(sessionId, deviceName());
  if (useHandoff.getState().sessionId !== sessionId) return;
  // Hotspot addresses first: they work without any shared network.
  const addresses = [...(link.hotspot ? link.addresses : []), ...rankAddresses(info.addresses)];
  useHandoff.setState({ addresses: [...new Set(addresses)], port: info.port, emulator: info.emulator === true, hotspot: link.hotspot, hotspotError: link.error });
}

/** Android needs "Nearby devices" (13+) or location (12 and older) before an app may create a hotspot. */
async function hotspotPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const permission = (Platform.Version as number) >= 33 ? 'android.permission.NEARBY_WIFI_DEVICES' : PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
  const result = await PermissionsAndroid.request(permission as typeof PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
    title: 'Create a direct connection',
    message: 'Fileora creates a private hotspot so the other phone can connect directly — no shared Wi-Fi needed. It is never used to find your location.',
    buttonPositive: 'Allow',
    buttonNegative: 'Not now',
  });
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

function nativeDetail(error: unknown): string {
  const message = toFileoraError(error).message;
  return message.replace(/^[^:]*failure:\s*/i, '').replace(/^Unsupported:\s*/i, '');
}

async function startHotspot(): Promise<{ hotspot: { ssid: string; passphrase: string } | null; addresses: string[]; error: string | null }> {
  if (!FileoraStorage) return { hotspot: null, addresses: [], error: null };
  if (!(await hotspotPermission())) return { hotspot: null, addresses: [], error: 'Allow “Nearby devices” to let phones connect without shared Wi-Fi.' };
  try {
    const result = await FileoraStorage.hotspotStart();
    return { hotspot: { ssid: result.ssid, passphrase: result.passphrase }, addresses: result.addresses, error: null };
  } catch (error) {
    logger.warn('handoff', 'Hotspot unavailable', error);
    return { hotspot: null, addresses: [], error: nativeDetail(error) };
  }
}

export function respondToPairing(accept: boolean): void {
  const { sessionId } = useHandoff.getState();
  if (sessionId) FileoraStorage?.handoffRespond(sessionId, accept);
  if (!accept) useHandoff.setState({ phase: 'listening', code: null, incoming: null });
}

export function stopReceiving(): void {
  const { sessionId } = useHandoff.getState();
  if (sessionId) FileoraStorage?.handoffStopReceiving(sessionId);
  FileoraStorage?.hotspotStop();
  FileoraStorage?.hotspotLeave();
  useHandoff.setState({ ...INITIAL });
}

// endregion

// region Sending

/** Expands folders into files with relative paths so the receiver can rebuild the hierarchy. */
export async function collectFiles(entries: Pick<FileEntry, 'uri' | 'name' | 'isDirectory' | 'size'>[]): Promise<HandoffFile[]> {
  const out: HandoffFile[] = [];
  const walk = async (uri: string, prefix: string) => {
    for (const child of await storage.listChildren(uri)) {
      const path = `${prefix}/${child.name}`;
      if (child.isDirectory) await walk(child.uri, path);
      else out.push({ uri: child.uri, path, size: child.size ?? 0 });
      if (out.length > 10_000) throw new FileoraError('ERR_UNSUPPORTED', 'Send at most 10,000 files at a time');
    }
  };
  for (const entry of entries) {
    if (entry.isDirectory) await walk(entry.uri, entry.name);
    else out.push({ uri: entry.uri, path: entry.name, size: entry.size ?? 0 });
  }
  return out;
}

export function setOutgoing(files: HandoffFile[]): void {
  useHandoff.setState({ ...INITIAL, role: 'send', outgoing: files, totalBytes: files.reduce((s, f) => s + f.size, 0) });
}

/**
 * Sends (or resumes, keeping the same transfer id) the outgoing files. When the receiver hosts a hotspot,
 * joins it first; Android asks the user to confirm.
 */
export async function send(target: HandoffTarget, resume = false): Promise<void> {
  if (!FileoraStorage) throw new FileoraError('ERR_UNSUPPORTED', 'Smart Handoff is available on Android');
  listen();
  if (target.hotspot) {
    useHandoff.setState({ target, phase: 'joining', message: null, sessionId: null });
    try {
      await FileoraStorage.hotspotJoin(target.hotspot.ssid, target.hotspot.passphrase);
    } catch (error) {
      // Not fatal: both phones may still share a Wi-Fi network, so try the normal route before giving up.
      logger.warn('handoff', 'Could not join hotspot; trying the current network', error);
    }
    if (useHandoff.getState().phase !== 'joining') return; // cancelled while joining
  }
  const state = useHandoff.getState();
  const sessionId = randomUUID();
  const transferId = resume && state.transferId ? state.transferId : randomUUID();
  useHandoff.setState({
    sessionId,
    transferId,
    target,
    phase: 'preparing',
    code: null,
    message: null,
    bytes: 0,
    results: state.outgoing.map((f, i) => (resume && state.results[i]?.status === 'verified' ? state.results[i] : { path: f.path, status: 'pending' })),
  });
  FileoraStorage.handoffSend(sessionId, target.hosts.join(','), target.port, transferId, deviceName(), state.outgoing);
}

export function cancelSending(): void {
  const { sessionId, phase } = useHandoff.getState();
  if (phase === 'joining') {
    FileoraStorage?.hotspotLeave();
    useHandoff.setState({ phase: 'cancelled' });
    return;
  }
  if (sessionId) FileoraStorage?.handoffCancel(sessionId);
}

export function resetHandoff(): void {
  stopReceiving();
}

// endregion

export async function transferHistory(): Promise<{ id: string; direction: string; peer: string; status: string; fileCount: number; totalBytes: number; verified: number; failed: number; finishedAt: number | null }[]> {
  const rows = await getDatabase().getAllAsync<{ id: string; direction: string; peer: string; status: string; file_count: number; total_bytes: number; verified_count: number; failed_count: number; finished_at: number | null }>(
    'SELECT * FROM transfers ORDER BY created_at DESC LIMIT 30',
  );
  return rows.map((r) => ({ id: r.id, direction: r.direction, peer: r.peer, status: r.status, fileCount: r.file_count, totalBytes: r.total_bytes, verified: r.verified_count, failed: r.failed_count, finishedAt: r.finished_at }));
}
