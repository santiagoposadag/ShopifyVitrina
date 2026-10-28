import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { loadDefinition, type AgentDefinition } from "../src/agent/definition.js";
import { AGENT_IDS } from "../src/router.js";
import { buildToolServer, MCP_SERVER_NAME, TOOL_REGISTRY, toolUniverse } from "../src/tools/registry.js";
import { newToolContext, renderDescription } from "../src/tools/factory.js";
import {
  describeProduct,
  findVariantsByLabel,
  isPublishTransition,
  newOptionValues,
  renderProductList,
  renderSearchHits,
  resolveUpdateVariant,
  whyVariantsCannotBeAdded,
} from "../src/tools/packs/catalog.js";
import { cartPermalink, storefrontHost } from "../src/shopify/catalog-port.js";
import type { SearchHit } from "../src/shopify/rank.js";
import type { ShopifyProduct } from "../src/shopify/types.js";
import type { TurnContext } from "../src/types.js";
import { callsTo, fakePorts, fakeProduct } from "./helpers/fake-ports.js";
import { whatsappPrincipal } from "../src/inbox/envelope.js";

const AGENTS_DIR = join(REPO_ROOT, "agents");

const CUSTOMER_TOOLS = ["search_catalog", "get_product", "save_lead", "build_cart"];
const OWNER_ONLY_TOOLS = [
  "list_products",
  "create_product",
  "update_product",
  "add_variant",
  "delete_product",
  "get_inventory",
  "adjust_inventory",
  "attach_pending_photos",
  "list_locations",
  "list_leads",
  // Phase 4. NOT one of the pre-split fourteen: this list was captured from
  // the role-selected owner set in agent/tools.ts, and search_knowledge did not
  // exist then. It is here because agents/vitrina-inventario/agent.yaml
  // deliberately declares it — the pin caught that change, which is its job.
  // It stays a strict set equality: a tool that arrives without an edit here is
  // a tool nobody decided to grant.
  "search_knowledge",
];

function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    principal: whatsappPrincipal("573000000000"),
    phone: "573000000000",
    role: "customer",
    agentId: AGENT_IDS.customer,
    conversationKey: "573000000000",
    turnKey: "msg:1",
    hop: 0,
    ...overrides,
  };
}

/** One tool, ready to call, from a definition that declares exactly these keys. */
function build(definition: AgentDefinition, ctx: TurnContext = turnContext()) {
  const fake = fakePorts();
  const { tools, toolNames } = buildToolServer({ definition, ctx, ports: fake.ports });
  return {
    fake,
    toolNames,
    names: tools.map((t) => t.name),
    tool: (name: string) => {
      const found = tools.find((t) => t.name === name);
      if (!found) throw new Error(`no tool named ${name} was served`);
      return found;
    },
  };
}

/** The text a tool handed back to the model. */
async function callTool(
  tool: { handler: (args: never, extra: never) => Promise<{ content: { text?: string }[] }> },
  args: Record<string, unknown>,
): Promise<string> {
  const result = await tool.handler(args as never, undefined as never);
  return result.content.map((block) => block.text ?? "").join("");
}

function definitionWith(tools: string[], overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "fixture-agent",
    roles: ["owner"],
    model: { maxTurns: 12 },
    tools,
    prompt: { base: "grounding", persona: "prompt.md", slots: {} },
    knowledge: { inline: [], searchable: [], maxInlineTokens: 0 },
    session: { resetOn: [], keyedBy: "principal" },
    reach: [],
    personaText: "A persona.",
    ...overrides,
  };
}

// This is the privilege boundary of the whole system. It matters more here than
// it did over a read-only storefront: an owner tool reaching a customer is a
// stranger repricing a live store, or deleting a product out of it.
//
// The boundary is now DATA — the served set is `definition.tools[]` — so these
// pins read the shipped definitions rather than a role switch. The literal
// lists above are what a bad edit to a yaml file has to get past.
describe("the privilege boundary, per definition", () => {
  it("gives the customer agent exactly the customer tools — no owner tool leaks", () => {
    const names = build(loadDefinition(AGENTS_DIR, AGENT_IDS.customer)).names;
    expect(names.sort()).toEqual([...CUSTOMER_TOOLS].sort());
    for (const ownerTool of OWNER_ONLY_TOOLS) {
      expect(names).not.toContain(ownerTool);
    }
  });

  it("gives the owner agent the customer tools plus the owner tools", () => {
    const names = build(loadDefinition(AGENTS_DIR, AGENT_IDS.owner)).names;
    expect(names.sort()).toEqual([...CUSTOMER_TOOLS, ...OWNER_ONLY_TOOLS].sort());
  });

  // Nothing may write to the catalog from the customer path, whatever it is
  // called. Pinned by prefix rather than by name so a future create_variant or
  // set_price cannot slip in unnoticed.
  it("gives the customer agent no tool that can write to the store", () => {
    for (const name of build(loadDefinition(AGENTS_DIR, AGENT_IDS.customer)).names) {
      expect(name).not.toMatch(/^(create|update|delete|adjust|set|attach|publish)_/);
    }
  });

  // The tool server has no WhatsApp client at all, so this is structural — but
  // pin it anyway: a tool that could push media back would be a silent
  // regression of a product decision, for any agent.
  it("gives NO agent a way to send media into the chat", () => {
    for (const agentId of Object.values(AGENT_IDS)) {
      expect(build(loadDefinition(AGENTS_DIR, agentId)).names).not.toContain("send_product_photos");
    }
    // Including one nobody has declared yet: the registry is the whole universe.
    expect([...TOOL_REGISTRY.keys()]).not.toContain("send_product_photos");
  });

  // The role used to choose the tool set. It must not be able to any more —
  // otherwise the definition is decoration and the boundary is still a switch.
  it("serves the same set whatever role the turn context carries", () => {
    for (const agentId of Object.values(AGENT_IDS)) {
      const definition = loadDefinition(AGENTS_DIR, agentId);
      const asOwner = build(definition, turnContext({ role: "owner", agentId })).names;
      const asCustomer = build(definition, turnContext({ role: "customer", agentId })).names;
      expect(asOwner).toEqual(asCustomer);
    }
  });
});

