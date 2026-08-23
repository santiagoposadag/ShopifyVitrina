import type { Config } from "../config.js";

/**
 * Only what talking to Shopify needs. Narrowed the same way transcribe.ts and
 * preflight.ts narrow theirs: a test builds this object literally instead of
 * assembling a whole Config, and nothing here can reach for an unrelated
 * setting later without changing the type first.
 */
export type ShopifyConfig = Pick<
  Config,
  "shopifyStoreDomain" | "shopifyAdminToken" | "shopifyApiVersion"
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

  constructor(
    config: ShopifyConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Injectable so tests do not actually wait out the backoff. */
    private readonly sleepImpl: (ms: number) => Promise<void> = sleep,
  ) {
    this.endpoint = `https://${config.shopifyStoreDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
    this.token = config.shopifyAdminToken;
  }

  private readonly token: string;

  /** Where requests go. Exposed for the boot-time log line, not for callers. */
  get url(): string {
    return this.endpoint;
  }

  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let lastError: ShopifyError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": this.token,
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
