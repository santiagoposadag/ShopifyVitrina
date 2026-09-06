import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

/**
 * How a database written by an older build is brought forward, where bringing
 * it forward needs a decision this module cannot make on its own.
 */
export interface SchemaOptions {
  /**
   * Which agent owned a pre-existing session, given the phone it was stored
   * under. Sessions used to be keyed by phone alone, so a legacy row names a
   * person and not an assistant — and nothing in this file can see the owner
   * allowlist that decides which of the two they were talking to.
   *
   * SUPPLIED: each legacy row is copied to (resolver(phone), phone) and the
   * conversation continues across the upgrade.
   *
   * OMITTED: legacy rows are DROPPED. That is the deliberate choice, not an
   * oversight — guessing the agent hands one person's transcript to the wrong
   * assistant, which the owner cannot detect and which reads as the assistant
   * inventing context. Dropping costs one conversation's history, and that cost
   * is already paid routinely: a resume whose transcript is gone falls back to a
   * fresh session and answers anyway. Every caller that cannot resolve a role
   * (backup, the purge tool, tests) omits it; the server MUST pass it.
   */
  legacyAgentIdFor?: (phone: string) => string;
}

/**
 * Open the SQLite database, enable WAL, and create the schema if needed.
 * Safe to call multiple times (schema uses IF NOT EXISTS).
 */
export function openDb(dbPath: string, options: SchemaOptions = {}): DB {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  createSchema(db, options);
  return db;
}

/**
 * The catalog is NOT in here. Products, variants, prices, stock and photos live
 * in Shopify, which is the source of truth for all of them. SQLite keeps only
 * what Shopify has no place for: the durable inbox, agent sessions, the leads
 * the assistant captures, and inbound photos on their way to a product.
 */
