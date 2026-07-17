import type { Config } from "../config.js";
import type { Product } from "../types.js";

/** The storefront's preview URL for a product, in any status. */
export function previewUrl(config: Config, product: Product): string {
  return `${config.storefrontBaseUrl}/preview/${encodeURIComponent(product.code)}`;
}

/** The public storefront URL for a product. Only active products render there. */
export function propertyUrl(config: Config, product: Product): string {
  return `${config.storefrontBaseUrl}/propiedad/${encodeURIComponent(product.code)}`;
}

/**
 * The link appended to the product-reading tools' results, so the agent can
 * relay a page instead of the facts alone. This is how a customer sees photos:
 * the assistant cannot send images, it sends this.
 *
 * It comes back from a tool rather than living in the prompt because of the
 * grounding rules — a URL the model assembles from memory is a URL it can get
 * wrong.
 *
 * Empty unless the product is active, mirroring previewLineFor: the storefront
 * only serves active products at this path, so a draft's link would 404, and a
 * draft's facts are unreviewed and must not reach a customer either way.
 */
export function linkLineFor(config: Config, product: Product): string {
  if (product.status !== "active") return "";
  return ` | link=${propertyUrl(config, product)}`;
}

/**
 * The line appended to upsert_product's result so the agent relays a preview
 * link to the owner — the owner cannot review a draft any other way, since the
 * catalog only renders active products.
 *
 * Empty once the product is active: it is on the public storefront by then, so
 * /propiedad/<code> is the link to share and there is nothing left to preview.
 *
 * The link is deliberately NOT access-controlled for the pilot — this is a
 * real-estate catalog with no sensitive data, and an unpublished listing
 * leaking is not a meaningful risk. The page is unlisted and noindex'd rather
 * than secret, so "owner only" here is guidance for the agent, not a guarantee.
 * What it protects is data quality: a draft is unreviewed, and unreviewed facts
 * should not reach a customer.
 */
export function previewLineFor(config: Config, product: Product): string {
  if (product.status === "active") return "";
  return `\nPreview link for the OWNER to review before publishing (do not send it to customers — a draft's data is unreviewed): ${previewUrl(config, product)}`;
}
