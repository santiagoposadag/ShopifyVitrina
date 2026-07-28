import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/data/db.js";
import {
  attachPendingPhotos,
  addPendingMedia,
  getProductByCode,
  insertLead,
  listLeads,
  listProducts,
  searchCatalog,
  type SearchHit,
  upsertProduct,
} from "../src/data/repo.js";

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
  // Copied from the real catalog: the owner wrote the sector as ONE word. This
  // fixture is the whole point of the scoring rewrite — see the "Llano Grande"
  // test below.
  upsertProduct(
    db,
    {
      code: "0195",
      title: "Casa en Llanogrande - 4 alcobas, 2 niveles",
      price: 2_500_000_000,
      status: "active",
      attributes: {
        bedrooms: 4,
        neighborhood: "Llanogrande",
        features: ["jacuzzi", "turco", "sauna"],
      },
    },
    null,
  );
  // A draft should never show up in search.
  upsertProduct(
    db,
    { code: "999", title: "Borrador", price: 100_000_000, status: "draft", attributes: { bedrooms: 2 } },
    null,
  );
  // Unpublished, and in the same sector as 0195. Invisible to searchCatalog by
  // design — and the reason list_products needed the sector filter, since the
  // owner asking "¿tenemos algo en Llano Grande?" means this one too.
  upsertProduct(
    db,
    {
      code: "0200",
      title: "Lote en Llanogrande",
      status: "draft",
      attributes: { neighborhood: "Llanogrande" },
    },
    null,
  );
}

function codes(hits: SearchHit[]): string[] {
  return hits.map((h) => h.product.code);
}

