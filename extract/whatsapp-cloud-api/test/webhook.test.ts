import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleVerification, parseWebhook, verifySignature } from "../src/index.js";

/** Meta's envelope around one `value` block. */
const envelope = (value: Record<string, unknown>, field = "messages") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA_ID", changes: [{ field, value }] }],
});

const meta = { messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: "PNID" } };

describe("verifySignature", () => {
  const secret = "app-secret";
  const body = '{"object":"whatsapp_business_account","entry":[]}';
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts the HMAC of the raw body, as a string or a Buffer", () => {
    expect(verifySignature(body, sig, secret)).toBe(true);
    expect(verifySignature(Buffer.from(body), sig, secret)).toBe(true);
  });

  it("rejects a re-serialised body, a wrong secret, and missing or malformed headers", () => {
    expect(verifySignature(JSON.stringify(JSON.parse(body), null, 1), sig, secret)).toBe(false);
    expect(verifySignature(body, sig, "other")).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, "sha256=zz", secret)).toBe(false);
  });
});

describe("handleVerification", () => {
  it("echoes the challenge as-is for the right token", () => {
    const q = { "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "1158201444" };
    expect(handleVerification(q, "tok")).toEqual({ status: 200, body: "1158201444" });
  });

  it("refuses a wrong token, a wrong mode, and an empty configured token", () => {
    expect(handleVerification({ "hub.mode": "subscribe", "hub.verify_token": "x" }, "tok").status).toBe(403);
    expect(handleVerification({ "hub.mode": "unsubscribe", "hub.verify_token": "tok" }, "tok").status).toBe(403);
    expect(handleVerification({ "hub.mode": "subscribe", "hub.verify_token": "" }, "").status).toBe(403);
  });
});

describe("parseWebhook", () => {
  it("returns EVERY message of a burst, in order, with profile name and receiving number", () => {
    const parsed = parseWebhook(
      envelope({
        ...meta,
        contacts: [{ profile: { name: "Ana" }, wa_id: "573001112233" }],
        messages: [
          { from: "573001112233", id: "wamid.1", timestamp: "1700000000", type: "text", text: { body: "hola" } },
          {
            from: "573001112233",
            id: "wamid.2",
            timestamp: "1700000001",
            type: "image",
            image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "foto" },
          },
        ],
      }),
    );
    expect(parsed.messages.map((m) => m.id)).toEqual(["wamid.1", "wamid.2"]);
    expect(parsed.messages[0]).toMatchObject({
      kind: "text",
      text: "hola",
      timestamp: 1700000000,
      profileName: "Ana",
      phoneNumberId: "PNID",
    });
    expect(parsed.messages[1]).toMatchObject({
      kind: "image",
      text: "foto",
      media: { id: "MEDIA1", mimeType: "image/jpeg", filename: "media.jpg" },
    });
  });

  it("normalises voice notes to audio with a usable file name", () => {
    const [msg] = parseWebhook(
      envelope({ ...meta, messages: [{ from: "1", id: "w", type: "voice", voice: { id: "M", mime_type: "audio/ogg; codecs=opus" } }] }),
    ).messages;
    expect(msg).toMatchObject({ kind: "audio", text: "", media: { id: "M", filename: "media.ogg" } });
  });

  it("flattens button, list and template quick-reply taps into `reply`", () => {
    const { messages } = parseWebhook(
      envelope({
        ...meta,
        messages: [
          { from: "1", id: "a", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes", title: "Sí" } } },
          { from: "1", id: "b", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "r1", title: "Fila" } } },
          { from: "1", id: "c", type: "button", button: { payload: "P", text: "Quiero" } },
        ],
      }),
    );
    expect(messages.map((m) => [m.kind, m.reply])).toEqual([
      ["interactive", { id: "yes", title: "Sí" }],
      ["interactive", { id: "r1", title: "Fila" }],
      ["button", { id: "P", title: "Quiero" }],
    ]);
  });

  it("keeps location, reaction, order, quoted context and unknown types", () => {
    const { messages } = parseWebhook(
      envelope({
        ...meta,
        messages: [
          { from: "1", id: "l", type: "location", location: { latitude: 4.6, longitude: -74.1, name: "Casa" } },
          { from: "1", id: "r", type: "reaction", reaction: { message_id: "wamid.X", emoji: "👍" } },
          { from: "1", id: "o", type: "order", order: { product_items: [{}, {}] } },
          { from: "1", id: "q", type: "text", text: { body: "esto" }, context: { id: "wamid.Q" } },
          { from: "1", id: "u", type: "unsupported", errors: [{ code: 131051 }] },
        ],
      }),
    );
    expect(messages.find((m) => m.id === "l")?.location).toEqual({ latitude: 4.6, longitude: -74.1, name: "Casa", address: undefined });
    expect(messages.find((m) => m.id === "r")?.reaction).toEqual({ messageId: "wamid.X", emoji: "👍" });
    expect(messages.find((m) => m.id === "o")?.orderItemCount).toBe(2);
    expect(messages.find((m) => m.id === "q")?.contextMessageId).toBe("wamid.Q");
    expect(messages.find((m) => m.id === "u")).toMatchObject({ kind: "unsupported", raw: { type: "unsupported" } });
  });

  it("drops a message without an id — it could not be deduplicated", () => {
    expect(parseWebhook(envelope({ ...meta, messages: [{ from: "1", type: "text", text: { body: "x" } }] })).messages).toEqual([]);
  });

  it("reports statuses, with the error only on failed ones", () => {
    const { statuses, messages } = parseWebhook(
      envelope({
        ...meta,
        statuses: [
          { id: "wamid.OUT1", status: "delivered", recipient_id: "573", timestamp: "1700000005" },
          {
            id: "wamid.OUT2",
            status: "failed",
            recipient_id: "573",
            errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "outside window" } }],
          },
        ],
      }),
    );
    expect(messages).toEqual([]);
    expect(statuses[0]).toMatchObject({ messageId: "wamid.OUT1", status: "delivered", timestamp: 1700000005 });
    expect(statuses[0]!.error).toBeUndefined();
    expect(statuses[1]!.error).toEqual({ code: 131047, title: "Re-engagement message", detail: "outside window" });
  });

  it("ignores other products, other fields and garbage instead of half-reading them", () => {
    expect(parseWebhook({ object: "page", entry: [] })).toEqual({ messages: [], statuses: [], errors: [] });
    expect(parseWebhook(envelope({ messages: [{ from: "1", id: "x", type: "text" }] }, "account_update")).messages).toEqual([]);
    expect(parseWebhook(null).messages).toEqual([]);
    expect(parseWebhook("nope").messages).toEqual([]);
  });
});
