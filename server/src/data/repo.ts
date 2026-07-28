import { unlinkSync } from "node:fs";
import type { DB } from "./db.js";
import type {
  Lead,
  LeadType,
  MessageKind,
  Product,
  ProductAttributes,
  ProductAttributeUpdates,
  ProductPhoto,
  ProductStatus,
} from "../types.js";

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
  /** Relevance floor, 0..1. Defaults to DEFAULT_MIN_SCORE. */
  min_score?: number;
}

/** A product the search kept, with how well its text answered the request. */
export interface SearchHit {
  product: Product;
  score: number;
}

/**
 * How much of what was asked for a listing must account for to come back at all.
 *
 * A floor rather than a cutoff the caller tunes per question: the agent decides
 * which of the survivors to show, but it does not get to widen its own search
 * until something appears. Empty means empty — we have nothing like that.
 */
export const DEFAULT_MIN_SCORE = 0.6;

/** Above this, the text answered the request rather than merely resembling it. */
export const CONFIDENT_MATCH_SCORE = 0.8;

const MAX_RESULTS = 10;

/** Below this length a word is too short for an edit-distance guess to mean anything. */
const FUZZY_MIN_LENGTH = 4;
const FUZZY_MIN_RATIO = 0.8;
const FUZZY_SCORE = 0.8;

/**
 * Spanish function words. They carry no information about a property, and left
 * in they would drag every score down by the length of the sentence: "casa en
 * llano grande" would cap at 3/4 even with a perfect match.
 */
const STOPWORDS = new Set([
  "a", "al", "algun", "alguna", "algunas", "alguno", "algunos", "con", "cual", "cuales", "de",
  "del", "el", "en", "es", "esta", "hay", "la", "las", "lo", "los", "me", "mi", "o", "para", "por",
  "que", "se", "si", "sin", "su", "sus", "tenemos", "tiene", "tienen", "un", "una", "unas", "unos",
  "y",

  // Not grammar — these name the catalog itself. Every listing is a propiedad
  // and every question is someone buscando one, so the words cannot tell two
  // listings apart, and counting them as misses punishes the natural way of
  // asking: "¿Tenemos alguna propiedad en Llano Grande?" would cap at 2/3 and
  // trip the approximate-match warning over an exact answer.
  "algo", "busca", "buscamos", "buscando", "busco", "disponible", "disponibles", "inmueble",
  "inmuebles", "necesito", "propiedad", "propiedades", "quiero",
]);

/** Lowercase, unaccented, punctuation-free. Applied to BOTH sides of every comparison. */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    // Strip the combining marks NFD just split off. Doing it BEFORE the
    // punctuation pass matters: left in, an accent would become a space and
    // "belen" would arrive as two words.
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  if (!value) return [];
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/**
 * The structured attributes, said the way a person would say them.
 *
 * Nobody asks for "un apartamento" — they ask for "un apartamento de 3 alcobas
 * en Laureles". Bedrooms is a number in a column, so without this the words
 * "3 alcobas" are two guaranteed misses that drag the score of the listing that
 * actually answers the question below the floor. Both Colombian words for a
 * bedroom are emitted because both get typed; this is verbalizing one field,
 * not a synonym table.
 *
 * Booleans are emitted only when true: a listing without an elevator must not
 * answer to "ascensor".
 */
function attributeText(a: ProductAttributes): string {
  const parts: string[] = [];
  if (a.bedrooms != null) parts.push(`${a.bedrooms} alcobas habitaciones`);
  if (a.bathrooms != null) parts.push(`${a.bathrooms} banos`);
  if (a.area_m2 != null) parts.push(`${a.area_m2} m2 metros`);
  if (a.lot_m2 != null) parts.push(`${a.lot_m2} lote`);
  if (a.levels != null) parts.push(`${a.levels} niveles`);
  if (a.floor != null) parts.push(`piso ${a.floor}`);
  if (a.estrato != null) parts.push(`estrato ${a.estrato}`);
  if (a.elevator) parts.push("ascensor");
  return parts.join(" ");
}

/**
 * Every word of a product's text, PLUS every adjacent pair glued together.
 *
 * The pairs are what make word boundaries stop mattering in either direction:
 * a search for "llanogrande" finds a listing that says "Llano Grande", and a
 * search for "llano grande" finds one that says "Llanogrande" because each
 * token is contained in that single word. Gluing the whole haystack instead
 * would invent matches across unrelated words ("piso rojo" would answer to
 * "oro"), so the joins stay pairwise.
 */
