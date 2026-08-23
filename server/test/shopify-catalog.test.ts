import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adjustInventory,
  createProduct,
  deleteProduct,
  publishToOnlineStore,
  resolveLocation,
  resolveProduct,
  setInventory,
  updateProduct,
  uploadProductPhotos,
} from "../src/shopify/catalog.js";
import { ShopifyClient, type ShopifyConfig } from "../src/shopify/client.js";

const CONFIG: ShopifyConfig = {
  shopifyStoreDomain: "tienda.myshopify.com",
  shopifyAdminToken: "shpat_secret",
  shopifyApiVersion: "2026-01",
};

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

/**
 * A Shopify that answers with whatever the test queued, and records what it was
 * asked. Assertions are on the RECORDED CALLS: what this module gets wrong is
 * not parsing a response, it is sending the wrong mutation or dropping a field.
 */
function fakeShopify(responses: unknown[]): { client: ShopifyClient; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Call;
    calls.push(body);
    if (queue.length === 0) {
      throw new Error(`unexpected Shopify call: ${body.query.slice(0, 80)}`);
    }
    return new Response(JSON.stringify({ data: queue.shift() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { client: new ShopifyClient(CONFIG, fetchImpl, async () => undefined), calls };
}

const rawVariant = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/ProductVariant/1",
  sku: "CAM-NEG-M",
  title: "M",
  price: "80000.00",
  compareAtPrice: null,
  inventoryQuantity: 5,
  selectedOptions: [{ name: "Talla", value: "M" }],
  inventoryItem: { id: "gid://shopify/InventoryItem/1", tracked: true },
  ...overrides,
});

const rawProduct = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Product/1",
  handle: "camiseta-negra",
  title: "Camiseta negra",
  description: "",
  status: "DRAFT",
  productType: "Camiseta",
  vendor: "",
  tags: [],
  totalInventory: 5,
  onlineStoreUrl: null,
  updatedAt: "2026-08-01T00:00:00Z",
  mediaCount: { count: 0 },
  variants: { nodes: [rawVariant()] },
  ...overrides,
});

