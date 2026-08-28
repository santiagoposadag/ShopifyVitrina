import type { Config } from "../config.js";

/**
 * Only what talking to Shopify needs. Narrowed the same way transcribe.ts and
 * preflight.ts narrow theirs: a test builds this object literally instead of
 * assembling a whole Config, and nothing here can reach for an unrelated
 * setting later without changing the type first.
 */
export type ShopifyConfig = Pick<
  Config,
  | "shopifyStoreDomain"
  | "shopifyAdminToken"
  | "shopifyClientId"
  | "shopifyClientSecret"
  | "shopifyApiVersion"
>;

/** Every failure this module raises, so callers can catch one type. */
export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ShopifyError";
  }
}

/**
 * A `userErrors` entry. Shopify reports business-rule failures HERE, inside a
 * 200 OK response body — a duplicate handle, a price on a product that has
 * none, a variant that does not exist. A client that only checks `res.ok`
 * reports every one of them to the owner as success.
 */
export interface UserError {
  field?: string[] | null;
  message: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: unknown } };
}

/** Total tries for one request, including the first. */
const MAX_ATTEMPTS = 4;
/** Base for the exponential backoff between throttled retries. */
const RETRY_BASE_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How early a minted token is treated as spent.
 *
 * Shopify returns expires_in: 86399, and a token used at 86398 is a request
 * that fails for no reason other than arithmetic. The margin also covers clock
 * skew between this container and Shopify, which nothing else here accounts
 * for. Renewing five minutes early costs one extra token mint per day.
 */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Token-endpoint failures worth naming, because the fix is a decision and not a
 * retry. shop_not_permitted is the one a first-time setup actually hits: the
 * client credentials grant only works when the app and the store live in the
 * same Shopify organization, and nothing in the error text says so.
 */
