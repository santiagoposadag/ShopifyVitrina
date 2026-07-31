import { createHmac } from "node:crypto";

/**
 * Deterministic, opaque share token for a product code — the id that appears in
 * an anonymous `/ver/<token>` storefront link. Derived from the code so nothing
 * has to be stored: the same code + secret always yields the same token, and the
 * token reveals neither the code nor the property.
 *
 * This function is MIRRORED byte-for-byte in web/lib/anon.ts: the WhatsApp agent
 * mints the link here (Node), the storefront resolves it there (Next.js), and
 * nothing else proves the two agree — a one-sided change breaks every anonymous
 * link with both sides still compiling. The shared vector is pinned in
 * test/anon-token.test.ts, the same cross-boundary-fixture discipline the
 * webhook HMAC uses.
 *
 * An empty secret yields an empty token: the caller's signal that anonymous
 * sharing is unconfigured (see anonUrl and the get_anonymous_link tool).
 */
export function anonToken(code: string, secret: string): string {
  if (!secret) return "";
  return createHmac("sha256", secret).update(code).digest("base64url").slice(0, 16);
}
