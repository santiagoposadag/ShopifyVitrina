import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDb } from "../src/data/db.js";
import { buildToolServer, isPublishTransition, MCP_SERVER_NAME } from "../src/agent/tools.js";
import type { Role } from "../src/types.js";

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
