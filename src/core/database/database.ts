import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { FileoraError } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';

import { LATEST_SCHEMA_VERSION, migrations } from './migrations';

const DATABASE_NAME = 'fileora.db';

let database: SQLiteDatabase | null = null;
let opening: Promise<SQLiteDatabase> | null = null;

/** Opens the database and applies pending migrations. Safe to call repeatedly. */
export function initDatabase(): Promise<SQLiteDatabase> {
  if (database) return Promise.resolve(database);
  opening ??= open().catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

/** Returns the open database. Only valid after `initDatabase` resolved (guaranteed inside the app shell). */
export function getDatabase(): SQLiteDatabase {
  if (!database) throw new FileoraError('ERR_INTERNAL', 'Database accessed before initialization');
  return database;
}

async function open(): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync(DATABASE_NAME);
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  await migrate(db);
  database = db;
  return db;
}

async function migrate(db: SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current > LATEST_SCHEMA_VERSION) {
    // A newer app version created this database (e.g. after a downgrade). Refuse to guess.
    throw new FileoraError(
      'ERR_DATABASE_MIGRATION',
      `Database schema ${current} is newer than this app supports (${LATEST_SCHEMA_VERSION}).`,
    );
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    try {
      await db.withExclusiveTransactionAsync(async (txn) => {
        await txn.execAsync(migration.sql);
        await txn.execAsync(`PRAGMA user_version = ${migration.version}`);
      });
      logger.info('database', `Applied migration ${migration.version}: ${migration.description}`);
    } catch (cause) {
      throw new FileoraError('ERR_DATABASE_MIGRATION', `Migration ${migration.version} failed`, { cause });
    }
  }
}

/** Removes cached metadata that can be regenerated. User data (journal, trash, favorites) is kept. */
export async function clearRegenerableData(): Promise<void> {
  const db = getDatabase();
  await db.execAsync('DELETE FROM recent_files; DELETE FROM search_history;');
}