/**
 * The served set IS `definition.tools[]` — §2.3's first rule.
 *
 * The set-equality is per definition and against the DECLARED list, so a tool
 * added to a pack reaches nobody until a definition names it, and a name in a
 * definition that the registry cannot serve fails loudly rather than silently
 * serving thirteen of fourteen tools.
 */
describe("buildToolServer serves exactly what the definition declares", () => {
  for (const agentId of Object.values(AGENT_IDS)) {
    it(`${agentId}: the served keys equal its tools[]`, () => {
      const definition = loadDefinition(AGENTS_DIR, agentId);
      const { tools } = buildToolServer({
        definition,
        ctx: turnContext({ agentId }),
        ports: fakePorts().ports,
      });
      const served = definition.tools.map((key) => TOOL_REGISTRY.get(key)?.name);
      expect(tools.map((t) => t.name)).toEqual(served);
      expect(tools).toHaveLength(definition.tools.length);
    });
  }

  it("serves one tool for a definition that declares one, and nothing else", () => {
    expect(build(definitionWith(["search_catalog"])).names).toEqual(["search_catalog"]);
  });

  it("refuses to build a definition naming a tool the registry does not have", () => {
    expect(() => build(definitionWith(["teleport_product"]))).toThrow(/teleport_product/);
  });

  // Two registry entries may share one exposed name (get_product does), and an
  // MCP server with two tools of the same name is a coin flip over which one
  // the model reaches. Refused where it is still a definition error.
  it("refuses a definition whose tools resolve to the same exposed name twice", () => {
    expect(() => build(definitionWith(["get_product", "get_product_any_status"]))).toThrow(
      /get_product/,
    );
  });

  it("allowedTools names every served tool, mcp-prefixed", () => {
    const { toolNames, names } = build(loadDefinition(AGENTS_DIR, AGENT_IDS.owner));
    expect(toolNames).toEqual(names.map((n) => `mcp__${MCP_SERVER_NAME}__${n}`));
  });

  // The universe the boot validator checks definitions against comes from the
  // registry itself — there is no second list to keep in sync with it.
  it("the tool universe is the registry's own keys", () => {
    expect([...toolUniverse().keys].sort()).toEqual([...TOOL_REGISTRY.keys()].sort());
  });
});

/**
 * `get_product` is two registry entries under one exposed name.
 *
 * The customer's answers "no product found" for anything not ACTIVE, because
 * confirming that a hidden product exists is itself a leak; the owner's sees
 * drafts and archived products. Which one an agent gets is decided by its
 * definition, never by the role on the turn — the pin below builds the
 * customer's entry with an OWNER role in the context.
 */
describe("get_product, the two entries", () => {
  const draft = fakeProduct({ status: "DRAFT", handle: "vela-borrador" });

  it("the customer's entry hides a draft behind the same answer as a genuine miss", async () => {
    const { fake, tool } = build(
      definitionWith(["get_product"]),
      turnContext({ role: "owner" }),
    );
    fake.products.set("vela-borrador", { product: draft });

    expect(await callTool(tool("get_product"), { ref: "vela-borrador" })).toBe(
      'No product found for "vela-borrador".',
    );
    expect(await callTool(tool("get_product"), { ref: "nada" })).toBe(
      'No product found for "nada".',
    );
  });

  it("the customer's entry answers normally for a product that IS for sale", async () => {
    const { fake, tool } = build(definitionWith(["get_product"]));
    const active = fakeProduct();
    fake.products.set("062AC-MZ", { product: active });

    expect(await callTool(tool("get_product"), { ref: "062AC-MZ" })).toBe(describeProduct(active));
  });

  it("the owner's entry sees the draft, under the same name the model calls", async () => {
    const { fake, tool } = build(
      definitionWith(["get_product_any_status"]),
      turnContext({ role: "customer" }),
    );
    fake.products.set("vela-borrador", { product: draft });

    // Same exposed name: both personas name get_product in prose.
    expect(TOOL_REGISTRY.get("get_product_any_status")?.name).toBe("get_product");
    expect(await callTool(tool("get_product"), { ref: "vela-borrador" })).toBe(
      describeProduct(draft),
    );
  });
});

/**
 * The stock idempotency key.
 *
 * `ctx.turnKey` is stable across retries of the same batch, which is what makes
 * a replayed delta safe. Two adjustments in ONE turn would then share it and
 * Shopify would discard the second as a duplicate — the owner sold three and
 * two more, and only three left the count. The counter that separates them
 * lives on the turn's context, shared by every tool the turn builds.
 */
