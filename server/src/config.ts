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

/**
 * Runtime configuration, read once from the environment at boot.
 * Fails fast with a clear message when a required variable is missing.
 */
export interface Config {
  anthropicApiKey: string;
  kapsoApiKey: string;
  kapsoPhoneNumberId: string;
  kapsoWebhookSecret: string;
  ownerPhoneNumbers: Set<string>;
  dbPath: string;
  mediaDir: string;
  publicBaseUrl: string;
  port: number;
  model: string;
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
  /** Public URL of the STOREFRONT (the web app) — not this server. */
  storefrontBaseUrl: string;
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

  return {
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    kapsoApiKey: required("KAPSO_API_KEY"),
    kapsoPhoneNumberId: required("KAPSO_PHONE_NUMBER_ID"),
    kapsoWebhookSecret: required("KAPSO_WEBHOOK_SECRET"),
    ownerPhoneNumbers,
    dbPath: resolveDataPath(optional("DB_PATH", "./data/vitrina.db")),
    mediaDir: resolveDataPath(optional("MEDIA_DIR", "./data/media")),
    publicBaseUrl: optional("PUBLIC_BASE_URL", "http://localhost:3001").replace(/\/+$/, ""),
    port: Number.parseInt(optional("PORT", "3001"), 10),
    model: optional("MODEL", "claude-haiku-4-5"),
    sessionMaxAgeDays: optionalInt("SESSION_MAX_AGE_DAYS", 7),
    rateLimitPerPhonePerHour: optionalInt("RATE_LIMIT_PER_PHONE_PER_HOUR", 20),
    rateLimitGlobalPerDay: optionalInt("RATE_LIMIT_GLOBAL_PER_DAY", 500),
    batchDebounceMs: optionalInt("BATCH_DEBOUNCE_MS", 8000),
    batchMaxWaitMs: optionalInt("BATCH_MAX_WAIT_MS", 45000),
    batchMediaDebounceMs: optionalInt("BATCH_MEDIA_DEBOUNCE_MS", 45000),
    batchMediaMaxWaitMs: optionalInt("BATCH_MEDIA_MAX_WAIT_MS", 120000),
    storefrontBaseUrl: optional("STOREFRONT_BASE_URL", "http://localhost:3000").replace(/\/+$/, ""),
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
