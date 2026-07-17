import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/data/db.js";
import { insertInboxMessage } from "../src/data/repo.js";
import {
  extractInbound,
  normalizeEvents,
  stableEventKey,
  verifySignature,
} from "../src/inbox/webhook.js";

const SECRET = "test_webhook_secret";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("verifySignature", () => {
  const body = JSON.stringify({ hello: "world", n: 1 });

  it("accepts a valid signature", () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("accepts a sha256= prefixed signature", () => {
    expect(verifySignature(body, `sha256=${sign(body)}`, SECRET)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifySignature(body, sign(body, "wrong_secret"), SECRET)).toBe(false);
  });

  it("rejects when the body was tampered with", () => {
    const tampered = body.replace("world", "moon");
    expect(verifySignature(tampered, sign(body), SECRET)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
  });
});

describe("per-event dedupe via the inbox", () => {
  it("dedupes on the WhatsApp message id across retries", () => {
    const db = openDb(":memory:");
    const event = { message: { id: "wamid.ABC", type: "text", from: "573001", text: { body: "hi" } } };
    const inbound = extractInbound(event);
    const key = stableEventKey(event, inbound?.id);
    expect(key).toBe("msg:wamid.ABC");
    // First delivery is persisted; the 10/40/90s retry of the same message is not.
    expect(insertInboxMessage(db, { dedupe_key: key, phone: "573001", agent_text: "hi" })).not.toBeNull();
    expect(insertInboxMessage(db, { dedupe_key: key, phone: "573001", agent_text: "hi" })).toBeNull();
    db.close();
  });

  it("falls back to a stable content hash when no message id is present", () => {
    const db = openDb(":memory:");
    const event = { message: { type: "text", from: "573001", text: { body: "hola" } } };
    const key1 = stableEventKey(event, undefined);
    const key2 = stableEventKey(event, undefined);
    expect(key1).toBe(key2); // deterministic
    expect(key1.startsWith("evt:")).toBe(true);
    expect(insertInboxMessage(db, { dedupe_key: key1, phone: "573001", agent_text: "hola" })).not.toBeNull();
    expect(insertInboxMessage(db, { dedupe_key: key2, phone: "573001", agent_text: "hola" })).toBeNull(); // retry deduped
    db.close();
  });

  it("produces different keys for different events", () => {
    const a = stableEventKey({ message: { from: "1", text: { body: "a" } } }, undefined);
    const b = stableEventKey({ message: { from: "1", text: { body: "b" } } }, undefined);
    expect(a).not.toBe(b);
  });
});

describe("normalizeEvents", () => {
  it("returns a single event as a one-item list", () => {
    const event = { message: { type: "text", from: "573001", text: { body: "Hola" } } };
    expect(normalizeEvents(event)).toHaveLength(1);
  });

  it("unwraps the batch envelope", () => {
    const batch = {
      batch: true,
      data: [
        { message: { type: "text", from: "573001", text: { body: "a" } } },
        { message: { type: "text", from: "573002", text: { body: "b" } } },
      ],
    };
    expect(normalizeEvents(batch)).toHaveLength(2);
  });

  it("returns an empty list for non-objects", () => {
    expect(normalizeEvents(null)).toHaveLength(0);
    expect(normalizeEvents("nope")).toHaveLength(0);
  });
});

describe("extractInbound", () => {
  it("extracts a text message", () => {
    const event = {
      message: {
        type: "text",
        from: "573001112233",
        text: { body: "Hola, busco apartamento" },
        kapso: { direction: "inbound" },
      },
    };
    const inbound = extractInbound(event);
    expect(inbound).not.toBeNull();
    expect(inbound?.kind).toBe("text");
    expect(inbound?.from).toBe("573001112233");
    expect(inbound?.agentText).toBe("Hola, busco apartamento");
    expect(inbound?.media).toBeUndefined();
  });

  it("extracts an inbound image with its media url", () => {
    const event = {
      message: {
        type: "image",
        from: "573001112233",
        image: { caption: "Mira esta casa", id: "media_1" },
        kapso: {
          direction: "inbound",
          media_data: {
            url: "https://api.kapso.ai/media/abc",
            filename: "photo.jpg",
            content_type: "image/jpeg",
          },
        },
      },
    };
    const inbound = extractInbound(event);
    expect(inbound?.kind).toBe("image");
    expect(inbound?.media?.url).toBe("https://api.kapso.ai/media/abc");
    expect(inbound?.media?.contentType).toBe("image/jpeg");
    expect(inbound?.agentText).toBe("Mira esta casa");
  });

  // An uncaptioned photo has NO text. It used to be given the placeholder
  // wording here, which then got stored as the photo's own caption — 47 rows in
  // the pilot database read "(El usuario envió una foto)" as if the owner had
  // described them that way. The placeholder is how a photo is ANNOUNCED to the
  // agent, so it belongs to buildBatchText; the row carries kind instead.
  it("leaves an uncaptioned image with no text of its own", () => {
    const event = {
      message: {
        type: "image",
        from: "573001112233",
        image: { id: "media_2" },
        kapso: {
          direction: "inbound",
          media_data: { url: "https://api.kapso.ai/media/def", content_type: "image/jpeg" },
        },
      },
    };
    const inbound = extractInbound(event);
    expect(inbound?.kind).toBe("image");
    expect(inbound?.media?.url).toBe("https://api.kapso.ai/media/def");
    expect(inbound?.agentText).toBe("");
  });

  it("extracts an interactive button reply", () => {
    const event = {
      message: {
        type: "interactive",
        from: "573001112233",
        interactive: { type: "button_reply", button_reply: { id: "visit", title: "Agendar visita" } },
        kapso: { direction: "inbound" },
      },
    };
    const inbound = extractInbound(event);
    expect(inbound?.kind).toBe("interactive");
    expect(inbound?.agentText).toContain("Agendar visita");
  });

  it("ignores outbound messages", () => {
    const event = {
      message: {
        type: "text",
        from: "573001112233",
        text: { body: "sent by us" },
        kapso: { direction: "outbound" },
      },
    };
    expect(extractInbound(event)).toBeNull();
  });

  it("returns null when there is no message", () => {
    expect(extractInbound({ type: "contacts" })).toBeNull();
  });
});
