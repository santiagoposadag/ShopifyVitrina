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

/** Normalize a phone number to bare E.164 digits (strip '+', spaces, dashes). */
export function normalizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export function loadConfig(): Config {
  const ownerPhoneNumbers = new Set(
    optional("OWNER_PHONE_NUMBERS", "")
      .split(",")
      .map((p) => normalizePhone(p))
      .filter((p) => p.length > 0),
  );

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
  };
}

export function isOwner(config: Config, phone: string): boolean {
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
      proc.loadEnvFile(path);
    } catch {
      // No .env file present — rely on real environment variables.
    }
  }
}
