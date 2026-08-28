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
  shopifyClientId: "",
  shopifyClientSecret: "",
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

/**
 * Minting the access token.
 *
 * Shopify stopped allowing new admin-created custom apps in January 2026, so a
 * new store's credentials are a Dev Dashboard client id and secret — and the
 * token they buy expires in 24 hours (expires_in: 86399). Those two do not
 * expire, which is why they are what lives in the environment and the token is
 * minted here.
 */
describe("ShopifyClient token minting", () => {
  const CREDS: ShopifyConfig = {
    ...CONFIG,
    // No ready-made token: this deployment mints its own.
    shopifyAdminToken: "",
    shopifyClientId: "client-id",
    shopifyClientSecret: "client-secret",
  };

  const TOKEN_URL = "https://tienda.myshopify.com/admin/oauth/access_token";
  const GRAPHQL_URL = "https://tienda.myshopify.com/admin/api/2026-01/graphql.json";

  /** A token-endpoint response. 86399 is what Shopify actually returns. */
  function tokenBody(token: string, expiresIn = 86399): Response {
    return json({ access_token: token, scope: "read_products", expires_in: expiresIn });
  }

  /**
   * A fake Shopify that answers both endpoints, with a movable clock.
   *
   * `mints` counts token requests, which is the number most of these tests are
   * really about: a token that is minted twice when once would do is a wasted
   * round trip on every agent turn.
   */
  function harness(opts: { graphql?: (token: string, n: number) => Response } = {}) {
    let clockMs = 1_000_000;
    const mints: string[] = [];
    const sent: string[] = [];
    let issued = 0;
    let graphqlCalls = 0;

    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url === TOKEN_URL) {
        mints.push(init.body as string);
        issued += 1;
        return tokenBody(`minted-${issued}`);
      }
      const token = (init.headers as Record<string, string>)["X-Shopify-Access-Token"]!;
      sent.push(token);
      graphqlCalls += 1;
      return opts.graphql?.(token, graphqlCalls) ?? json({ data: { ok: true } });
    }) as unknown as typeof fetch;

    const c = new ShopifyClient(
      CREDS,
      fetchImpl,
      async () => undefined,
      () => clockMs,
    );
    return {
      client: c,
      mints,
      sent,
      advance: (ms: number) => {
        clockMs += ms;
      },
    };
  }

  it("exchanges the client credentials and uses the token it gets back", async () => {
    const h = harness();

    await h.client.request("query { ok }");

    expect(h.mints).toHaveLength(1);
    // Form-encoded OAuth, not the GraphQL shape — a different endpoint entirely.
    const body = new URLSearchParams(h.mints[0]!);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(h.sent).toEqual(["minted-1"]);
  });

  it("NEVER sends the client secret to the GraphQL endpoint", async () => {
    // The secret buys tokens for the whole catalog. It belongs in exactly one
    // request, and this pins that it does not leak into the other one.
    const h = harness();
    await h.client.request("query { ok }");
    expect(h.sent.some((t) => t.includes("client-secret"))).toBe(false);
  });

  it("reuses the cached token instead of minting per request", async () => {
    const h = harness();

    await h.client.request("q1");
    await h.client.request("q2");
    await h.client.request("q3");

    expect(h.mints).toHaveLength(1);
    expect(h.sent).toEqual(["minted-1", "minted-1", "minted-1"]);
  });

  it("mints ONCE for a burst of concurrent calls", async () => {
    // One agent turn fans out into many Shopify calls — a photo burst is a
    // dozen. Without single-flighting, a cold cache fires a dozen token
    // requests at once and keeps whichever happens to land last.
    const h = harness();

    await Promise.all([h.client.request("q1"), h.client.request("q2"), h.client.request("q3")]);

    expect(h.mints).toHaveLength(1);
    expect(new Set(h.sent)).toEqual(new Set(["minted-1"]));
  });

  it("renews BEFORE the token expires, not after it fails", async () => {
    // The whole reason expires_in is read. A purely reactive refresh means one
    // request every 24 hours is guaranteed to fail before it is retried.
    const h = harness();
    await h.client.request("q1");

    // Past the 5-minute safety margin, but still inside Shopify's own 86399s.
    h.advance((86399 - 60) * 1000);
    await h.client.request("q2");

    expect(h.mints).toHaveLength(2);
    expect(h.sent).toEqual(["minted-1", "minted-2"]);
  });

  it("does not renew while the token is comfortably valid", async () => {
    const h = harness();
    await h.client.request("q1");

    h.advance(60 * 60 * 1000); // an hour in
    await h.client.request("q2");

    expect(h.mints).toHaveLength(1);
  });

  it("refreshes and retries the SAME request when Shopify rejects the token", async () => {
    // The safety net for everything expires_in cannot predict: a revoked token,
    // clock skew, an early invalidation.
    const h = harness({
      graphql: (token) =>
        token === "minted-1" ? json({ errors: [{ message: "unauthorized" }] }, 401) : json({ data: { ok: true } }),
    });

    const data = await h.client.request<{ ok: boolean }>("q");

    expect(data.ok).toBe(true);
    expect(h.mints).toHaveLength(2);
    expect(h.sent).toEqual(["minted-1", "minted-2"]);
  });

  it("gives up after ONE refresh rather than burning the retry budget", async () => {
    // A freshly minted token that is also rejected is not a transient failure —
    // it is wrong credentials or missing scopes. Three more identical 401s only
    // delay the real error reaching the owner.
    const h = harness({ graphql: () => json({ errors: [{ message: "unauthorized" }] }, 401) });

    await expect(h.client.request("q")).rejects.toThrow(ShopifyError);
    expect(h.mints).toHaveLength(2);
    expect(h.sent).toEqual(["minted-1", "minted-2"]);
  });

  it("does not try to refresh a token that was configured, not minted", async () => {
    // A static token has nothing behind it to mint from; a 401 is simply final.
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return json({ errors: [{ message: "unauthorized" }] }, 401);
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).request("q")).rejects.toThrow(ShopifyError);
    expect(calls).toEqual([GRAPHQL_URL]);
  });

  it("names app_not_installed, which arrives as an HTML PAGE", async () => {
    // Shopify answers this one with a full HTML error page, so without the name
    // the message is 500 characters of markup — which is exactly what it did the
    // first time this was hit against a real store.
    const html = "<!DOCTYPE html><html><head><title>400 - Oauth error app_not_installed</title>";
    const fetchImpl = (async () => new Response(html, { status: 400 })) as unknown as typeof fetch;
    const c = new ShopifyClient(CREDS, fetchImpl, async () => undefined);

    await expect(c.request("q")).rejects.toThrow(/not installed on this store/);
    await expect(c.request("q")).rejects.not.toThrow(/DOCTYPE/);
  });

  it("names shop_not_permitted for what it is", async () => {
    // The error a first-time setup actually hits, and nothing in Shopify's own
    // text says the cause is the app and store being in different organizations.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "shop_not_permitted" }), { status: 401 })) as unknown as typeof fetch;
    const c = new ShopifyClient(CREDS, fetchImpl, async () => undefined);

    await expect(c.request("q")).rejects.toThrow(/same Shopify organization/);
  });

  it("does not leak the client secret into the error when credentials are refused", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })) as unknown as typeof fetch;
    const c = new ShopifyClient(CREDS, fetchImpl, async () => undefined);

    await expect(c.request("q")).rejects.toThrow(/SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET/);
    await expect(c.request("q")).rejects.not.toThrow(/client-secret/);
  });

  it("falls back to a short lifetime when expires_in is missing", async () => {
    // Neither immediately stale nor trusted forever: an hour self-corrects
    // without minting per request.
    let clockMs = 0;
    let issued = 0;
    const mints: string[] = [];
    const fetchImpl = (async (url: string) => {
      if (url === TOKEN_URL) {
        mints.push(url);
        issued += 1;
        return json({ access_token: `minted-${issued}` }); // no expires_in
      }
      return json({ data: { ok: true } });
    }) as unknown as typeof fetch;
    const c = new ShopifyClient(CREDS, fetchImpl, async () => undefined, () => clockMs);

    await c.request("q1");
    clockMs += 50 * 60 * 1000; // 50 minutes: inside the fallback hour
    await c.request("q2");
    expect(mints).toHaveLength(1);

    clockMs += 20 * 60 * 1000; // past it
    await c.request("q3");
    expect(mints).toHaveLength(2);
  });
});
