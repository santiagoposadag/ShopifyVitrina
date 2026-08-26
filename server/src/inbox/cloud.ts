import type { InboundMessage } from "../types.js";

/**
 * Parser for Meta's WhatsApp Cloud API webhook payloads.
 *
 * Three things make this shape different from the bridge's, and every one of
 * them is a behaviour change further down the pipeline:
 *
 *  1. ONE POST CAN CARRY MANY MESSAGES. The bridge posts a single event per
 *     request; Meta nests an array under every change. The webhook therefore
 *     loops instead of handling one item.
 *  2. STATUS CALLBACKS ARRIVE ON THE SAME URL. Delivery receipts (sent,
 *     delivered, read, failed) come through as `statuses`, not `messages`, and
 *     they far outnumber real messages. They must be recognised and skipped,
 *     not parsed hopefully.
 *  3. MEDIA IS AN ID, NOT A PATH. What travels as `media.ref` here is Meta's
 *     media id; the URL it resolves to expires in ~5 minutes, so it is
 *     deliberately NOT read from the payload (see whatsapp/cloud.ts).
 *
 * `sentAt` is carried out of `timestamp` because Meta does not guarantee
 * webhook ordering — see types.ts.
 */

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Meta sends the timestamp as a STRING of unix seconds. */
function asUnixSeconds(v: unknown): number | undefined {
  const raw = typeof v === "number" ? String(v) : asString(v);
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Every `value` block carried by this payload, whatever field it belongs to. */
function changeValues(payload: Record<string, unknown>): Record<string, unknown>[] {
  // Anything that is not a WhatsApp payload is not ours to interpret. An app
  // subscribed to other products posts to the same URL, and parsing an unknown
  // shape anyway would manufacture a plausible message out of the wrong fields.
  if (payload["object"] !== "whatsapp_business_account") return [];
  const values: Record<string, unknown>[] = [];
  for (const entry of asArray(payload["entry"])) {
    for (const change of asArray(asRecord(entry)?.["changes"])) {
      const record = asRecord(change);
      if (!record) continue;
      // "messages" is the only field this server subscribes to; a payload from
      // another subscription is skipped rather than half-read.
      if (asString(record["field"]) !== "messages") continue;
      const value = asRecord(record["value"]);
      if (value) values.push(value);
    }
  }
  return values;
}

/** Media blocks all share this shape; `id` is the media id, never a URL. */
function mediaOf(
  message: Record<string, unknown>,
  key: string,
): { ref: string; filename?: string; contentType?: string } | undefined {
  const block = asRecord(message[key]);
  const ref = asString(block?.["id"]);
  if (!ref) return undefined;
  const contentType = asString(block?.["mime_type"]) || undefined;
  return {
    ref,
    // Only documents carry a real name. For audio the extension is what the
    // transcription API reads the format from, so it is synthesised from the
    // mime type rather than left to a default that may be wrong.
    filename: asString(block?.["filename"]) || filenameForMime(contentType),
    contentType,
  };
}

/** A plausible file name for a mime type, or undefined to let the caller decide. */
function filenameForMime(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  // "audio/ogg; codecs=opus" -> "audio/ogg"
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  const ext = MIME_EXT[base];
  return ext ? `media${ext}` : undefined;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".m4a",
  "audio/amr": ".amr",
  "audio/wav": ".wav",
};

function parseMessage(message: Record<string, unknown>): InboundMessage | null {
  const from = asString(message["from"]);
  const id = asString(message["id"]);
  // Unlike the bridge, the id is REQUIRED here: one POST can carry several
  // messages, so the content hash the webhook falls back to would key them all
  // the same and the dedupe would swallow every message but the first.
  if (!from || !id) return null;

  const sentAt = asUnixSeconds(message["timestamp"]);
  const type = asString(message["type"]);
  const base = { from, id, sentAt };

  switch (type) {
    case "text":
      return {
        ...base,
        kind: "text",
        agentText: asString(asRecord(message["text"])?.["body"]),
      };

    case "image": {
      const media = mediaOf(message, "image");
      if (!media) break;
      return {
        ...base,
        kind: "image",
        // The caption and nothing else — an uncaptioned photo carries no text.
        agentText: asString(asRecord(message["image"])?.["caption"]),
        media,
      };
    }

    case "audio":
    case "voice": {
      const media = mediaOf(message, type === "voice" ? "voice" : "audio");
      if (!media) break;
      return {
        ...base,
        kind: "audio",
        // Audio has no caption field; the transcript replaces this later, on
        // the worker. It is empty here on purpose.
        agentText: "",
        media: { ...media, filename: media.filename ?? "media.ogg" },
      };
    }

    case "interactive": {
      const interactive = asRecord(message["interactive"]);
      const reply =
        asRecord(interactive?.["button_reply"]) ?? asRecord(interactive?.["list_reply"]);
      const title = asString(reply?.["title"]);
      const replyId = asString(reply?.["id"]);
      // Worded exactly like the bridge branch: the agent's prompt was tuned
      // against this phrasing, so two providers must not describe a tap two
      // different ways.
      return {
        ...base,
        kind: "interactive",
        agentText: `Seleccionó: ${title}${replyId ? ` (id ${replyId})` : ""}`,
      };
    }

    case "button": {
      // A quick-reply tap on a template. Same shape of event, different block.
      const button = asRecord(message["button"]);
      const title = asString(button?.["text"]);
      const payload = asString(button?.["payload"]);
      return {
        ...base,
        kind: "interactive",
        agentText: `Seleccionó: ${title}${payload ? ` (id ${payload})` : ""}`,
      };
    }

    case "order": {
      // A cart sent from a WhatsApp catalog. We do not sell through one today,
      // and this deliberately does NOT stay empty: an order that reaches an
      // empty agentText is discarded by the webhook, and silently dropping a
      // customer's cart is the worst possible failure on this path.
      const items = asArray(asRecord(message["order"])?.["product_items"]).length;
      return {
        ...base,
        kind: "other",
        agentText: `Envió un pedido del catálogo de WhatsApp con ${items} artículo(s).`,
      };
    }

    // Documents, video, stickers, location, contacts and system notices all
    // land here. A caption keeps them alive; without one the webhook settles
    // them quietly, exactly as the bridge does for its own "other".
    default:
      break;
  }

  const caption = asString(asRecord(message[type])?.["caption"]);
  return { ...base, kind: "other", agentText: caption };
}

/**
 * Every inbound MESSAGE in one webhook payload, in the order Meta listed them.
 *
 * Status callbacks and error notifications are skipped here; use
 * extractCloudStatusErrors for the ones worth logging.
 */
export function extractCloudInbound(payload: Record<string, unknown>): InboundMessage[] {
  const messages: InboundMessage[] = [];
  for (const value of changeValues(payload)) {
    for (const raw of asArray(value["messages"])) {
      const record = asRecord(raw);
      if (!record) continue;
      const parsed = parseMessage(record);
      if (parsed) messages.push(parsed);
    }
  }
  return messages;
}

export interface CloudStatusError {
  /** The wamid of the message WE sent that could not be delivered. */
  messageId: string;
  recipient: string;
  code: number | undefined;
  detail: string;
}

/**
 * Failed-delivery callbacks, which are the only status worth a log line.
 *
 * This is where a send that Meta ACCEPTED and then could not deliver shows up —
 * most often error 131047, a free-form reply that fell outside the 24-hour
 * customer service window. The POST that carried the reply returned 200, so
 * nothing else in the pipeline can tell you it never arrived.
 */
export function extractCloudStatusErrors(payload: Record<string, unknown>): CloudStatusError[] {
  const failures: CloudStatusError[] = [];
  for (const value of changeValues(payload)) {
    for (const raw of asArray(value["statuses"])) {
      const status = asRecord(raw);
      if (!status || asString(status["status"]) !== "failed") continue;
      const error = asRecord(asArray(status["errors"])[0]);
      failures.push({
        messageId: asString(status["id"]),
        recipient: asString(status["recipient_id"]),
        code: typeof error?.["code"] === "number" ? (error["code"] as number) : undefined,
        detail:
          asString(asRecord(error?.["error_data"])?.["details"]) ||
          asString(error?.["title"]) ||
          asString(error?.["message"]),
      });
    }
  }
  return failures;
}
