import { describe, expect, it, vi } from "vitest";
import {
  assertNoUserErrors,
  gidSuffix,
  ShopifyClient,
  ShopifyError,
  toMoneyString,
  type ShopifyConfig,
} from "../src/shopify/client.js";

const CONFIG: ShopifyConfig = {
  shopifyStoreDomain: "tienda.myshopify.com",
  shopifyAdminToken: "shpat_secret",
  shopifyApiVersion: "2026-01",
};

/** A JSON response, as the Admin API returns them. */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A client whose backoff does not actually wait. */
function client(fetchImpl: typeof fetch): ShopifyClient {
  return new ShopifyClient(CONFIG, fetchImpl, async () => undefined);
}

describe("ShopifyClient request", () => {
  it("posts to the pinned version's graphql endpoint with the token header", async () => {
    const fetchImpl = vi.fn(async () => json({ data: { ok: true } }));
    await client(fetchImpl as unknown as typeof fetch).request("query { ok }", { a: 1 });

    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://tienda.myshopify.com/admin/api/2026-01/graphql.json");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat_secret");
    expect(JSON.parse(init.body as string)).toEqual({ query: "query { ok }", variables: { a: 1 } });
  });

  it("returns the data payload", async () => {
    const fetchImpl = async () => json({ data: { product: { id: "gid://shopify/Product/1" } } });
    const data = await client(fetchImpl as typeof fetch).request<{ product: { id: string } }>("q");
    expect(data.product.id).toBe("gid://shopify/Product/1");
  });
});

// The Admin API is a leaky bucket of query cost. Throttling arrives as a 200 OK
// with THROTTLED in the errors array — exactly the shape a client that only
// checks res.ok treats as a hard failure, which would fail the whole batch and
// replay the entire agent turn 30 seconds later.
describe("ShopifyClient throttling", () => {
  it("retries a THROTTLED response and returns the eventual success", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls < 3
        ? json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] })
        : json({ data: { ok: true } });
    };

    const data = await client(fetchImpl as typeof fetch).request<{ ok: boolean }>("q");
    expect(data.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("gives up after the attempt budget rather than retrying forever", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
    };

    await expect(client(fetchImpl as typeof fetch).request("q")).rejects.toThrow(/throttled/i);
    expect(calls).toBe(4);
  });

  it("retries a 429 and a 5xx", async () => {
    for (const status of [429, 500, 503]) {
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        return calls === 1 ? json({}, status) : json({ data: { ok: true } });
      };
      await client(fetchImpl as typeof fetch).request("q");
      expect(calls, `status ${status} should have been retried`).toBe(2);
    }
  });

  // A 401 is a bad token and a 400 is a malformed query. Retrying either only
  // spends the rate-limit bucket on a request that cannot start working.
  it("does NOT retry a 4xx that is not 429", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return json({ errors: [{ message: "Invalid API key" }] }, 401);
    };

    await expect(client(fetchImpl as typeof fetch).request("q")).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });
});

describe("ShopifyClient errors", () => {
  it("raises a GraphQL error rather than returning empty data", async () => {
    const fetchImpl = async () => json({ errors: [{ message: "Field 'nope' doesn't exist" }] });
    await expect(client(fetchImpl as typeof fetch).request("q")).rejects.toThrow(/nope/);
  });

  it("raises when the body has neither data nor errors", async () => {
    const fetchImpl = async () => json({});
    await expect(client(fetchImpl as typeof fetch).request("q")).rejects.toThrow(/no data/i);
  });

  it("raises on a non-JSON body instead of crashing on the parse", async () => {
    const fetchImpl = async () => new Response("<html>maintenance</html>", { status: 200 });
    await expect(client(fetchImpl as typeof fetch).request("q")).rejects.toBeInstanceOf(ShopifyError);
  });

  it("retries a network failure and surfaces it once the budget is spent", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    };
    await expect(client(fetchImpl as typeof fetch).request("q")).rejects.toThrow(/ECONNRESET/);
    expect(calls).toBe(4);
  });
});

// userErrors is the ONLY place Shopify says a write did not happen: the status
// is 200 and `errors` is absent. Skipping this check anywhere turns a rejected
// price change into "Listo, actualicé el precio".
describe("assertNoUserErrors", () => {
  it("passes on an empty or missing list", () => {
    expect(() => assertNoUserErrors("productUpdate", [])).not.toThrow();
    expect(() => assertNoUserErrors("productUpdate", undefined)).not.toThrow();
    expect(() => assertNoUserErrors("productUpdate", null)).not.toThrow();
  });

  it("throws with the mutation name and the field path", () => {
    expect(() =>
      assertNoUserErrors("productUpdate", [
        { field: ["product", "handle"], message: "Handle has already been taken" },
      ]),
    ).toThrow(/productUpdate rejected: product\.handle: Handle has already been taken/);
  });

  it("survives an error with no field", () => {
    expect(() => assertNoUserErrors("productDelete", [{ message: "Not found" }])).toThrow(
      /Not found/,
    );
  });
});

// Money goes OUT as a decimal string. It never comes back through here — reads
// pass Shopify's own string straight through — so no stored price is ever
// rebuilt from a float.
describe("toMoneyString", () => {
  it("formats to two decimals", () => {
    expect(toMoneyString(80000)).toBe("80000.00");
    expect(toMoneyString(19.9)).toBe("19.90");
    expect(toMoneyString(0)).toBe("0.00");
  });

  it("refuses a value that is not a finite number", () => {
    expect(() => toMoneyString(Number.NaN)).toThrow(ShopifyError);
    expect(() => toMoneyString(Number.POSITIVE_INFINITY)).toThrow(ShopifyError);
  });
});

describe("gidSuffix", () => {
  it("extracts the numeric id", () => {
    expect(gidSuffix("gid://shopify/Product/1234")).toBe("1234");
  });

  it("returns the input unchanged when it is not a gid", () => {
    expect(gidSuffix("camiseta-negra")).toBe("camiseta-negra");
  });
});
