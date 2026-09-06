import type { LeadsPort, MediaPort, PendingPhoto } from "../tools/ports.js";
import type { Lead } from "../types.js";
import type { DB } from "./db.js";
import { insertLead, listLeads, listPendingMedia, markPendingMediaAttached } from "./repo.js";

/**
 * The SQLite side of the tool ports.
 *
 * Thin on purpose: the queries stay in data/repo.ts, where every other caller
 * finds them. What these add is the boundary — a pack asks for "the photos this
 * conversation sent" and never holds a database handle, so the tool layer can
 * be driven by a plain object in tests and by something else entirely later.
 *
 * The methods are async while better-sqlite3 is synchronous. That is the port's
 * shape, not the adapter's: a leads store that is not in this process must be
 * able to implement it, and awaiting a resolved promise costs a microtask.
 */

export function sqliteLeadsPort(db: DB): LeadsPort {
  return {
    save: async (draft): Promise<Lead> =>
      insertLead(db, {
        phone: draft.phone,
        type: draft.type,
        name: draft.name,
        note: draft.note,
        product_code: draft.productCode,
      }),
    list: async (sinceDays?: number): Promise<Lead[]> => listLeads(db, sinceDays),
  };
}

export function sqliteMediaPort(db: DB): MediaPort {
  return {
    /**
     * Oldest first, and NOT claimed: the rows stay available until an upload
     * actually lands, so a partial failure leaves the rest for the next attempt.
     */
    listPending: async (phone: string): Promise<PendingPhoto[]> =>
      listPendingMedia(db, phone).map((media) => ({
        id: media.id,
        path: media.file_path,
        caption: media.caption,
      })),
    markAttached: async (ids: number[], productId: string): Promise<void> => {
      markPendingMediaAttached(db, ids, productId);
    },
  };
}
