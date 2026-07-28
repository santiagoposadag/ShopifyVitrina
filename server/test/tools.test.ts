import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDb } from "../src/data/db.js";
import {
  buildToolServer,
  isPublishTransition,
  MCP_SERVER_NAME,
  renderProductList,
  renderSearchHits,
} from "../src/agent/tools.js";
import type { SearchHit } from "../src/data/repo.js";
import type { Product, Role } from "../src/types.js";

const CUSTOMER_TOOLS = ["search_catalog", "get_product", "save_lead"];
const OWNER_ONLY_TOOLS = ["upsert_product", "attach_pending_photos", "list_products", "list_leads"];

function toolNamesFor(role: Role): string[] {
  const db = openDb(":memory:");
  const { toolNames } = buildToolServer({
    db,
    config: {} as Config,
    ctx: { phone: "573000000000", role },
  });
  db.close();
  return toolNames.map((n) => n.replace(`mcp__${MCP_SERVER_NAME}__`, ""));
}

// This is the privilege boundary of the whole system: customers must never be
// offered the inventory/lead tools. Lock the tool sets in explicitly.
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

  // Photos reach a customer as a storefront link, never as images in the chat.
  // The tool server has no WhatsApp client at all, so this is structural — but
  // pin it anyway: a tool that could push media back would be a silent
  // regression of a product decision, in either role.
  it("gives NO role a way to send media into the chat", () => {
    for (const role of ["customer", "owner"] as const) {
      expect(toolNamesFor(role)).not.toContain("send_product_photos");
    }
  });
});

// search_catalog now answers with approximate matches, which is only safe if
// the agent can tell a hit from a near-miss. These pin the two things that make
// that possible: the score reaches the model, and a weak result set arrives
// labelled as weak.
function hit(code: string, score: number): SearchHit {
  return {
    product: {
      id: 1,
      code,
      title: `Casa ${code}`,
      description: null,
      price: 100,
      currency: "COP",
      status: "active",
      attributes: {},
      created_at: "",
      updated_at: "",
    } as Product,
    score,
  };
}

describe("renderSearchHits", () => {
  const config = { storefrontBaseUrl: "http://x" } as Config;

  it("tells the agent to capture a lead when nothing matched", () => {
    expect(renderSearchHits(config, [])).toContain("lead");
  });

  it("puts the match percentage on every line", () => {
    const out = renderSearchHits(config, [hit("916", 1), hit("1912", 0.75)]);
    expect(out).toContain("match=100%");
    expect(out).toContain("match=75%");
    expect(out).toContain("link=http://x/propiedad/916");
  });

  it("warns when even the best result is only approximate", () => {
    const out = renderSearchHits(config, [hit("916", 0.6)]);
    expect(out).toContain("APPROXIMATE");
  });

  it("stays quiet when the top result is a confident match", () => {
    const out = renderSearchHits(config, [hit("916", 1), hit("1912", 0.6)]);
    expect(out).not.toContain("APPROXIMATE");
  });
});

// "No products found." for status=draft means there are no DRAFTS. The agent
// read the literal sentence, three times over different statuses, and concluded
// the catalog had nothing in a sector it never filtered on. An empty answer has
// to carry the shape of its own question.
describe("renderProductList", () => {
  it("scopes an empty answer to the filter that produced it", () => {
    const out = renderProductList([], { status: "draft" });
    expect(out).toContain("status=draft");
    expect(out).toMatch(/nothing about|does not mean/i);
  });

  it("names the text that found nothing", () => {
    expect(renderProductList([], { neighborhood: "Llano Grande" })).toContain("Llano Grande");
  });

  it("reports an empty catalog plainly when nothing was filtered", () => {
    const out = renderProductList([], {});
    expect(out).toMatch(/empty|no products at all/i);
  });

  it("shows a match percentage only when text was actually asked for", () => {
    expect(renderProductList([hit("916", 0.8)], { neighborhood: "Laureles" })).toContain(
      "match=80%",
    );
    // A percentage against nothing is meaningless noise on an inventory report.
    expect(renderProductList([hit("916", 1)], { status: "active" })).not.toContain("match=");
  });

  it("lists the products it did find", () => {
    const out = renderProductList([hit("916", 1), hit("1912", 1)], {});
    expect(out).toContain("code=916");
    expect(out).toContain("code=1912");
  });
});

// The session-reset trigger: only the moment a product BECOMES active ends the
// unit of work. Editing an already-live listing mid-conversation must not reset.
describe("isPublishTransition", () => {
  it("fires when a draft is published", () => {
    expect(isPublishTransition("draft", "active")).toBe(true);
  });

  it("fires when a product is created directly as active", () => {
    expect(isPublishTransition(undefined, "active")).toBe(true);
  });

  it("fires when a sold or inactive product is republished", () => {
    expect(isPublishTransition("sold", "active")).toBe(true);
    expect(isPublishTransition("inactive", "active")).toBe(true);
  });

  it("does not fire when editing an already-active product", () => {
    expect(isPublishTransition("active", "active")).toBe(false);
  });

  it("does not fire on draft work", () => {
    expect(isPublishTransition("draft", "draft")).toBe(false);
    expect(isPublishTransition(undefined, "draft")).toBe(false);
    expect(isPublishTransition("active", "inactive")).toBe(false);
  });
});
