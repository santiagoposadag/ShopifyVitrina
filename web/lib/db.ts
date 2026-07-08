import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { dbPath } from "./paths";

export interface ProductAttributes {
  area_m2?: number;
  bedrooms?: number;
  bathrooms?: number;
  neighborhood?: string;
  city?: string;
  features?: string[];
  admin_fee?: number;
  estrato?: number;
  levels?: number;
  floor?: number;
  elevator?: boolean;
  negotiable?: boolean;
  [key: string]: unknown;
}

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
