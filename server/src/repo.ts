import { unlinkSync } from "node:fs";
import type { DB } from "./db.js";
import type {
  Lead,
  LeadType,
  Product,
  ProductAttributes,
  ProductAttributeUpdates,
  ProductPhoto,
  ProductStatus,
} from "./types.js";

interface ProductRow {
  id: number;
  code: string;
  title: string;
  description: string | null;
  price: number | null;
  currency: string;
  status: ProductStatus;
  attributes: string;
  created_at: string;
  updated_at: string;
}

function rowToProduct(row: ProductRow): Product {
  let attributes: ProductAttributes = {};
  try {
    attributes = JSON.parse(row.attributes) as ProductAttributes;
  } catch {
    attributes = {};
  }
  return { ...row, attributes };
}

export interface SearchFilters {
  query?: string;
  min_price?: number;
  max_price?: number;
  bedrooms?: number;
  neighborhood?: string;
}

/** Search ACTIVE products only, applying simple filters. */
export function searchCatalog(db: DB, filters: SearchFilters): Product[] {
  const rows = db
    .prepare(`SELECT * FROM products WHERE status = 'active' ORDER BY updated_at DESC`)
    .all() as ProductRow[];

  const q = filters.query?.toLowerCase().trim();
  const neighborhood = filters.neighborhood?.toLowerCase().trim();

  return rows.map(rowToProduct).filter((p) => {
    if (filters.min_price !== undefined && (p.price ?? 0) < filters.min_price) return false;
    if (filters.max_price !== undefined && (p.price ?? Number.MAX_SAFE_INTEGER) > filters.max_price)
      return false;
    if (filters.bedrooms !== undefined && (p.attributes.bedrooms ?? -1) < filters.bedrooms)
      return false;
    if (neighborhood) {
      const hay = `${p.attributes.neighborhood ?? ""} ${p.attributes.city ?? ""}`.toLowerCase();
      if (!hay.includes(neighborhood)) return false;
    }
    if (q) {
      const hay = [
        p.title,
        p.description ?? "",
        p.code,
        p.attributes.neighborhood ?? "",
        p.attributes.city ?? "",
        (p.attributes.features ?? []).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function getProductByCode(db: DB, code: string): Product | undefined {
  const row = db.prepare(`SELECT * FROM products WHERE code = ?`).get(code) as
    | ProductRow
    | undefined;
  return row ? rowToProduct(row) : undefined;
}

export function listProducts(db: DB, status?: ProductStatus): Product[] {
  const rows = (
    status
      ? db.prepare(`SELECT * FROM products WHERE status = ? ORDER BY updated_at DESC`).all(status)
      : db.prepare(`SELECT * FROM products ORDER BY updated_at DESC`).all()
  ) as ProductRow[];
  return rows.map(rowToProduct);
}

export function getProductPhotos(db: DB, productId: number): ProductPhoto[] {
  return db
    .prepare(`SELECT * FROM product_photos WHERE product_id = ? ORDER BY sort ASC, id ASC`)
    .all(productId) as ProductPhoto[];
}

export interface UpsertProductInput {
  code: string;
  title?: string;
  description?: string;
  price?: number;
  currency?: string;
  status?: ProductStatus;
  attributes?: ProductAttributeUpdates;
}

/**
 * Merge incoming attributes into the stored ones, key by key. An explicit null
 * REMOVES the key rather than storing a null: the owner's only way to un-say a
 * fact (the agent has been known to invent one), and the stored JSON keeps
 * matching ProductAttributes, where absent means absent.
 *
 * Only null clears. Falsy values like 0 (no admin fee) and false (no elevator)
 * are facts the owner stated and are preserved.
 */
function mergeAttributes(
  existing: ProductAttributes,
  incoming: ProductAttributeUpdates | undefined,
): ProductAttributes {
  const merged: ProductAttributes = { ...existing };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

export interface UpsertResult {
  product: Product;
  created: boolean;
}

/**
 * Create a draft product or update an existing one by code. Only provided
 * fields are changed. Records an audit row in product_changes.
 */
export function upsertProduct(
  db: DB,
  input: UpsertProductInput,
  changedByPhone: string | null,
): UpsertResult {
  const existing = getProductByCode(db, input.code);

  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO products (code, title, description, price, currency, status, attributes)
         VALUES (@code, @title, @description, @price, @currency, @status, @attributes)`,
      )
      .run({
        code: input.code,
        title: input.title ?? `Producto ${input.code}`,
        description: input.description ?? null,
        price: input.price ?? null,
        currency: input.currency ?? "COP",
        status: input.status ?? "draft",
        attributes: JSON.stringify(mergeAttributes({}, input.attributes)),
      });
    const product = getProductById(db, Number(info.lastInsertRowid));
    recordChange(db, product.id, changedByPhone, `Created product ${input.code}`);
    return { product, created: true };
  }

  const merged = mergeAttributes(existing.attributes, input.attributes);
  const changes: string[] = [];
  if (input.title !== undefined && input.title !== existing.title) changes.push("title");
  if (input.description !== undefined && input.description !== existing.description)
    changes.push("description");
  if (input.price !== undefined && input.price !== existing.price) changes.push("price");
  if (input.status !== undefined && input.status !== existing.status) changes.push("status");
  if (input.attributes !== undefined) changes.push("attributes");

  db.prepare(
    `UPDATE products SET
       title = @title,
       description = @description,
       price = @price,
       currency = @currency,
       status = @status,
       attributes = @attributes,
       updated_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id: existing.id,
    title: input.title ?? existing.title,
    description: input.description ?? existing.description,
    price: input.price ?? existing.price,
    currency: input.currency ?? existing.currency,
    status: input.status ?? existing.status,
    attributes: JSON.stringify(merged),
  });

  const product = getProductById(db, existing.id);
  recordChange(
    db,
    product.id,
    changedByPhone,
    changes.length > 0 ? `Updated ${changes.join(", ")}` : "No-op update",
  );
  return { product, created: false };
}

export function getProductById(db: DB, id: number): Product {
  const row = db.prepare(`SELECT * FROM products WHERE id = ?`).get(id) as ProductRow | undefined;
  if (!row) throw new Error(`Product ${id} not found`);
  return rowToProduct(row);
}

export function recordChange(
  db: DB,
  productId: number,
  changedByPhone: string | null,
  summary: string,
): void {
  db.prepare(
    `INSERT INTO product_changes (product_id, changed_by_phone, change_summary)
     VALUES (?, ?, ?)`,
  ).run(productId, changedByPhone, summary);
}

export function insertPhoto(
  db: DB,
  photo: { product_id: number; file_path: string; public_path: string; caption?: string | null; sort?: number },
): void {
  db.prepare(
    `INSERT INTO product_photos (product_id, file_path, public_path, caption, sort)
     VALUES (@product_id, @file_path, @public_path, @caption, @sort)`,
  ).run({
    product_id: photo.product_id,
    file_path: photo.file_path,
    public_path: photo.public_path,
    caption: photo.caption ?? null,
    sort: photo.sort ?? 0,
  });
}

export interface LeadInput {
  phone: string;
  product_code?: string | null;
  type: LeadType;
  name?: string | null;
  note?: string | null;
}

export function insertLead(db: DB, input: LeadInput): Lead {
  const info = db
    .prepare(
      `INSERT INTO leads (phone, product_code, type, name, note)
       VALUES (@phone, @product_code, @type, @name, @note)`,
    )
    .run({
      phone: input.phone,
      product_code: input.product_code ?? null,
      type: input.type,
      name: input.name ?? null,
      note: input.note ?? null,
    });
  return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(Number(info.lastInsertRowid)) as Lead;
}

export function listLeads(db: DB, sinceDays?: number): Lead[] {
  if (sinceDays !== undefined) {
    return db
      .prepare(
        `SELECT * FROM leads WHERE created_at >= datetime('now', ?) ORDER BY created_at DESC`,
      )
      .all(`-${sinceDays} days`) as Lead[];
  }
  return db.prepare(`SELECT * FROM leads ORDER BY created_at DESC`).all() as Lead[];
}

// --- Contacts / sessions ------------------------------------------------------

export function upsertContact(
  db: DB,
  phone: string,
  role: string,
  name?: string | null,
): void {
  db.prepare(
    `INSERT INTO contacts (phone, name, role, last_seen_at)
     VALUES (@phone, @name, @role, datetime('now'))
     ON CONFLICT(phone) DO UPDATE SET
       role = excluded.role,
       last_seen_at = excluded.last_seen_at,
       name = COALESCE(excluded.name, contacts.name)`,
  ).run({ phone, name: name ?? null, role });
}

/**
 * Get the resumable agent session for a phone. When maxAgeDays is given,
 * sessions idle longer than that are treated as expired (returns undefined) so
 * long-lived contacts start a fresh conversation instead of dragging months of
 * history — and cost — into every turn.
 */
export function getSessionId(db: DB, phone: string, maxAgeDays?: number): string | undefined {
  const row = (
    maxAgeDays !== undefined
      ? db
          .prepare(
            `SELECT agent_session_id FROM sessions
             WHERE phone = ? AND updated_at >= datetime('now', ?)`,
          )
          .get(phone, `-${maxAgeDays} days`)
      : db.prepare(`SELECT agent_session_id FROM sessions WHERE phone = ?`).get(phone)
  ) as { agent_session_id: string | null } | undefined;
  return row?.agent_session_id ?? undefined;
}

/**
 * Forget a phone's stored session id. Used when the SDK cannot resume it — the
 * transcript is gone, so keeping the id only guarantees the next turn fails the
 * same way (a replayed inbox row would resume the same dead session).
 */
export function clearSessionId(db: DB, phone: string): void {
  db.prepare(`DELETE FROM sessions WHERE phone = ?`).run(phone);
}

export function setSessionId(db: DB, phone: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (phone, agent_session_id, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(phone) DO UPDATE SET
       agent_session_id = excluded.agent_session_id,
       updated_at = excluded.updated_at`,
  ).run(phone, sessionId);
}

// --- Inbox (at-least-once message processing) --------------------------------

export type InboxStatus = "pending" | "processing" | "done" | "failed";

export interface InboxRow {
  id: number;
  dedupe_key: string;
  phone: string;
  agent_text: string;
  status: InboxStatus;
  attempts: number;
  received_at: string;
  processed_at: string | null;
}

/**
 * Persist an inbound message for processing. Returns the new row, or null when
 * the dedupe key was already recorded (a Kapso retry of a persisted event).
 */
export function insertInboxMessage(
  db: DB,
  input: { dedupe_key: string; phone: string; agent_text: string },
): InboxRow | null {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO inbox (dedupe_key, phone, agent_text)
       VALUES (@dedupe_key, @phone, @agent_text)`,
    )
    .run(input);
  if (info.changes === 0) return null;
  return getInboxRow(db, Number(info.lastInsertRowid));
}

export function getInboxRow(db: DB, id: number): InboxRow | null {
  const row = db.prepare(`SELECT * FROM inbox WHERE id = ?`).get(id) as InboxRow | undefined;
  return row ?? null;
}

/**
 * Claim every un-settled row for a phone as ONE batch: 'pending' rows plus
 * 'processing' rows a previous process crashed on. Marking them in a single
 * transaction keeps at-least-once intact — a crash mid-batch leaves them
 * 'processing', so listReplayableInbox picks the whole burst up again on boot.
 *
 * Ordered by arrival (received_at is only second-resolution, so id breaks ties)
 * because the joined prompt has to read in the order the user typed it.
 *
 * Callers MUST run this inside the phone's queue: serialization is what stops
 * two batches from claiming the same rows.
 */
export function claimInboxBatch(db: DB, phone: string): InboxRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM inbox
       WHERE phone = ? AND status IN ('pending','processing')
       ORDER BY received_at ASC, id ASC`,
    )
    .all(phone) as InboxRow[];
  if (rows.length === 0) return [];

  const claim = db.prepare(
    `UPDATE inbox SET status = 'processing', attempts = attempts + 1 WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const row of rows) claim.run(row.id);
  });
  tx();

  return rows.map((row) => ({ ...row, status: "processing", attempts: row.attempts + 1 }));
}