const NAMED_OAUTH_ERRORS: Record<string, string> = {
  shop_not_permitted:
    "the app and the store are not in the same Shopify organization — the client credentials grant cannot reach this store",
  invalid_client: "SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET is wrong",
  invalid_request: "the token request was malformed (check SHOPIFY_STORE_DOMAIN)",
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Thin GraphQL client for the Shopify Admin API.
 *
 * Native `fetch` with an injectable implementation, following the pattern
 * already proven by agent/transcribe.ts and agent/preflight.ts: the whole tool
 * suite is then testable against a plain function, with no network, no store
 * and no casts anywhere in the tests.
 *
 * Retries exist here rather than only at the batch level because the failure
 * this guards against is specific and self-healing. The Admin API is a leaky
 * bucket of calculated query cost — 100 points/second on a Standard plan — and
 * a burst of photo uploads inside one agent turn reaches it easily. Letting a
 * throttle bubble up would fail the whole batch and re-run the ENTIRE turn 30
 * seconds later, including every mutation that had already succeeded.
 */
export class ShopifyClient {
  private readonly endpoint: string;
  private readonly tokenEndpoint: string;
  /** Set only when a ready-made token was configured; then nothing is minted. */
  private readonly staticToken: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  /** The minted token and when to stop trusting it. Null until first use. */
  private cached: { token: string; expiresAt: number } | null = null;
  /** The mint in progress, so a burst of calls produces ONE token request. */
  private minting: Promise<string> | null = null;

  constructor(
    config: ShopifyConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Injectable so tests do not actually wait out the backoff. */
    private readonly sleepImpl: (ms: number) => Promise<void> = sleep,
    /** Injectable so a test can move the expiry clock without waiting a day. */
    private readonly now: () => number = Date.now,
  ) {
    this.endpoint = `https://${config.shopifyStoreDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
    // NOT versioned, and not the GraphQL path. The token endpoint is form-encoded
    // OAuth and shares nothing with the Admin API but the host.
    this.tokenEndpoint = `https://${config.shopifyStoreDomain}/admin/oauth/access_token`;
    this.staticToken = config.shopifyAdminToken;
    this.clientId = config.shopifyClientId;
    this.clientSecret = config.shopifyClientSecret;
  }

  /** Where requests go. Exposed for the boot-time log line, not for callers. */
  get url(): string {
    return this.endpoint;
  }

  /**
   * The token to send, minting one if this deployment holds client credentials.
   *
   * A configured token wins outright and is never refreshed: it is either a
   * legacy custom app's permanent token, or one a human pasted in, and in both
   * cases there is nothing here to mint from.
   *
   * Otherwise the cached token is reused until it is nearly spent. The mint is
   * single-flighted because one agent turn fans out into many Shopify calls —
   * a photo burst is a dozen — and without it a cold cache would fire a dozen
   * token requests at once and keep whichever landed last.
   */
  private async accessToken(): Promise<string> {
    if (this.staticToken) return this.staticToken;

    const cached = this.cached;
    if (cached && this.now() < cached.expiresAt) return cached.token;

    if (!this.minting) {
      this.minting = this.mintToken().finally(() => {
        this.minting = null;
      });
    }
    return this.minting;
  }

  /**
   * Discard a token Shopify just rejected and get another one.
   *
   * Takes the token that actually failed, rather than clearing unconditionally,
   * because concurrent calls fail one after another: without this check the
   * second 401 would throw away the good token the first one just minted, and a
   * busy turn could chase its own tail through the whole retry budget.
   */
  private async refreshAfter(rejected: string): Promise<string> {
    if (this.cached && this.cached.token !== rejected) return this.cached.token;
    this.cached = null;
    return this.accessToken();
  }

  /**
   * Exchange the client credentials for an access token.
   *
   * POST /admin/oauth/access_token, form-encoded, grant_type=client_credentials.
   * The response carries expires_in — 86399 today — and this trusts that number
   * rather than assuming 24 hours, so a shorter lifetime Shopify may hand out
   * later is honoured without a code change.
   */
  private async mintToken(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ShopifyError(`Shopify token request failed: ${describe(err)}`);
    }

    if (!response.ok) {
      // The body names the reason; the secret is never in it, and nothing from
      // this.clientSecret is interpolated into the message.
      const raw = await safeText(response);
      const named = Object.keys(NAMED_OAUTH_ERRORS).find((code) => raw.includes(code));
      throw new ShopifyError(
        `Shopify refused the client credentials (HTTP ${response.status})` +
          (named ? ` — ${NAMED_OAUTH_ERRORS[named]}` : `: ${raw}`),
      );
    }

    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch (err) {
      throw new ShopifyError(`Shopify token endpoint returned a non-JSON body: ${describe(err)}`);
    }

    const token = typeof body.access_token === "string" ? body.access_token : "";
    if (!token) throw new ShopifyError("Shopify token endpoint returned no access_token", body);

    // A missing or nonsensical expires_in must not produce a token that is
    // either immediately stale or trusted forever. Fall back to one hour, which
    // is short enough to self-correct and long enough not to mint per request.
    const seconds = typeof body.expires_in === "number" ? body.expires_in : Number.NaN;
    const lifetimeMs =
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60 * 60 * 1000;
    this.cached = {
      token,
      expiresAt: this.now() + Math.max(lifetimeMs - TOKEN_EXPIRY_MARGIN_MS, 0),
    };
    return token;
  }

  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let lastError: ShopifyError | undefined;
    // One shot, deliberately outside the attempt loop. A rejected token is not
    // a transient failure: if a freshly minted one is rejected too, the problem
    // is the credentials or the scopes, and spending the throttle budget on
    // three more identical 401s only delays the real error.
    let mayRefresh = true;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const token = await this.accessToken();
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token,
          },
          body: JSON.stringify({ query, variables: variables ?? {} }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // DNS, TLS, timeout. Worth one more try; the batch retry behind us is
        // 30 seconds away and would replay the whole turn.
        lastError = new ShopifyError(`Shopify request failed: ${describe(err)}`);
        if (attempt < MAX_ATTEMPTS) {
          await this.sleepImpl(RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        throw lastError;
      }

      // 429 and 5xx are the transient half of the status codes; 4xx is a bad
      // token or a malformed query and retrying only spends the bucket.
      if (response.status === 429 || response.status >= 500) {
        lastError = new ShopifyError(
          `Shopify responded ${response.status}: ${await safeText(response)}`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await this.sleepImpl(retryDelayFrom(response, attempt));
          continue;
        }
        throw lastError;
      }

      // An expired token reads as 401, and a minted one expires by design. Mint
      // a replacement and retry the SAME request rather than failing the turn —
      // this attempt does not count against the retry budget, because nothing
      // was wrong with the request itself.
      //
      // 403 is deliberately NOT included: that is a missing scope, and a new
      // token carries exactly the same scopes as the one that was refused.
      if (response.status === 401 && mayRefresh && !this.staticToken) {
        mayRefresh = false;
        await this.refreshAfter(token);
        attempt -= 1;
        continue;
      }

      if (!response.ok) {
        throw new ShopifyError(
          `Shopify responded ${response.status}: ${await safeText(response)}`,
        );
      }

      let body: GraphQLResponse<T>;
      try {
        body = (await response.json()) as GraphQLResponse<T>;
      } catch (err) {
        throw new ShopifyError(`Shopify returned a non-JSON body: ${describe(err)}`);
      }

      if (body.errors && body.errors.length > 0) {
        // Cost throttling arrives as a 200 with THROTTLED in the errors array,
        // which is exactly the shape a naive client treats as a hard failure.
        if (body.errors.some((e) => e.extensions?.code === "THROTTLED")) {
          lastError = new ShopifyError("Shopify throttled the request", body.errors);
          if (attempt < MAX_ATTEMPTS) {
            await this.sleepImpl(RETRY_BASE_MS * 2 ** (attempt - 1));
            continue;
          }
          throw lastError;
        }
        throw new ShopifyError(
          `Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`,
          body.errors,
        );
      }

      if (!body.data) throw new ShopifyError("Shopify returned no data", body);
      return body.data;
    }

    throw lastError ?? new ShopifyError("Shopify request failed");
  }
}

