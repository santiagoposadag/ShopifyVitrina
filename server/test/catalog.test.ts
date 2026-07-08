import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import {
  attachPendingPhotos,
  addPendingMedia,
  getProductByCode,
  insertLead,
  listLeads,
  searchCatalog,
  upsertProduct,
} from "../src/repo.js";

function seed(db: DB): void {
  upsertProduct(
    db,
    {
      code: "916",
      title: "Casa en Rionegro",
      price: 1_150_000_000,
      status: "active",
      attributes: { bedrooms: 4, neighborhood: "Barro Blanco", city: "Rionegro", area_m2: 230 },
    },
    null,
  );
  upsertProduct(
    db,
    {
      code: "1912",
      title: "Apartamento en Belén",
      price: 670_000_000,
      status: "active",
      attributes: { bedrooms: 3, neighborhood: "Belén Rosales", city: "Medellín", area_m2: 78 },
    },
    null,
  );
  // A draft should never show up in search.
  upsertProduct(
    db,
    { code: "999", title: "Borrador", price: 100_000_000, status: "draft", attributes: { bedrooms: 2 } },
    null,
  );
}

describe("searchCatalog", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
    seed(db);
  });

  it("returns only active products", () => {
    const all = searchCatalog(db, {});
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.code).sort()).toEqual(["1912", "916"]);
  });

  it("filters by max_price", () => {
    const results = searchCatalog(db, { max_price: 700_000_000 });
    expect(results.map((p) => p.code)).toEqual(["1912"]);
  });

  it("filters by min_price", () => {
    const results = searchCatalog(db, { min_price: 1_000_000_000 });
    expect(results.map((p) => p.code)).toEqual(["916"]);
  });

  it("filters by minimum bedrooms", () => {
    const results = searchCatalog(db, { bedrooms: 4 });
    expect(results.map((p) => p.code)).toEqual(["916"]);
  });

  it("filters by neighborhood (case-insensitive)", () => {
    const results = searchCatalog(db, { neighborhood: "belén" });
    expect(results.map((p) => p.code)).toEqual(["1912"]);
  });

  it("matches free-text query over title and features", () => {
    const results = searchCatalog(db, { query: "Rionegro" });
    expect(results.map((p) => p.code)).toEqual(["916"]);
  });
});

describe("upsertProduct", () => {
  it("creates then updates, applying a code correction and audit trail", () => {
    const db = openDb(":memory:");
    const created = upsertProduct(db, { code: "008", title: "Apto", price: 670_000_000 }, "573001");
    expect(created.created).toBe(true);
    expect(created.product.status).toBe("draft");

    // Simulate the "el código ya es 1912" correction by upserting the new code.
    const corrected = upsertProduct(
      db,
      { code: "1912", title: "Apto", price: 670_000_000, status: "active" },
      "573001",
    );
    expect(corrected.created).toBe(true);

    // Price update on the same code writes a change row.
    upsertProduct(db, { code: "1912", price: 650_000_000 }, "573001");
    const changes = db
      .prepare(`SELECT COUNT(*) AS n FROM product_changes WHERE product_id = ?`)
      .get(corrected.product.id) as { n: number };
    expect(changes.n).toBeGreaterThanOrEqual(2);

    const fresh = getProductByCode(db, "1912");
    expect(fresh?.price).toBe(650_000_000);
    db.close();
  });

  it("merges attributes instead of replacing them", () => {
    const db = openDb(":memory:");
    upsertProduct(db, { code: "1", attributes: { bedrooms: 3, city: "Medellín" } }, null);
    upsertProduct(db, { code: "1", attributes: { bathrooms: 2 } }, null);
    const p = getProductByCode(db, "1");
    expect(p?.attributes.bedrooms).toBe(3);
    expect(p?.attributes.bathrooms).toBe(2);
    expect(p?.attributes.city).toBe("Medellín");
    db.close();
  });
});

describe("leads", () => {
  it("inserts and lists leads", () => {
    const db = openDb(":memory:");
    insertLead(db, { phone: "573001", type: "visit_request", name: "Ana", note: "Sábado 10am" });
    insertLead(db, { phone: "573002", type: "inquiry", product_code: "916" });
    expect(listLeads(db)).toHaveLength(2);
    db.close();
  });
});

describe("attachPendingPhotos", () => {
  it("moves a phone's pending media onto a product", () => {
    const db = openDb(":memory:");
    const { product } = upsertProduct(db, { code: "1912", title: "Apto" }, "573001");
    addPendingMedia(db, {
      phone: "573001",
      file_path: "/tmp/a.jpg",
      public_path: "http://x/media/a.jpg",
    });
    addPendingMedia(db, {
      phone: "573001",
      file_path: "/tmp/b.jpg",
      public_path: "http://x/media/b.jpg",
    });
    // Media from a different phone must not attach.
    addPendingMedia(db, {
      phone: "573999",
      file_path: "/tmp/c.jpg",
      public_path: "http://x/media/c.jpg",
    });

    const count = attachPendingPhotos(db, "573001", product.id);
    expect(count).toBe(2);

    const photos = db
      .prepare(`SELECT COUNT(*) AS n FROM product_photos WHERE product_id = ?`)
      .get(product.id) as { n: number };
    expect(photos.n).toBe(2);

    // Second attach should find nothing left for this phone.
    expect(attachPendingPhotos(db, "573001", product.id)).toBe(0);
    db.close();
  });
});