describe("adjust_inventory idempotency keys", () => {
  const definition = definitionWith(["adjust_inventory"]);

  async function adjustTwice(ctx: TurnContext): Promise<string[]> {
    const { fake, tool } = build(definition, ctx);
    fake.products.set("062AC-MZ", {
      product: fakeProduct(),
      variant: fakeProduct().variants[0],
    });
    await callTool(tool("adjust_inventory"), { sku: "062AC-MZ", delta: -3 });
    await callTool(tool("adjust_inventory"), { sku: "062AC-MZ", delta: -2 });
    return callsTo(fake, "adjustInventory").map(
      ([input]) => (input as { idempotencyKey: string }).idempotencyKey,
    );
  }

  it("gives two adjustments in ONE turn different keys", async () => {
    const keys = await adjustTwice(turnContext({ turnKey: "inbox:41" }));
    expect(keys).toEqual(["inbox:41:1", "inbox:41:2"]);
    expect(new Set(keys).size).toBe(2);
  });

  it("gives the SAME keys when the batch is replayed", async () => {
    // A retry re-runs the turn from the same inbox rows, so turnKey is the same
    // and the counter starts over — which is exactly what makes Shopify discard
    // the replay instead of removing the units twice.
    const first = await adjustTwice(turnContext({ turnKey: "inbox:41" }));
    const replay = await adjustTwice(turnContext({ turnKey: "inbox:41" }));
    expect(replay).toEqual(first);
  });

  it("gives a different turn different keys", async () => {
    const first = await adjustTwice(turnContext({ turnKey: "inbox:41" }));
    const later = await adjustTwice(turnContext({ turnKey: "inbox:42" }));
    expect(first.some((key) => later.includes(key))).toBe(false);
  });

  // One counter per TURN, not per pack and not per tool: a second pack that
  // moves stock would otherwise start its own sequence at 1 and collide with
  // the first tool's key on the very first call.
  it("counts once per turn, whichever tool asks", () => {
    const ctx = newToolContext(turnContext({ turnKey: "inbox:41" }), {});
    expect([ctx.nextInventoryKey(), ctx.nextInventoryKey(), ctx.nextInventoryKey()]).toEqual([
      "inbox:41:1",
      "inbox:41:2",
      "inbox:41:3",
    ]);
  });

  // set_to is a compare-and-set against the count that was just read, so it
  // carries no key — and must not consume one either.
  it("does not spend a key on a set_to, which is idempotent by construction", async () => {
    const { fake, tool } = build(definition, turnContext({ turnKey: "inbox:41" }));
    fake.products.set("062AC-MZ", {
      product: fakeProduct(),
      variant: fakeProduct().variants[0],
    });
    await callTool(tool("adjust_inventory"), { sku: "062AC-MZ", set_to: 11 });
    await callTool(tool("adjust_inventory"), { sku: "062AC-MZ", delta: -3 });

    expect(callsTo(fake, "setInventory")).toHaveLength(1);
    expect(
      callsTo(fake, "adjustInventory").map(([i]) => (i as { idempotencyKey: string }).idempotencyKey),
    ).toEqual(["inbox:41:1"]);
  });
});

/**
 * The guards that stand between the model and an irreversible write. Each one
 * is checked before any mutation is sent, and the recorded calls are what prove
 * nothing was sent.
 */
