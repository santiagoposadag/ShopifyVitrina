/**
 * Boot-time check that the Anthropic credential actually works.
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
 */

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

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";

export async function checkAnthropicKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyCheck> {
  try {
    const res = await fetchImpl(MODELS_URL, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { status: "valid" };
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      return { status: "invalid", detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { status: "unknown", detail: `HTTP ${res.status}` };
  } catch (err) {
    return { status: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
}