/**
 * Throw when a mutation reported business-rule errors.
 *
 * Called on EVERY mutation payload. `userErrors` is the only place Shopify
 * says a write did not happen — the HTTP status is 200 and `errors` is absent
 * — so skipping this check anywhere turns a rejected price change into
 * "Listo, actualicé el precio".
 */
export function assertNoUserErrors(mutation: string, errors: UserError[] | undefined | null): void {
  if (!errors || errors.length === 0) return;
  const detail = errors
    .map((e) => (e.field?.length ? `${e.field.join(".")}: ${e.message}` : e.message))
    .join("; ");
  throw new ShopifyError(`${mutation} rejected: ${detail}`, errors);
}

/** Extract the numeric suffix of a gid, for compact rendering. */
export function gidSuffix(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1] ?? gid;
}

/**
 * Format a money amount for the Admin API, which takes a decimal STRING.
 *
 * Two decimals regardless of currency: Shopify normalises to the currency's own
 * precision on the way in, and a zero-decimal currency like COP is handed back
 * as "1150000.00" either way. Reads of money never go through here — they are
 * passed through as the string Shopify returned, so no stored price is ever
 * reconstructed from a float.
 */
export function toMoneyString(amount: number): string {
  if (!Number.isFinite(amount)) throw new ShopifyError(`Invalid money amount: ${amount}`);
  return amount.toFixed(2);
}

function retryDelayFrom(response: Response, attempt: number): number {
  const header = response.headers.get("Retry-After");
  const seconds = header ? Number.parseFloat(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return RETRY_BASE_MS * 2 ** (attempt - 1);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
