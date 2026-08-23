import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/data/db.js";
import {
  addPendingMedia,
  deleteStalePendingMedia,
  insertLead,
  listLeads,
  listPendingMedia,
  markPendingMediaAttached,
  upsertContact,
} from "../src/data/repo.js";

const PHONE = "573001112233";

describe("leads", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("stores the three retail lead kinds", () => {
    for (const type of ["inquiry", "back_in_stock", "follow_up"] as const) {
      const lead = insertLead(db, { phone: PHONE, type, note: `wants ${type}` });
      expect(lead.type).toBe(type);
    }
    expect(listLeads(db)).toHaveLength(3);
  });

  // The schema's CHECK is the last line of defence if a tool's enum and the
  // table ever drift apart.
  it("rejects a lead type the schema does not know", () => {
    expect(() =>
      insertLead(db, { phone: PHONE, type: "visit_request" as never }),
    ).toThrow();
  });

  // Free text, not a foreign key: the product lives in Shopify, and a lead has
  // to survive it being renamed, archived or deleted.
  it("keeps a product reference that no longer resolves", () => {
    insertLead(db, { phone: PHONE, type: "back_in_stock", product_code: "CAM-NEG-M" });
    expect(listLeads(db)[0]?.product_code).toBe("CAM-NEG-M");
  });

  it("filters by age", () => {
    insertLead(db, { phone: PHONE, type: "inquiry" });
    db.prepare(`UPDATE leads SET created_at = datetime('now', '-10 days')`).run();
    insertLead(db, { phone: PHONE, type: "follow_up" });

    expect(listLeads(db, 3)).toHaveLength(1);
    expect(listLeads(db)).toHaveLength(2);
  });
});

describe("contacts", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("keeps a known name when a later turn has none", () => {
    upsertContact(db, PHONE, "customer", "Ana");
    upsertContact(db, PHONE, "customer");

    const row = db.prepare(`SELECT name, role FROM contacts WHERE phone = ?`).get(PHONE) as {
      name: string | null;
      role: string;
    };
    expect(row.name).toBe("Ana");
    expect(row.role).toBe("customer");
  });
});

// Photos land here on the way to Shopify. Arrival order IS listing order: the
// bridge's outbox delivers a burst strictly sequentially, so the first photo
// the owner sent becomes the product's cover image.
describe("pending media", () => {
  let db: DB;
  let dir: string;

  beforeEach(() => {
    db = openDb(":memory:");
    dir = mkdtempSync(join(tmpdir(), "vitrina-pending-"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const addPhoto = (name: string, caption?: string): string => {
    const path = join(dir, name);
    writeFileSync(path, "x");
    addPendingMedia(db, { phone: PHONE, file_path: path, public_path: `/media/${name}`, caption });
    return path;
  };

  it("returns this phone's photos oldest first", () => {
    addPhoto("1.jpg");
    addPhoto("2.jpg");
    addPendingMedia(db, {
      phone: "573009998877",
      file_path: join(dir, "other.jpg"),
      public_path: "/media/other.jpg",
    });

    const pending = listPendingMedia(db, PHONE);
    expect(pending.map((m) => m.public_path)).toEqual(["/media/1.jpg", "/media/2.jpg"]);
  });

  // Deliberately does NOT claim: the upload can fail halfway, and a row claimed
  // before the network call would leave photos that never reached Shopify
  // looking like they had.
  it("does not mark anything as it lists", () => {
    addPhoto("1.jpg");
    expect(listPendingMedia(db, PHONE)).toHaveLength(1);
    expect(listPendingMedia(db, PHONE)).toHaveLength(1);
  });

  it("stops returning a photo once it is marked as uploaded", () => {
    addPhoto("1.jpg");
    addPhoto("2.jpg");
    const pending = listPendingMedia(db, PHONE);

    markPendingMediaAttached(db, [pending[0]!.id], "gid://shopify/Product/1");

    expect(listPendingMedia(db, PHONE).map((m) => m.id)).toEqual([pending[1]!.id]);
  });

  // A partial upload must leave the rest claimable by a second attempt rather
  // than silently dropping them.
  it("leaves the photos that failed to upload still pending", () => {
    addPhoto("1.jpg");
    addPhoto("2.jpg");
    addPhoto("3.jpg");
    const pending = listPendingMedia(db, PHONE);

    // Two of three landed.
    markPendingMediaAttached(db, pending.slice(0, 2).map((m) => m.id), "gid://shopify/Product/1");

    expect(listPendingMedia(db, PHONE)).toHaveLength(1);
  });

  it("captures the caption the owner wrote with the photo", () => {
    addPhoto("1.jpg", "de frente");
    expect(listPendingMedia(db, PHONE)[0]?.caption).toBe("de frente");
  });

  describe("housekeeping", () => {
    it("deletes stale un-uploaded photos and their files", () => {
      const path = addPhoto("1.jpg");
      db.prepare(`UPDATE pending_media SET received_at = datetime('now', '-72 hours')`).run();

      expect(deleteStalePendingMedia(db, 48)).toBe(1);
      expect(listPendingMedia(db, PHONE)).toHaveLength(0);
      expect(existsSync(path)).toBe(false);
    });

    // The file is on Shopify's side of the line now, but the row is what stops
    // the sweep from deleting a local copy that is still the only record of
    // which product it went to.
    it("leaves an uploaded photo alone however old it is", () => {
      const path = addPhoto("1.jpg");
      markPendingMediaAttached(db, [listPendingMedia(db, PHONE)[0]!.id], "gid://shopify/Product/1");
      db.prepare(`UPDATE pending_media SET received_at = datetime('now', '-72 hours')`).run();

      expect(deleteStalePendingMedia(db, 48)).toBe(0);
      expect(existsSync(path)).toBe(true);
    });

    it("keeps a recent photo", () => {
      addPhoto("1.jpg");
      expect(deleteStalePendingMedia(db, 48)).toBe(0);
    });

    // The row is what matters; a file already gone is not an error.
    it("survives a file that has already disappeared", () => {
      const path = addPhoto("1.jpg");
      rmSync(path);
      db.prepare(`UPDATE pending_media SET received_at = datetime('now', '-72 hours')`).run();

      expect(deleteStalePendingMedia(db, 48)).toBe(1);
    });
  });
});
