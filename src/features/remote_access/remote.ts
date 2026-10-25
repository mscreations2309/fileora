import { randomUUID } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { FileoraStorage, type RemoteDevice, type RemoteEvent } from 'fileora-storage';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { getDatabase } from '@/core/database/database';
import { toFileoraError } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';
import { usePreferences } from '@/core/preferences/preferences';
import { mimeTypeFor } from '@/core/storage/fileTypes';
import { loadLocations, locationForUri, trashDirectoryUri } from '@/core/storage/locations';
import { storage, toFileEntry } from '@/core/storage/storage';
import type { StorageLocation } from '@/core/storage/types';
import { createFolder, deleteItems, renameItem } from '@/features/file_operations/actions';
import { nameKey, uniqueName } from '@/features/file_operations/conflicts';
import { useOperations } from '@/features/file_operations/operationsStore';

import { insideRoots, nameProblem, visibleEntries, type WebEntry } from './remoteRules';

const PORT = 8765;

export type PairedLaptop = RemoteDevice & { createdAt: number; lastSeenAt: number | null };
export type Activity = { id: string; at: number; device: string; text: string };

type RemoteState = {
  running: boolean;
  starting: boolean;
  port: number | null;
  addresses: string[];
  devices: PairedLaptop[];
  pairing: { pairId: string; name: string; code: string } | null;
  activity: Activity[];
  error: string | null;
};

export const useRemote = create<RemoteState>()(() => ({
  running: false,
  starting: false,
  port: null,
  addresses: [],
  devices: [],
  pairing: null,
  activity: [],
  error: null,
}));

export const remoteSupported = FileoraStorage !== null;

let subscription: { remove: () => void } | null = null;
let revisionUnsubscribe: (() => void) | null = null;
let locationsCache: { at: number; locations: StorageLocation[] } | null = null;

function log(device: string, text: string): void {
  useRemote.setState((s) => ({ activity: [{ id: randomUUID(), at: Date.now(), device, text }, ...s.activity].slice(0, 50) }));
}

async function locations(): Promise<StorageLocation[]> {
  if (locationsCache && Date.now() - locationsCache.at < 10_000) return locationsCache.locations;
  const all = (await loadLocations()).filter((l) => l.status === 'available' && l.kind !== 'appSandbox');
  locationsCache = { at: Date.now(), locations: all };
  return all;
}

/** Second line of defence (the native server already restricts to listed URIs). */
async function assertInside(uri: string): Promise<StorageLocation> {
  const all = await locations();
  if (!insideRoots(uri, all.map((l) => l.rootUri), [trashDirectoryUri()])) throw new Error('That location is not shared with laptops');
  const location = locationForUri(all, uri);
  if (!location) throw new Error('That location is not shared with laptops');
  return location;
}

async function findEntry(parentUri: string, uri: string) {
  const location = await assertInside(parentUri);
  const raw = (await storage.listChildren(parentUri)).find((e) => e.uri === uri);
  if (!raw) throw new Error('It was moved or deleted — refresh the folder');
  return toFileEntry(raw, parentUri, location.id);
}

// region Request handling

async function handleRequest(op: Extract<RemoteEvent, { type: 'request' }>['op'], args: Record<string, unknown>, device: string): Promise<Record<string, unknown>> {
  switch (op) {
    case 'roots': {
      const all = await locations();
      return { roots: all.map((l) => ({ id: l.id, uri: l.rootUri, name: l.label, icon: l.icon })) };
    }
    case 'list': {
      const uri = String(args.uri);
      await assertInside(uri);
      const raw = await storage.listChildren(uri);
      const entries: WebEntry[] = visibleEntries(raw, usePreferences.getState().showHiddenFiles).map((e) => ({
        uri: e.uri,
        name: e.name,
        isDirectory: e.isDirectory,
        size: e.size,
        modifiedAt: e.modifiedAt,
        mimeType: e.mimeType,
        childCount: e.childCount,
      }));
      return { entries };
    }
    case 'import': {
      const parent = String(args.parent);
      const requested = String(args.name);
      const problem = nameProblem(requested);
      if (problem) throw new Error(problem);
      await assertInside(parent);
      const taken = new Set((await storage.listChildren(parent)).map((c) => nameKey(c.name)));
      const name = uniqueName(requested.trim(), false, taken);
      await storage.copyFile(randomUUID(), String(args.staged), parent, name, mimeTypeFor(name), false);
      useOperations.setState((s) => ({ revision: s.revision + 1 }));
      log(device, `Uploaded “${name}”`);
      return { name };
    }
    case 'rename': {
      const newName = String(args.newName ?? '');
      const problem = nameProblem(newName);
      if (problem) throw new Error(problem);
      const entry = await findEntry(String(args.parentUri), String(args.uri));
      const result = await renameItem(entry, newName.trim());
      if (result.status === 'failed') throw new Error(result.error?.message ?? 'Could not rename');
      log(device, `Renamed “${entry.name}” to “${newName.trim()}”`);
      return { name: result.entry?.name ?? newName.trim() };
    }
    case 'mkdir': {
      const parent = String(args.parent);
      const name = String(args.name ?? '');
      const problem = nameProblem(name);
      if (problem) throw new Error(problem);
      const location = await assertInside(parent);
      const result = await createFolder({ uri: parent, locationId: location.id }, name.trim());
      if (result.status === 'failed') throw new Error(result.error?.message ?? 'Could not create the folder');
      log(device, `Created folder “${name.trim()}”`);
      return { name: result.entry?.name ?? name.trim() };
    }
    case 'delete': {
      const parent = String(args.parentUri);
      const uris = Array.isArray(args.uris) ? args.uris.map(String) : [];
      const entries = await Promise.all(uris.map((u) => findEntry(parent, u)));
      // Always into Fileora Trash, so a laptop can never permanently erase anything.
      const result = await deleteItems(entries, false);
      if (result.status === 'failed') throw new Error(result.error?.message ?? 'Could not delete');
      log(device, entries.length === 1 ? `Moved “${entries[0]?.name}” to Trash` : `Moved ${entries.length} items to Trash`);
      return { count: entries.length };
    }
  }
}

