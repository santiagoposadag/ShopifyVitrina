import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import {
  anonLineFor,
  anonUrl,
  linkLineFor,
  previewLineFor,
  previewUrl,
  propertyUrl,
} from "../src/agent/preview.js";
import { anonToken } from "../src/agent/anon-token.js";
import type { Product } from "../src/types.js";

// One domain: anonBaseUrl mirrors loadConfig's fallback to the branded host.
const CONFIG = {
  storefrontBaseUrl: "https://vitrina.example.com",
  anonBaseUrl: "https://vitrina.example.com",
} as Config;
const ANON_CONFIG = { ...CONFIG, anonShareSecret: "s3cr3t-shared" } as Config;
// Two domains: the real deployment, where the anonymous link lives on a host
// whose NAME does not identify the company either.
const SPLIT_CONFIG = { ...ANON_CONFIG, anonBaseUrl: "https://anonimo.example.net" } as Config;

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

// The customer's route to a property's photos: the assistant cannot send
// images, so this link is what it relays instead. It rides back on the tool
// results because the grounding rules forbid stating anything a tool did not
// return — a URL built from memory is a URL that can be wrong.
describe("property link", () => {
  const ACTIVE = { ...DRAFT, status: "active" } as Product;

  it("points at the storefront's public property page", () => {
    expect(propertyUrl(CONFIG, ACTIVE)).toBe("https://vitrina.example.com/propiedad/0195");
  });

  it("escapes the code so it cannot break out of the URL path", () => {
    expect(propertyUrl(CONFIG, { ...ACTIVE, code: "a b/c" })).toBe(
      "https://vitrina.example.com/propiedad/a%20b%2Fc",
    );
  });

  it("offers the link for an active product", () => {
    expect(linkLineFor(CONFIG, ACTIVE)).toBe(" | link=https://vitrina.example.com/propiedad/0195");
  });

  it("offers NO link for a product the storefront will not serve", () => {
    // /propiedad/<code> renders active products only, so a link for any other
    // status would hand the customer a 404 — and a draft's facts are unreviewed
    // anyway. The owner gets previewLineFor for those instead.
    for (const status of ["draft", "sold", "inactive"] as const) {
      expect(linkLineFor(CONFIG, { ...DRAFT, status })).toBe("");
    }
  });

  it("never offers both links for the same product", () => {
    // The two lines are complements, not alternatives: exactly one applies at
    // any status, so a customer can never be handed an unreviewed draft page.
    for (const status of ["draft", "active", "sold", "inactive"] as const) {
      const product = { ...DRAFT, status } as Product;
      const offered = [linkLineFor(CONFIG, product), previewLineFor(CONFIG, product)];
      expect(offered.filter((line) => line !== "")).toHaveLength(1);
    }
  });
});

// The anonymous, de-branded link the owner hands a colleague to reshare. It
// carries the SAME token the web storefront recomputes to resolve /ver/<token>,
// so the path here and the resolver there must stay in lockstep (anon-token.test).
describe("anonymous share link", () => {
  const ACTIVE = { ...DRAFT, status: "active" } as Product;

  it("builds a /ver/<token> URL whose token matches the shared derivation", () => {
    const url = anonUrl(ANON_CONFIG, ACTIVE);
    expect(url).toBe(`https://vitrina.example.com/ver/${anonToken("0195", "s3cr3t-shared")}`);
  });

  it("does NOT reveal the code in the URL", () => {
    // The whole point of the anonymous link: nothing on the page or in the URL
    // maps it back to our catalog.
    expect(anonUrl(ANON_CONFIG, ACTIVE)).not.toContain("0195");
  });

  it("offers a link only for an active product", () => {
    for (const status of ["draft", "sold", "inactive"] as const) {
      expect(anonUrl(ANON_CONFIG, { ...DRAFT, status })).toBe("");
      expect(anonLineFor(ANON_CONFIG, { ...DRAFT, status })).toBe("");
    }
  });

  it("is disabled when the secret is unset", () => {
    // No ANON_SHARE_SECRET means no feature: emit nothing rather than a dead link.
    expect(anonUrl(CONFIG, ACTIVE)).toBe("");
    expect(anonLineFor(CONFIG, ACTIVE)).toBe("");
  });

  it("labels the owner-facing line so it is never sent to a customer", () => {
    const line = anonLineFor(ANON_CONFIG, ACTIVE);
    expect(line).toContain("OWNER");
    expect(line).toContain("/ver/");
  });

  // The reason ANON_BASE_URL exists. The page hides the logo, the footer and the
  // WhatsApp button — and then the address bar says the company's domain, which
  // the colleague's client reads before any of that renders.
  it("uses the ANONYMOUS host while the branded links stay on the branded one", () => {
    const url = anonUrl(SPLIT_CONFIG, ACTIVE);
    expect(url).toBe(`https://anonimo.example.net/ver/${anonToken("0195", "s3cr3t-shared")}`);
    expect(anonLineFor(SPLIT_CONFIG, ACTIVE)).toContain("https://anonimo.example.net/ver/");

    expect(propertyUrl(SPLIT_CONFIG, ACTIVE)).toBe("https://vitrina.example.com/propiedad/0195");
    expect(previewUrl(SPLIT_CONFIG, DRAFT)).toBe("https://vitrina.example.com/preview/0195");
  });

  it("keeps the branded host out of the anonymous link entirely", () => {
    // Not just the path: no substring of the branded base may survive into the
    // link, since the whole URL is what the colleague's client sees.
    expect(anonUrl(SPLIT_CONFIG, ACTIVE)).not.toContain("vitrina.example.com");
  });
});
