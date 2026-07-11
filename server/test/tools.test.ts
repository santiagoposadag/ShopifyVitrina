import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { KapsoClient } from "../src/kapso.js";
import { buildToolServer, MCP_SERVER_NAME } from "../src/tools.js";
import type { Role } from "../src/types.js";

const CUSTOMER_TOOLS = ["search_catalog", "get_product", "send_product_photos", "save_lead"];
const OWNER_ONLY_TOOLS = ["upsert_product", "attach_pending_photos", "list_products", "list_leads"];

function toolNamesFor(role: Role): string[] {
  const db = openDb(":memory:");
  const { toolNames } = buildToolServer({
    db,
    kapso: {} as KapsoClient,
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
});
