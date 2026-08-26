import { describe, expect, it } from "vitest";
import { extractCloudInbound, extractCloudStatusErrors } from "../src/inbox/cloud.js";

/** One Cloud API webhook payload wrapping whatever `value` block a test needs. */
function payload(value: Record<string, unknown>): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_ID", changes: [{ field: "messages", value }] }],
  };
}

function message(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    from: "573001112233",
    id: "wamid.AAA",
    timestamp: "1756200000",
    ...extra,
  };
}

const VALUE_BASE = {
  messaging_product: "whatsapp",
  metadata: {
    display_phone_number: "573001112233",
    phone_number_id: "1234567890",
  },
  contacts: [{ profile: { name: "Santiago" }, wa_id: "573001112233" }],
};

describe("extractCloudInbound", () => {
  it("reads a text message and the timestamp WhatsApp stamped on it", () => {
    const [item] = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        messages: [message({ type: "text", text: { body: "hola" } })],
      }),
    );

    expect(item).toMatchObject({
      from: "573001112233",
      id: "wamid.AAA",
      kind: "text",
      agentText: "hola",
      // Not decoration: this is what orders a photo burst, because Meta does not
      // guarantee the order its webhooks arrive in.
      sentAt: 1756200000,
    });
  });

  it("returns EVERY message in one POST, in the order Meta listed them", () => {
    // The bridge posts one event per request; Meta nests an array. A parser that
    // read only the first would drop the rest of a photo burst on the floor.
    const items = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        messages: [
          message({ id: "wamid.1", type: "text", text: { body: "uno" } }),
          message({ id: "wamid.2", type: "text", text: { body: "dos" } }),
          message({ id: "wamid.3", type: "text", text: { body: "tres" } }),
        ],
      }),
    );

    expect(items.map((i) => i.agentText)).toEqual(["uno", "dos", "tres"]);
  });

  it("ignores delivery status callbacks instead of inventing messages from them", () => {
    // Statuses arrive on the SAME url and vastly outnumber real messages. One
    // parsed hopefully becomes a phantom inbound message, an agent turn, and a
    // reply to a customer who said nothing.
    const items = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        statuses: [
          {
            id: "wamid.OUT",
            status: "delivered",
            timestamp: "1756200001",
            recipient_id: "573001112233",
          },
        ],
      }),
    );

    expect(items).toEqual([]);
  });

  it("carries an image as a media ID, never a url", () => {
    // The url a media id resolves to expires in ~5 minutes; the id does not.
    // Storing the id is what lets the download happen when we get to it.
    const [item] = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        messages: [
          message({
            type: "image",
            image: {
              id: "MEDIA_123",
              mime_type: "image/jpeg",
              caption: "camisa azul",
            },
          }),
        ],
      }),
    );

    expect(item).toMatchObject({
      kind: "image",
      agentText: "camisa azul",
      media: { ref: "MEDIA_123", contentType: "image/jpeg" },
    });
  });

  it("gives a voice note a file name with the right extension", () => {
    // The transcription API reads the audio format from the file name, and Meta
    // sends no filename for audio — only a mime type.
    const [item] = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        messages: [
          message({
            type: "audio",
            audio: {
              id: "MEDIA_AUDIO",
              mime_type: "audio/ogg; codecs=opus",
              voice: true,
            },
          }),
        ],
      }),
    );

    expect(item).toMatchObject({ kind: "audio", agentText: "" });
    expect(item!.media!.filename).toBe("media.ogg");
  });

  it("describes a button tap exactly as the bridge does", () => {
    // The agent's prompt was tuned against this phrasing. Two transports must
    // not describe the same tap two different ways.
    const [button] = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        messages: [
          message({
            type: "interactive",
            interactive: {
              type: "button_reply",
              button_reply: { id: "si", title: "Sí" },
            },
          }),
        ],
      }),
    );
    const [list] = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        messages: [
          message({
            type: "interactive",
            interactive: {
              type: "list_reply",
              list_reply: { id: "m", title: "Mediana" },
            },
          }),
        ],
      }),
    );

    expect(button!.agentText).toBe("Seleccionó: Sí (id si)");
    expect(list!.agentText).toBe("Seleccionó: Mediana (id m)");
  });

  it("reads a template quick-reply tap, which arrives in its own block", () => {
    const [item] = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        messages: [
          message({
            type: "button",
            button: { text: "Confirmar", payload: "CONFIRM" },
          }),
        ],
      }),
    );

    expect(item).toMatchObject({
      kind: "interactive",
      agentText: "Seleccionó: Confirmar (id CONFIRM)",
    });
  });

  it("never lets a catalog order arrive empty, because empty is discarded", () => {
    // The webhook drops any message with no text and no media. For an order that
    // would silently swallow a customer's cart — the worst failure on this path.
    const [item] = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        messages: [
          message({
            type: "order",
            order: {
              catalog_id: "CAT",
              product_items: [{ product_retailer_id: "a" }, { product_retailer_id: "b" }],
            },
          }),
        ],
      }),
    );

    expect(item!.agentText).toContain("2 artículo(s)");
  });

  it("drops a message with no id, rather than letting the dedupe key collapse a burst", () => {
    // One POST can carry several messages. Without an id the webhook falls back
    // to hashing the whole event, which is IDENTICAL for every message in it —
    // so the inbox would keep the first and silently swallow the rest.
    const items = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        messages: [
          {
            from: "573001112233",
            timestamp: "1756200000",
            type: "text",
            text: { body: "sin id" },
          },
          message({ id: "wamid.OK", type: "text", text: { body: "con id" } }),
        ],
      }),
    );

    expect(items.map((i) => i.agentText)).toEqual(["con id"]);
  });

  it("keeps a captioned document alive and lets an uncaptioned one settle", () => {
    const captioned = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        messages: [
          message({
            type: "document",
            document: {
              id: "DOC",
              mime_type: "application/pdf",
              caption: "la factura",
            },
          }),
        ],
      }),
    );
    const bare = extractCloudInbound(
      payload({
        ...VALUE_BASE,
        messages: [
          message({
            type: "sticker",
            sticker: { id: "STK", mime_type: "image/webp" },
          }),
        ],
      }),
    );

    expect(captioned[0]).toMatchObject({
      kind: "other",
      agentText: "la factura",
    });
    // Empty text and no media: the webhook settles this quietly, exactly as it
    // does for the bridge's own "other".
    expect(bare[0]).toMatchObject({ kind: "other", agentText: "" });
  });

  it("refuses to interpret a payload that is not a WhatsApp one", () => {
    // The same callback URL receives whatever else the app subscribes to.
    // Parsing an unknown shape anyway manufactures a message out of wrong fields.
    expect(extractCloudInbound({ object: "page", entry: [] })).toEqual([]);
    expect(
      extractCloudInbound({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "message_template_status_update",
                value: {
                  messages: [message({ type: "text", text: { body: "x" } })],
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("extractCloudStatusErrors", () => {
  it("surfaces a send that Meta accepted and then could not deliver", () => {
    // The POST that carried the reply returned 200. Without this, a reply that
    // fell outside the 24h window is invisible everywhere.
    const failures = extractCloudStatusErrors(
      payload({
        ...VALUE_BASE,
        statuses: [
          { id: "wamid.OK", status: "delivered", recipient_id: "573001112233" },
          {
            id: "wamid.BAD",
            status: "failed",
            recipient_id: "573001112233",
            errors: [
              {
                code: 131047,
                title: "Re-engagement message",
                error_data: {
                  details: "Message failed to send because more than 24 hours have passed",
                },
              },
            ],
          },
        ],
      }),
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ messageId: "wamid.BAD", code: 131047 });
    expect(failures[0]!.detail).toContain("24 hours");
  });
});
