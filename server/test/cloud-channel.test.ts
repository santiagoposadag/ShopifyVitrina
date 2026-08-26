import { describe, expect, it } from "vitest";
import {
  CloudApiChannel,
  isAllowedMediaHost,
  splitForWhatsApp,
  type CloudApiConfig,
} from "../src/whatsapp/cloud.js";

const CONFIG: CloudApiConfig = {
  whatsappPhoneNumberId: "1234567890",
  whatsappAccessToken: "SYSTEM_USER_TOKEN",
  whatsappGraphBaseUrl: "https://graph.facebook.com",
  whatsappGraphVersion: "v23.0",
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/**
 * A fake fetch that records what was SENT. What this layer gets wrong is not
 * parsing a response — it is sending the wrong body, or sending the token
 * somewhere it should never go — so the assertions are on the recorded calls.
 */
function recorder(responder: (url: string, call: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return responder(url, calls.length);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function headerOf(call: Call | undefined, name: string): string | undefined {
  return (call?.init?.headers as Record<string, string> | undefined)?.[name];
}

describe("CloudApiChannel.sendText", () => {
  it("posts Meta's message shape to the phone number id, with the Bearer token", () => {
    const { calls, fetchImpl } = recorder(() => ok({ messages: [{ id: "wamid.OUT" }] }));

    return new CloudApiChannel(CONFIG, fetchImpl).sendText("573001112233", "hola").then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/1234567890/messages");
      expect(headerOf(calls[0], "Authorization")).toBe("Bearer SYSTEM_USER_TOKEN");
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "573001112233",
        type: "text",
        // Previews off: the assistant sends storefront and checkout links, and an
        // unfurled card pushes the actual reply off screen.
        text: { preview_url: false, body: "hola" },
      });
    });
  });

  it("addresses the reply by digits it normalized itself", async () => {
    // Same rule the bridge enforces before building a JID: never send to a
    // string that arrived over the wire.
    const { calls, fetchImpl } = recorder(() => ok({}));

    await new CloudApiChannel(CONFIG, fetchImpl).sendText("+57 300 111 2233", "hola");

    expect(JSON.parse(calls[0]!.init!.body as string).to).toBe("573001112233");
  });

  it("splits an over-long reply and sends the pieces IN ORDER", async () => {
    // WhatsApp rejects a body over 4096 chars outright (error 131009). Before
    // this the whole turn failed and retried forever; the answer must arrive.
    const { calls, fetchImpl } = recorder(() => ok({}));
    const long = `${"a".repeat(4000)}\n${"b".repeat(3000)}`;

    await new CloudApiChannel(CONFIG, fetchImpl).sendText("573001112233", long);

    expect(calls).toHaveLength(2);
    const bodies = calls.map((c) => JSON.parse(c.init!.body as string).text.body as string);
    expect(bodies[0]!.startsWith("a")).toBe(true);
    expect(bodies[1]!.startsWith("b")).toBe(true);
    expect(bodies.every((b) => b.length <= 4096)).toBe(true);
  });

  it("names the 24-hour window when that is why the send was rejected", async () => {
    // The single most likely send failure of this deployment, and the one whose
    // fix is a decision (an approved template) rather than a retry.
    const { fetchImpl } = recorder(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: "(#131047) Re-engagement message",
              code: 131047,
              error_data: { details: "more than 24 hours have passed" },
            },
          }),
          { status: 400 },
        ),
    );

    await expect(
      new CloudApiChannel(CONFIG, fetchImpl).sendText("573001112233", "hola"),
    ).rejects.toThrow(/131047.*24h customer service window/s);
  });
});

describe("CloudApiChannel.downloadMedia", () => {
  it("resolves the media id first, then downloads with the token attached", async () => {
    const { calls, fetchImpl } = recorder((url, n) =>
      n === 1
        ? ok({
            url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=MEDIA_1",
            mime_type: "image/jpeg",
          })
        : new Response(Buffer.from("jpeg-bytes"), { status: 200 }),
    );

    const bytes = await new CloudApiChannel(CONFIG, fetchImpl).downloadMedia("MEDIA_1");

    expect(bytes.toString()).toBe("jpeg-bytes");
    // Two round trips, and the id is what we hold: the url expires in ~5 minutes.
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/MEDIA_1");
    expect(calls[1]!.url).toContain("lookaside.fbsbx.com");
    expect(headerOf(calls[1], "Authorization")).toBe("Bearer SYSTEM_USER_TOKEN");
  });

  it("never sends the access token to a host outside Meta", async () => {
    // The url is read out of a response and we attach the credential that can
    // send WhatsApp messages as the business. One wrong host is a leaked token.
    const { calls, fetchImpl } = recorder(() => ok({ url: "https://evil.example.com/steal" }));

    await expect(new CloudApiChannel(CONFIG, fetchImpl).downloadMedia("MEDIA_1")).rejects.toThrow(
      /untrusted host/,
    );

    expect(calls).toHaveLength(1); // the download was never attempted
  });

  it("surfaces an expired token instead of returning empty bytes", async () => {
    const { fetchImpl } = recorder(
      () =>
        new Response(JSON.stringify({ error: { code: 190, message: "expired" } }), { status: 401 }),
    );

    await expect(new CloudApiChannel(CONFIG, fetchImpl).downloadMedia("MEDIA_1")).rejects.toThrow(
      /code 190/,
    );
  });
});

describe("isAllowedMediaHost", () => {
  it("accepts Meta's media hosts", () => {
    expect(
      isAllowedMediaHost("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1"),
    ).toBe(true);
    expect(isAllowedMediaHost("https://graph.facebook.com/v23.0/MEDIA")).toBe(true);
    expect(isAllowedMediaHost("https://scontent-bog.xx.fbcdn.net/v/t1")).toBe(true);
  });

  it("rejects a look-alike host, a bare http hop, and junk", () => {
    // The leading dot is why: "evil-fbcdn.net" is a suffix match on "fbcdn.net".
    expect(isAllowedMediaHost("https://evil-fbcdn.net/x")).toBe(false);
    expect(isAllowedMediaHost("https://lookaside.fbsbx.com.attacker.dev/x")).toBe(false);
    // A token on a plaintext hop is a leaked token.
    expect(isAllowedMediaHost("http://lookaside.fbsbx.com/x")).toBe(false);
    expect(isAllowedMediaHost("not a url")).toBe(false);
    expect(isAllowedMediaHost("")).toBe(false);
  });
});

describe("splitForWhatsApp", () => {
  it("leaves a normal reply untouched", () => {
    expect(splitForWhatsApp("hola")).toEqual(["hola"]);
  });

  it("prefers a line break over cutting mid-sentence", () => {
    const parts = splitForWhatsApp("uno dos tres\ncuatro cinco seis", 20);
    expect(parts[0]).toBe("uno dos tres");
    expect(parts.join(" ")).toContain("cuatro cinco seis");
  });

  it("still splits text that offers no break at all", () => {
    const parts = splitForWhatsApp("x".repeat(25), 10);
    expect(parts).toHaveLength(3);
    expect(parts.join("")).toHaveLength(25);
  });
});