function wordsAndPairs(raw: string): string[] {
  const words = normalize(raw).split(" ").filter(Boolean);
  const pairs = words.slice(0, -1).map((word, i) => word + words[i + 1]);
  return [...words, ...pairs];
}

function haystackFor(p: Product): string[] {
  return wordsAndPairs(
    [
      p.title,
      p.description ?? "",
      p.code,
      p.attributes.neighborhood ?? "",
      p.attributes.city ?? "",
      (p.attributes.features ?? []).join(" "),
      attributeText(p.attributes),
    ].join(" "),
  );
}

/** The location fields alone — the tie-break haystack, see searchCatalog. */
function locationHaystackFor(p: Product): string[] {
  return wordsAndPairs(`${p.attributes.neighborhood ?? ""} ${p.attributes.city ?? ""}`);
}

/**
 * Standard Levenshtein, two rows. Only ever runs on single words.
 *
 * Every `?? 0` below is unreachable — both rows are built to length b.length+1
 * and every index is bounded by its loop — but noUncheckedIndexedAccess cannot
 * see that, and a fallback reads better here than an assertion.
 */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitute = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insert = (current[j - 1] ?? 0) + 1;
      const remove = (previous[j] ?? 0) + 1;
      current.push(Math.min(substitute, insert, remove));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** 1 for a contained word, FUZZY_SCORE for a probable typo, 0 for a miss. */
function scoreToken(token: string, haystack: string[]): number {
  // A number is a value, not a word fragment: "3 alcobas" must not be answered
  // by an area of 230 m². Exact word only, and never fuzzy — a mistyped number
  // is a different number, not a misspelling.
  if (/^\d+$/.test(token)) return haystack.includes(token) ? 1 : 0;

  if (haystack.some((word) => word.includes(token))) return 1;
  if (token.length < FUZZY_MIN_LENGTH) return 0;

  for (const word of haystack) {
    // A word that differs in length by more than a couple of characters is a
    // different word, not a misspelling — and skipping it keeps the glued
    // pairs from fuzzy-matching short tokens.
    if (Math.abs(word.length - token.length) > 2) continue;
    const ratio = 1 - editDistance(token, word) / Math.max(token.length, word.length);
    if (ratio >= FUZZY_MIN_RATIO) return FUZZY_SCORE;
  }
  return 0;
}

/**
 * Search ACTIVE products, ranked by how much of the request each one answers.
 *
 * Two kinds of filter, deliberately not treated alike:
 *
 * - price and bedrooms EXCLUDE. They are constraints someone stated, not
 *   preferences to weigh: a listing at five times the budget is not a partial
 *   match, it is the wrong property, and surfacing it "because it scored well
 *   on text" wastes the customer's time.
 * - `query` and `neighborhood` SCORE. Both are prose, both arrive however the
 *   person happened to say it, and neither should ever be the reason a real
 *   listing goes unmentioned. They share one token bag against one haystack:
 *   in real estate a sector named in the description ("cerca de Laureles") is
 *   genuine signal, and the agent is the one judging relevance anyway.
 */