describe("write guards reach the port only when they should", () => {
  it("delete_product refuses when the echoed handle is not the one that resolved", async () => {
    const { fake, tool } = build(definitionWith(["delete_product"]));
    fake.products.set("062AC-MZ", { product: fakeProduct() });

    const out = await callTool(tool("delete_product"), {
      ref: "062AC-MZ",
      confirm_handle: "vela-lavanda",
    });

    expect(out).toMatch(/Refused/);
    expect(callsTo(fake, "remove")).toEqual([]);
  });

  it("delete_product deletes when the handle matches exactly", async () => {
    const { fake, tool } = build(definitionWith(["delete_product"]));
    fake.products.set("062AC-MZ", { product: fakeProduct() });

    await callTool(tool("delete_product"), { ref: "062AC-MZ", confirm_handle: "vela-citronela" });

    expect(callsTo(fake, "remove")).toEqual([["gid://shopify/Product/1"]]);
  });

  it("update_product sends only the fields it was given", async () => {
    const { fake, tool } = build(definitionWith(["update_product"]));
    fake.products.set("062AC-MZ", { product: fakeProduct() });

    await callTool(tool("update_product"), { ref: "062AC-MZ", vendor: "Luminiere" });

    expect(callsTo(fake, "update")).toEqual([
      [
        "gid://shopify/Product/1",
        {
          title: undefined,
          description: undefined,
          status: undefined,
          productType: undefined,
          vendor: "Luminiere",
          tags: undefined,
        },
      ],
    ]);
  });

  /** Four variants of one product sharing ONE sku — the live duplicate-SKU bug. */
  function archangelCandle(): ShopifyProduct {
    const names = ["Jofiel", "Chamuel", "Gabriel", "Rafael"];
    return fakeProduct({
      handle: "vela-arcangel-3d",
      title: "Vela Arcángel 3D",
      options: [{ name: "Nombre", values: names }],
      variants: names.map((name, i) => ({
        id: `gid://shopify/ProductVariant/${i + 1}`,
        sku: "VANG-RA",
        title: name,
        price: "45000.00",
        compareAtPrice: null,
        inventoryQuantity: 3,
        inventoryItemId: `gid://shopify/InventoryItem/${i + 1}`,
        inventoryTracked: true,
        selectedOptions: [{ name: "Nombre", value: name }],
      })),
    });
  }

  it("update_product refuses when both variant and variant_sku are given", async () => {
    const { fake, tool } = build(definitionWith(["update_product"]));
    fake.products.set("vela-arcangel-3d", { product: archangelCandle() });

    const out = await callTool(tool("update_product"), {
      ref: "vela-arcangel-3d",
      variant: "Rafael",
      variant_sku: "VANG-RA",
      price: 46000,
    });

    expect(out).toMatch(/not both/);
    expect(callsTo(fake, "updateVariants")).toEqual([]);
  });

  it("update_product selects a variant by label when the SKU is shared", async () => {
    const { fake, tool } = build(definitionWith(["update_product"]));
    fake.products.set("vela-arcangel-3d", { product: archangelCandle() });

    await callTool(tool("update_product"), {
      ref: "vela-arcangel-3d",
      variant: "Rafael",
      price: 46000,
    });

    expect(callsTo(fake, "updateVariants")).toEqual([
      ["gid://shopify/Product/1", [{ id: "gid://shopify/ProductVariant/4", price: 46000, sku: undefined }]],
    ]);
  });

  it("update_product refuses a variant_sku that names more than one variant", async () => {
    const { fake, tool } = build(definitionWith(["update_product"]));
    fake.products.set("vela-arcangel-3d", { product: archangelCandle() });

    const out = await callTool(tool("update_product"), {
      ref: "vela-arcangel-3d",
      variant_sku: "VANG-RA",
      price: 46000,
    });

    expect(out).toMatch(/shared by 4 variants/);
    expect(out).toContain("Rafael");
    expect(callsTo(fake, "updateVariants")).toEqual([]);
  });

  // catalog.resolve resolves the PRODUCT cleanly here (every owner of the
  // shared SKU agrees on it) and leaves `variant` unset — which of its 4
  // variants was meant is still open, so with no selector at all this must
  // land on the generic "say which one" refusal, not a mutation.
  it("update_product refuses when a shared-SKU ref names no variant at all", async () => {
    const { fake, tool } = build(definitionWith(["update_product"]));
    fake.products.set("VANG-RA", { product: archangelCandle() });

    const out = await callTool(tool("update_product"), { ref: "VANG-RA", price: 46000 });

    expect(out).toMatch(/variant_sku/);
    expect(callsTo(fake, "updateVariants")).toEqual([]);
  });

  // A shared SKU used AS THE REF still resolves the product; `variant`
  // selects among its variants exactly as it does when the ref was the
  // product's handle. This is the documented repair recipe for a duplicated
  // SKU: ref (the SKU itself) + variant (the name) + new_sku.
  it("update_product selects a variant by label when the ref itself is the shared SKU", async () => {
    const { fake, tool } = build(definitionWith(["update_product"]));
    fake.products.set("VANG-RA", { product: archangelCandle() });

    await callTool(tool("update_product"), {
      ref: "VANG-RA",
      variant: "Rafael",
      new_sku: "VANG-RAFAEL",
    });

    expect(callsTo(fake, "updateVariants")).toEqual([
      [
        "gid://shopify/Product/1",
        [{ id: "gid://shopify/ProductVariant/4", price: undefined, sku: "VANG-RAFAEL" }],
      ],
    ]);
  });

  // Defense in depth: even if some other path ever handed resolveUpdateVariant
  // a `resolvedVariant` whose own SKU turns out to be shared (catalog.resolve
  // itself no longer does this — see shopify-catalog.test.ts — but the guard
  // stays, the same way canUseTool stays behind allowedTools), it must not be
  // used implicitly. Pinned directly against resolveUpdateVariant below too.
  it("update_product still refuses an implicit variant whose own SKU turns out to be shared", async () => {
    const { fake, tool } = build(definitionWith(["update_product"]));
    const candle = archangelCandle();
    fake.products.set("VANG-RA", { product: candle, variant: candle.variants[0] });

    const out = await callTool(tool("update_product"), { ref: "VANG-RA", price: 46000 });

    expect(out).toMatch(/shared by 4/);
    expect(callsTo(fake, "updateVariants")).toEqual([]);
  });

  it("update_product refuses a new_sku already used by a different variant", async () => {
    const { fake, tool } = build(definitionWith(["update_product"]));
    const target = fakeProduct();
    fake.products.set("062AC-MZ", { product: target });
    const otherVariant = { ...target.variants[0]!, id: "gid://shopify/ProductVariant/999" };
    fake.skuOwners = [{ product: fakeProduct({ handle: "otra-vela" }), variant: otherVariant }];

    const out = await callTool(tool("update_product"), {
      ref: "062AC-MZ",
      new_sku: "TAKEN-SKU",
    });

    expect(out).toMatch(/Refused/);
    expect(out).toContain("otra-vela");
    expect(callsTo(fake, "updateVariants")).toEqual([]);
  });

  it("update_product allows a new_sku already held by the SAME target variant", async () => {
    const { fake, tool } = build(definitionWith(["update_product"]));
    const target = fakeProduct();
    fake.products.set("062AC-MZ", { product: target });
    // The uniqueness check must exclude the variant being written to, or a
    // no-op re-send of its own SKU would refuse itself.
    fake.skuOwners = [{ product: target, variant: target.variants[0]! }];

    await callTool(tool("update_product"), { ref: "062AC-MZ", new_sku: "062AC-MZ" });

    expect(callsTo(fake, "updateVariants")).toEqual([
      ["gid://shopify/Product/1", [{ id: "gid://shopify/ProductVariant/51237367841067", price: undefined, sku: "062AC-MZ" }]],
    ]);
  });

  it("adjust_inventory refuses a SKU shared by more than one variant", async () => {
    const { fake, tool } = build(definitionWith(["adjust_inventory"]));
    fake.products.set("VANG-RA", { product: archangelCandle() });

    const out = await callTool(tool("adjust_inventory"), { sku: "VANG-RA", delta: -1 });

    expect(out).toMatch(/shared by 4 variants/);
    expect(callsTo(fake, "adjustInventory")).toEqual([]);
    expect(callsTo(fake, "setInventory")).toEqual([]);
  });

  // catalog.resolve resolves the PRODUCT (every owner of "VANG-RA" agrees on
  // it) but leaves `variant` unset. build_cart needs exactly ONE variant to
  // build a line — it must refuse rather than add an arbitrary one of the 4.
  it("build_cart refuses a SKU shared by more than one variant of the same product", async () => {
    const { fake, tool } = build(definitionWith(["build_cart"]));
    fake.products.set("VANG-RA", { product: archangelCandle() });

    const out = await callTool(tool("build_cart"), {
      items_json: '[{"sku":"VANG-RA","quantity":1}]',
    });

    expect(out).toMatch(/No variant found/);
    expect(callsTo(fake, "cartUrl")).toEqual([]);
  });

  it("build_cart refuses a sold-out variant before a link exists", async () => {
    const { fake, tool } = build(definitionWith(["build_cart"]));
    const product = fakeProduct();
    product.variants[0]!.inventoryQuantity = 0;
    fake.products.set("062AC-MZ", { product, variant: product.variants[0] });

    const out = await callTool(tool("build_cart"), {
      items_json: '[{"sku":"062AC-MZ","quantity":1}]',
    });

    expect(out).toMatch(/SOLD OUT/);
    expect(callsTo(fake, "cartUrl")).toEqual([]);
  });

  it("build_cart refuses an unpublished product before a link exists", async () => {
    const { fake, tool } = build(definitionWith(["build_cart"]));
    const product = fakeProduct({ onlineStoreUrl: null });
    fake.products.set("062AC-MZ", { product, variant: product.variants[0] });

    const out = await callTool(tool("build_cart"), {
      items_json: '[{"sku":"062AC-MZ","quantity":1}]',
    });

    expect(out).toMatch(/not published/);
    expect(callsTo(fake, "cartUrl")).toEqual([]);
  });

  // Photos go up in the order they arrived, and only the ids that actually
  // landed are marked — a partial failure leaves the rest claimable.
  it("attach_pending_photos uploads in arrival order and marks only what landed", async () => {
    const { fake, tool } = build(definitionWith(["attach_pending_photos"]));
    fake.products.set("062AC-MZ", { product: fakeProduct() });
    fake.pending = [
      { id: 1, path: "/staging/a.jpg", caption: "primera" },
      { id: 2, path: "/staging/b.jpg", caption: null },
    ];

    await callTool(tool("attach_pending_photos"), { ref: "062AC-MZ" });

    expect(callsTo(fake, "uploadPhotos")).toEqual([
      [
        "gid://shopify/Product/1",
        [
          { path: "/staging/a.jpg", alt: "primera" },
          { path: "/staging/b.jpg", alt: null },
        ],
      ],
    ]);
    expect(callsTo(fake, "markAttached")).toEqual([[[1, 2], "gid://shopify/Product/1"]]);
  });
});

