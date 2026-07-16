import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { previewLineFor, previewUrl } from "../src/agent/preview.js";
import type { Product } from "../src/types.js";

const CONFIG = { storefrontBaseUrl: "https://vitrina.example.com" } as Config;

const DRAFT = { code: "0195", status: "draft" } as Product;

describe("preview link", () => {
  it("points at the STOREFRONT, not at this server", () => {
    // PUBLIC_BASE_URL is the server (it serves photos); the storefront is a
    // different host, which is why STOREFRONT_BASE_URL exists at all.
    expect(previewUrl(CONFIG, DRAFT)).toBe("https://vitrina.example.com/preview/0195");
  });

  it("escapes the code so it cannot break out of the URL path", () => {
    expect(previewUrl(CONFIG, { ...DRAFT, code: "a b/c" })).toBe(
      "https://vitrina.example.com/preview/a%20b%2Fc",
    );
  });

  it("offers the link for every unpublished status", () => {
    for (const status of ["draft", "sold", "inactive"] as const) {
      const line = previewLineFor(CONFIG, { ...DRAFT, status });
      expect(line).toContain("https://vitrina.example.com/preview/0195");
      expect(line).toContain("OWNER");
    }
  });

  it("offers NO link once the product is active", () => {
    // It is in the public catalog by then: /propiedad/<code> is the link to
    // share, and there is nothing left to preview.
    expect(previewLineFor(CONFIG, { ...DRAFT, status: "active" })).toBe("");
  });

  it("tells the agent a draft's data is unreviewed and not for customers", () => {
    // The link is not access-controlled, so this line is the only thing keeping
    // unreviewed facts away from customers.
    expect(previewLineFor(CONFIG, DRAFT)).toContain("do not send it to customers");
  });
});
