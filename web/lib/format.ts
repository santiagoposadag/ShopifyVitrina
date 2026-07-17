import type { Product } from "./db";

/** Format a COP amount the Colombian way, e.g. 670000000 -> "$ 670.000.000". */
export function formatCOP(value: number | null): string {
  if (value == null) return "Precio a consultar";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(value);
}

/** A short one-line summary of a property's headline attributes. */
export function attributeSummary(product: Product): string {
  const a = product.attributes;
  const parts: string[] = [];
  if (a.bedrooms != null) parts.push(`${a.bedrooms} hab.`);
  if (a.bathrooms != null) parts.push(`${a.bathrooms} baños`);
  if (a.area_m2 != null) parts.push(`${a.area_m2} m²`);
  // Lot size only in the summary line for properties that have one (a house);
  // for an apartment the key is simply absent, so nothing is added.
  if (a.lot_m2 != null) parts.push(`lote ${a.lot_m2} m²`);
  return parts.join(" · ");
}

export function locationSummary(product: Product): string {
  const a = product.attributes;
  return [a.neighborhood, a.city].filter(Boolean).join(", ");
}
