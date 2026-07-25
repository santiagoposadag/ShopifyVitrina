import { describe, expect, it } from "vitest";
import { checkAgentCredential, type AgentCredential } from "../src/agent/preflight.js";

const ok = async () => new Response('{"data":[]}', { status: 200 });

/** An Anthropic deployment: x-api-key, default endpoint. */
function apiKeyCredential(key: string): AgentCredential {
  return { agentBaseUrl: "https://api.anthropic.com", anthropicApiKey: key, agentAuthToken: "" };
}

describe("checkAgentCredential", () => {
  it("reports a working key as valid", async () => {
    expect(await checkAgentCredential(apiKeyCredential("sk-ant-good"), ok as typeof fetch)).toEqual({
      status: "valid",
    });
  });

  it("reports a rejected key as invalid, with the API's own words", async () => {
    // The exact failure this exists for: the SDK turns it into "Claude Code
    // process exited with code 1" on the first customer message.
    const unauthorized = async () =>
      new Response('{"error":{"message":"API key is invalid."}}', { status: 401 });

    const result = await checkAgentCredential(
      apiKeyCredential("sk-ant-bad"),
      unauthorized as typeof fetch,
    );

    expect(result.status).toBe("invalid");
    expect(result).toHaveProperty("detail", expect.stringContaining("API key is invalid"));
  });

  it("treats 403 as invalid too", async () => {
    const forbidden = async () => new Response("nope", { status: 403 });
    expect(
      (await checkAgentCredential(apiKeyCredential("k"), forbidden as typeof fetch)).status,
    ).toBe("invalid");
  });

  it("does NOT blame the key when the network is the problem", async () => {
    // Crying wolf on every boot-time hiccup would train people to ignore the one
    // message that matters.
    const offline = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
    };
    const result = await checkAgentCredential(apiKeyCredential("k"), offline as typeof fetch);

    expect(result.status).toBe("unknown");
    expect(result).toHaveProperty("detail", expect.stringContaining("ENOTFOUND"));
  });

  it("does not blame the key for a server-side outage either", async () => {
    const outage = async () => new Response("bad gateway", { status: 502 });
    expect((await checkAgentCredential(apiKeyCredential("k"), outage as typeof fetch)).status).toBe(
      "unknown",
    );
  });

  it("sends the key and API version, and asks for no tokens", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const spy = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await checkAgentCredential(apiKeyCredential("sk-ant-xyz"), spy);

    const headers = seen!.init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-xyz");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // A GET against /v1/models authenticates without generating tokens, so this
    // costs nothing per restart. A messages call would bill every boot.
    expect(seen!.url).toContain("/v1/models");
    expect(seen!.init!.method ?? "GET").toBe("GET");
  });

  describe("against a non-Anthropic endpoint", () => {
    const deepseek: AgentCredential = {
      agentBaseUrl: "https://api.deepseek.com/anthropic",
      agentAuthToken: "ds-token",
      anthropicApiKey: "",
    };

    it("checks the configured base URL, not Anthropic's", async () => {
      let seen = "";
      const spy = (async (url: string) => {
        seen = url;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      await checkAgentCredential(deepseek, spy);

      expect(seen).toBe("https://api.deepseek.com/anthropic/v1/models?limit=1");
    });

    it("presents a Bearer token when one is configured, not x-api-key", async () => {
      let headers: Record<string, string> = {};
      const spy = (async (_url: string, init?: RequestInit) => {
        headers = init!.headers as Record<string, string>;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      await checkAgentCredential(deepseek, spy);

      expect(headers["authorization"]).toBe("Bearer ds-token");
      expect(headers["x-api-key"]).toBeUndefined();
    });

    it("does NOT report a missing /v1/models route as a bad credential", async () => {
      // DeepSeek serves /v1/messages but 404s /v1/models. Reporting that as
      // "credential REJECTED" would fire a false alarm on every boot of a
      // perfectly healthy deployment — exactly the crying-wolf failure the
      // `unknown` branch exists to prevent.
      const notFound = async () => new Response("Not Found", { status: 404 });
      const result = await checkAgentCredential(deepseek, notFound as typeof fetch);

      expect(result.status).toBe("unknown");
      expect(result).toHaveProperty("detail", expect.stringContaining("ANTHROPIC_BASE_URL"));
    });

    it("still reports a rejected credential as invalid there", async () => {
      const unauthorized = async () => new Response("bad token", { status: 401 });
      expect((await checkAgentCredential(deepseek, unauthorized as typeof fetch)).status).toBe(
        "invalid",
      );
    });
  });
});