/** Settle a whole claimed batch. All-or-nothing: one agent turn, one outcome. */
export function markInboxBatchDone(db: DB, ids: number[]): void {
  const mark = db.prepare(
    `UPDATE inbox SET status = 'done', processed_at = datetime('now') WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const id of ids) mark.run(id);
  });
  tx();
}

export function markInboxBatchFailed(db: DB, ids: number[]): void {
  const mark = db.prepare(
    `UPDATE inbox SET status = 'failed', processed_at = datetime('now') WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const id of ids) mark.run(id);
  });
  tx();
}

/**
 * Rows a previous process accepted but never finished: 'pending' (crashed
 * before the queue ran it) or 'processing' (crashed mid agent turn). Ordered by
 * id so per-phone ordering is preserved when re-enqueued.
 */
export function listReplayableInbox(db: DB): InboxRow[] {
  return db
    .prepare(`SELECT * FROM inbox WHERE status IN ('pending','processing') ORDER BY id ASC`)
    .all() as InboxRow[];
}

/**
 * TTL cleanup for settled inbox rows. Done rows only serve dedupe, so a few
 * days beyond Kapso's retry window is plenty; failed rows are kept longer for
 * diagnosis. Returns the number of rows deleted.
 */
export function deleteStaleInboxRows(
  db: DB,
  doneOlderThanDays = 7,
  failedOlderThanDays = 30,
): number {
  const done = db
    .prepare(`DELETE FROM inbox WHERE status = 'done' AND processed_at < datetime('now', ?)`)
    .run(`-${doneOlderThanDays} days`);
  const failed = db
    .prepare(`DELETE FROM inbox WHERE status = 'failed' AND processed_at < datetime('now', ?)`)
    .run(`-${failedOlderThanDays} days`);
  return done.changes + failed.changes;
}