/**
 * `catalog.resolve` can answer with an `AmbiguousResolution` instead of a
 * product — a SKU that names more than one exact owner, possibly on
 * different products. Every tool that calls `resolve` has to check for it
 * BEFORE touching `.product`, and refuse the same way: no mutation, and the
 * candidates named so the model can retry with something unambiguous.
 */
describe("an ambiguous catalog.resolve reaches every caller the same way", () => {
  function ambiguity(ref: string) {
    return {
      ambiguous: true as const,
      ref,
      candidates: [
        { product: fakeProduct({ handle: "vela-arcangel-3d" }), variant: fakeProduct().variants[0]! },
        { product: fakeProduct({ handle: "vela-arcangel-3d-bodega-2" }), variant: fakeProduct().variants[0]! },
      ],
    };
  }

  it("update_product refuses and names both products, sending no mutation", async () => {
    const { fake, tool } = build(definitionWith(["update_product"]));
    fake.products.set("VANG-RA", ambiguity("VANG-RA"));

    const out = await callTool(tool("update_product"), { ref: "VANG-RA", price: 46000 });

    expect(out).toMatch(/matches more than one variant/);
    expect(out).toContain("vela-arcangel-3d");
    expect(out).toContain("vela-arcangel-3d-bodega-2");
    expect(callsTo(fake, "update")).toEqual([]);
    expect(callsTo(fake, "updateVariants")).toEqual([]);
  });

  it("adjust_inventory refuses before reading or writing any stock", async () => {
    const { fake, tool } = build(definitionWith(["adjust_inventory"]));
    fake.products.set("VANG-RA", ambiguity("VANG-RA"));

    const out = await callTool(tool("adjust_inventory"), { sku: "VANG-RA", delta: -1 });

    expect(out).toMatch(/matches more than one variant/);
    expect(callsTo(fake, "inventoryLevels")).toEqual([]);
    expect(callsTo(fake, "adjustInventory")).toEqual([]);
    expect(callsTo(fake, "setInventory")).toEqual([]);
  });

  it("get_product refuses rather than describing a first pick", async () => {
    const { fake, tool } = build(definitionWith(["get_product"]));
    fake.products.set("VANG-RA", ambiguity("VANG-RA"));

    const out = await callTool(tool("get_product"), { ref: "VANG-RA" });

    expect(out).toMatch(/matches more than one variant/);
  });

  it("build_cart refuses before a link exists", async () => {
    const { fake, tool } = build(definitionWith(["build_cart"]));
    fake.products.set("VANG-RA", ambiguity("VANG-RA"));

    const out = await callTool(tool("build_cart"), {
      items_json: '[{"sku":"VANG-RA","quantity":1}]',
    });

    expect(out).toMatch(/matches more than one variant/);
    expect(callsTo(fake, "cartUrl")).toEqual([]);
  });

  it("delete_product refuses before anything is removed", async () => {
    const { fake, tool } = build(definitionWith(["delete_product"]));
    fake.products.set("VANG-RA", ambiguity("VANG-RA"));

    const out = await callTool(tool("delete_product"), {
      ref: "VANG-RA",
      confirm_handle: "vela-arcangel-3d",
    });

    expect(out).toMatch(/matches more than one variant/);
    expect(callsTo(fake, "remove")).toEqual([]);
  });
});

/**
 * Descriptions are templates, and the definition fills the business literals.
 *
 * The golden fixture proves today's descriptions did not change. It cannot
 * prove the templating is wired: a build that dropped slot rendering entirely
 * would still render every shipped description correctly, because neither
 * shipped definition sets a slot. These pin the seam itself.
 */
describe("templated descriptions", () => {
  const CART_EXAMPLE = '[{"sku":"062AMLLA","quantity":1}]';

  it("falls back to the pack's own literal when the definition sets no slot", () => {
    const { tool } = build(definitionWith(["build_cart"]));
    expect(tool("build_cart").inputSchema.items_json.description).toBe(
      `JSON array of what they chose: ${CART_EXAMPLE}`,
    );
  });

  it("lets a definition replace the business literal without touching the code", () => {
    const { tool } = build(
      definitionWith(["build_cart"], {
        prompt: {
          base: "grounding",
          persona: "prompt.md",
          slots: { example_cart_items_json: '[{"sku":"VEL-01","quantity":2}]' },
        },
      }),
    );
    expect(tool("build_cart").inputSchema.items_json.description).toBe(
      'JSON array of what they chose: [{"sku":"VEL-01","quantity":2}]',
    );
  });

  // A slot nothing fills would reach the model as literal braces inside an
  // otherwise plausible sentence — it renders, it deploys, and only a reading
  // of the prompt would catch it.
  it("refuses to render a description with a slot nothing fills", () => {
    expect(() => renderDescription("Use {{example_sku}} exactly.", {})).toThrow(/example_sku/);
    expect(renderDescription("Use {{example_sku}}.", { example_sku: "062AC-MZ" })).toBe(
      "Use 062AC-MZ.",
    );
  });
});

