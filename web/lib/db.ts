import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { basename } from "node:path";
// Shared with the server (both read the same SQLite rows) — type-only,
// erased at compile time (see shared/index.d.ts).
import type { ProductAttributes } from "@vitrina/shared";
import { anonToken, hasAnonShare } from "./anon";
import { dbPath } from "./paths";

export type { ProductAttributes };

export interface Product {
  id: number;
  code: string;
  title: string;
  description: string | null;
  price: number | null;
  currency: string;
  status: string;
  attributes: ProductAttributes;
  photos: string[]; // storefront photo URLs (/media/<file>)
}

interface ProductRow {
  id: number;
  code: string;
  title: string;
  description: string | null;
  price: number | null;
  currency: string;
  status: string;
  attributes: string;
}

/**
 * Open the shared SQLite database read-only. A fresh connection per call keeps
 * this simple and correct under Next's dynamic rendering; SQLite handles it.
 * Returns null when the DB file does not exist yet (before `npm run seed`).
 */
function openReadonly(): Database.Database | null {
  const path = dbPath();
  if (!existsSync(path)) return null;
  return new Database(path, { readonly: true, fileMustExist: true });
}

function parseAttributes(raw: string): ProductAttributes {
  try {
    return JSON.parse(raw) as ProductAttributes;
  } catch {
    return {};
  }
}

function photoUrlsFor(db: Database.Database, productId: number): string[] {
  const rows = db
    .prepare(`SELECT file_path FROM product_photos WHERE product_id = ? ORDER BY sort ASC, id ASC`)
    .all(productId) as { file_path: string }[];
  return rows.map((r) => `/media/${encodeURIComponent(basename(r.file_path))}`);
}

function hydrate(db: Database.Database, row: ProductRow): Product {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    price: row.price,
    currency: row.currency,
    status: row.status,
    attributes: parseAttributes(row.attributes),
    photos: photoUrlsFor(db, row.id),
  };
}

export function getActiveProducts(): Product[] {
  const db = openReadonly();
  if (!db) return [];
  try {
    const rows = db
      .prepare(`SELECT * FROM products WHERE status = 'active' ORDER BY updated_at DESC`)
      .all() as ProductRow[];
    return rows.map((r) => hydrate(db, r));
  } finally {
    db.close();
  }
}

export function getProductByCode(code: string): Product | null {
  const db = openReadonly();
  if (!db) return null;
  try {
    const row = db
      .prepare(`SELECT * FROM products WHERE code = ? AND status = 'active'`)
      .get(code) as ProductRow | undefined;
    return row ? hydrate(db, row) : null;
  } finally {
    db.close();
  }
}

/**
 * Resolve an anonymous /ver/<token> link to its product. The token is a
 * deterministic HMAC of the code (see lib/anon.ts), so there is nothing to look
 * up by: we recompute it over the ACTIVE catalog and match. Only published
 * listings are shareable, and the pilot catalog is small enough that a scan is
 * cheaper than the stored column (and the write path) a lookup would need — the
 * web workspace stays read-only. Null when sharing is unconfigured or no active
 * product matches.
 */
export function getProductByShareToken(token: string): Product | null {
  if (!token || !hasAnonShare()) return null;
  return getActiveProducts().find((p) => anonToken(p.code) === token) ?? null;
}

/**
 * Read a product of ANY status, for the owner's preview page — the only way to
 * see a draft, since the catalog renders active products only. Deliberately
 * does NOT filter on status; that is the entire point of this function, so
 * never call it from a customer-facing page.
 */
export function getProductForPreview(code: string): Product | null {
  const db = openReadonly();
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT * FROM products WHERE code = ?`).get(code) as
      | ProductRow
      | undefined;
    return row ? hydrate(db, row) : null;
  } finally {
    db.close();
  }
}
