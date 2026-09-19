import type { LeadsPort, MediaPort, PendingPhoto } from "../tools/ports.js";
import type { Lead } from "../types.js";
import type { DB } from "./db.js";
import {
  findOpenDuplicateLead,
  insertLead,
  listLeads,
  listPendingMedia,
  markPendingMediaAttached,
} from "./repo.js";

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

/**
 * What happens once a lead is captured, beyond writing the row.
 *
 * INJECTED RATHER THAN CALLED FROM HERE, because the only useful thing to do is
 * send a WhatsApp message and this module must not know what a transport is —
 * every other query in it is a query. The composition root has the channel and
 * wires it (see index.ts).
 */
export interface LeadNotifier {
  /**
   * Tell whoever needs to know. MUST NOT THROW and MUST NOT BLOCK the caller:
   * this runs inside a live tool call on a turn the customer is waiting for,
   * and a lead that was written must never fail because nobody could be
   * notified about it. The implementation logs its own failures.
   */
  leadCaptured(lead: Lead): void;
}

export function sqliteLeadsPort(db: DB, notifier?: LeadNotifier): LeadsPort {
  return {
    save: async (draft): Promise<{ lead: Lead; created: boolean }> => {
      // DEDUPE BEFORE INSERT. A customer who asks three times about the same
      // sold-out item is one promise to contact them, not three — see
      // findOpenDuplicateLead for what "the same ask" means and why a closed
      // lead deliberately does not match.
      const duplicate = findOpenDuplicateLead(db, {
        phone: draft.phone,
        type: draft.type,
        product_code: draft.productCode,
      });
      if (duplicate) return { lead: duplicate, created: false };

      const lead = insertLead(db, {
        phone: draft.phone,
        type: draft.type,
        name: draft.name,
        note: draft.note,
        product_code: draft.productCode,
        conversation_key: draft.conversationKey,
        agent_id: draft.agentId,
        turn_key: draft.turnKey,
      });
      // ONLY ON A REAL CAPTURE. Notifying on a duplicate would page the owner
      // every time an impatient customer repeats themselves, which is how a
      // notification stops being read at all.
      notifier?.leadCaptured(lead);
      return { lead, created: true };
    },
    list: async (query = {}): Promise<Lead[]> => listLeads(db, query),
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