/**
 * `status: ACTIVE` does not publish. A flow that sets ACTIVE, reports success
 * and leaves the product invisible is the most plausible wrong-but-plausible
 * bug here, so the tool reports which of the two actually happened.
 */
describe("publishing is a second operation, and says which half happened", () => {
  it("publishes a product created directly as ACTIVE, and resets the session", async () => {
    const ctx = turnContext();
    const { fake, tool } = build(definitionWith(["create_product"]), ctx);

    const out = await callTool(tool("create_product"), {
      title: "Vela citronela",
      status: "ACTIVE",
      variants_json: '[{"sku":"062AC-MZ","price":13800}]',
    });

    expect(callsTo(fake, "publish")).toEqual([["gid://shopify/Product/1"]]);
    expect(out).toContain(" Published to the online store.");
    expect(ctx.sessionAfterTurn).toBe("reset");
  });

  it("does not publish a draft, and leaves the session alone", async () => {
    const ctx = turnContext();
    const { fake, tool } = build(definitionWith(["create_product"]), ctx);

    await callTool(tool("create_product"), {
      title: "Vela citronela",
      variants_json: '[{"sku":"062AC-MZ","price":13800}]',
    });

    expect(callsTo(fake, "publish")).toEqual([]);
    expect(ctx.sessionAfterTurn).toBeUndefined();
  });

  it("warns when the status changed but the publish did not happen", async () => {
    // publish() returns false rather than throwing: the status change already
    // succeeded, and an ACTIVE product nobody can see must be said out loud.
    const { fake, tool } = build(definitionWith(["update_product"]));
    fake.products.set("062AC-MZ", { product: fakeProduct({ status: "DRAFT" }) });
    fake.ports.catalog.publish = async () => false;

    const out = await callTool(tool("update_product"), { ref: "062AC-MZ", status: "ACTIVE" });

    expect(out).toContain("WARNING: status is ACTIVE but it could not be published");
    expect(out).toContain("NOT visible to customers");
  });
});

/**
 * Publishing ends a unit of work, and only a TRANSITION to ACTIVE counts. The
 * signal still travels through ctx.sessionAfterTurn — `session.resetOn` stays
 * declared and unread, because a reset at tool-name granularity would drop the
 * owner's session on an ordinary price edit.
 */
