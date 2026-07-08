export type Role = "owner" | "customer";

export type ProductStatus = "draft" | "active" | "sold" | "inactive";

export type LeadType = "inquiry" | "visit_request";

/** Structured attributes stored as JSON in products.attributes. */
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
}
