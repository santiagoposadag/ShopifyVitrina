/**
 * Shared setup for the live provider suites.
 *
 * These tests exist because configuring the swap is trivial and verifying it is
 * not. An Anthropic-compatible endpoint answers 200 to a request it only
 * partially honoured — DeepSeek documents `cache_control`, `top_k` and
 * `thinking.budget_tokens` as IGNORED rather than rejected, and resolves an
 * unrecognised model id to its own default silently. So nothing here asserts on
 * what we sent. Everything asserts on an observed effect: what came back, or
 * what ended up in the database.
 */
import type { Config } from "../../src/config.js";
import { loadOfflineConfig } from "../../src/tools/offline-config.js";
import type { WhatsAppChannel } from "../../src/whatsapp/channel.js";

/**
 * These suites are excluded from the default vitest run (see vitest.config.ts),
 * so reaching this file already means someone asked for a live run. The gate is
 * a second lock on a real API bill: an unset credential skips rather than
 * failing a CI job with a confusing auth error.
 */
export const LIVE = Boolean(
  process.env["LIVE_PROVIDER_TESTS"] &&
    (process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]),
);

/** Config for a live run — the same one the comparison harness uses. */
export function liveConfig(overrides: Partial<Config> = {}): Config {
  return loadOfflineConfig(overrides);
}

/** Base URL and auth header for the raw-HTTP suite, from the same variables. */
export function liveEndpoint(): { url: string; headers: Record<string, string> } {
  const base = (process.env["ANTHROPIC_BASE_URL"] || "https://api.anthropic.com").replace(
    /\/+$/,
    "",
  );
  const token = process.env["ANTHROPIC_AUTH_TOKEN"];
  return {
    url: `${base}/v1/messages`,
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(token
        ? { authorization: `Bearer ${token}` }
        : { "x-api-key": process.env["ANTHROPIC_API_KEY"] ?? "" }),
    },
  };
}

/** Records what the agent sent, so assertions can read the actual reply. */
export function recordingChannel(sent: string[]): WhatsAppChannel {
  return {
    sendText: async (_phone: string, text: string) => {
      sent.push(text);
    },
    downloadMedia: async () => {
      throw new Error("live suites are text-only; no media should be requested");
    },
  } as WhatsAppChannel;
}

/** A logger that keeps every record, so tests can assert on the turn stats. */
export function capturingLog(): {
  log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };
  turns: Record<string, unknown>[];
  warnings: Record<string, unknown>[];
} {
  const turns: Record<string, unknown>[] = [];
  const warnings: Record<string, unknown>[] = [];
  return {
    turns,
    warnings,
    log: {
      info: (obj: unknown) => {
        if (obj && typeof obj === "object") turns.push(obj as Record<string, unknown>);
      },
      warn: (obj: unknown) => {
        if (obj && typeof obj === "object") warnings.push(obj as Record<string, unknown>);
      },
    },
  };
}

/**
 * Long, stable prefix used to probe prompt caching. Must be IDENTICAL between
 * calls — a cache is a prefix match, so one changed character at the front
 * invalidates all of it.
 *
 * SIZED DELIBERATELY LARGE (~28k tokens). An earlier 6k-token version reported
 * cache_read_input_tokens=0 against DeepSeek and looked like proof that caching
 * does not carry over. It was a false negative: the prefix sat below the
 * provider's minimum cacheable length. At this size the same endpoint reports
 * input_tokens=10 / cache_read_input_tokens=28800 on the second call. A caching
 * probe that is too small does not measure caching, it measures the threshold.
 */
export function cacheProbePrefix(): string {
  const paragraph =
    "The following is reference material about a residential property catalogue. " +
    "Each listing carries a code, a price in Colombian pesos, a neighbourhood, and a set of attributes. " +
    "Codes are four digits. Prices are quoted exactly as stored, never rounded or converted. ";
  return paragraph.repeat(1200);
}