describe("searchCatalog", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
    seed(db);
  });

  it("returns only active products", () => {
    const all = searchCatalog(db, {});
    expect(all).toHaveLength(3);
    expect(codes(all).sort()).toEqual(["0195", "1912", "916"]);
  });

  it("scores every product 1 when no text was asked for", () => {
    expect(searchCatalog(db, {}).map((h) => h.score)).toEqual([1, 1, 1]);
  });

  it("filters by max_price", () => {
    expect(codes(searchCatalog(db, { max_price: 700_000_000 }))).toEqual(["1912"]);
  });

  it("filters by min_price", () => {
    expect(codes(searchCatalog(db, { min_price: 1_000_000_000 })).sort()).toEqual(["0195", "916"]);
  });

  it("filters by minimum bedrooms", () => {
    expect(codes(searchCatalog(db, { bedrooms: 4 })).sort()).toEqual(["0195", "916"]);
  });

  it("filters by neighborhood (case-insensitive)", () => {
    expect(codes(searchCatalog(db, { neighborhood: "belén" }))).toEqual(["1912"]);
  });

  it("matches free-text query over title and features", () => {
    expect(codes(searchCatalog(db, { query: "Rionegro" }))).toEqual(["916"]);
  });

  // The production bug, verbatim: the owner stored "Llanogrande", the customer
  // asked for "Llano Grande", and the old whole-string `includes` answered "no
  // tenemos ninguna propiedad" over a listing that was sitting right there.
  it("finds a one-word sector when the customer spells it as two", () => {
    const results = searchCatalog(db, { neighborhood: "Llano Grande" });
    expect(codes(results)).toEqual(["0195"]);
    expect(results[0]?.score).toBe(1);
  });

  it("finds a two-word sector when the customer spells it as one", () => {
    expect(codes(searchCatalog(db, { neighborhood: "belenrosales" }))).toEqual(["1912"]);
  });

  it("matches without accents", () => {
    expect(codes(searchCatalog(db, { neighborhood: "belen" }))).toEqual(["1912"]);
  });

  // The other half of the bug: `query` advertised free-text search but demanded
  // the entire phrase appear verbatim, so any natural sentence matched nothing.
  it("matches a natural-language phrase, not just a verbatim substring", () => {
    const results = searchCatalog(db, { query: "casa en llano grande con jacuzzi" });
    expect(codes(results)).toEqual(["0195"]);
    // "en"/"con" are dropped as noise; casa, llano, grande and jacuzzi all hit.
    expect(results[0]?.score).toBe(1);
  });

  it("keeps a partial match that clears the floor, and reports its score", () => {
    // apartamento + belen + rosales hit; piscina + gimnasio do not. 3/5 = 0.6.
    const results = searchCatalog(db, {
      query: "apartamento belen rosales piscina gimnasio",
    });
    expect(codes(results)).toEqual(["1912"]);
    expect(results[0]?.score).toBeCloseTo(0.6, 5);
  });

  it("drops a match below the floor rather than offering something unrelated", () => {
    // Only apartamento + belen hit: 2/5 = 0.4. Nothing comes back, and the
    // agent is meant to read that as "we have nothing like this".
    expect(
      searchCatalog(db, { query: "apartamento belen piscina gimnasio jacuzzi" }),
    ).toEqual([]);
  });

  it("forgives a typo in a word that is otherwise clearly the sector", () => {
    const results = searchCatalog(db, { neighborhood: "Belen Rosalez" });
    expect(codes(results)).toEqual(["1912"]);
    // Fuzzy hits score below an exact one, so a clean match always outranks it.
    expect(results[0]?.score).toBeLessThan(1);
  });

  // Nobody asks for "un apartamento" — they ask for "un apartamento de 3
  // alcobas". Those words live in a NUMBER column, so without a text rendering
  // of the attributes every realistic question drags its own score below the
  // floor with words the listing does answer.
  it("matches the words people use for structured attributes", () => {
    const results = searchCatalog(db, { query: "apartamento 3 alcobas belen" });
    expect(codes(results)).toEqual(["1912"]);
    expect(results[0]?.score).toBe(1);
  });

  it("does not read a digit as a match because it sits inside a bigger number", () => {
    // 916 has 4 bedrooms and area_m2 230. Asking for 3 alcobas must not match it
    // through the "3" in "230" — a digit is a value, not a word fragment.
    const results = searchCatalog(db, { query: "3 alcobas", min_score: 0 });
    expect(results.find((h) => h.product.code === "916")?.score).toBe(0.5);
    expect(results.find((h) => h.product.code === "1912")?.score).toBe(1);
  });

  // The question that started all this, word for word.
  it("ignores words that name the catalog itself rather than a property", () => {
    // Every listing IS a propiedad, so the word cannot tell them apart. Counted
    // as a miss it drops a perfect answer to 67% — under the confidence line —
    // and the agent hedges about the one listing that fully answers the question.
    const results = searchCatalog(db, { query: "Tenemos alguna propiedad en Llano Grande." });
    expect(codes(results)).toEqual(["0195"]);
    expect(results[0]?.score).toBe(1);
  });

  it("does not fuzzy-match short tokens into anything that resembles them", () => {
    // Three letters are too few to be a typo of something else; at this length
    // every word in the catalog is within a couple of edits of every other.
    expect(searchCatalog(db, { query: "xyz" })).toEqual([]);
  });

  it("ranks by score, best first", () => {
    // min_score 0 to see the whole ranking, including what the floor would hide.
    const results = searchCatalog(db, { query: "casa jacuzzi", min_score: 0 });
    expect(codes(results)).toEqual(["0195", "916", "1912"]);
    expect(results[0]?.score).toBe(1); // casa + jacuzzi
    expect(results[1]?.score).toBe(0.5); // casa only
    expect(results[2]?.score).toBe(0); // neither
  });

  // Price and bedrooms are constraints, not preferences: a perfect text match
  // that costs five times the budget is not a 100% result, it is the wrong
  // house. Scoring must never smuggle it back in.
  it("still excludes on price even when the text matches perfectly", () => {
    expect(
      searchCatalog(db, { query: "casa llanogrande jacuzzi", max_price: 500_000_000 }),
    ).toEqual([]);
  });

  it("still excludes on bedrooms even when the text matches perfectly", () => {
    expect(searchCatalog(db, { query: "casa llanogrande jacuzzi", bedrooms: 6 })).toEqual([]);
  });
});

// Taken from the real catalog: listing 916 sits in Barro Blanco and its
// description ends "a 7 minutos de Jardines de Llanogrande". Asked for Llano
// Grande, BOTH listings score 100% — every word asked for really is in both —
// and that is correct: a house seven minutes away is worth mentioning. What is
// not acceptable is which one leads, being decided by whichever was edited last.
describe("searchCatalog ranking between equally-scored listings", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
    upsertProduct(
      db,
      {
        code: "0195",
        title: "Casa en Llanogrande",
        price: 2_500_000_000,
        status: "active",
        attributes: { neighborhood: "Llanogrande" },
      },
      null,
    );
    // Seeded LAST, so it wins the updated_at ordering the search falls back to.
    upsertProduct(
      db,
      {
        code: "916",
        title: "Casa nueva en Barro Blanco",
        description: "A 7 minutos de Jardines de Llanogrande.",
        price: 1_150_000_000,
        status: "active",
        attributes: { neighborhood: "Barro Blanco" },
      },
      null,
    );
  });

  it("puts the listing that IS in the sector above the one that merely mentions it", () => {
    const results = searchCatalog(db, { neighborhood: "Llano Grande" });
    expect(codes(results)).toEqual(["0195", "916"]);
    // Both genuinely answer every word, so the score cannot be what separates
    // them — the sector living in the structured field is.
    expect(results[0]?.score).toBe(1);
    expect(results[1]?.score).toBe(1);
  });
});

