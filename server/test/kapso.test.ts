import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedMediaHost, KapsoClient } from "../src/whatsapp/kapso.js";

describe("isAllowedMediaHost", () => {
  it("allows kapso.ai and its subdomains", () => {
    expect(isAllowedMediaHost("https://api.kapso.ai/media/abc")).toBe(true);
    expect(isAllowedMediaHost("https://kapso.ai/media/abc")).toBe(true);
    expect(isAllowedMediaHost("https://cdn.kapso.ai/x")).toBe(true);
  });

  it("rejects non-kapso and look-alike hosts", () => {
    expect(isAllowedMediaHost("https://evil.com/x")).toBe(false);
    expect(isAllowedMediaHost("https://kapso.ai.evil.com/x")).toBe(false);
    expect(isAllowedMediaHost("https://notkapso.ai/x")).toBe(false);
    expect(isAllowedMediaHost("not a url")).toBe(false);
  });
});

describe("KapsoClient.downloadMedia", () => {
  const client = new KapsoClient({ kapsoApiKey: "secret-key", kapsoPhoneNumberId: "1" });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses an untrusted host WITHOUT sending the API key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(client.downloadMedia("https://evil.com/steal")).rejects.toThrow(/untrusted host/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("aborts a hanging download when the budget signal fires (never blocks the ACK)", async () => {
    // Simulate a request that hangs until the AbortSignal fires (real fetch
    // rejects on abort). If the timeout did not bound it, this would hang.
    vi.stubGlobal("fetch", (_url: string, opts?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const start = Date.now();
    await expect(
      client.downloadMedia("https://api.kapso.ai/media/slow", AbortSignal.timeout(50)),
    ).rejects.toThrow();
    // Resolved by the abort, well within a webhook ACK budget.
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