export function createSchema(db: DB, options: SchemaOptions = {}): void {
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

    -- One resumable agent conversation, keyed by WHICH ASSISTANT and WHICH
    -- CONVERSATION rather than by phone: one person can hold a conversation
    -- with more than one agent, and sharing a session id between them would
    -- resume the wrong transcript into the wrong persona.
    --
    -- conversation_key is the phone for a WhatsApp principal and a correlation
    -- id for an agent-to-agent exchange. A database created before this shape
    -- existed is rebuilt by migrateSessionsKey below — IF NOT EXISTS does not
    -- reach an existing table, and a PRIMARY KEY cannot be ALTERed.
    CREATE TABLE IF NOT EXISTS sessions (
      agent_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      agent_session_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent_id, conversation_key)
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
      -- The envelope, persisted: who asked, which agent must answer, which
      -- conversation, where the reply goes, and how many agent-to-agent hops
      -- produced it. Written by the door that AUTHENTICATED the sender, and
      -- read again when the batch is claimed — so a row replayed after a crash
      -- is routed by what was proven then, not by whatever a registry or an
      -- allowlist happens to say at replay time.
      --
      -- agent_id is NULL on a WhatsApp row ON PURPOSE: a phone's target agent
      -- is resolved when the burst flushes (router.ts), one turn for many rows,
      -- and freezing it per row would let one burst disagree with itself.
      agent_id TEXT,
      principal_kind TEXT NOT NULL DEFAULT 'whatsapp',
      -- The phone, or the CALLING agent's id as its credential identified it.
      -- Never anything the message said about itself.
      principal_id TEXT,
      -- What claimInboxBatch claims by, and half the session key: the phone on
      -- the WhatsApp door, an 'a2a:<caller>:<correlation>' key on the agent
      -- door. Nullable only because ALTER TABLE cannot add a NOT NULL column
      -- without a constant default; every writer fills it and migrate()
      -- backfills the rows written before it existed.
      conversation_key TEXT,
      -- A callback URL for a caller that cannot take the reply in its own
      -- response body. NULL means "answer whoever asked, the way that door
      -- answers" — which is every WhatsApp message.
      reply_to TEXT,
      hop INTEGER NOT NULL DEFAULT 0,
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

    -- The knowledge index: an agent's own documents, chunked, for
    -- search_knowledge. DERIVED DATA, and the only table here that is: the
    -- documents under agents/<id>/knowledge/ are the source of truth and this
    -- is rebuilt from them at boot (see knowledge/store.ts). Losing it costs
    -- nothing but the next boot; that is what makes re-indexing by
    -- delete-then-insert, inside one transaction, an acceptable way to do it.
    --
    -- New tables, so IF NOT EXISTS IS the migration for a database that
    -- predates them: nothing here alters an existing table and no column is
    -- added to one.
    --
    -- FTS5, not a plain table: the whole point is matching an owner's own
    -- words against prose. The remove_diacritics option is what makes "publicacion"
    -- find "publicación" — Spanish is typed both ways on a phone keyboard, and
    -- an accent deciding whether a policy is found is a silent miss.
    --
    -- agent_id is UNINDEXED so it can never be MATCHed as text: it is a scope,
    -- not a search term, and a query that could reach it could name another
    -- agent's chunks. Every read filters on it in SQL (see searchChunks).
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks USING fts5(
      agent_id UNINDEXED,
      source UNINDEXED,
      ordinal UNINDEXED,
      heading,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    -- What each agent's indexed content currently is, so a boot that changes
    -- nothing writes nothing. Without it every restart would delete and
    -- re-insert every chunk, which is correct but leaves a window in which a
    -- turn running in ANOTHER process sees an empty knowledge base.
    CREATE TABLE IF NOT EXISTS knowledge_index (
      agent_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- WHO may speak through the agent door, and what each caller may reach.
    --
    -- THIS TABLE IS THE SWITCH. The door authenticates by looking a presented
    -- token up in here, so an empty table matches nothing and every request is
    -- refused — that is the whole "off by default" story, and there is no
    -- separate flag that a deployment could leave on by accident.
    --
    -- token_hash, never a token: this file is copied by data/backup.ts and
    -- lives on a volume, so a stored credential would sit in every copy of it.
    -- SHA-256 is enough BECAUSE the token is 256 random bits (see
    -- data/agent-registry.ts): there is no dictionary to run against it, which
    -- is what makes the slow-KDF reasoning for passwords not apply here.
    --
    -- reach is a JSON array of agent ids, and it is the OPERATOR's copy of the
    -- permission: an agent definition's own reach list says what that agent was
    -- designed to ask, this says what this deployment permits for this
    -- credential, and the door consults the one that belongs to the caller it
    -- authenticated.
    --
    -- callback_prefix is the only URL family this caller may name in replyTo.
    -- NULL means it may name none, which is the default: a callback is a
    -- request WE make to a URL a request body chose.
    CREATE TABLE IF NOT EXISTS agent_registry (
      agent_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      reach TEXT NOT NULL DEFAULT '[]',
      callback_prefix TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      rotated_at TEXT
    );

    -- WHO is an owner, and therefore which assistant answers them.
    --
    -- THIS TABLE IS THE ROLE BOUNDARY. It replaces OWNER_PHONE_NUMBERS as the
    -- authority (router.ts reads it for every inbound message); the variable
    -- survives as a SEED, copied in at boot for phones that have no row yet
    -- (data/assignments.ts seedOwnerAssignments). A deployment that sets the
    -- variable and knows nothing about this table keeps working unchanged.
    --
    -- A MISSING ROW IS A CUSTOMER, never an error and never an owner. That is
    -- today's behaviour and the only safe default: an unknown phone repricing a
    -- live store is the failure this whole boundary exists to prevent.
    --
    -- phone is normalizePhone's output — bare E.164 digits — because that is
    -- what the WhatsApp door produces and what every lookup normalises to.
    -- ONE normalisation, or an owner who wrote their number with a '+' reads as
    -- a customer for the life of the deployment. A LID is NOT a phone number
    -- (see CLAUDE.md); its digits would land here looking like one, so the
    -- lookup is exact equality and nothing else.
    --
    -- The CHECK lists the roles this build actually serves. A third role would
    -- be dead configuration that reads, to whoever writes it, like a privilege
    -- somebody honours — and nothing does.
    --
    -- A new table, so IF NOT EXISTS IS the migration for a database that
    -- predates it: nothing here alters an existing table.
    CREATE TABLE IF NOT EXISTS assignments (
      phone TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('owner','customer')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);
    -- Every batch flush claims one CONVERSATION's un-settled rows. The index
    -- that serves that claim is created in migrate() below, not here: on a
    -- database from an older build the column does not exist yet at this point,
    -- and CREATE INDEX over a missing column fails the boot outright.
    --
    -- The (phone, status) index stays. It no longer serves the claim, but it is
    -- what makes "everything this person ever sent" answerable, and dropping an
    -- index is not something to do on the same boot that adds six columns to
    -- the table it belongs to.
    CREATE INDEX IF NOT EXISTS idx_inbox_phone_status ON inbox(phone, status);
    CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
    CREATE INDEX IF NOT EXISTS idx_pending_media_phone ON pending_media(phone);
  `);

  migrate(db, options);
}

/**
 * Bring a database created by an older build up to the schema above.
 *
 * CREATE TABLE IF NOT EXISTS never alters a table that already exists, so a
 * column added to the definition above reaches new databases only — the running
 * pilot would keep its original table and every query naming the new column
 * would throw at runtime. Each step here is idempotent and runs on every boot.
 */
function migrate(db: DB, options: SchemaOptions): void {
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
  // The envelope: one inbox, two doors. Every one of these is nullable or has a
  // CONSTANT default, which is all ALTER TABLE ADD COLUMN accepts — a NOT NULL
  // column whose default had to be read from another column could not be added
  // to the running pilot's table at all, which is why conversation_key arrives
  // nullable and is filled by the backfill below.
  addColumn(db, "inbox", "agent_id", "TEXT");
  addColumn(db, "inbox", "principal_kind", "TEXT NOT NULL DEFAULT 'whatsapp'");
  addColumn(db, "inbox", "principal_id", "TEXT");
  addColumn(db, "inbox", "conversation_key", "TEXT");
  addColumn(db, "inbox", "reply_to", "TEXT");
  addColumn(db, "inbox", "hop", "INTEGER NOT NULL DEFAULT 0");
  backfillInboxEnvelope(db);
  // Created HERE rather than in createSchema: the column it indexes is added by
  // the step immediately above, so on an existing database a CREATE INDEX in
  // the schema block would run against a table that does not have it yet and
  // fail the boot.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_inbox_conversation_status
       ON inbox(conversation_key, status);`,
  );
  // The one step that is not a column: sessions changed their primary key.
  migrateSessionsKey(db, options.legacyAgentIdFor);
}

/**
 * Give every legacy inbox row the envelope its door never wrote.
 *
 * A row from an older build is a WhatsApp row by definition — that was the only
 * door — so its conversation is its phone and its principal is that same phone.
 * `principal_kind` needs nothing: the ADD COLUMN above defaults it to
 * 'whatsapp', which is what those rows are.
 *
 * RUN ON EVERY BOOT, deliberately, rather than only on the boot that added the
 * columns. Both statements match only NULLs and every writer since fills both,
 * so the steady-state cost is one scan of a table the TTL keeps to days — and
 * the alternative is worse than that cost: a crash between the ALTER and the
 * UPDATE would leave rows whose conversation_key is NULL, which claimInboxBatch
 * can never match, and those messages would sit unanswered forever with nothing
 * reporting it.
 */
function backfillInboxEnvelope(db: DB): void {
  db.exec(`
    UPDATE inbox SET conversation_key = phone WHERE conversation_key IS NULL;
    UPDATE inbox SET principal_id = phone WHERE principal_id IS NULL;
  `);
}

/**
 * Re-key `sessions` from (phone) to (agent_id, conversation_key).
 *
 * A REBUILD, because neither tool available does the job: CREATE TABLE IF NOT
 * EXISTS is a no-op against the table that is already there, and SQLite's ALTER
 * TABLE cannot add, drop or change a primary key. So: create, copy, drop,
 * rename — the sequence SQLite's own documentation prescribes for this.
 *
 * IDEMPOTENT BY THE SHAPE ITSELF, not by a version counter. The guard is the
 * presence of `conversation_key`, a column that exists only after this has run,
 * so a second boot returns before touching anything. That matters more than it
 * looks: a rebuild that ran twice would find an empty legacy table the second
 * time and replace every session migrated by the first, silently resetting
 * every live conversation on the next redeploy.
 *
 * The check and the rebuild share ONE immediate transaction. A deferred one
 * takes its read lock first and can only discover a competing writer when it
 * tries to upgrade, which — with two servers pointed at the same file — is how
 * one process reads the old shape, waits, and then copies from a table that has
 * already been replaced. Taking the write lock up front makes the loser block
 * on it and then re-read the shape inside the lock, where it sees the migration
 * is done and does nothing.
 */
function migrateSessionsKey(db: DB, legacyAgentIdFor?: (phone: string) => string): void {
  const rebuild = db.transaction(() => {
    const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    // Already re-keyed (or created fresh at the new shape) — nothing to do.
    if (columns.some((c) => c.name === "conversation_key")) return;

    const legacy = legacyAgentIdFor
      ? (db.prepare(`SELECT phone, agent_session_id, updated_at FROM sessions`).all() as {
          phone: string;
          agent_session_id: string | null;
          updated_at: string;
        }[])
      : [];

    db.exec(`
      CREATE TABLE sessions_rekeyed (
        agent_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        agent_session_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, conversation_key)
      );
    `);

    const insert = db.prepare(
      `INSERT INTO sessions_rekeyed (agent_id, conversation_key, agent_session_id, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const row of legacy) {
      // updated_at is carried over VERBATIM. Expiry is a sliding window
      // measured from it, so stamping the copies with now() would resurrect
      // every session the window had already retired and drag months of
      // history — and its cost — back into the next turn.
      //
      // A plain INSERT: the source key was a primary key, so two rows cannot
      // collide here. If one somehow does, the whole transaction rolls back
      // with the legacy table intact and the boot fails loudly, which is the
      // safe direction to fail in.
      insert.run(legacyAgentIdFor!(row.phone), row.phone, row.agent_session_id, row.updated_at);
    }

    db.exec(`DROP TABLE sessions;`);
    db.exec(`ALTER TABLE sessions_rekeyed RENAME TO sessions;`);
  });

  rebuild.immediate();
}

/** Add a column unless the table already has it. Table/column names are literals. */
function addColumn(db: DB, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

