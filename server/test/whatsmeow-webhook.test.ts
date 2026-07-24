import { describe, expect, it } from "vitest";
import { extractInboundWhatsmeow } from "../src/inbox/whatsmeow.js";
import { verifySignature } from "../src/inbox/webhook.js";

/**
 * The other half of the bridge's signature contract.
 *
 * These three constants are duplicated verbatim in bridge/delivery_test.go. The
 * bridge signs in Go and this server verifies in Node, so nothing else proves
 * the two agree — a change to either side that is not mirrored would break every
 * inbound message while both suites stayed green.
 */
const PINNED_SECRET = "bridge-test-secret";
const PINNED_BODY = '{"provider":"whatsmeow","id":"3EB0ABC","from":"573001112233"}';
const PINNED_SIGNATURE = "5fdd6a2dc000ccd74070f754429c98b6547a4a18008f2522a53a29ac95f338e5";

describe("bridge signature contract", () => {
  it("accepts the exact signature the Go bridge produces", () => {
    expect(verifySignature(PINNED_BODY, PINNED_SIGNATURE, PINNED_SECRET)).toBe(true);
  });

  it("still accepts it with the sha256= prefix", () => {
    expect(verifySignature(PINNED_BODY, `sha256=${PINNED_SIGNATURE}`, PINNED_SECRET)).toBe(true);
  });

  it("rejects the signature when a single body byte changes", () => {
    const tampered = PINNED_BODY.replace("573001112233", "573001112234");
    expect(verifySignature(tampered, PINNED_SIGNATURE, PINNED_SECRET)).toBe(false);
  });
});

describe("extractInboundWhatsmeow", () => {
  const base = { provider: "whatsmeow", id: "3EB0ABC", from: "573001112233", timestamp: 1 };

  it("reads a plain text message", () => {
    const inbound = extractInboundWhatsmeow({ ...base, type: "text", text: "hola" });
    expect(inbound).toEqual({
      from: "573001112233",
      id: "3EB0ABC",
      kind: "text",
      agentText: "hola",
    });
  });

  it("maps a photo to a media ref and keeps the caption as the only text", () => {
    const inbound = extractInboundWhatsmeow({
      ...base,
      type: "image",
      text: "fachada principal",
      media: { path: "/data/inbound/abc.bin", contentType: "image/jpeg" },
    });
    expect(inbound?.kind).toBe("image");
    expect(inbound?.media?.ref).toBe("/data/inbound/abc.bin");
    expect(inbound?.media?.contentType).toBe("image/jpeg");
    // An uncaptioned photo carries no text — the row's kind is what says a photo
    // arrived, exactly as on the Kapso path.
    expect(inbound?.agentText).toBe("fachada principal");
  });

  it("leaves an uncaptioned photo's text empty", () => {
    const inbound = extractInboundWhatsmeow({
      ...base,
      type: "image",
      text: "",
      media: { path: "/data/inbound/abc.bin" },
    });
    expect(inbound?.kind).toBe("image");
    expect(inbound?.agentText).toBe("");
  });

  it("degrades an image whose file never arrived instead of passing an empty ref", () => {
    // downloadMedia would otherwise be handed "" and fail on every burst.
    const inbound = extractInboundWhatsmeow({ ...base, type: "image", text: "sin foto", media: {} });
    expect(inbound?.kind).toBe("other");
    expect(inbound?.media).toBeUndefined();
  });

  it("words a button tap exactly like the Kapso branch does", () => {
    // The agent prompt was tuned against this phrasing; two providers must not
    // describe the same tap two different ways.
    const inbound = extractInboundWhatsmeow({
      ...base,
      type: "interactive",
      text: "Ver fotos",
      reply: { id: "btn_photos" },
    });
    expect(inbound?.kind).toBe("interactive");
    expect(inbound?.agentText).toBe("Seleccionó: Ver fotos (id btn_photos)");
  });

  it("omits the id suffix when a selection carries no id", () => {
    const inbound = extractInboundWhatsmeow({
      ...base,
      type: "interactive",
      text: "Ver fotos",
      reply: {},
    });
    expect(inbound?.agentText).toBe("Seleccionó: Ver fotos");
  });

  it("ignores an event from another provider", () => {
    // Only one provider is live at a time. Parsing a foreign shape anyway would
    // manufacture a plausible-looking message out of the wrong fields.
    expect(extractInboundWhatsmeow({ ...base, provider: "kapso", type: "text" })).toBeNull();
    expect(extractInboundWhatsmeow({ ...base, provider: undefined, type: "text" })).toBeNull();
  });

  it("drops an event with no sender rather than inventing one", () => {
    expect(extractInboundWhatsmeow({ ...base, from: "", type: "text", text: "hola" })).toBeNull();
    expect(extractInboundWhatsmeow({ ...base, from: undefined, type: "text" })).toBeNull();
  });

  it("keeps an unknown type as 'other' so it can still be deduped and settled", () => {
    const inbound = extractInboundWhatsmeow({ ...base, type: "sticker", text: "" });
    expect(inbound?.kind).toBe("other");
    expect(inbound?.id).toBe("3EB0ABC");
  });
});
