import { randomUUID } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { extractText, extractionMethodFor } from '@/core/content/extract';
import { getDatabase } from '@/core/database/database';
import { toFileoraError } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';
import { getIndexedText, indexedDocuments } from '@/features/search/contentIndex';

import { CATEGORY_LABELS, daysUntil, expiryCandidates, suggestCategory, type DateConfidence, type DocumentCategory } from './dateExtraction';

export type ExpiryStatus = 'suggested' | 'confirmed' | 'dismissed' | 'renewed' | 'done';

export type ExpiryItem = {
  id: string;
  uri: string;
  parentUri: string;
  locationId: string | null;
  name: string;
  category: DocumentCategory;
  expiresOn: string;
  status: ExpiryStatus;
  sourceText: string | null;
  confidence: DateConfidence;
  remindDays: number;
  notificationId: string | null;
  replacedBy: string | null;
  createdAt: number;
  updatedAt: number;
};

export const useExpiryRevision = create<{ revision: number; bump: () => void }>()((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

type Row = {
  id: string;
  uri: string;
  parent_uri: string;
  location_id: string | null;
  name: string;
  category: string;
  expires_on: string;
  status: string;
  source_text: string | null;
  confidence: string;
  remind_days: number;
  notification_id: string | null;
  replaced_by: string | null;
  created_at: number;
  updated_at: number;
};

function toItem(row: Row): ExpiryItem {
  return {
    id: row.id,
    uri: row.uri,
    parentUri: row.parent_uri,
    locationId: row.location_id,
    name: row.name,
    category: row.category as DocumentCategory,
    expiresOn: row.expires_on,
    status: row.status as ExpiryStatus,
    sourceText: row.source_text,
    confidence: row.confidence as DateConfidence,
    remindDays: row.remind_days,
    notificationId: row.notification_id,
    replacedBy: row.replaced_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listExpiry(): Promise<ExpiryItem[]> {
  const rows = await getDatabase().getAllAsync<Row>("SELECT * FROM expiry_items WHERE status != 'dismissed' ORDER BY expires_on");
  return rows.map(toItem);
}

type FileRef = { uri: string; parentUri: string; locationId: string | null; name: string; mimeType?: string | null; size?: number | null };

/** Stores expiry-date suggestions for a file. Existing items for the same date are left as they are. */
async function storeSuggestions(file: FileRef, text: string): Promise<number> {
  const candidates = expiryCandidates(text);
  if (candidates.length === 0) return 0;
  const category = suggestCategory(text, file.name);
  let added = 0;
  for (const candidate of candidates) {
    const result = await getDatabase().runAsync(
      `INSERT OR IGNORE INTO expiry_items (id, uri, parent_uri, location_id, name, category, expires_on, status, source_text, confidence, remind_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'suggested', ?, ?, 30, ?, ?)`,
      randomUUID(),
      file.uri,
      file.parentUri,
      file.locationId,
      file.name,
      category,
      candidate.date,
      candidate.alternative ? `${candidate.source} (could also be ${candidate.alternative})` : candidate.source,
      candidate.confidence,
      Date.now(),
      Date.now(),
    );
    added += result.changes;
  }
  useExpiryRevision.getState().bump();
  return added;
}

/** Checks one file (uses indexed text when available, otherwise reads it on the device). */
export async function detectInFile(file: FileRef): Promise<{ added: number; readable: boolean }> {
  const indexed = await getIndexedText(file.uri);
  let text = indexed?.text ?? null;
  if (text === null && extractionMethodFor(file.name, file.mimeType ?? null)) {
    try {
      text = (await extractText({ uri: file.uri, name: file.name, mimeType: file.mimeType ?? null, size: file.size ?? null }, { maxPdfPages: 10 })).text;
    } catch (error) {
      logger.warn('expiry', 'Could not read file for dates', error);
    }
  }
  if (text === null) return { added: 0, readable: false };
  return { added: await storeSuggestions(file, text), readable: true };
}

/** Scans every document in the content index (user-initiated). */
export async function detectInIndex(onProgress?: (done: number, total: number) => void): Promise<number> {
  const documents = await indexedDocuments();
  let added = 0;
  for (const [index, doc] of documents.entries()) {
    onProgress?.(index, documents.length);
    const text = await getIndexedText(doc.uri);
    if (text) added += await storeSuggestions({ uri: doc.uri, parentUri: doc.parentUri, locationId: doc.locationId, name: doc.name }, text.text);
  }
  return added;
}

// region Reminders

const CHANNEL = 'expiry-reminders';

async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: 'Document expiry reminders', importance: AndroidImportance.DEFAULT });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

async function schedule(item: ExpiryItem): Promise<string | null> {
  const [y, m, d] = item.expiresOn.split('-').map(Number);
  const reminder = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 9, 0, 0);
  reminder.setDate(reminder.getDate() - item.remindDays);
  const now = Date.now();
  // If the reminder day has passed but the document has not expired yet, remind in an hour.
  const when = reminder.getTime() > now ? reminder : daysUntil(item.expiresOn) >= 0 ? new Date(now + 3_600_000) : null;
  if (!when) return null;
  const days = daysUntil(item.expiresOn, when);
  return Notifications.scheduleNotificationAsync({
    content: {
      title: `${CATEGORY_LABELS[item.category]} may expire soon`,
      body: `“${item.name}” may expire ${days <= 0 ? 'today' : `in ${days} ${days === 1 ? 'day' : 'days'}`} (${item.expiresOn}). Please verify the date.`,
      data: { expiryId: item.id },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when, channelId: CHANNEL },
  });
}

async function cancel(item: ExpiryItem): Promise<void> {
  if (item.notificationId) await Notifications.cancelScheduledNotificationAsync(item.notificationId).catch(() => undefined);
}

// endregion

async function save(item: ExpiryItem): Promise<void> {
  await getDatabase().runAsync(
    `UPDATE expiry_items SET category = ?, expires_on = ?, status = ?, remind_days = ?, notification_id = ?, replaced_by = ?, updated_at = ? WHERE id = ?`,
    item.category,
    item.expiresOn,
    item.status,
    item.remindDays,
    item.notificationId,
    item.replacedBy,
    Date.now(),
    item.id,
  );
  useExpiryRevision.getState().bump();
}

/** Confirms (or corrects) a date and schedules a reminder. Returns false if notifications are not allowed. */
export async function confirmExpiry(item: ExpiryItem, patch: { expiresOn: string; category: DocumentCategory; remindDays: number }): Promise<{ reminder: boolean }> {
  await cancel(item);
  const next: ExpiryItem = { ...item, ...patch, status: 'confirmed', notificationId: null };
  let reminder = false;
  try {
    if (await ensureNotificationPermission()) {
      next.notificationId = await schedule(next);
      reminder = next.notificationId !== null;
    }
  } catch (error) {
    logger.warn('expiry', 'Could not schedule a reminder', toFileoraError(error));
  }
  await save(next);
  return { reminder };
}

export async function setStatus(item: ExpiryItem, status: 'dismissed' | 'done'): Promise<void> {
  await cancel(item);
  await save({ ...item, status, notificationId: null });
}

/** Links a renewed document: the old item is marked renewed and points at the new one. */
export async function markRenewed(item: ExpiryItem, newer: ExpiryItem): Promise<void> {
  await cancel(item);
  await save({ ...item, status: 'renewed', notificationId: null, replacedBy: newer.id });
}

export async function addManual(file: FileRef, expiresOn: string, category: DocumentCategory): Promise<ExpiryItem> {
  const id = randomUUID();
  await getDatabase().runAsync(
    `INSERT OR REPLACE INTO expiry_items (id, uri, parent_uri, location_id, name, category, expires_on, status, source_text, confidence, remind_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'suggested', NULL, 'high', 30, ?, ?)`,
    id,
    file.uri,
    file.parentUri,
    file.locationId,
    file.name,
    category,
    expiresOn,
    Date.now(),
    Date.now(),
  );
  const row = await getDatabase().getFirstAsync<Row>('SELECT * FROM expiry_items WHERE id = ?', id);
  useExpiryRevision.getState().bump();
  if (!row) throw new Error('Could not save');
  return toItem(row);
}
