/**
 * Ordered schema migrations. Each entry upgrades the database from `version - 1` to `version`.
 * Never edit a released migration; append a new one instead.
 */
export type Migration = { version: number; description: string; sql: string };

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Initial schema: preferences, locations, journal, trash, recents, favorites',
    sql: `
      CREATE TABLE preferences (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );

      -- User-granted or discovered storage roots (SAF trees, volumes, app sandbox).
      CREATE TABLE locations (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        root_uri TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER
      );

      -- Operation journal (Time Machine foundation). One row per user-visible operation.
      CREATE TABLE operations (
        id TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        location_id TEXT,
        destination_uri TEXT,
        item_count INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER,
        processed_bytes INTEGER NOT NULL DEFAULT 0,
        reversible INTEGER NOT NULL DEFAULT 0,
        undo_operation_id TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX idx_operations_created ON operations(created_at DESC);
      CREATE INDEX idx_operations_status ON operations(status);

      -- Per-item steps of an operation; used for undo, resume reporting and audit.
      CREATE TABLE operation_items (
        operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        kind TEXT NOT NULL,
        source_uri TEXT,
        source_parent_uri TEXT,
        destination_uri TEXT,
        destination_parent_uri TEXT,
        name TEXT NOT NULL,
        is_directory INTEGER NOT NULL DEFAULT 0,
        size INTEGER,
        sha256 TEXT,
        status TEXT NOT NULL,
        error_code TEXT,
        PRIMARY KEY (operation_id, position)
      );

      -- Items moved into the Fileora-managed trash.
      CREATE TABLE trash_items (
        id TEXT PRIMARY KEY NOT NULL,
        operation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        is_directory INTEGER NOT NULL,
        size INTEGER,
        original_parent_uri TEXT NOT NULL,
        original_location_id TEXT,
        trash_uri TEXT NOT NULL,
        sha256 TEXT,
        deleted_at INTEGER NOT NULL
      );
      CREATE INDEX idx_trash_deleted ON trash_items(deleted_at DESC);

      CREATE TABLE recent_files (
        uri TEXT PRIMARY KEY NOT NULL,
        location_id TEXT,
        name TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER,
        opened_at INTEGER NOT NULL
      );
      CREATE INDEX idx_recent_opened ON recent_files(opened_at DESC);

      CREATE TABLE favorites (
        uri TEXT PRIMARY KEY NOT NULL,
        location_id TEXT,
        name TEXT NOT NULL,
        is_directory INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE search_history (
        query TEXT PRIMARY KEY NOT NULL,
        searched_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    description: 'Intelligence features: content index, workspaces, relationships, expiry, snapshots, privacy, vault, transfers',
    sql: `
      -- Local content index. Text never leaves the device.
      CREATE TABLE content_index (
        uri TEXT PRIMARY KEY NOT NULL,
        location_id TEXT,
        parent_uri TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER,
        modified_at INTEGER,
        status TEXT NOT NULL,
        method TEXT,
        text_length INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        indexed_at INTEGER NOT NULL
      );
      CREATE INDEX idx_content_location ON content_index(location_id);
      CREATE VIRTUAL TABLE content_fts USING fts5(
        uri UNINDEXED,
        name,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE index_exclusions (
        uri TEXT PRIMARY KEY NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        labels TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT 'indigo',
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE workspace_items (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        uri TEXT NOT NULL,
        parent_uri TEXT NOT NULL,
        location_id TEXT,
        name TEXT NOT NULL,
        is_directory INTEGER NOT NULL,
        size INTEGER,
        mime_type TEXT,
        collection TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        missing INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        checked_at INTEGER,
        PRIMARY KEY (workspace_id, uri)
      );

      -- Manual links and dismissed suggestions. URIs are stored in sorted order (a < b).
      CREATE TABLE relationships (
        a_uri TEXT NOT NULL,
        b_uri TEXT NOT NULL,
        kind TEXT NOT NULL,
        a_name TEXT NOT NULL,
        b_name TEXT NOT NULL,
        a_parent TEXT NOT NULL,
        b_parent TEXT NOT NULL,
        a_location TEXT,
        b_location TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (a_uri, b_uri)
      );

      CREATE TABLE expiry_items (
        id TEXT PRIMARY KEY NOT NULL,
        uri TEXT NOT NULL,
        parent_uri TEXT NOT NULL,
        location_id TEXT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        expires_on TEXT NOT NULL,
        status TEXT NOT NULL,
        source_text TEXT,
        confidence TEXT NOT NULL,
        remind_days INTEGER NOT NULL DEFAULT 30,
        notification_id TEXT,
        replaced_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_expiry_date ON expiry_items(expires_on);
      CREATE UNIQUE INDEX idx_expiry_uri_date ON expiry_items(uri, expires_on);

      CREATE TABLE folder_snapshots (
        id TEXT PRIMARY KEY NOT NULL,
        folder_uri TEXT NOT NULL,
        location_id TEXT,
        label TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        hashed INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE snapshot_items (
        snapshot_id TEXT NOT NULL REFERENCES folder_snapshots(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        is_directory INTEGER NOT NULL,
        size INTEGER,
        modified_at INTEGER,
        sha256 TEXT,
        PRIMARY KEY (snapshot_id, path)
      );
      CREATE TABLE comparisons (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        left_name TEXT NOT NULL,
        right_name TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE privacy_dismissals (
        uri TEXT NOT NULL,
        finding_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (uri, finding_key)
      );

      -- Vault index. Names are stored encrypted; only sizes, categories and timestamps are plaintext.
      CREATE TABLE vault_entries (
        id TEXT PRIMARY KEY NOT NULL,
        sealed_name TEXT NOT NULL,
        category TEXT NOT NULL,
        size INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        collection TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      -- Content hashes reused only while size and modification time are unchanged.
      CREATE TABLE file_hashes (
        uri TEXT PRIMARY KEY NOT NULL,
        size INTEGER NOT NULL,
        modified_at INTEGER,
        sha256 TEXT,
        image_hash TEXT,
        computed_at INTEGER NOT NULL
      );

      CREATE TABLE transfers (
        id TEXT PRIMARY KEY NOT NULL,
        direction TEXT NOT NULL,
        peer TEXT NOT NULL,
        status TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL,
        verified_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        destination_uri TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
    `,
  },
  {
    version: 3,
    description: 'Fileora Web: laptops approved for local browser access',
    sql: `
      CREATE TABLE remote_devices (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1]?.version ?? 0;