export function searchCatalog(db: DB, filters: SearchFilters): SearchHit[] {
  const rows = db
    .prepare(`SELECT * FROM products WHERE status = 'active' ORDER BY updated_at DESC`)
    .all() as ProductRow[];

  const tokens = [...tokenize(filters.query ?? ""), ...tokenize(filters.neighborhood ?? "")];
  const minScore = filters.min_score ?? DEFAULT_MIN_SCORE;

  const hits: (SearchHit & { locationScore: number })[] = [];
  for (const row of rows) {
    const product = rowToProduct(row);

    if (filters.min_price !== undefined && (product.price ?? 0) < filters.min_price) continue;
    if (
      filters.max_price !== undefined &&
      (product.price ?? Number.MAX_SAFE_INTEGER) > filters.max_price
    )
      continue;
    if (filters.bedrooms !== undefined && (product.attributes.bedrooms ?? -1) < filters.bedrooms)
      continue;

    // No text asked for means every survivor answers the request equally.
    if (tokens.length === 0) {
      hits.push({ product, score: 1, locationScore: 0 });
      continue;
    }

    const scoreAgainst = (haystack: string[]): number =>
      tokens.reduce((sum, token) => sum + scoreToken(token, haystack), 0) / tokens.length;

    const score = scoreAgainst(haystackFor(product));
    if (score < minScore) continue;
    hits.push({ product, score, locationScore: scoreAgainst(locationHaystackFor(product)) });
  }

  // The tie-break exists because a description that cross-references a sector
  // ("a 7 minutos de Jardines de Llanogrande") scores exactly as high as the
  // listing that IS in it, and both deserve to come back. Which one leads is
  // then decided by where the words were found: the structured field beats a
  // passing mention. Without it, the answer to "¿tienen algo en Llanogrande?"
  // would open with the neighbouring house whenever that one was edited more
  // recently — sort is stable, so equal ranks keep the SQL order and the only
  // signal left is updated_at.
  return hits
    .sort((a, b) => b.score - a.score || b.locationScore - a.locationScore)
    .slice(0, MAX_RESULTS)
    .map(({ product, score }) => ({ product, score }));
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
 * Every stored session, regardless of age. Deliberately unfiltered, unlike
 * getSessionId: the callers are housekeeping and the purge tool, and a session
 * too old to RESUME still owns a transcript on disk that must not be swept as
 * an orphan until its row is actually gone.
 */
export function listSessions(db: DB): { phone: string; agent_session_id: string }[] {
  return db
    .prepare(
      `SELECT phone, agent_session_id FROM sessions WHERE agent_session_id IS NOT NULL`,
    )
    .all() as { phone: string; agent_session_id: string }[];
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
  /** What the event was, straight from the webhook — never re-derived from the text. */
  kind: MessageKind;
  /** Set while a voice note still needs transcribing; null once agent_text holds it. */
  audio_path: string | null;
  status: InboxStatus;
  attempts: number;
  received_at: string;
  processed_at: string | null;
}

/**
 * Persist an inbound message for processing. Returns the new row, or null when
 * the dedupe key was already recorded (a Kapso retry of a persisted event).
 *
 * `kind` defaults to "text" so callers that deal only in chat stay unchanged;
 * the webhook always passes what it parsed.
 */
export function insertInboxMessage(
  db: DB,
  input: {
    dedupe_key: string;
    phone: string;
    agent_text: string;
    kind?: MessageKind;
    audio_path?: string | null;
  },
): InboxRow | null {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO inbox (dedupe_key, phone, agent_text, kind, audio_path)
       VALUES (@dedupe_key, @phone, @agent_text, @kind, @audio_path)`,
    )
    .run({ kind: "text", audio_path: null, ...input });
  if (info.changes === 0) return null;
  return getInboxRow(db, Number(info.lastInsertRowid));
}

/**
 * Record a voice note's transcript and retire its audio.
 *
 * Both fields move together, in one statement, because they are the same fact:
 * clearing audio_path is what marks the audio as already paid for. A batch that
 * fails downstream is retried, and without this every retry would re-upload and
 * re-bill the same seconds of speech.
 */
export function setInboxTranscript(db: DB, id: number, transcript: string): void {
  db.prepare(`UPDATE inbox SET agent_text = @transcript, audio_path = NULL WHERE id = @id`).run({
    id,
    transcript,
  });
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
  const select = db.prepare(
    `SELECT * FROM inbox
     WHERE phone = ? AND status IN ('pending','processing')
     ORDER BY received_at ASC, id ASC`,
  );
  const claim = db.prepare(
    `UPDATE inbox SET status = 'processing', attempts = attempts + 1 WHERE id = ?`,
  );
  // Read and claim share one transaction, so the batch is atomic even if a
  // future caller ever violates the per-phone-queue invariant above.
  const tx = db.transaction((): InboxRow[] => {
    const rows = select.all(phone) as InboxRow[];
    for (const row of rows) claim.run(row.id);
    return rows.map((row) => ({ ...row, status: "processing" as const, attempts: row.attempts + 1 }));
  });
  return tx();
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
 * Return a claimed batch to 'pending' for a delayed retry. attempts is NOT
 * reset — it is the retry budget (see MAX_BATCH_ATTEMPTS in batcher.ts). The
 * rows are re-claimed by the next flush for that phone, together with any newer
 * messages, so a retried batch may grow; ordering holds because the old rows
 * keep their original received_at/id.
 */
export function markInboxBatchPending(db: DB, ids: number[]): void {
  const mark = db.prepare(`UPDATE inbox SET status = 'pending' WHERE id = ?`);
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
