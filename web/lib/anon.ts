import { createHmac } from "node:crypto";

/**
 * Server-only secret for anonymous share tokens. NOT a NEXT_PUBLIC_ variable: the
 * token rides in the URL, but the secret must never reach the browser. Every call
 * site (the /ver/[token] page, the preview page's copy box) runs server-side, so
 * it stays a plain runtime env — changing it needs a restart, not a rebuild.
 */
export const ANON_SHARE_SECRET = (process.env.ANON_SHARE_SECRET ?? "").trim();

/** Whether anonymous sharing is configured. */
export function hasAnonShare(): boolean {
  return ANON_SHARE_SECRET.length > 0;
}

/**
 * Deterministic, opaque share token for a product code. MIRRORS
 * server/src/agent/anon-token.ts byte-for-byte — the agent mints the link there,
 * this app resolves it here, and the two must agree or a minted /ver/<token> link
 * 404s. The shared vector is pinned in server/test/anon-token.test.ts; keep this
 * and the server copy identical.
 */
export function anonToken(code: string): string {
  if (!ANON_SHARE_SECRET) return "";
  return createHmac("sha256", ANON_SHARE_SECRET).update(code).digest("base64url").slice(0, 16);
}
