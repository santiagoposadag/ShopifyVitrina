import type { InboundMessage } from "./webhook.js";

/**
 * Parser for the whatsmeow bridge's inbound events.
 *
 * The bridge posts OUR shape rather than an imitation of Kapso's envelope, so
 * this is a flat read with no probing for where the message might be hiding.
 * Both extractors produce InboundMessage, which is the only shape the rest of
 * the pipeline depends on.
 *
 * See bridge/inbound.go (InboundEvent) for the producing side.
 */

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function extractInboundWhatsmeow(event: Record<string, unknown>): InboundMessage | null {
  // Guard the provider tag: with one provider live at a time, an event from the
  // other one reaching this route means something is misconfigured, and parsing
  // it anyway would produce a plausible-looking message from the wrong shape.
  if (event["provider"] !== "whatsmeow") return null;

  const from = asString(event["from"]);
  if (!from) return null;

  const id = asString(event["id"]) || undefined;
  const text = asString(event["text"]);
  const type = asString(event["type"]);

  if (type === "interactive") {
    const reply = asRecord(event["reply"]);
    const replyId = asString(reply?.["id"]);
    // Worded exactly like the Kapso branch: the agent's prompt was tuned against
    // this phrasing, so two providers must not describe a tap two different ways.
    return {
      from,
      id,
      kind: "interactive",
      agentText: `Seleccionó: ${text}${replyId ? ` (id ${replyId})` : ""}`,
    };
  }

  if (type === "image") {
    const media = asRecord(event["media"]);
    const ref = asString(media?.["path"]);
    // An image whose file never made it is not an image. The bridge already
    // downgrades those to "other", but a media block without a path would
    // otherwise reach downloadMedia as an empty ref.
    if (ref) {
      return {
        from,
        id,
        kind: "image",
        // The caption and nothing else — an uncaptioned photo carries no text.
        agentText: text,
        media: {
          ref,
          filename: asString(media?.["filename"]) || undefined,
          contentType: asString(media?.["contentType"]) || undefined,
        },
      };
    }
  }

  if (type === "text") return { from, id, kind: "text", agentText: text };

  return { from, id, kind: "other", agentText: text };
}