// --- Pending media ----------------------------------------------------------

export function addPendingMedia(
  db: DB,
  media: { phone: string; file_path: string; public_path: string; caption?: string | null },
): void {
  db.prepare(
    `INSERT INTO pending_media (phone, file_path, public_path, caption)
     VALUES (@phone, @file_path, @public_path, @caption)`,
  ).run({
    phone: media.phone,
    file_path: media.file_path,
    public_path: media.public_path,
    caption: media.caption ?? null,
  });
}

interface PendingMediaRow {
  id: number;
  phone: string;
  file_path: string;
  public_path: string;
  caption: string | null;
}

/**
 * Delete unattached pending media older than the given age, removing both the
 * DB rows and the files on disk. Keeps stored inbound media from growing without
 * bound. Returns the number of rows deleted.
 */
export function deleteStalePendingMedia(db: DB, olderThanHours: number): number {
  const rows = db
    .prepare(
      `SELECT id, file_path FROM pending_media
       WHERE attached_product_id IS NULL AND received_at < datetime('now', ?)`,
    )
    .all(`-${olderThanHours} hours`) as { id: number; file_path: string }[];
  if (rows.length === 0) return 0;

  for (const row of rows) {
    try {
      unlinkSync(row.file_path);
    } catch {
      // File may already be gone; deleting the row is what matters.
    }
  }
  const del = db.prepare(`DELETE FROM pending_media WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const row of rows) del.run(row.id);
  });
  tx();
  return rows.length;
}

/**
 * Attach this phone's unattached inbound media to a product. Moves rows from
 * pending_media into product_photos and marks them attached. Returns count.
 */
export function attachPendingPhotos(db: DB, phone: string, productId: number): number {
  const pending = db
    .prepare(
      `SELECT id, phone, file_path, public_path, caption
       FROM pending_media
       WHERE phone = ? AND attached_product_id IS NULL
       ORDER BY received_at ASC, id ASC`,
    )
    .all(phone) as PendingMediaRow[];

  if (pending.length === 0) return 0;

  const baseSort =
    (db.prepare(`SELECT COALESCE(MAX(sort), -1) AS m FROM product_photos WHERE product_id = ?`).get(
      productId,
    ) as { m: number }).m + 1;

  const tx = db.transaction(() => {
    pending.forEach((row, index) => {
      insertPhoto(db, {
        product_id: productId,
        file_path: row.file_path,
        public_path: row.public_path,
        caption: row.caption,
        sort: baseSort + index,
      });
      db.prepare(`UPDATE pending_media SET attached_product_id = ? WHERE id = ?`).run(
        productId,
        row.id,
      );
    });
  });
  tx();
  return pending.length;
}
