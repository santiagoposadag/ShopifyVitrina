/**
 * Config for running the agent OUTSIDE the server process — the comparison
 * harness and the live parity suites.
 *
 * Both drive `runAgentTurn` directly with a fake channel, so they never reach
 * the bridge. `loadConfig` still requires the bridge variables because the
 * server genuinely cannot run without them, and failing a provider comparison
 * over a WhatsApp sidecar it will never call is noise. These placeholders let a
 * provider run need only the provider variables set.
 *
 * Deliberately NOT a default inside config.ts: the server must keep failing
 * fast on a missing BRIDGE_URL, because there the missing value is real.
 */
import { loadConfig, loadDotEnv, type Config } from "../config.js";

export function loadOfflineConfig(overrides: Partial<Config> = {}): Config {
  loadDotEnv();
  process.env["BRIDGE_WEBHOOK_SECRET"] ||= "offline-run-secret";
  process.env["BRIDGE_URL"] ||= "http://localhost:3002";
  process.env["BRIDGE_API_TOKEN"] ||= "offline-run-token";
  process.env["BRIDGE_STAGING_DIR"] ||= "./data/inbound";

  // In-memory by default: a comparison or a parity run must never write into
  // the real catalog it seeds fixtures against.
  return { ...loadConfig(), dbPath: ":memory:", ...overrides };
}