// The owner asked "¿tenemos alguna propiedad en Llano Grande?" and the agent
// answered "no" after three list_products calls by status, because that was the
// only tool spanning statuses and it had no sector filter. The improvisation was
// the symptom; the missing capability was the bug.
describe("listProducts", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
    seed(db);
  });

  it("returns every product in every status when nothing is asked", () => {
    expect(codes(listProducts(db)).sort()).toEqual(["0195", "0200", "1912", "916", "999"]);
  });

  it("filters by status", () => {
    expect(codes(listProducts(db, { status: "draft" })).sort()).toEqual(["0200", "999"]);
  });

  it("finds an unpublished listing by sector — the answer search_catalog cannot give", () => {
    expect(codes(listProducts(db, { neighborhood: "Llano Grande" })).sort()).toEqual([
      "0195",
      "0200",
    ]);
    // The boundary that makes the above safe: the draft stays invisible to the
    // customer-facing search, whose data is reviewed by definition.
    expect(codes(searchCatalog(db, { neighborhood: "Llano Grande" }))).toEqual(["0195"]);
  });

  it("combines a status with a sector", () => {
    expect(codes(listProducts(db, { status: "draft", neighborhood: "Llano Grande" }))).toEqual([
      "0200",
    ]);
  });

  // A truncated report is a lie the owner cannot see: "¿qué tengo publicado?"
  // answered with 10 of 30 reads as a complete inventory.
  it("does not cap a report the way a customer search is capped", () => {
    for (let i = 0; i < 15; i++) {
      upsertProduct(db, { code: `cap-${i}`, title: "Casa", status: "active" }, null);
    }
    expect(listProducts(db).length).toBe(20);
    expect(searchCatalog(db, {})).toHaveLength(10);
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

  it("removes an attribute the owner un-says, keeping the rest", () => {
    const db = openDb(":memory:");
    upsertProduct(db, { code: "1", attributes: { bedrooms: 3, bathrooms: 2 } }, null);

    // "No, nunca dije cuántos baños" — an explicit null clears the key.
    upsertProduct(db, { code: "1", attributes: { bathrooms: null } }, null);

    const p = getProductByCode(db, "1");
    expect(p?.attributes.bathrooms).toBeUndefined();
    expect("bathrooms" in (p?.attributes ?? {})).toBe(false); // gone, not tombstoned as null
    expect(p?.attributes.bedrooms).toBe(3); // the merge still protects the rest
    db.close();
  });

  it("does not store a null attribute on create", () => {
    const db = openDb(":memory:");
    upsertProduct(db, { code: "1", attributes: { bedrooms: 3, bathrooms: null } }, null);
    const p = getProductByCode(db, "1");
    expect("bathrooms" in (p?.attributes ?? {})).toBe(false);
    expect(p?.attributes.bedrooms).toBe(3);
    db.close();
  });

  it("clearing an attribute that was never set is a no-op", () => {
    const db = openDb(":memory:");
    upsertProduct(db, { code: "1", attributes: { bedrooms: 3 } }, null);
    upsertProduct(db, { code: "1", attributes: { bathrooms: null } }, null);
    const p = getProductByCode(db, "1");
    expect("bathrooms" in (p?.attributes ?? {})).toBe(false);
    expect(p?.attributes.bedrooms).toBe(3);
    db.close();
  });

  it("round-trips lot size and property tax as structured attributes", () => {
    const db = openDb(":memory:");
    // The owner said "Lote 1.400 mts" and "Predial 7'300.000 anuales" — both
    // are decision factors for a house, so both belong in the schema.
    upsertProduct(db, { code: "0195", attributes: { lot_m2: 1400, property_tax: 7_300_000 } }, null);

    const p = getProductByCode(db, "0195");

    expect(p?.attributes.lot_m2).toBe(1400);
    expect(p?.attributes.property_tax).toBe(7_300_000);
    db.close();
  });

  it("keeps falsy attribute values that are real data", () => {
    const db = openDb(":memory:");
    // 0 and false are values the owner stated; only null means "clear this".
    upsertProduct(db, { code: "1", attributes: { admin_fee: 0, elevator: false } }, null);
    const p = getProductByCode(db, "1");
    expect(p?.attributes.admin_fee).toBe(0);
    expect(p?.attributes.elevator).toBe(false);
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