// A reference the owner typed has to land on exactly one product, and nothing
// here falls through to a text search: a fuzzy match that then feeds
// delete_product is how the wrong product gets deleted.
describe("resolveProduct", () => {
  it("resolves a gid directly, without a search", async () => {
    const { client, calls } = fakeShopify([{ product: rawProduct() }]);
    const resolved = await resolveProduct(client, "gid://shopify/Product/1");

    expect(resolved?.product.handle).toBe("camiseta-negra");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.variables["id"]).toBe("gid://shopify/Product/1");
  });

  // SKU first: it identifies a single VARIANT, which is what a stock or price
  // question is actually about.
  it("tries SKU before handle and carries the matched variant back", async () => {
    const { client, calls } = fakeShopify([
      { productVariants: { nodes: [{ ...rawVariant(), product: rawProduct() }] } },
    ]);
    const resolved = await resolveProduct(client, "CAM-NEG-M");

    expect(resolved?.variant?.sku).toBe("CAM-NEG-M");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.variables["query"]).toBe('sku:"CAM-NEG-M"');
  });

  it("falls back to the handle when no SKU matches", async () => {
    const { client, calls } = fakeShopify([
      { productVariants: { nodes: [] } },
      { products: { nodes: [rawProduct()] } },
    ]);
    const resolved = await resolveProduct(client, "camiseta-negra");

    expect(resolved?.product.handle).toBe("camiseta-negra");
    expect(resolved?.variant).toBeUndefined();
    expect(calls[1]!.variables["query"]).toBe('handle:"camiseta-negra"');
  });

  it("returns null rather than guessing when nothing matches", async () => {
    const { client } = fakeShopify([
      { productVariants: { nodes: [] } },
      { products: { nodes: [] } },
    ]);
    expect(await resolveProduct(client, "no-existe")).toBeNull();
  });

  // The query argument is its own little language. An unescaped quote does not
  // error — it silently changes which products the query selects.
  it("escapes quotes and backslashes in the reference", async () => {
    const { client, calls } = fakeShopify([{ productVariants: { nodes: [] } }, { products: { nodes: [] } }]);
    await resolveProduct(client, 'SKU" OR id:*');
    expect(calls[0]!.variables["query"]).toBe('sku:"SKU\\" OR id:*"');
  });

  it("treats an empty reference as no reference at all", async () => {
    const { client, calls } = fakeShopify([]);
    expect(await resolveProduct(client, "   ")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

// A merge, not a rewrite. A model rebuilding a payload from what it half
// remembers must not be able to overwrite correct data with a guess.
describe("updateProduct", () => {
  it("sends ONLY the fields it was given", async () => {
    const { client, calls } = fakeShopify([
      { productUpdate: { product: rawProduct({ status: "ACTIVE" }), userErrors: [] } },
    ]);
    await updateProduct(client, "gid://shopify/Product/1", { status: "ACTIVE" });

    expect(calls[0]!.variables["product"]).toEqual({
      id: "gid://shopify/Product/1",
      status: "ACTIVE",
    });
  });

  // An empty string is a real value — the owner clearing a description — and
  // must not be dropped as if it were absent.
  it("keeps an explicitly empty description", async () => {
    const { client, calls } = fakeShopify([
      { productUpdate: { product: rawProduct(), userErrors: [] } },
    ]);
    await updateProduct(client, "gid://shopify/Product/1", { description: "" });

    const sent = calls[0]!.variables["product"] as Record<string, unknown>;
    expect(sent["descriptionHtml"]).toBe("");
  });

  // userErrors arrives inside a 200 OK. A client that reports success on it
  // turns a rejected change into "Listo, actualicé el precio".
  it("throws when Shopify reports a userError", async () => {
    const { client } = fakeShopify([
      {
        productUpdate: {
          product: null,
          userErrors: [{ field: ["handle"], message: "Handle has already been taken" }],
        },
      },
    ]);
    await expect(
      updateProduct(client, "gid://shopify/Product/1", { title: "x" }),
    ).rejects.toThrow(/Handle has already been taken/);
  });
});

describe("createProduct", () => {
  it("declares the options from the variants and removes the standalone variant", async () => {
    const { client, calls } = fakeShopify([
      { productCreate: { product: rawProduct({ variants: { nodes: [] } }), userErrors: [] } },
      { productVariantsBulkCreate: { product: rawProduct(), userErrors: [] } },
    ]);

    await createProduct(client, {
      product: { title: "Camiseta negra" },
      optionNames: ["Talla"],
      variants: [
        { sku: "CAM-NEG-M", price: 80000, optionValues: ["M"], quantity: 10 },
        { sku: "CAM-NEG-L", price: 80000, optionValues: ["L"] },
      ],
      locationId: "gid://shopify/Location/1",
    });

    const created = calls[0]!.variables["product"] as Record<string, unknown>;
    expect(created["status"]).toBe("DRAFT"); // review before it is for sale
    expect(created["productOptions"]).toEqual([
      { name: "Talla", values: [{ name: "M" }, { name: "L" }] },
    ]);

    // Leaving the default variant behind puts a phantom "Default Title" line in
    // the store next to the real sizes.
    expect(calls[1]!.variables["strategy"]).toBe("REMOVE_STANDALONE_VARIANT");
    const variants = calls[1]!.variables["variants"] as Record<string, unknown>[];
    expect(variants[0]!["price"]).toBe("80000.00");
    expect(variants[0]!["inventoryQuantities"]).toEqual([
      { locationId: "gid://shopify/Location/1", availableQuantity: 10 },
    ]);
    // The second variant stated no opening stock, so none is set — 0 would be a
    // claim the owner never made.
    expect(variants[1]!["inventoryQuantities"]).toBeUndefined();
  });

  // Shopify derives a product's option values from its variants, so a
  // disagreement between the two produces a product with variants nobody can
  // select. Caught before anything is created rather than half-way through.
  it("refuses a variant whose option values do not match the declared options", async () => {
    const { client, calls } = fakeShopify([]);
    await expect(
      createProduct(client, {
        product: { title: "Camiseta" },
        optionNames: ["Talla", "Color"],
        variants: [{ sku: "X", price: 1000, optionValues: ["M"] }],
      locationId: "gid://shopify/Location/1",
      }),
    ).rejects.toThrow(/option value/i);
    expect(calls).toHaveLength(0);
  });
});

// This is the sharpest risk in the whole integration: delivery is at-least-once
// by design, so a retried batch would apply the same delta twice and remove six
// shirts where the owner sold three, with nothing recording that it happened.
describe("adjustInventory", () => {
  it("passes an idempotency key with the mutation", async () => {
    const { client, calls } = fakeShopify([
      {
        inventoryAdjustQuantities: {
          userErrors: [],
          inventoryAdjustmentGroup: { changes: [{ name: "available", delta: -3, quantityAfterChange: 2 }] },
        },
      },
    ]);

    const after = await adjustInventory(client, {
      inventoryItemId: "gid://shopify/InventoryItem/1",
      locationId: "gid://shopify/Location/1",
      delta: -3,
      idempotencyKey: "msg:wamid.ABC:1",
      reason: "correction",
    });

    expect(after).toBe(2);
    expect(calls[0]!.query).toContain("@idempotent(key: $key)");
    expect(calls[0]!.variables["key"]).toBe("msg:wamid.ABC:1");
    const input = calls[0]!.variables["input"] as Record<string, unknown>;
    expect(input["name"]).toBe("available");
    expect(input["changes"]).toEqual([
      {
        delta: -3,
        inventoryItemId: "gid://shopify/InventoryItem/1",
        locationId: "gid://shopify/Location/1",
      },
    ]);
  });

  it("throws on a userError instead of reporting the adjustment as done", async () => {
    const { client } = fakeShopify([
      {
        inventoryAdjustQuantities: {
          userErrors: [{ message: "Inventory item not stocked at location" }],
          inventoryAdjustmentGroup: null,
        },
      },
    ]);
    await expect(
      adjustInventory(client, {
        inventoryItemId: "i",
        locationId: "l",
        delta: 1,
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/not stocked/);
  });
});

// compareQuantity turns this into a compare-and-set: if someone sold one at the
// counter between the read and this write, the mutation fails instead of
// silently overwriting their sale.
describe("setInventory", () => {
  it("sends compareQuantity when the current count is known", async () => {
    const { client, calls } = fakeShopify([{ inventorySetQuantities: { userErrors: [] } }]);
    await setInventory(client, {
      inventoryItemId: "gid://shopify/InventoryItem/1",
      locationId: "gid://shopify/Location/1",
      quantity: 11,
      compareQuantity: 12,
    });

    const input = calls[0]!.variables["input"] as Record<string, unknown>;
    expect(input["ignoreCompareQuantity"]).toBe(false);
    expect((input["quantities"] as Record<string, unknown>[])[0]!["compareQuantity"]).toBe(12);
  });

  it("opts out of the check only when the current count is genuinely unknown", async () => {
    const { client, calls } = fakeShopify([{ inventorySetQuantities: { userErrors: [] } }]);
    await setInventory(client, { inventoryItemId: "i", locationId: "l", quantity: 11 });

    const input = calls[0]!.variables["input"] as Record<string, unknown>;
    expect(input["ignoreCompareQuantity"]).toBe(true);
    expect((input["quantities"] as Record<string, unknown>[])[0]!["compareQuantity"]).toBeUndefined();
  });
});

// Moving four shirts out of the wrong warehouse is an error nobody notices
// until a count, so an ambiguous location is a question, not a default.
describe("resolveLocation", () => {
  const twoLocations = () => ({
    locations: {
      nodes: [
        { id: "gid://shopify/Location/1", name: "Bodega Centro" },
        { id: "gid://shopify/Location/2", name: "Punto Envigado" },
      ],
    },
  });

  it("resolves silently when the store has exactly one location", async () => {
    const { client } = fakeShopify([
      { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Principal" }] } },
    ]);
    expect((await resolveLocation(client, "", undefined)).name).toBe("Principal");
  });

  it("refuses to guess when there is more than one and none was given", async () => {
    const { client } = fakeShopify([twoLocations()]);
    await expect(resolveLocation(client, "", undefined)).rejects.toThrow(/more than one location/i);
  });

  it("matches a location by name as well as by id", async () => {
    const { client } = fakeShopify([twoLocations()]);
    expect((await resolveLocation(client, "", "punto envigado")).id).toBe(
      "gid://shopify/Location/2",
    );
  });

  it("names the real options when the requested location does not exist", async () => {
    const { client } = fakeShopify([twoLocations()]);
    await expect(resolveLocation(client, "", "Bodega Norte")).rejects.toThrow(
      /Bodega Centro, Punto Envigado/,
    );
  });

  it("prefers the configured default over asking", async () => {
    const { client } = fakeShopify([twoLocations()]);
    expect((await resolveLocation(client, "gid://shopify/Location/2")).name).toBe("Punto Envigado");
  });
});

// status ACTIVE alone does not make a product visible. Reporting "publicado" on
// the strength of the status field is the most plausible wrong-but-plausible
// bug in this integration, so the caller is told what actually happened.
describe("publishToOnlineStore", () => {
  it("publishes to the Online Store publication", async () => {
    const { client, calls } = fakeShopify([
      {
        publications: {
          nodes: [
            { id: "gid://shopify/Publication/9", name: "Point of Sale" },
            { id: "gid://shopify/Publication/7", name: "Online Store" },
          ],
        },
      },
      { publishablePublish: { userErrors: [] } },
    ]);

    expect(await publishToOnlineStore(client, "gid://shopify/Product/1")).toBe(true);
    expect(calls[1]!.variables["input"]).toEqual([{ publicationId: "gid://shopify/Publication/7" }]);
  });

  // The status change already succeeded. Throwing here would retry the whole
  // turn over a reporting detail, so this degrades instead.
  it("reports false rather than throwing when the channel cannot be found", async () => {
    const { client } = fakeShopify([{ publications: { nodes: [] } }]);
    expect(await publishToOnlineStore(client, "gid://shopify/Product/1")).toBe(false);
  });

  it("reports false when the publish itself is rejected", async () => {
    const { client } = fakeShopify([
      { publications: { nodes: [{ id: "p", name: "Online Store" }] } },
      { publishablePublish: { userErrors: [{ message: "not publishable" }] } },
    ]);
    expect(await publishToOnlineStore(client, "gid://shopify/Product/1")).toBe(false);
  });
});

describe("deleteProduct", () => {
  it("throws when nothing was actually deleted", async () => {
    const { client } = fakeShopify([{ productDelete: { deletedProductId: null, userErrors: [] } }]);
    await expect(deleteProduct(client, "gid://shopify/Product/1")).rejects.toThrow(/no deleted/i);
  });
});

// Photo order is not cosmetic: the bridge delivers a WhatsApp burst strictly
// sequentially, so arrival order is the order the owner shot them in and the
// first one becomes the product's cover.
describe("uploadProductPhotos", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vitrina-photos-"));
    for (const name of ["a.jpg", "b.png", "c.jpg"]) {
      writeFileSync(join(dir, name), Buffer.from([0xff, 0xd8, 0xff]));
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const stagedFor = (name: string) => ({
    stagedUploadsCreate: {
      stagedTargets: [
        {
          url: "https://storage.example.com/upload",
          resourceUrl: `https://storage.example.com/${name}`,
          parameters: [{ name: "key", value: name }],
        },
      ],
      userErrors: [],
    },
  });
  const attached = { productCreateMedia: { mediaUserErrors: [] } };

  it("uploads in the order given, one at a time", async () => {
    const { client, calls } = fakeShopify([
      stagedFor("a.jpg"),
      attached,
      stagedFor("b.png"),
      attached,
    ]);
    const uploads: string[] = [];
    const uploadFetch = (async (url: string) => {
      uploads.push(url);
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;

    const result = await uploadProductPhotos(
      client,
      "gid://shopify/Product/1",
      [{ path: join(dir, "a.jpg") }, { path: join(dir, "b.png"), alt: "de frente" }],
      uploadFetch,
    );

    expect(result).toEqual({ uploaded: 2, failed: 0 });
    expect(uploads).toHaveLength(2);

    const first = calls[0]!.variables["input"] as Record<string, unknown>[];
    expect(first[0]!["filename"]).toBe("a.jpg");
    expect(first[0]!["mimeType"]).toBe("image/jpeg");
    // The extension decides the type; a PNG announced as a JPEG is rejected by
    // the storage backend, not by us.
    const second = calls[2]!.variables["input"] as Record<string, unknown>[];
    expect(second[0]!["mimeType"]).toBe("image/png");

    const media = (calls[3]!.variables["media"] as Record<string, unknown>[])[0]!;
    expect(media["originalSource"]).toBe("https://storage.example.com/b.png");
    expect(media["alt"]).toBe("de frente");
  });

  // Losing the last photo of a set is not a reason to undo the ones that
  // landed, or to replay the whole turn.
  it("reports a partial result instead of failing the batch", async () => {
    const { client } = fakeShopify([stagedFor("a.jpg"), attached, stagedFor("b.png")]);
    let call = 0;
    const uploadFetch = (async () => {
      call += 1;
      return new Response("", { status: call === 1 ? 201 : 403 });
    }) as unknown as typeof fetch;

    const result = await uploadProductPhotos(
      client,
      "gid://shopify/Product/1",
      [{ path: join(dir, "a.jpg") }, { path: join(dir, "b.png") }],
      uploadFetch,
    );

    expect(result).toEqual({ uploaded: 1, failed: 1 });
  });

  it("counts an unreadable file as failed rather than throwing", async () => {
    const { client } = fakeShopify([]);
    const result = await uploadProductPhotos(
      client,
      "gid://shopify/Product/1",
      [{ path: join(dir, "does-not-exist.jpg") }],
      (async () => new Response("", { status: 201 })) as unknown as typeof fetch,
    );
    expect(result).toEqual({ uploaded: 0, failed: 1 });
  });
});
