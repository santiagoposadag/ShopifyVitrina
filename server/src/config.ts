import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Monorepo root, computed from this file's location (server/src/config.ts).
// Used so DB_PATH / MEDIA_DIR resolve to the SAME place whether a script is run
// from the repo root or from within the server/ workspace.
export const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../");

/** Resolve a data path: absolute paths are kept, relative ones anchor at REPO_ROOT. */
export function resolveDataPath(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

/** The two WhatsApp transports this server can run behind WhatsAppChannel. */
export type WhatsAppProvider = "bridge" | "cloud";

/**
 * Runtime configuration, read once from the environment at boot.
 * Fails fast with a clear message when a required variable is missing.
 */
export interface Config {
  /**
   * Anthropic-style API key (`x-api-key`). Empty when the deployment
   * authenticates with agentAuthToken instead — see loadConfig's credential rule.
   */
  anthropicApiKey: string;
  /**
   * Bearer token (`Authorization: Bearer`). DeepSeek's Claude Code guide
   * prescribes this form; its endpoint accepts either.
   */
  agentAuthToken: string;
  /**
   * Where the Agent SDK sends /v1/messages. Anthropic by default; point it at
   * an Anthropic-compatible endpoint (e.g. https://api.deepseek.com/anthropic)
   * to serve every turn from another provider without a code change.
   */
  agentBaseUrl: string;
  /**
   * Which WhatsApp transport this deployment runs.
   *
   * "cloud" is Meta's official Business Cloud API; "bridge" is the whatsmeow
   * sidecar paired as a linked device. Both are kept behind WhatsAppChannel so
   * a bad number registration can be rolled back with one variable instead of
   * a revert — see docs/whatsapp-cloud-api.md.
   */
  whatsappProvider: WhatsAppProvider;
  /**
   * The secret the inbound webhook verifies signatures with. Which secret that
   * IS depends on the provider: the bridge signs with BRIDGE_WEBHOOK_SECRET,
   * Meta signs with the app secret (WHATSAPP_APP_SECRET). Both are HMAC-SHA256
   * over the raw body; only the header name and the key differ.
   */
  webhookSecret: string;
  /**
   * Cloud API only. The token echoed back during Meta's webhook verification
   * handshake (GET /webhook). It is a shared string we choose, unrelated to
   * the app secret, and Meta re-runs the handshake whenever the callback URL
   * is edited — so it has to survive in config, not in someone's clipboard.
   */
  whatsappVerifyToken: string;
  /** Cloud API only. The phone number ID from the panel — NOT the number. */
  whatsappPhoneNumberId: string;
  /**
   * Cloud API only. System user access token. Its blast radius is every
   * message the business can send, so it is a System User token scoped to this
   * WABA rather than a personal one.
   */
  whatsappAccessToken: string;
  /** Graph API origin. A variable so tests can point it at a fake. */
  whatsappGraphBaseUrl: string;
  /**
   * Pinned Graph API version, for the same reason SHOPIFY_API_VERSION is
   * pinned: Meta ships versions on a schedule and deprecates on a rolling one,
   * so "whatever is newest" is a silently-changing transport. Bump it
   * deliberately, to the version the app panel shows.
   */
  whatsappGraphVersion: string;
  /** Internal URL of the bridge sidecar, e.g. http://bridge:3002 */
  bridgeUrl: string;
  /** Bearer token for the bridge's /send endpoint. */
  bridgeApiToken: string;
  /**
   * Directory the bridge writes decrypted inbound media into. The server reads
   * from here and unlinks; nothing outside this directory is ever readable
   * through a media ref (see whatsapp/bridge.ts).
   */
  bridgeStagingDir: string;
  ownerPhoneNumbers: Set<string>;
  dbPath: string;
  mediaDir: string;
  /**
   * Where inbound voice notes wait to be transcribed. SEPARATE from mediaDir,
   * which is served publicly at /media — private speech must not land somewhere
   * a guessable URL reaches.
   */
  audioDir: string;
  /**
   * Speech-to-text. Anthropic-compatible thinking in the same spirit as the
   * agent provider: an OpenAI-shaped /audio/transcriptions endpoint, chosen by
   * URL, so Groq or OpenAI or anything compatible is an env change.
   *
   * With no key, transcription is OFF and a voice note gets a reply asking for
   * text instead. Deliberately not required: an unset key must not stop the
   * server from answering everyone who types.
   */
  transcriptionBaseUrl: string;
  transcriptionApiKey: string;
  transcriptionModel: string;
  /** Skip anything larger, rather than paying to transcribe a podcast. */
  transcriptionMaxBytes: number;
  publicBaseUrl: string;
  port: number;
  /** Model for the agent turn itself. */
  model: string;
  /**
   * Model for the SDK's own utility calls — compaction, summarisation,
   * subagents. Historically a Haiku-tier model, and invisible in our code: the
   * bundled CLI picks it up from the environment, so an unset value keeps that
   * path asking for `claude-haiku-4-5` even when `model` points elsewhere.
   *
   * Deliberately a SEPARATE value from `model` rather than one shared literal,
   * so the two tiers can be split again without touching code.
   */
  smallFastModel: string;
  /**
   * JSON merged into every request body by the bundled CLI
   * (CLAUDE_CODE_EXTRA_BODY). The escape hatch for provider-specific fields the
   * SDK has no option for — notably DeepSeek's `output_config.effort`, which is
   * its ONLY thinking knob: it ignores `thinking.budget_tokens` outright.
   * Empty object means "send nothing extra".
   */
  agentExtraBody: Record<string, unknown>;
  /**
   * Extended-thinking budget (MAX_THINKING_TOKENS). Any value > 0 turns
   * thinking on. Portable and honoured by Anthropic; DeepSeek ignores the
   * number, so steer effort there with agentExtraBody. 0 = leave unset.
   */
  maxThinkingTokens: number;
  /** Agent sessions idle longer than this many days start fresh. */
  sessionMaxAgeDays: number;
  /** Max agent turns per customer phone per sliding hour (owners exempt). */
  rateLimitPerPhonePerHour: number;
  /** Max customer agent turns per day across all phones (circuit breaker). */
  rateLimitGlobalPerDay: number;
  /** Silence after an inbound message before its burst becomes one agent turn. */
  batchDebounceMs: number;
  /** Ceiling on that wait, so a non-stop talker still gets a reply. */
  batchMaxWaitMs: number;
  /** Same, for a burst containing photos: WhatsApp uploads them in slow waves. */
  batchMediaDebounceMs: number;
  batchMediaMaxWaitMs: number;
  /**
   * Diagnostic mode: answer every inbound message with a canned reply and run
   * NOTHING else. No agent turn, no Claude call, no Shopify request.
   *
   * It exists to prove the transport end to end — webhook signature, inbox,
   * debounce, worker, outbound send — before the store and the model are
   * wired, because when all three are new at once a silent failure has three
   * candidate causes. With this on, Shopify and agent credentials stop being
   * required at boot: demanding them would defeat the entire point.
   *
   * OFF by default, and loud at boot when on. A deployment left in this mode
   * answers real customers with a test message.
   */
  echoMode: boolean;
  /** The store's myshopify domain, e.g. mitienda.myshopify.com (no scheme). */
  shopifyStoreDomain: string;
  /**
   * A ready-made Admin API access token, sent as X-Shopify-Access-Token.
   *
   * EMPTY when this deployment mints its own (see shopifyClientId). Only two
   * things still hand one out: a legacy admin-created custom app — Shopify
   * stopped allowing new ones in January 2026 — and a client-credentials token
   * pasted in by hand, which dies 24 hours later.
   *
   * The blast radius of this one string is the whole catalog — prices and stock
   * on a store that takes money — so it is scoped in Shopify to exactly the
   * operations the tools use and never leaves this process.
   */
  shopifyAdminToken: string;
  /**
   * Dev Dashboard app credentials, exchanged for an access token at runtime.
   *
   * This is the CURRENT path: admin-created custom apps can no longer be made,
   * and a Dev Dashboard app hands out a client id and secret instead of a
   * token. The token it mints expires in 24 hours; these two do not, which is
   * the whole reason they are what lives in the environment.
   *
   * Requires the app and the store to be in the same Shopify organization —
   * otherwise the token endpoint answers `shop_not_permitted`.
   */
  shopifyClientId: string;
  shopifyClientSecret: string;
  /**
   * Pinned Admin API version. Shopify ships quarterly and deprecates on a
   * rolling schedule, so this is a deliberate value rather than "latest": a
   * silently-moving API is a silently-changing agent.
   */
  shopifyApiVersion: string;
  /**
   * Default inventory location (a gid://shopify/Location/… id). Every stock
   * operation is per-location; with one location set here the agent never has
   * to ask. Empty means "resolve the store's locations and ask when there is
   * more than one" — see shopify/catalog.ts resolveLocation.
   */
  shopifyLocationId: string;
  /**
   * How long a fetched catalog stays usable for RANKING search results. The
   * facts that must never be stale — price and stock — are re-read live for the
   * products actually shown, so this only bounds how quickly a brand-new
   * product becomes findable by text.
   */
  catalogCacheTtlMs: number;
  /**
   * Kill switch for the customer path. When false, non-owner messages get a
   * static "assistant unavailable" reply and never reach the agent (no Claude
   * call). Owners are unaffected.
   */
  customerAgentEnabled: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function optionalInt(name: string, fallback: number): number {
  const raw = optional(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 1) {
    throw new Error(`Invalid value for ${name}: expected a positive integer, got "${raw}"`);
  }
  return value;
}

/** Like optionalInt, but 0 is legal and means "leave this knob unset". */
function optionalCountOrZero(name: string, fallback: number): number {
  const raw = optional(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`Invalid value for ${name}: expected a non-negative integer, got "${raw}"`);
  }
  return value;
}

/**
 * Parse a JSON object from the environment. Exported for tests.
 *
 * Validated HERE rather than left to the consumer because the bundled CLI only
 * logs an error and carries on when CLAUDE_CODE_EXTRA_BODY will not parse — a
 * typo would silently disable the knob for the life of the deploy instead of
 * failing the boot.
 */
export function optionalJsonObject(name: string, fallback: Record<string, unknown>) {
  const raw = optional(name, "");
  if (raw === "") return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid value for ${name}: expected a JSON object (${detail})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid value for ${name}: expected a JSON object, got "${raw}"`);
  }
  return parsed as Record<string, unknown>;
}

/** Exported for tests. Accepts true/false/1/0 (case-insensitive); empty → fallback. */
export function optionalBool(name: string, fallback: boolean): boolean {
  const raw = optional(name, String(fallback)).toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`Invalid value for ${name}: expected true/false/1/0, got "${raw}"`);
}

/** Normalize a phone number to bare E.164 digits (strip '+', spaces, dashes). */
export function normalizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

/**
 * The OWNER_PHONE_NUMBERS allowlist, parsed. Exported so one-off tools can
 * resolve roles without loadConfig's required secrets — deleting a session
 * should not depend on a WhatsApp key being present.
 */
export function loadOwnerPhoneNumbers(): Set<string> {
  return new Set(
    optional("OWNER_PHONE_NUMBERS", "")
      .split(",")
      .map((p) => normalizePhone(p))
      .filter((p) => p.length > 0),
  );
}

export function loadConfig(): Config {
  const ownerPhoneNumbers = loadOwnerPhoneNumbers();

  // Either credential is enough, and NEITHER is individually required: a
  // DeepSeek deployment has no Anthropic key at all, so demanding
  // ANTHROPIC_API_KEY would make the provider swap impossible to actually
  // deploy. Requiring at least one keeps the old fail-fast guarantee — a
  // credential-less boot still dies here rather than on the first customer
  // message, which is the whole reason the check exists.
  // Read before the credential checks below, both of which it relaxes.
  const echoMode = optionalBool("ECHO_MODE", false);

  const anthropicApiKey = optional("ANTHROPIC_API_KEY", "");
  const agentAuthToken = optional("ANTHROPIC_AUTH_TOKEN", "");
  if (!echoMode && anthropicApiKey === "" && agentAuthToken === "") {
    throw new Error(
      "Missing agent credential: set ANTHROPIC_API_KEY (x-api-key) or ANTHROPIC_AUTH_TOKEN (Bearer)",
    );
  }

  const model = optional("MODEL", "claude-haiku-4-5");

  // The transport decides which credentials are mandatory. Demanding all of
  // them would make either deployment impossible to boot: a Cloud API deploy
  // has no bridge and no staging volume, and a bridge deploy has no Meta app.
  // Defaulting to "bridge" keeps every existing deployment booting unchanged.
  const whatsappProvider = optional("WHATSAPP_PROVIDER", "bridge") as WhatsAppProvider;
  if (whatsappProvider !== "bridge" && whatsappProvider !== "cloud") {
    throw new Error(
      `Invalid value for WHATSAPP_PROVIDER: expected "bridge" or "cloud", got "${whatsappProvider}"`,
    );
  }
  const isCloud = whatsappProvider === "cloud";
  const requiredFor = (name: string, wanted: WhatsAppProvider): string =>
    whatsappProvider === wanted ? required(name) : optional(name, "");

  // Two ways to hold Shopify credentials, and neither is individually required.
  // A Dev Dashboard app has no token to paste — it has a client id and secret
  // that the client exchanges for one — while a legacy admin-created custom app
  // has only the token. Demanding either specifically would make one of the two
  // real deployments impossible to boot.
  //
  // Requiring at least one keeps the fail-fast guarantee: a credential-less boot
  // dies here rather than on the owner's first "¿qué tengo?".
  const shopifyAdminToken = optional("SHOPIFY_ADMIN_TOKEN", "");
  const shopifyClientId = optional("SHOPIFY_CLIENT_ID", "");
  const shopifyClientSecret = optional("SHOPIFY_CLIENT_SECRET", "");
  if (!echoMode && shopifyAdminToken === "" && (shopifyClientId === "" || shopifyClientSecret === "")) {
    throw new Error(
      "Missing Shopify credential: set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET " +
        "(Dev Dashboard app, token minted at runtime), or SHOPIFY_ADMIN_TOKEN " +
        "(a legacy custom app's token, or a hand-minted one that expires in 24h)",
    );
  }

  // Accept a full URL and keep only the host: the token header goes to
  // https://<domain>/admin/api/<version>/graphql.json, and a domain that
  // already carries a scheme would build a URL with two of them.
  // Optional in echo mode only. Nothing reads it there — ShopifyClient is still
  // constructed, but constructing one makes no request.
  const shopifyStoreDomain = (echoMode ? optional("SHOPIFY_STORE_DOMAIN", "") : required("SHOPIFY_STORE_DOMAIN"))
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  return {
    anthropicApiKey,
    agentAuthToken,
    agentBaseUrl: optional("ANTHROPIC_BASE_URL", "https://api.anthropic.com").replace(/\/+$/, ""),
    whatsappProvider,
    // One field, two owners. The webhook route picks the header that goes with
    // it (see inbox/webhook.ts) — a deployment that swapped one without the
    // other would reject every inbound message with a valid signature.
    webhookSecret: isCloud ? required("WHATSAPP_APP_SECRET") : required("BRIDGE_WEBHOOK_SECRET"),
    whatsappVerifyToken: requiredFor("WHATSAPP_VERIFY_TOKEN", "cloud"),
    whatsappPhoneNumberId: requiredFor("WHATSAPP_PHONE_NUMBER_ID", "cloud"),
    whatsappAccessToken: requiredFor("WHATSAPP_ACCESS_TOKEN", "cloud"),
    whatsappGraphBaseUrl: optional("WHATSAPP_GRAPH_BASE_URL", "https://graph.facebook.com").replace(
      /\/+$/,
      "",
    ),
    whatsappGraphVersion: optional("WHATSAPP_GRAPH_VERSION", "v23.0"),
    bridgeUrl: requiredFor("BRIDGE_URL", "bridge").replace(/\/+$/, ""),
    bridgeApiToken: requiredFor("BRIDGE_API_TOKEN", "bridge"),
    // Empty on the Cloud API, where nothing is staged on disk. Both consumers
    // already treat an empty directory as "nothing to do" (isAllowedMediaPath
    // refuses it, sweepStagedMedia returns 0), so this needs no branch.
    bridgeStagingDir: isCloud ? "" : resolveDataPath(required("BRIDGE_STAGING_DIR")),
    ownerPhoneNumbers,
    dbPath: resolveDataPath(optional("DB_PATH", "./data/vitrina.db")),
    mediaDir: resolveDataPath(optional("MEDIA_DIR", "./data/media")),
    audioDir: resolveDataPath(optional("AUDIO_DIR", "./data/audio")),
    transcriptionBaseUrl: optional(
      "TRANSCRIPTION_BASE_URL",
      "https://api.groq.com/openai/v1",
    ).replace(/\/+$/, ""),
    transcriptionApiKey: optional("TRANSCRIPTION_API_KEY", ""),
    transcriptionModel: optional("TRANSCRIPTION_MODEL", "whisper-large-v3-turbo"),
    transcriptionMaxBytes: optionalInt("TRANSCRIPTION_MAX_BYTES", 25 * 1024 * 1024),
    publicBaseUrl: optional("PUBLIC_BASE_URL", "http://localhost:3001").replace(/\/+$/, ""),
    port: Number.parseInt(optional("PORT", "3001"), 10),
    model,
    // Defaults to `model` so a single-model deployment needs one variable, and
    // so today's behaviour is unchanged when neither is set.
    smallFastModel: optional("SMALL_FAST_MODEL", model),
    agentExtraBody: optionalJsonObject("AGENT_EXTRA_BODY", {}),
    maxThinkingTokens: optionalCountOrZero("MAX_THINKING_TOKENS", 0),
    sessionMaxAgeDays: optionalInt("SESSION_MAX_AGE_DAYS", 7),
    rateLimitPerPhonePerHour: optionalInt("RATE_LIMIT_PER_PHONE_PER_HOUR", 20),
    rateLimitGlobalPerDay: optionalInt("RATE_LIMIT_GLOBAL_PER_DAY", 500),
    batchDebounceMs: optionalInt("BATCH_DEBOUNCE_MS", 8000),
    batchMaxWaitMs: optionalInt("BATCH_MAX_WAIT_MS", 45000),
    batchMediaDebounceMs: optionalInt("BATCH_MEDIA_DEBOUNCE_MS", 45000),
    batchMediaMaxWaitMs: optionalInt("BATCH_MEDIA_MAX_WAIT_MS", 120000),
    echoMode,
    shopifyStoreDomain,
    shopifyAdminToken,
    shopifyClientId,
    shopifyClientSecret,
    shopifyApiVersion: optional("SHOPIFY_API_VERSION", "2026-01"),
    shopifyLocationId: optional("SHOPIFY_LOCATION_ID", ""),
    catalogCacheTtlMs: optionalCountOrZero("CATALOG_CACHE_TTL_MS", 60_000),
    customerAgentEnabled: optionalBool("CUSTOMER_AGENT_ENABLED", true),
  };
}

export function isOwner(config: Pick<Config, "ownerPhoneNumbers">, phone: string): boolean {
  return config.ownerPhoneNumbers.has(normalizePhone(phone));
}

/**
 * Load variables from a .env file into process.env if present, using Node's
 * built-in loader. Silently does nothing when the file or the API is missing.
 */
export function loadDotEnv(path = ".env"): void {
  const proc = process as unknown as { loadEnvFile?: (p: string) => void };
  if (typeof proc.loadEnvFile === "function") {
    try {
      // Anchor at REPO_ROOT, not the cwd, for the same reason resolveDataPath
      // exists: every `npm run <script> -w server` (dev, seed, backup) runs from
      // server/, where a relative ".env" resolves to a file that does not exist
      // and the catch below swallows it. Every variable then falls back to its
      // default — and an empty OWNER_PHONE_NUMBERS makes every phone read as a
      // customer, the owner included.
      proc.loadEnvFile(resolveDataPath(path));
    } catch {
      // No .env file present — rely on real environment variables.
    }
  }
}
