/**
 * Boot-time check that the agent credential actually works.
 *
 * The Agent SDK runs Claude Code as a subprocess and this version exposes no
 * way to read its stderr, so an invalid API key surfaces as
 * `Claude Code process exited with code 1` — on the first customer message, from
 * inside the batcher, with a stack trace pointing at the SDK's process handling
 * and nothing at all pointing at the key. It looks exactly like a crash.
 *
 * One request at boot converts that into a sentence in the startup log, before
 * anyone has messaged the bot.
 *
 * GET /v1/models is used deliberately: it authenticates the key without
 * generating a single token, so this costs nothing per restart.
 *
 * It is also OPTIONAL in the Anthropic-compatible endpoints we can be pointed
 * at — DeepSeek serves /v1/messages but answers 404 here — so a missing models
 * route reports `unknown`, never `invalid`. See the KeyCheck doc below: this
 * check exists to catch a rejected credential, and a check that fires on a
 * perfectly healthy deployment is worse than no check at all.
 */

import type { Config } from "../config.js";

export type KeyCheck =
  | { status: "valid" }
  /** The API answered, and the answer was "no". Worth shouting about. */
  | { status: "invalid"; detail: string }
  /**
   * We could not tell — no network, an outage, a proxy. NOT reported as a bad
   * key: crying wolf every time the network hiccups at boot would train people
   * to ignore the one message that matters.
   */
  | { status: "unknown"; detail: string };

/** The credential to present, in whichever header form the provider expects. */
export type AgentCredential = Pick<Config, "agentBaseUrl" | "agentAuthToken" | "anthropicApiKey">;

/**
 * Bearer when an auth token is configured, `x-api-key` otherwise. Both are
 * accepted by Anthropic and by DeepSeek's compatible endpoint; which one a
 * deployment uses is decided by which variable it sets, so this mirrors the
 * same choice buildAgentEnv makes for the SDK subprocess.
 */
function authHeaders(credential: AgentCredential): Record<string, string> {
  return credential.agentAuthToken
    ? { authorization: `Bearer ${credential.agentAuthToken}` }
    : { "x-api-key": credential.anthropicApiKey };
}

export async function checkAgentCredential(
  credential: AgentCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyCheck> {
  const url = `${credential.agentBaseUrl.replace(/\/+$/, "")}/v1/models?limit=1`;
  try {
    const res = await fetchImpl(url, {
      headers: { ...authHeaders(credential), "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { status: "valid" };
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      return { status: "invalid", detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    if (res.status === 404) {
      return {
        status: "unknown",
        detail: `HTTP 404: ${url} is not served by this endpoint, so the credential could not be checked. Expected when ANTHROPIC_BASE_URL points somewhere other than Anthropic.`,
      };
    }
    return { status: "unknown", detail: `HTTP ${res.status}` };
  } catch (err) {
    return { status: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
}
