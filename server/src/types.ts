// The row shapes both apps must agree on live in the shared workspace —
// type-only, erased at compile time (see shared/index.d.ts).
import type { ProductAttributes, ProductStatus } from "@vitrina/shared";

export type { ProductAttributes, ProductStatus };

export type Role = "owner" | "customer";

export type LeadType = "inquiry" | "visit_request";

/**
 * Whether an inbound message carried media. The webhook knows this from the
 * event it parsed, so it is PERSISTED with the row rather than re-derived from
 * agent_text later: a photo's caption is stored as its text, so any attempt to
 * recognise a photo by its wording silently misses every captioned one.
 * Lives here, not in the batcher, so data/repo.ts can type the column without
 * importing back from a module that already imports it.
 */
export type MessageKind = "text" | "media";

/**
 * Attributes as they arrive from the agent, where an explicit null means "clear
 * this key" — the owner never stated it, or un-said it. Stored attributes never
 * contain null (upsertProduct strips the keys), so ProductAttributes above stays
 * honest: a value is present or the key is absent, never a null in between.
 */
export type ProductAttributeUpdates = {
  [K in keyof ProductAttributes]: ProductAttributes[K] | null;
};

export interface Product {
  id: number;
  code: string;
  title: string;
  description: string | null;
  price: number | null;
  currency: string;
  status: ProductStatus;
  attributes: ProductAttributes;
  created_at: string;
  updated_at: string;
}

export interface ProductPhoto {
  id: number;
  product_id: number;
  file_path: string;
  public_path: string;
  caption: string | null;
  sort: number;
}

export interface Lead {
  id: number;
  phone: string;
  product_code: string | null;
  type: LeadType;
  name: string | null;
  note: string | null;
  status: string;
  created_at: string;
}

/** Context bound to the tools for a single inbound message turn. */
export interface TurnContext {
  phone: string;
  role: Role;
  /**
   * Set by a tool to change what happens to the stored agent session AFTER
   * this turn completes. "reset" clears it instead of persisting the new id,
   * so the next message starts a fresh conversation. This mutable field is the
   * only in-process channel from a tool back to runAgentTurn.
   */
  sessionAfterTurn?: "reset";
}
