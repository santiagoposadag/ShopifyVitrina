import type {
  AgentsPort,
  AskAgentRequest,
  AskAgentResult,
  CartLine,
  CatalogPort,
  CatalogSearch,
  CatalogSearchResult,
  KnowledgeHit,
  KnowledgePort,
  LeadDraft,
  LeadsPort,
  MediaPort,
  PendingPhoto,
  ResolvedProduct,
  ToolPorts,
} from "../../src/tools/ports.js";
import type { Lead } from "../../src/types.js";
import type {
  InventoryLevel,
  ProductInput,
  ShopifyLocation,
  ShopifyProduct,
  VariantInput,
} from "../../src/shopify/types.js";

/**
 * The ports as a plain object, recording what each tool asked for.
 *
 * This is what the port layer buys: the packs can be driven with no GraphQL
 * client, no cache, no database and no casts. Assertions are on the RECORDED
 * CALLS, because what this layer gets wrong is not parsing a response — it is
 * sending the wrong thing, or dropping a field like an idempotency key.
 */
export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface FakePorts {
  ports: ToolPorts;
  calls: RecordedCall[];
  /** Answers for `resolve`, keyed by the exact ref the tool passes. */
  products: Map<string, ResolvedProduct>;
  pending: PendingPhoto[];
  /** What `adjustInventory` reports back as the resulting count. */
  quantityAfterAdjust: number | null;
  /** What the knowledge port answers with. */
  knowledgeHits: KnowledgeHit[];
}

export function fakeProduct(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: "gid://shopify/Product/1",
    handle: "vela-citronela",
    title: "Vela citronela",
    description: "",
    status: "ACTIVE",
    productType: "Vela",
    vendor: "",
    tags: [],
    totalInventory: 4,
    onlineStoreUrl: "https://luminiere.co/products/vela-citronela",
    mediaCount: 0,
    options: [{ name: "Diámetro", values: ["5 cm"] }],
    updatedAt: "2026-08-01T00:00:00Z",
    variants: [
      {
        id: "gid://shopify/ProductVariant/51237367841067",
        sku: "062AC-MZ",
        title: "5 cm",
        price: "13800.00",
        compareAtPrice: null,
        inventoryQuantity: 4,
        inventoryItemId: "gid://shopify/InventoryItem/1",
        inventoryTracked: true,
        selectedOptions: [{ name: "Diámetro", value: "5 cm" }],
      },
    ],
    ...overrides,
  };
}

const LOCATION: ShopifyLocation = { id: "gid://shopify/Location/1", name: "Bodega" };

export function fakePorts(): FakePorts {
  const calls: RecordedCall[] = [];
  const products = new Map<string, ResolvedProduct>();
  const state: FakePorts = {
    calls,
    products,
    pending: [],
    quantityAfterAdjust: 1,
    knowledgeHits: [],
    ports: undefined as unknown as ToolPorts,
  };
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };

  const catalog: CatalogPort = {
    async search(input: CatalogSearch): Promise<CatalogSearchResult> {
      record("search", input);
      return { hits: [], truncated: false };
    },
    async resolve(ref: string): Promise<ResolvedProduct | null> {
      record("resolve", ref);
      return products.get(ref) ?? null;
    },
    variantBySku(product: ShopifyProduct, sku: string) {
      return product.variants.find((v) => v.sku?.toLowerCase() === sku.trim().toLowerCase());
    },
    async locations(): Promise<ShopifyLocation[]> {
      record("locations");
      return [LOCATION];
    },
    async location(requested?: string): Promise<ShopifyLocation> {
      record("location", requested);
      return LOCATION;
    },
    async inventoryLevels(inventoryItemId: string): Promise<InventoryLevel[]> {
      record("inventoryLevels", inventoryItemId);
      return [{ locationId: LOCATION.id, locationName: LOCATION.name, available: 4 }];
    },
    async adjustInventory(input): Promise<number | null> {
      record("adjustInventory", input);
      return state.quantityAfterAdjust;
    },
    async setInventory(input): Promise<void> {
      record("setInventory", input);
    },
    async create(input): Promise<ShopifyProduct> {
      record("create", input);
      return fakeProduct({ status: input.product.status ?? "DRAFT" });
    },
    async update(productId: string, fields: ProductInput): Promise<ShopifyProduct> {
      record("update", productId, fields);
      return fakeProduct({ status: fields.status ?? "ACTIVE" });
    },
    async updateVariants(productId, variants): Promise<ShopifyProduct> {
      record("updateVariants", productId, variants);
      return fakeProduct();
    },
    async addVariants(input: {
      productId: string;
      optionNames: string[];
      variants: VariantInput[];
      locationId: string;
    }): Promise<ShopifyProduct> {
      record("addVariants", input);
      return fakeProduct();
    },
    async remove(productId: string): Promise<void> {
      record("remove", productId);
    },
    async publish(productId: string): Promise<boolean> {
      record("publish", productId);
      return true;
    },
    async uploadPhotos(productId, files): Promise<{ uploaded: number; failed: number }> {
      record("uploadPhotos", productId, files);
      return { uploaded: files.length, failed: 0 };
    },
    cartUrl(lines: CartLine[]): string {
      record("cartUrl", lines);
      return "https://luminiere.co/cart/fake";
    },
  };

  const leads: LeadsPort = {
    async save(draft: LeadDraft): Promise<Lead> {
      record("saveLead", draft);
      return {
        id: 7,
        phone: draft.phone,
        product_code: draft.productCode ?? null,
        type: draft.type,
        name: draft.name ?? null,
        note: draft.note ?? null,
        status: "new",
        created_at: "2026-09-06T00:00:00Z",
      };
    },
    async list(sinceDays?: number): Promise<Lead[]> {
      record("listLeads", sinceDays);
      return [];
    },
  };

  const media: MediaPort = {
    async listPending(phone: string): Promise<PendingPhoto[]> {
      record("listPending", phone);
      return state.pending;
    },
    async markAttached(ids: number[], productId: string): Promise<void> {
      record("markAttached", ids, productId);
    },
  };

  /**
   * The knowledge base as a plain object: it records the scope it was asked
   * for, which is the assertion that matters — a leak between agents is a
   * wrong `agentId` on this call, not a wrong string in a rendered result.
   * `hits` is what it answers with; empty by default.
   */
  const knowledge: KnowledgePort = {
    async search(input): Promise<KnowledgeHit[]> {
      record("searchKnowledge", input);
      return state.knowledgeHits;
    },
  };

  /**
   * The agent door as a plain object. It REFUSES by default and reaches
   * nobody: a fake that answered would let a test pass while the real door was
   * never asked, and every suite but the ask_agent one has no business sending
   * a message to another agent at all.
   */
  const agents: AgentsPort = {
    reachOf(agentId: string): readonly string[] {
      record("reachOf", agentId);
      return [];
    },
    async ask(request: AskAgentRequest): Promise<AskAgentResult> {
      record("askAgent", request);
      return { ok: false, reason: "reach_denied" };
    },
  };

  state.ports = { catalog, leads, media, knowledge, agents };
  return state;
}

/** Every call recorded for one port method, in order. */
export function callsTo(fake: FakePorts, method: string): unknown[][] {
  return fake.calls.filter((c) => c.method === method).map((c) => c.args);
}
