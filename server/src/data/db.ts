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

/**
 * The catalog is NOT in here. Products, variants, prices, stock and photos live
 * in Shopify, which is the source of truth for all of them. SQLite keeps only
 * what Shopify has no place for: the durable inbox, agent sessions, the leads
 * the assistant captures, and inbound photos on their way to a product.
 */
export function createSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      phone TEXT PRIMARY KEY,
      name TEXT,
      role TEXT,
      last_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      -- The SKU or handle the lead is about. Deliberately free text and NOT a
      -- foreign key: the product it names lives in Shopify, and a lead must
      -- survive that product being renamed, archived or deleted.
      product_code TEXT,
      type TEXT NOT NULL CHECK (type IN ('inquiry','back_in_stock','follow_up')),
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
      -- An inbound file this row is entitled to but that nobody has fetched yet.
      -- The webhook stores the transport's reference and ACKs; the worker
      -- downloads it (inbox/batcher.ts resolveMedia) and clears media_ref, which
      -- is the marker that the fetch has already been paid for.
      --
      -- Distinct from audio_path on purpose: audio_path means "on our disk,
      -- awaiting transcription", media_ref means "not downloaded at all". A
      -- retry has to tell those apart or it re-downloads what it already has.
      media_ref TEXT,
      -- 'photo' or 'audio'. Explicit rather than inferred from the kind column:
      -- audio rides on kind='text' (see above), so inferring would couple this
      -- to a rule stated three files away.
      media_kind TEXT,
      media_mime TEXT,
      media_name TEXT,
      -- WhatsApp's own send stamp, on its way to pending_media.sent_at.
      media_sent_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );

    -- Inbound media received on a conversation but not yet uploaded to a
    -- product. Owner tool attach_pending_photos consumes rows from here.
    CREATE TABLE IF NOT EXISTS pending_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      file_path TEXT NOT NULL,
      public_path TEXT NOT NULL,
      caption TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- The Shopify product gid this photo was uploaded to, and when. A gid
      -- rather than a local id because the product is not ours: nothing here
      -- can reference it, and the column's only job is to keep the housekeeping
      -- sweep from deleting a file that already made it to the store.
      attached_to TEXT,
      attached_at TEXT
    );

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
  // The Shopify cut-over: pending_media used to point at a local products row.
  addColumn(db, "pending_media", "attached_to", "TEXT");
  addColumn(db, "pending_media", "attached_at", "TEXT");
  // The Cloud API cut-over. Photo order is listing order, and Meta does not
  // guarantee webhook ordering the way the bridge's sequential outbox did — so
  // the order has to come from WhatsApp's own timestamp rather than from the
  // row's autoincrement id. NULL on every bridge-era row, which is exactly how
  // they already sort (see listPendingMedia).
  addColumn(db, "pending_media", "sent_at", "INTEGER");
  // An inbound file the webhook accepted but deliberately did NOT download.
  //
  // These five carry a media reference across the ACK so the fetch can happen on
  // the worker instead of inside the request — see inbox/batcher.ts resolveMedia.
  // Nullable with no CHECK for the same reason audio_path is: SQLite cannot add
  // a CHECK to an existing table without rebuilding it, and the running pilot is
  // not worth a table rebuild for a constraint two call sites already enforce.
  addColumn(db, "inbox", "media_ref", "TEXT");
  addColumn(db, "inbox", "media_kind", "TEXT");
  addColumn(db, "inbox", "media_mime", "TEXT");
  addColumn(db, "inbox", "media_name", "TEXT");
  addColumn(db, "inbox", "media_sent_at", "INTEGER");
}

/** Add a column unless the table already has it. Table/column names are literals. */
function addColumn(db: DB, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

