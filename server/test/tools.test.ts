import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDb } from "../src/data/db.js";
import {
  buildToolServer,
  describeProduct,
  isPublishTransition,
  MCP_SERVER_NAME,
  renderProductList,
  renderSearchHits,
} from "../src/agent/tools.js";
import { CatalogCache } from "../src/shopify/cache.js";
import { ShopifyClient } from "../src/shopify/client.js";
import type { SearchHit } from "../src/shopify/rank.js";
import type { ShopifyProduct } from "../src/shopify/types.js";
import type { Role } from "../src/types.js";

const CUSTOMER_TOOLS = ["search_catalog", "get_product", "save_lead"];
const OWNER_ONLY_TOOLS = [
  "list_products",
  "create_product",
  "update_product",
  "delete_product",
  "get_inventory",
  "adjust_inventory",
  "attach_pending_photos",
  "list_locations",
  "list_leads",
];

const TEST_CONFIG = {
  shopifyStoreDomain: "tienda.myshopify.com",
  shopifyAdminToken: "shpat_x",
  shopifyApiVersion: "2026-01",
  shopifyLocationId: "",
} as Config;

function toolNamesFor(role: Role): string[] {
  const db = openDb(":memory:");
  const shopify = new ShopifyClient(TEST_CONFIG);
  const { toolNames } = buildToolServer({
    db,
    config: TEST_CONFIG,
    shopify,
    cache: new CatalogCache(shopify, 0),
    ctx: { phone: "573000000000", role, turnKey: "msg:1" },
  });
  db.close();
  return toolNames.map((n) => n.replace(`mcp__${MCP_SERVER_NAME}__`, ""));
}

// This is the privilege boundary of the whole system. It matters more here than
// it did over a read-only storefront: an owner tool reaching a customer is a
// stranger repricing a live store, or deleting a product out of it.
describe("buildToolServer privilege boundary", () => {
  it("gives customers exactly the customer tools — no owner tool leaks", () => {
    const names = toolNamesFor("customer");
    expect(names.sort()).toEqual([...CUSTOMER_TOOLS].sort());
    for (const ownerTool of OWNER_ONLY_TOOLS) {
      expect(names).not.toContain(ownerTool);
    }
  });

  it("gives owners the customer tools plus the owner tools", () => {
    const names = toolNamesFor("owner");
    expect(names.sort()).toEqual([...CUSTOMER_TOOLS, ...OWNER_ONLY_TOOLS].sort());
  });

  // Nothing may write to the catalog from the customer path, whatever it is
  // called. Pinned by prefix rather than by name so a future create_variant or
  // set_price cannot slip in unnoticed.
  it("gives customers no tool that can write to the store", () => {
    const names = toolNamesFor("customer");
    for (const name of names) {
      expect(name).not.toMatch(/^(create|update|delete|adjust|set|attach|publish)_/);
    }
  });

  // The tool server has no WhatsApp client at all, so this is structural — but
  // pin it anyway: a tool that could push media back would be a silent
  // regression of a product decision, in either role.
  it("gives NO role a way to send media into the chat", () => {
    for (const role of ["customer", "owner"] as const) {
      expect(toolNamesFor(role)).not.toContain("send_product_photos");
    }
  });
});

function product(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: "gid://shopify/Product/1",
    handle: "camiseta-negra",
    title: "Camiseta negra",
    description: "",
    status: "ACTIVE",
    productType: "Camiseta",
    vendor: "",
    tags: [],
    totalInventory: 5,
    onlineStoreUrl: "https://tienda.example.com/products/camiseta-negra",
    mediaCount: 2,
    updatedAt: "2026-08-01T00:00:00Z",
    variants: [
      {
        id: "gid://shopify/ProductVariant/1",
        sku: "CAM-NEG-M",
        title: "M",
        price: "80000.00",
        compareAtPrice: null,
        inventoryQuantity: 5,
        inventoryItemId: "gid://shopify/InventoryItem/1",
        inventoryTracked: true,
        selectedOptions: [{ name: "Talla", value: "M" }],
      },
    ],
    ...overrides,
  };
}

function hit(score: number, overrides: Partial<ShopifyProduct> = {}): SearchHit {
  return { product: product(overrides), score };
}

