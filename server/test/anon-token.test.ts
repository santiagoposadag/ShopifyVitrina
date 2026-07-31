import { describe, expect, it } from "vitest";
import { anonToken } from "../src/agent/anon-token.js";

/**
 * anonToken is duplicated in web/lib/anon.ts, byte-for-byte, because the server
 * mints the /ver/<token> share link and the web storefront resolves it, and the
 * two workspaces share no runtime code (shared/ is types-only). Nothing else
 * proves they still agree — a one-sided change breaks every anonymous link with
 * both sides still compiling.
 *
 * These vectors are the cross-boundary fixture: keep web/lib/anon.ts producing
 * EXACTLY these values, the same discipline the webhook HMAC vector uses across
 * bridge/delivery_test.go and webhook.test.ts. Recompute with:
 *   node -e 'const {createHmac}=require("crypto");
 *     console.log(createHmac("sha256","s3cr3t-shared").update("916").digest("base64url").slice(0,16))'
 */
describe("anonToken", () => {
  const SECRET = "s3cr3t-shared";

  it("pins the shared token vectors (must match web/lib/anon.ts)", () => {
    expect(anonToken("916", SECRET)).toBe("1JLzRr5P4QByd5NU");
    expect(anonToken("1912", SECRET)).toBe("XMLZ8Sgq0ZUvgLKW");
  });

  it("is deterministic and opaque — never leaks the code", () => {
    const token = anonToken("916", SECRET);
    expect(anonToken("916", SECRET)).toBe(token);
    expect(token).not.toContain("916");
    expect(token).toHaveLength(16);
    // URL-safe: no '+', '/' or '=' padding to break routing or need encoding.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("changes with the secret, so rotating it invalidates every old link", () => {
    expect(anonToken("916", "other-secret")).not.toBe(anonToken("916", SECRET));
  });

  it("returns an empty token when the secret is unset (feature disabled)", () => {
    expect(anonToken("916", "")).toBe("");
  });
});
