import { describe, expect, it } from "vitest";
import { extractInbound } from "../src/inbox/whatsmeow.js";

describe("extractInbound", () => {
  const base = { provider: "whatsmeow", id: "3EB0ABC", from: "573001112233", timestamp: 1 };

  it("reads a plain text message", () => {
    const inbound = extractInbound({ ...base, type: "text", text: "hola" });
    expect(inbound).toEqual({
      from: "573001112233",
      id: "3EB0ABC",
      kind: "text",
      agentText: "hola",
    });
  });

  it("maps a photo to a media ref and keeps the caption as the only text", () => {
    const inbound = extractInbound({
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
    const inbound = extractInbound({
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
    const inbound = extractInbound({ ...base, type: "image", text: "sin foto", media: {} });
    expect(inbound?.kind).toBe("other");
    expect(inbound?.media).toBeUndefined();
  });

  it("words a button tap exactly like the Kapso branch does", () => {
    // The agent prompt was tuned against this phrasing; two providers must not
    // describe the same tap two different ways.
    const inbound = extractInbound({
      ...base,
      type: "interactive",
      text: "Ver fotos",
      reply: { id: "btn_photos" },
    });
    expect(inbound?.kind).toBe("interactive");
    expect(inbound?.agentText).toBe("Seleccionó: Ver fotos (id btn_photos)");
  });

  it("omits the id suffix when a selection carries no id", () => {
    const inbound = extractInbound({
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
    expect(extractInbound({ ...base, provider: "kapso", type: "text" })).toBeNull();
    expect(extractInbound({ ...base, provider: undefined, type: "text" })).toBeNull();
  });

  it("drops an event with no sender rather than inventing one", () => {
    expect(extractInbound({ ...base, from: "", type: "text", text: "hola" })).toBeNull();
    expect(extractInbound({ ...base, from: undefined, type: "text" })).toBeNull();
  });

  it("keeps an unknown type as 'other' so it can still be deduped and settled", () => {
    const inbound = extractInbound({ ...base, type: "sticker", text: "" });
    expect(inbound?.kind).toBe("other");
    expect(inbound?.id).toBe("3EB0ABC");
  });

  describe("voice notes", () => {
    it("maps audio to a media ref and carries no text of its own", () => {
      const inbound = extractInbound({
        ...base,
        type: "audio",
        text: "",
        media: {
          path: "/data/inbound/abc.bin",
          filename: "audio.ogg",
          contentType: "audio/ogg; codecs=opus",
        },
      });

      expect(inbound?.kind).toBe("audio");
      expect(inbound?.media?.ref).toBe("/data/inbound/abc.bin");
      // The staged file is always .bin; this name is the only place the format
      // survives, and the transcriber reads the format from it.
      expect(inbound?.media?.filename).toBe("audio.ogg");
      expect(inbound?.media?.contentType).toBe("audio/ogg; codecs=opus");
      // WhatsApp has no caption field for audio. The transcript replaces this
      // later, on the worker.
      expect(inbound?.agentText).toBe("");
    });

    it("degrades to 'other' when the audio file never arrived", () => {
      // Nothing is left to answer without the file, and surfacing a media block
      // with no path would send an empty ref to downloadMedia.
      const inbound = extractInbound({ ...base, type: "audio", text: "", media: {} });

      expect(inbound?.kind).toBe("other");
      expect(inbound?.media).toBeUndefined();
    });
  });
});