describe("the publish transition still signals through the turn context", () => {
  it("asks for a session reset when an update publishes the product", async () => {
    const ctx = turnContext();
    const { fake, tool } = build(definitionWith(["update_product"]), ctx);
    fake.products.set("062AC-MZ", { product: fakeProduct({ status: "DRAFT" }) });

    await callTool(tool("update_product"), { ref: "062AC-MZ", status: "ACTIVE" });

    expect(callsTo(fake, "publish")).toEqual([["gid://shopify/Product/1"]]);
    expect(ctx.sessionAfterTurn).toBe("reset");
  });

  it("leaves the session alone when an already-active product is edited", async () => {
    const ctx = turnContext();
    const { fake, tool } = build(definitionWith(["update_product"]), ctx);
    fake.products.set("062AC-MZ", { product: fakeProduct({ status: "ACTIVE" }) });

    await callTool(tool("update_product"), { ref: "062AC-MZ", vendor: "Luminiere" });

    expect(callsTo(fake, "publish")).toEqual([]);
    expect(ctx.sessionAfterTurn).toBeUndefined();
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
    options: [],
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

/**
 * Adding a variant to an existing product.
 *
 * A variant is ONE combination of the product's option axes, and Shopify
 * matches the values POSITIONALLY. Every guard here exists because the wrong
 * answer does not error — it silently creates a variant that is wrong.
 */
describe("whyVariantsCannotBeAdded", () => {
  /** The real shape: two axes, and only SOME combinations sold. */
  function candle(): ShopifyProduct {
    return product({
      handle: "vela-aromatica-manzanilla",
      options: [
        { name: "Diámetro", values: ["5 cm", "7,5 cm"] },
        { name: "Altura", values: ["8 cm", "10 cm"] },
      ],
      variants: [
        {
          id: "gid://shopify/ProductVariant/1",
          sku: "062AC-MZ",
          title: "5 cm / 8 cm",
          price: "13800.00",
          compareAtPrice: null,
          inventoryQuantity: 4,
          inventoryItemId: "gid://shopify/InventoryItem/1",
          inventoryTracked: true,
          selectedOptions: [
            { name: "Diámetro", value: "5 cm" },
            { name: "Altura", value: "8 cm" },
          ],
        },
      ],
    });
  }

  it("accepts a combination that does not exist yet", () => {
    const draft = [{ price: 17900, option_values: ["5 cm", "10 cm"] }];
    expect(whyVariantsCannotBeAdded(candle(), draft)).toBeNull();
  });

  it("refuses a variant that gives the wrong NUMBER of option values", () => {
    // The dangerous case: Shopify matches positionally and does not error, so
    // one value on a two-axis product creates a variant whose height landed in
    // the diameter axis.
    const draft = [{ price: 17900, option_values: ["5 cm"] }];
    expect(whyVariantsCannotBeAdded(candle(), draft)).toMatch(/exactly 2 option_values/);
  });

  it("refuses a combination the product already sells", () => {
    // Not an update. The owner almost certainly meant update_product.
    const draft = [{ price: 15000, option_values: ["5 cm", "8 cm"] }];
    expect(whyVariantsCannotBeAdded(candle(), draft)).toMatch(/already has the combination/);
  });

  it("refuses a product with no option axes at all", () => {
    // One anonymous default variant; Shopify cannot attach a second to it.
    const plain = product({ handle: "vela-simple", options: [] });
    expect(whyVariantsCannotBeAdded(plain, [{ price: 100, option_values: [] }])).toMatch(
      /no option axes/,
    );
  });

  it("matches an existing combination by axis NAME, not by position", () => {
    // selectedOptions come back in Shopify's order, which need not be the
    // product's option order. Comparing positionally would miss the duplicate.
    const p = candle();
    p.variants[0]!.selectedOptions = [
      { name: "Altura", value: "8 cm" },
      { name: "Diámetro", value: "5 cm" },
    ];
    expect(whyVariantsCannotBeAdded(p, [{ price: 1, option_values: ["5 cm", "8 cm"] }])).toMatch(
      /already has the combination/,
    );
  });
});

describe("newOptionValues", () => {
  function candle(): ShopifyProduct {
    return product({
      options: [
        { name: "Diámetro", values: ["5 cm", "7,5 cm"] },
        { name: "Altura", values: ["8 cm"] },
      ],
      variants: [],
    });
  }

  it("says nothing when every value already exists", () => {
    expect(newOptionValues(candle(), [{ price: 1, option_values: ["7,5 cm", "8 cm"] }])).toEqual([]);
  });

  it("reports a value the product has never used", () => {
    expect(newOptionValues(candle(), [{ price: 1, option_values: ["9 cm", "8 cm"] }])).toEqual([
      'Diámetro="9 cm"',
    ]);
  });

  it("catches the decimal-separator typo, which Shopify does NOT normalise", () => {
    // "7.5 cm" and "7,5 cm" become two different axis values, permanently.
    // Only the owner can tell a new size from a typo, so this reports it.
    expect(newOptionValues(candle(), [{ price: 1, option_values: ["7.5 cm", "8 cm"] }])).toEqual([
      'Diámetro="7.5 cm"',
    ]);
  });

  it("does not repeat the same new value across several variants", () => {
    const drafts = [
      { price: 1, option_values: ["9 cm", "8 cm"] },
      { price: 2, option_values: ["9 cm", "8 cm"] },
    ];
    expect(newOptionValues(candle(), drafts)).toEqual(['Diámetro="9 cm"']);
  });
});

/**
 * Selecting a variant by its title or option values, not just by SKU.
 *
 * A live audit found variants with no SKU at all (an option axis like
 * "Aroma" with values nobody gave a code) and SKUs duplicated across every
 * variant of one product (one candle line shares "VANG-RA" across four
 * archangel names) — both make SKU-only targeting unreachable or dangerous.
 */
describe("findVariantsByLabel", () => {
  /** Four variants of one product, all sharing ONE sku — the live bug. */
  function archangelCandle(): ShopifyProduct {
    const names = ["Jofiel", "Chamuel", "Gabriel", "Rafael"];
    return product({
      handle: "vela-arcangel-3d",
      title: "Vela Arcángel 3D",
      options: [{ name: "Nombre", values: names }],
      variants: names.map((name, i) => ({
        id: `gid://shopify/ProductVariant/${i + 1}`,
        sku: "VANG-RA",
        title: name,
        price: "45000.00",
        compareAtPrice: null,
        inventoryQuantity: 3,
        inventoryItemId: `gid://shopify/InventoryItem/${i + 1}`,
        inventoryTracked: true,
        selectedOptions: [{ name: "Nombre", value: name }],
      })),
    });
  }

  /** One variant with NO sku, on a two-axis product — the other live bug. */
  function botanicalCandle(): ShopifyProduct {
    return product({
      handle: "vela-botanica",
      title: "Vela Botánica",
      options: [
        { name: "Aroma", values: ["Aromática"] },
        { name: "Diámetro", values: ["8 cm"] },
      ],
      variants: [
        {
          id: "gid://shopify/ProductVariant/9",
          sku: null,
          title: "Aromática / 8 cm",
          price: "17900.00",
          compareAtPrice: null,
          inventoryQuantity: 6,
          inventoryItemId: "gid://shopify/InventoryItem/9",
          inventoryTracked: true,
          selectedOptions: [
            { name: "Aroma", value: "Aromática" },
            { name: "Diámetro", value: "8 cm" },
          ],
        },
      ],
    });
  }

  it("selects a single-axis variant by one value", () => {
    const matches = findVariantsByLabel(archangelCandle(), "Rafael");
    expect(matches.map((v) => v.title)).toEqual(["Rafael"]);
  });

  it("selects a two-axis variant by 'A / B', in EITHER order", () => {
    const candle = botanicalCandle();
    expect(findVariantsByLabel(candle, "Aromática / 8 cm").map((v) => v.id)).toEqual([
      "gid://shopify/ProductVariant/9",
    ]);
    expect(findVariantsByLabel(candle, "8 cm / Aromática").map((v) => v.id)).toEqual([
      "gid://shopify/ProductVariant/9",
    ]);
  });

  it("folds accents, case and stray whitespace", () => {
    const candle = botanicalCandle();
    expect(findVariantsByLabel(candle, "  AROMATICA  /  8 CM  ").map((v) => v.id)).toEqual([
      "gid://shopify/ProductVariant/9",
    ]);
  });

  it("finds nothing for a label that names no variant", () => {
    expect(findVariantsByLabel(archangelCandle(), "Miguel")).toEqual([]);
  });

  it("matches more than one variant for an ambiguous label", () => {
    // Two variants sharing a value on one axis, distinguished on another.
    const p = product({
      options: [
        { name: "Color", values: ["Dorado"] },
        { name: "Diámetro", values: ["10 cm", "24 cm"] },
      ],
      variants: [
        {
          id: "gid://shopify/ProductVariant/1",
          sku: "VD-DOR-10",
          title: "Dorado / 10 cm",
          price: "40000.00",
          compareAtPrice: null,
          inventoryQuantity: 1,
          inventoryItemId: "gid://shopify/InventoryItem/1",
          inventoryTracked: true,
          selectedOptions: [
            { name: "Color", value: "Dorado" },
            { name: "Diámetro", value: "10 cm" },
          ],
        },
        {
          id: "gid://shopify/ProductVariant/2",
          sku: "VD-DOR-24",
          title: "Dorado / 24 cm",
          price: "50000.00",
          compareAtPrice: null,
          inventoryQuantity: 1,
          inventoryItemId: "gid://shopify/InventoryItem/2",
          inventoryTracked: true,
          selectedOptions: [
            { name: "Color", value: "Dorado" },
            { name: "Diámetro", value: "24 cm" },
          ],
        },
      ],
    });
    // "Dorado" alone names only one VALUE, not one variant of a two-axis
    // product — it must not resolve to either half of an incomplete label.
    expect(findVariantsByLabel(p, "Dorado")).toEqual([]);
  });

  // The values were compared as a SET, so a two-axis variant carrying the
  // SAME value on both axes de-duplicated down to size 1 — exactly matching a
  // one-word label that only ever named ONE of its two axes. The true axis
  // count (selectedOptions.length, a multiset) is what must be compared.
  it("does not match a one-word label against a variant with a repeated value on two axes", () => {
    const p = product({
      options: [
        { name: "Color", values: ["Dorado"] },
        { name: "Acabado", values: ["Dorado"] },
      ],
      variants: [
        {
          id: "gid://shopify/ProductVariant/1",
          sku: "VD-DOR-DOR",
          title: "Dorado / Dorado",
          price: "40000.00",
          compareAtPrice: null,
          inventoryQuantity: 1,
          inventoryItemId: "gid://shopify/InventoryItem/1",
          inventoryTracked: true,
          selectedOptions: [
            { name: "Color", value: "Dorado" },
            { name: "Acabado", value: "Dorado" },
          ],
        },
      ],
    });
    expect(findVariantsByLabel(p, "Dorado")).toEqual([]);
    // The full two-part label still matches it, in either order.
    expect(findVariantsByLabel(p, "Dorado / Dorado").map((v) => v.id)).toEqual([
      "gid://shopify/ProductVariant/1",
    ]);
  });
});

/**
 * `resolveUpdateVariant` — the decision update_product makes before any
 * mutation is sent. Every path that could land on more than one variant must
 * refuse rather than guess, because Shopify itself never enforces the
 * uniqueness that would make guessing safe.
 */
describe("resolveUpdateVariant", () => {
  const names = ["Jofiel", "Chamuel", "Gabriel", "Rafael"];
  function archangelCandle(): ShopifyProduct {
    return product({
      handle: "vela-arcangel-3d",
      options: [{ name: "Nombre", values: names }],
      variants: names.map((name, i) => ({
        id: `gid://shopify/ProductVariant/${i + 1}`,
        sku: "VANG-RA",
        title: name,
        price: "45000.00",
        compareAtPrice: null,
        inventoryQuantity: 3,
        inventoryItemId: `gid://shopify/InventoryItem/${i + 1}`,
        inventoryTracked: true,
        selectedOptions: [{ name: "Nombre", value: name }],
      })),
    });
  }

  it("resolves an unambiguous variant label", () => {
    const target = resolveUpdateVariant(archangelCandle(), undefined, { variant: "Rafael" });
    expect(target).not.toBeTypeOf("string");
    expect((target as { title: string }).title).toBe("Rafael");
  });

  it("refuses a variant_sku shared by several variants, naming them", () => {
    const refusal = resolveUpdateVariant(archangelCandle(), undefined, { variantSku: "VANG-RA" });
    expect(refusal).toBeTypeOf("string");
    expect(refusal as string).toContain("shared by 4 variants");
    for (const name of names) expect(refusal as string).toContain(name);
  });

  // Defense in depth: catalog.resolve itself never hands back a `variant`
  // whose own SKU is shared any more (see shopify-catalog.test.ts) — it
  // leaves `variant` unset for that case instead. This guard is what stops
  // an implicit pick if a `resolvedVariant` with a shared SKU ever reaches
  // here anyway, the silent-wrong-variant case.
  it("refuses the implicit path when the resolved variant's own SKU is ambiguous", () => {
    const candle = archangelCandle();
    const refusal = resolveUpdateVariant(candle, candle.variants[0], {});
    expect(refusal).toBeTypeOf("string");
    expect(refusal as string).toMatch(/shared by 4/);
  });

  it("uses the implicit variant when its SKU is not shared", () => {
    const single = product();
    const target = resolveUpdateVariant(single, single.variants[0], {});
    expect(target).toBe(single.variants[0]);
  });
});

/**
 * The cart link is a URL, not an API call — which is exactly why the parts that
 * can be wrong are wrong SILENTLY. A gid where a numeric id belongs, or the
 * wrong host, both produce a page that loads and simply is not the cart the
 * customer was promised.
 */
describe("cartPermalink", () => {
  it("uses the NUMERIC variant id, never the gid", () => {
    // Shopify's /cart route does not accept a gid. It does not error either —
    // it shows an empty cart, which reads as "the shop lost my order".
    const url = cartPermalink("luminiere.co", [
      { variantId: "gid://shopify/ProductVariant/51237367841067", quantity: 1 },
    ]);
    expect(url).toBe("https://luminiere.co/cart/51237367841067:1");
    expect(url).not.toContain("gid");
  });

  it("joins several lines with commas, keeping quantities", () => {
    const url = cartPermalink("luminiere.co", [
      { variantId: "gid://shopify/ProductVariant/1", quantity: 2 },
      { variantId: "gid://shopify/ProductVariant/2", quantity: 1 },
    ]);
    expect(url).toBe("https://luminiere.co/cart/1:2,2:1");
  });
});

describe("storefrontHost", () => {
  it("prefers the host the store actually answers on", () => {
    // The config holds awyk1i-b4.myshopify.com while the store serves
    // luminiere.co. Both reach checkout, but sending a customer the myshopify
    // one looks like a phishing link.
    const p = product({ onlineStoreUrl: "https://luminiere.co/products/vela-citronela" });
    expect(storefrontHost([p], "awyk1i-b4.myshopify.com")).toBe("luminiere.co");
  });

  it("falls back to the configured domain when nothing is published", () => {
    const p = product({ onlineStoreUrl: null });
    expect(storefrontHost([p], "awyk1i-b4.myshopify.com")).toBe("awyk1i-b4.myshopify.com");
  });

  it("skips a product whose url is unusable rather than failing the cart", () => {
    const broken = product({ onlineStoreUrl: "not a url" });
    const good = product({ onlineStoreUrl: "https://luminiere.co/products/x" });
    expect(storefrontHost([broken, good], "fallback.myshopify.com")).toBe("luminiere.co");
  });
});