async function onEvent(event: RemoteEvent): Promise<void> {
  switch (event.type) {
    case 'request': {
      let reply: Record<string, unknown>;
      try {
        const args = JSON.parse(event.args) as Record<string, unknown>;
        reply = { ok: true, ...(await handleRequest(event.op, args, event.deviceName)) };
      } catch (error) {
        reply = { ok: false, error: error instanceof Error && !(error as { code?: string }).code ? error.message : toFileoraError(error).message };
      }
      FileoraStorage?.remoteRespond(event.id, JSON.stringify(reply));
      break;
    }
    case 'pair':
      useRemote.setState({ pairing: { pairId: event.pairId, name: event.name, code: event.code } });
      if (AppState.currentState !== 'active') {
        void Notifications.scheduleNotificationAsync({
          content: { title: 'A laptop wants to connect', body: `${event.name} · code ${event.code}. Open Fileora to approve or decline.`, data: { route: '/web' } },
          trigger: null,
        }).catch(() => undefined);
      }
      break;
    case 'seen':
      await getDatabase().runAsync('UPDATE remote_devices SET last_seen_at = ? WHERE id = ?', Date.now(), event.deviceId).catch(() => undefined);
      void loadDevices();
      break;
    case 'activity': {
      const name = useRemote.getState().devices.find((d) => d.id === event.deviceId)?.name ?? 'Laptop';
      let file = 'a file';
      try {
        file = decodeURIComponent(event.uri).split(/[/:]/).pop() || file;
      } catch {
        // Undecodable URI: keep the generic label.
      }
      log(name, `Downloaded “${file}”`);
      break;
    }
    case 'stopped':
      stopRemote();
      break;
  }
}

// endregion

// region Devices

export async function loadDevices(): Promise<PairedLaptop[]> {
  const rows = await getDatabase().getAllAsync<{ id: string; name: string; token_hash: string; created_at: number; last_seen_at: number | null }>(
    'SELECT * FROM remote_devices ORDER BY created_at DESC',
  );
  const devices = rows.map((r) => ({ id: r.id, name: r.name, tokenHash: r.token_hash, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
  useRemote.setState({ devices });
  return devices;
}

export async function respondToPairing(accept: boolean): Promise<void> {
  const pairing = useRemote.getState().pairing;
  useRemote.setState({ pairing: null });
  if (!pairing || !FileoraStorage) return;
  const device = FileoraStorage.remoteResolvePairing(pairing.pairId, accept);
  if (!accept || !device) return;
  await getDatabase().runAsync('INSERT OR REPLACE INTO remote_devices (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', device.id, device.name, device.tokenHash, Date.now(), Date.now());
  await loadDevices();
  log(device.name, 'Paired');
}

export async function forgetDevice(id: string): Promise<void> {
  await getDatabase().runAsync('DELETE FROM remote_devices WHERE id = ?', id);
  const devices = await loadDevices();
  FileoraStorage?.remoteSetDevices(devices.map(({ id: deviceId, name, tokenHash }) => ({ id: deviceId, name, tokenHash })));
}

// endregion

// region Lifecycle

export async function startRemote(): Promise<void> {
  if (!FileoraStorage || useRemote.getState().running || useRemote.getState().starting) return;
  useRemote.setState({ starting: true, error: null });
  try {
    subscription ??= FileoraStorage.addListener('onRemote', (event) => void onEvent(event));
    // Live updates: any change made on the phone (or by a laptop) refreshes connected browsers.
    revisionUnsubscribe ??= useOperations.subscribe((state, previous) => {
      if (state.revision !== previous.revision) FileoraStorage?.remoteNotifyChange(null);
    });
    await Notifications.requestPermissionsAsync().catch(() => undefined); // for the "Fileora Web is on" notification
    const devices = await loadDevices();
    const info = await FileoraStorage.remoteStart(PORT, devices.map(({ id, name, tokenHash }) => ({ id, name, tokenHash })));
    useRemote.setState({ running: true, port: info.port, addresses: info.addresses });
    usePreferences.getState().setPreference('remoteAccessEnabled', true);
  } catch (error) {
    logger.warn('remote', 'Could not start Fileora Web', error);
    useRemote.setState({ error: toFileoraError(error).message });
  } finally {
    useRemote.setState({ starting: false });
  }
}

export function stopRemote(): void {
  FileoraStorage?.remoteStop();
  revisionUnsubscribe?.();
  revisionUnsubscribe = null;
  useRemote.setState({ running: false, port: null, addresses: [], pairing: null });
  usePreferences.getState().setPreference('remoteAccessEnabled', false);
}

/** Re-starts Fileora Web on launch when the user left it on. */
export function resumeRemoteIfEnabled(): void {
  if (usePreferences.getState().remoteAccessEnabled) void startRemote();
}

// endregion
