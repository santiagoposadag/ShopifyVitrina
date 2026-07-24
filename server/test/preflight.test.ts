import { describe, expect, it } from "vitest";
import { checkAnthropicKey } from "../src/agent/preflight.js";

const ok = async () => new Response('{"data":[]}', { status: 200 });

describe("checkAnthropicKey", () => {
  it("reports a working key as valid", async () => {
    expect(await checkAnthropicKey("sk-ant-good", ok as typeof fetch)).toEqual({ status: "valid" });
  });

  it("reports a rejected key as invalid, with the API's own words", async () => {
    // The exact failure this exists for: the SDK turns it into "Claude Code
    // process exited with code 1" on the first customer message.
    const unauthorized = async () =>
      new Response('{"error":{"message":"API key is invalid."}}', { status: 401 });

    const result = await checkAnthropicKey("sk-ant-bad", unauthorized as typeof fetch);

    expect(result.status).toBe("invalid");
    expect(result).toHaveProperty("detail", expect.stringContaining("API key is invalid"));
  });

  it("treats 403 as invalid too", async () => {
    const forbidden = async () => new Response("nope", { status: 403 });
    expect((await checkAnthropicKey("k", forbidden as typeof fetch)).status).toBe("invalid");
  });

  it("does NOT blame the key when the network is the problem", async () => {
    // Crying wolf on every boot-time hiccup would train people to ignore the one
    // message that matters.
    const offline = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
    };
    const result = await checkAnthropicKey("k", offline as typeof fetch);

    expect(result.status).toBe("unknown");
    expect(result).toHaveProperty("detail", expect.stringContaining("ENOTFOUND"));
  });

  it("does not blame the key for a server-side outage either", async () => {
    const outage = async () => new Response("bad gateway", { status: 502 });
    expect((await checkAnthropicKey("k", outage as typeof fetch)).status).toBe("unknown");
  });

  it("sends the key and API version, and asks for no tokens", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const spy = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await checkAnthropicKey("sk-ant-xyz", spy);

    const headers = seen!.init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-xyz");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // A GET against /v1/models authenticates without generating tokens, so this
    // costs nothing per restart. A messages call would bill every boot.
    expect(seen!.url).toContain("/v1/models");
    expect(seen!.init!.method ?? "GET").toBe("GET");
  });
});
