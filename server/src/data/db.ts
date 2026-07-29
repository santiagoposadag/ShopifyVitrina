import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

/**
 * Open the SQLite database, enable WAL, and create the schema if needed.
 * Safe to call multiple times (schema uses IF NOT EXISTS).
 */
export function openDb(dbPath: string): DB {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  createSchema(db);
  return db;
}

export function createSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      price INTEGER,
      currency TEXT NOT NULL DEFAULT 'COP',
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','active','sold','inactive')),
      attributes TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      public_path TEXT NOT NULL,
      caption TEXT,
      sort INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS product_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      changed_by_phone TEXT,
      change_summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contacts (
      phone TEXT PRIMARY KEY,
      name TEXT,
      role TEXT,
      last_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      product_code TEXT,
      type TEXT NOT NULL CHECK (type IN ('inquiry','visit_request')),
      name TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      phone TEXT PRIMARY KEY,
      agent_session_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Persisted inbound messages (at-least-once processing). The UNIQUE
    -- dedupe_key absorbs Kapso's 10/40/90s retries; rows left 'pending' or
    -- 'processing' by a crash are re-enqueued on the next boot.
    CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      agent_text TEXT NOT NULL,
      -- Whether the message carried media, as parsed from the event. NOT derived
      -- from agent_text: a photo's caption is stored as its text.
      kind TEXT NOT NULL DEFAULT 'text'
        CHECK (kind IN ('text','media')),
      -- A voice note awaiting transcription, stored OUTSIDE the media directory
      -- (see whatsapp/media.ts saveAudio). Set at insert time and cleared once
      -- the worker writes the transcript into agent_text, so a retried batch
      -- never pays to transcribe the same audio twice.
      --
      -- Audio rows are deliberately kind='text', not 'media': buildBatchText
      -- renders a media row as a photo COUNT and treats its text as a caption
      -- grouped underneath, which is the wrong shape for a transcript — and the
      -- media debounce window would make one voice note wait 45s for a reply.
      audio_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );

    -- Inbound media received on a conversation but not yet attached to a
    -- product. Owner tool attach_pending_photos consumes rows from here.
    CREATE TABLE IF NOT EXISTS pending_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      file_path TEXT NOT NULL,
      public_path TEXT NOT NULL,
      caption TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      attached_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
    CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);
    -- Every batch flush claims one phone's un-settled rows by (phone, status).
    CREATE INDEX IF NOT EXISTS idx_inbox_phone_status ON inbox(phone, status);
    CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
    CREATE INDEX IF NOT EXISTS idx_pending_media_phone ON pending_media(phone);
  `);

  migrate(db);
}

/**
 * Bring a database created by an older build up to the schema above.
 *
 * CREATE TABLE IF NOT EXISTS never alters a table that already exists, so a
 * column added to the definition above reaches new databases only — the running
 * pilot would keep its original table and every query naming the new column
 * would throw at runtime. Each step here is idempotent and runs on every boot.
 */
function migrate(db: DB): void {
  // Added when a captioned photo was found to be indistinguishable from chat:
  // the caption is stored as agent_text, so the photo signal had to become data.
  // Existing rows default to 'text', which is exactly how they read today.
  addColumn(db, "inbox", "kind", "TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','media'))");
  // Voice notes. Nullable with no CHECK on purpose: SQLite cannot widen an
  // existing CHECK with ALTER TABLE, so audio rides on kind='text' plus this
  // column rather than forcing a table rebuild on the running pilot.
  addColumn(db, "inbox", "audio_path", "TEXT");
}

/** Add a column unless the table already has it. Table/column names are literals. */
function addColumn(db: DB, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

