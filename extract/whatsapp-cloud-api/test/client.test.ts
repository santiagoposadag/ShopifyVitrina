import { describe, expect, it } from "vitest";
import {
  WhatsAppApiError,
  WhatsAppCloudClient,
  isAllowedMediaHost,
  splitText,
  templateParam,
} from "../src/index.js";

const CONFIG = { phoneNumberId: "1234567890", accessToken: "TOKEN" };

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake fetch that records what was SENT — the assertions are on the requests. */
function recorder(responder: (url: string, n: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return responder(url, calls.length);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const header = (c: Call | undefined, name: string) => (c?.init?.headers as Record<string, string>)?.[name];
const bodyOf = (c: Call | undefined) => JSON.parse(c!.init!.body as string);

describe("sendText", () => {
  it("posts Meta's text shape to /{phoneNumberId}/messages with the Bearer token", async () => {
    const { calls, fetchImpl } = recorder(() => json({ messages: [{ id: "wamid.OUT" }] }));
    const result = await new WhatsAppCloudClient(CONFIG, fetchImpl).sendText("+57 300 111 2233", "hola");

    expect(result.messageIds).toEqual(["wamid.OUT"]);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/1234567890/messages");
    expect(header(calls[0], "Authorization")).toBe("Bearer TOKEN");
    expect(bodyOf(calls[0])).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "573001112233",
      type: "text",
      text: { preview_url: false, body: "hola" },
    });
  });

  it("splits a long body and sends the pieces in order, quoting only from the first", async () => {
    const { calls, fetchImpl } = recorder((_, n) => json({ messages: [{ id: `wamid.${n}` }] }));
    const body = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
    const result = await new WhatsAppCloudClient(CONFIG, fetchImpl).sendText("573001112233", body, {
      replyTo: "wamid.IN",
    });

    expect(result.messageIds).toEqual(["wamid.1", "wamid.2"]);
    expect(bodyOf(calls[0]).text.body).toBe("a".repeat(3000));
    expect(bodyOf(calls[0]).context).toEqual({ message_id: "wamid.IN" });
    expect(bodyOf(calls[1]).text.body).toBe("b".repeat(3000));
    expect(bodyOf(calls[1]).context).toBeUndefined();
  });

  it("refuses a recipient with no digits before touching the network", async () => {
    const { calls, fetchImpl } = recorder(() => json({}));
    await expect(new WhatsAppCloudClient(CONFIG, fetchImpl).sendText("abc", "x")).rejects.toThrow(/unusable/);
    expect(calls).toHaveLength(0);
  });

  it("throws a WhatsAppApiError naming 131047 as the 24h window", async () => {
    const { fetchImpl } = recorder(() =>
      json({ error: { code: 131047, message: "Re-engagement message", error_data: { details: "x" } } }, 400),
    );
    const err = await new WhatsAppCloudClient(CONFIG, fetchImpl).sendText("573001112233", "hola").catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppApiError);
    expect(err.code).toBe(131047);
    expect(err.outsideServiceWindow).toBe(true);
    expect(err.message).toMatch(/24h customer service window/);
  });
});

describe("sendTemplate", () => {
  it("builds body and URL-button components; the button carries the suffix alone", async () => {
    const { calls, fetchImpl } = recorder(() => json({ messages: [{ id: "wamid.T" }] }));
    await new WhatsAppCloudClient(CONFIG, fetchImpl).sendTemplate("573001112233", {
      name: "aviso",
      language: "es",
      bodyParams: ["uno", "dos"],
      buttonUrlSuffix: "abc123",
    });
    expect(bodyOf(calls[0]).template).toEqual({
      name: "aviso",
      language: { code: "es" },
      components: [
        { type: "body", parameters: [{ type: "text", text: "uno" }, { type: "text", text: "dos" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "abc123" }] },
      ],
    });
  });

  it("omits components for a parameterless template", async () => {
    const { calls, fetchImpl } = recorder(() => json({ messages: [{ id: "wamid.T" }] }));
    await new WhatsAppCloudClient(CONFIG, fetchImpl).sendTemplate("573001112233", { name: "hello_world", language: "en_US" });
    expect(bodyOf(calls[0]).template).toEqual({ name: "hello_world", language: { code: "en_US" } });
  });
});

describe("downloadMedia", () => {
  it("resolves the id, then downloads from the Meta host with token and User-Agent", async () => {
    const { calls, fetchImpl } = recorder((url) =>
      url.includes("lookaside")
        ? new Response(new Uint8Array([1, 2, 3]))
        : json({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", mime_type: "image/jpeg" }),
    );
    const { data, mimeType } = await new WhatsAppCloudClient(CONFIG, fetchImpl).downloadMedia("MEDIA_ID");

    expect([...data]).toEqual([1, 2, 3]);
    expect(mimeType).toBe("image/jpeg");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/MEDIA_ID");
    expect(header(calls[1], "Authorization")).toBe("Bearer TOKEN");
    expect(header(calls[1], "User-Agent")).toBeTruthy();
  });

  it("never sends the token to a host that is not Meta's", async () => {
    const { calls, fetchImpl } = recorder(() => json({ url: "https://evil.example/steal" }));
    await expect(new WhatsAppCloudClient(CONFIG, fetchImpl).downloadMedia("MEDIA_ID")).rejects.toThrow(/untrusted host/);
    expect(calls).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("isAllowedMediaHost accepts Meta over https only, and not look-alike suffixes", () => {
    expect(isAllowedMediaHost("https://lookaside.fbsbx.com/x")).toBe(true);
    expect(isAllowedMediaHost("https://scontent.xx.fbcdn.net/x")).toBe(true);
    expect(isAllowedMediaHost("http://lookaside.fbsbx.com/x")).toBe(false);
    expect(isAllowedMediaHost("https://evil-fbcdn.net/x")).toBe(false);
    expect(isAllowedMediaHost("not a url")).toBe(false);
  });

  it("splitText keeps short bodies whole and never exceeds the limit", () => {
    expect(splitText("")).toEqual([""]);
    expect(splitText("hola")).toEqual(["hola"]);
    for (const chunk of splitText("x".repeat(10_000))) expect(chunk.length).toBeLessThanOrEqual(4096);
  });

  it("templateParam collapses whitespace, substitutes empties and caps length", () => {
    expect(templateParam("a\n\tb   c")).toBe("a b c");
    expect(templateParam("   ")).toBe("—");
    expect(templateParam(null, 10, "n/a")).toBe("n/a");
    expect(templateParam("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