// The search answers with approximate matches, which is only safe if the agent
// can tell a hit from a near-miss. These pin the two things that make that
// possible: the score reaches the model, and a weak result set arrives labelled
// as weak.
describe("renderSearchHits", () => {
  it("tells the agent to capture a lead when nothing matched", () => {
    expect(renderSearchHits([])).toContain("lead");
  });

  it("puts the match percentage on every line", () => {
    const out = renderSearchHits([hit(1), hit(0.75, { handle: "otra" })]);
    expect(out).toContain("match=100%");
    expect(out).toContain("match=75%");
  });

  it("warns when even the best result is only approximate", () => {
    expect(renderSearchHits([hit(0.6)])).toContain("APPROXIMATE");
  });

  it("stays quiet when the top result is a confident match", () => {
    expect(renderSearchHits([hit(1), hit(0.6)])).not.toContain("APPROXIMATE");
  });

  // A sold-out product still comes back — it answers the question, and hiding
  // it makes the agent say "no tenemos" about something the customer can see on
  // the shelf. But it must never be offered as available, and the flag has to
  // ride on the result line, not only in the prompt.
  it("marks a sold-out product on its own line", () => {
    const soldOut = hit(1, {
      totalInventory: 0,
      variants: [
        {
          ...product().variants[0]!,
          inventoryQuantity: 0,
        },
      ],
    });
    expect(renderSearchHits([soldOut])).toContain("SOLD OUT");
    expect(renderSearchHits([hit(1)])).not.toContain("SOLD OUT");
  });
});

// An answer meaning "no DRAFTS" must not read as "no products anywhere": the
// agent that called this three times over three statuses added the three
// sentences up into a confident, wrong claim about the whole catalog.
describe("renderProductList", () => {
  it("scopes an empty answer to the filter that produced it", () => {
    const out = renderProductList([], { status: "DRAFT" });
    expect(out).toContain("status=DRAFT");
    expect(out).toMatch(/nothing about|does not mean/i);
  });

  it("names the text that found nothing", () => {
    expect(renderProductList([], { query: "camiseta roja" })).toContain("camiseta roja");
  });

  it("reports an empty catalog plainly when nothing was filtered", () => {
    expect(renderProductList([], {})).toMatch(/empty|no products at all/i);
  });

  it("shows a match percentage only when text was actually asked for", () => {
    expect(renderProductList([hit(0.8)], { query: "camiseta" })).toContain("match=80%");
    // A percentage against nothing is meaningless noise on an inventory report.
    expect(renderProductList([hit(1)], { status: "ACTIVE" })).not.toContain("match=");
  });

  // A truncated list read as a complete one is how an owner is told they have
  // 250 products when they have 900.
  it("says so when the catalog is larger than one fetch", () => {
    const out = renderProductList([hit(1)], {}, true);
    expect(out).toMatch(/incomplete|larger than/i);
  });
});

describe("describeProduct", () => {
  it("carries the facts the agent is allowed to quote", () => {
    const out = describeProduct(product());
    expect(out).toContain("handle=camiseta-negra");
    expect(out).toContain("status=ACTIVE");
    expect(out).toContain("sku=CAM-NEG-M");
    expect(out).toContain("price=80000.00");
    expect(out).toContain("stock=5");
    expect(out).toContain("photos=2");
  });

  // An untracked variant is not "0 in stock" — Shopify is not counting it, and
  // reporting a zero would tell the owner something sold out that never was.
  it("distinguishes untracked stock from zero stock", () => {
    const untracked = product({
      totalInventory: null,
      variants: [
        { ...product().variants[0]!, inventoryTracked: false, inventoryQuantity: 0 },
      ],
    });
    expect(describeProduct(untracked)).toContain("stock=untracked");
    expect(describeProduct(untracked)).not.toContain("stock=0");
  });
});

// The session-reset trigger: only the moment a product BECOMES active ends the
// unit of work. Editing an already-live product mid-conversation must not reset.
describe("isPublishTransition", () => {
  it("fires when a draft is published", () => {
    expect(isPublishTransition("DRAFT", "ACTIVE")).toBe(true);
  });

  it("fires when a product is created directly as active", () => {
    expect(isPublishTransition(undefined, "ACTIVE")).toBe(true);
  });

  it("fires when an archived product is republished", () => {
    expect(isPublishTransition("ARCHIVED", "ACTIVE")).toBe(true);
  });

  it("does not fire when editing an already-active product", () => {
    expect(isPublishTransition("ACTIVE", "ACTIVE")).toBe(false);
  });

  it("does not fire on draft work or on archiving", () => {
    expect(isPublishTransition("DRAFT", "DRAFT")).toBe(false);
    expect(isPublishTransition(undefined, "DRAFT")).toBe(false);
    expect(isPublishTransition("ACTIVE", "ARCHIVED")).toBe(false);
  });
});
