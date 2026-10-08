import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundKind, InboundMedia, InboundMessage, ParsedWebhook, StatusUpdate } from "./types.js";

/**
 * Framework-agnostic pieces of Meta's webhook: the GET handshake, the POST
 * signature, and the payload parser. Wire them into any HTTP server — see
 * examples/node-http.ts.
 *
 * Three rules every integration has to keep:
 *
 *  1. VERIFY OVER THE RAW BODY. The signature is HMAC-SHA256 of the exact bytes
 *     Meta sent; a re-serialised JSON copy can reorder keys and every check fails.
 *     Your framework must hand you the body before it parses it.
 *  2. ACK FAST. Persist what you need (dedupe on InboundMessage.id) and answer
 *     200, then do the work. Meta retries a slow webhook and can eventually
 *     disable the subscription. Never download media inside the handler.
 *  3. ONE POST CARRIES MANY. Loop over every message, in the order given;
 *     reading only the first silently drops the rest of a burst.
 */

/** Meta's signature header (lower-cased, as Node exposes it). */
export const SIGNATURE_HEADER = "x-hub-signature-256";

/** Constant-time string compare. `===` on a secret leaks its prefix through timing. */
function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify `X-Hub-Signature-256` ("sha256=<hex>") against the RAW body, keyed
 * with the APP SECRET — not the verify token; they are different secrets with
 * different jobs. Constant-time; false on any malformed input.
 */
export function verifySignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Answer Meta's verification GET.
 *
 * Meta calls it when the callback URL is saved and AGAIN on every edit. The
 * challenge must be echoed as raw text/plain — a JSON-quoted copy fails and the
 * panel refuses to save the URL.
 */
export function handleVerification(
  query: Record<string, string | string[] | undefined>,
  verifyToken: string,
): { status: 200; body: string } | { status: 403; body: string } {
  const pick = (k: string): string => {
    const v = query[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  if (pick("hub.mode") === "subscribe" && secretEquals(pick("hub.verify_token"), verifyToken)) {
    return { status: 200, body: pick("hub.challenge") };
  }
  return { status: 403, body: "verification_failed" };
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const asRecord = (v: unknown): Rec | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asNumber = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** Meta sends timestamps as a STRING of unix seconds. */
function asUnixSeconds(v: unknown): number | undefined {
  const raw = typeof v === "number" ? String(v) : asString(v);
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".m4a",
  "audio/amr": ".amr",
  "audio/wav": ".wav",
  "application/pdf": ".pdf",
};

/** A plausible file name for a mime type — transcription APIs read the format from the extension. */
function filenameForMime(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  const base = mimeType.split(";")[0]!.trim().toLowerCase(); // "audio/ogg; codecs=opus" -> "audio/ogg"
  const ext = MIME_EXT[base];
  return ext ? `media${ext}` : undefined;
}

function mediaOf(block: Rec | undefined): InboundMedia | undefined {
  const id = asString(block?.["id"]);
  if (!id) return undefined;
  const mimeType = asString(block?.["mime_type"]) || undefined;
  return {
    id,
    mimeType,
    filename: asString(block?.["filename"]) || filenameForMime(mimeType),
    sha256: asString(block?.["sha256"]) || undefined,
  };
}

interface ChangeValue {
  value: Rec;
  phoneNumberId?: string;
  profileNames: Map<string, string>;
}

/** Every `value` block of the `messages` field. Anything else is not ours to interpret. */
function changeValues(payload: Rec, field: string): ChangeValue[] {
  // An app subscribed to other products posts to the same URL; parsing an
  // unknown shape anyway would manufacture a plausible message from wrong fields.
  if (payload["object"] !== "whatsapp_business_account") return [];
  const values: ChangeValue[] = [];
  for (const entry of asArray(payload["entry"])) {
    for (const change of asArray(asRecord(entry)?.["changes"])) {
      const record = asRecord(change);
      if (!record || asString(record["field"]) !== field) continue;
      const value = asRecord(record["value"]);
      if (!value) continue;
      const profileNames = new Map<string, string>();
      for (const c of asArray(value["contacts"])) {
        const contact = asRecord(c);
        const waId = asString(contact?.["wa_id"]);
        const name = asString(asRecord(contact?.["profile"])?.["name"]);
        if (waId && name) profileNames.set(waId, name);
      }
      values.push({
        value,
        phoneNumberId: asString(asRecord(value["metadata"])?.["phone_number_id"]) || undefined,
        profileNames,
      });
    }
  }
  return values;
}

const MEDIA_KINDS = new Set(["image", "video", "document", "sticker", "audio", "voice"]);

function parseMessage(message: Rec, cv: ChangeValue): InboundMessage | null {
  const from = asString(message["from"]);
  const id = asString(message["id"]);
  // The id is REQUIRED: one POST can carry several messages, so a content-hash
  // fallback would key them alike and dedupe would swallow all but the first.
  if (!from || !id) return null;

  const type = asString(message["type"]);
  const block = asRecord(message[type]);
  const msg: InboundMessage = {
    from,
    id,
    kind: "unsupported",
    timestamp: asUnixSeconds(message["timestamp"]),
    text: "",
    contextMessageId: asString(asRecord(message["context"])?.["id"]) || undefined,
    profileName: cv.profileNames.get(from),
    phoneNumberId: cv.phoneNumberId,
    raw: message,
  };

  if (type === "text") {
    msg.kind = "text";
    msg.text = asString(block?.["body"]);
  } else if (MEDIA_KINDS.has(type)) {
    const media = mediaOf(block);
    if (!media) return msg; // malformed media block: keep it visible as "unsupported"
    msg.kind = (type === "voice" ? "audio" : type) as InboundKind;
    msg.media = msg.kind === "audio" ? { ...media, filename: media.filename ?? "media.ogg" } : media;
    msg.text = asString(block?.["caption"]); // audio and stickers have none
  } else if (type === "interactive") {
    const reply = asRecord(block?.["button_reply"]) ?? asRecord(block?.["list_reply"]);
    msg.kind = "interactive";
    msg.reply = { id: asString(reply?.["id"]), title: asString(reply?.["title"]) };
    msg.text = msg.reply.title;
  } else if (type === "button") {
    // A quick-reply tap on a TEMPLATE. Same idea, different block.
    msg.kind = "button";
    msg.reply = { id: asString(block?.["payload"]), title: asString(block?.["text"]) };
    msg.text = msg.reply.title;
  } else if (type === "location") {
    const lat = asNumber(block?.["latitude"]);
    const lng = asNumber(block?.["longitude"]);
    if (lat !== undefined && lng !== undefined) {
      msg.kind = "location";
      msg.location = {
        latitude: lat,
        longitude: lng,
        name: asString(block?.["name"]) || undefined,
        address: asString(block?.["address"]) || undefined,
      };
    }
  } else if (type === "reaction") {
    msg.kind = "reaction";
    msg.reaction = { messageId: asString(block?.["message_id"]), emoji: asString(block?.["emoji"]) };
  } else if (type === "order") {
    // A cart from a WhatsApp catalog. Never drop this silently: it is a customer's order.
    msg.kind = "order";
    msg.orderItemCount = asArray(block?.["product_items"]).length;
    msg.text = asString(block?.["text"]);
  } else if (type === "contacts") {
    msg.kind = "contacts";
  }
  // Anything else ("unsupported", "system", "unknown", ...) stays "unsupported" with `raw` intact.
  return msg;
}

/**
 * Everything one webhook POST carried: inbound messages in the order Meta
 * listed them, delivery receipts for what you sent, and account errors.
 *
 * Statuses arrive on the SAME URL and far outnumber messages. Don't skip the
 * `failed` ones: a send Meta accepted (HTTP 200) and then could not deliver —
 * typically 131047, outside the 24h window — shows up nowhere else.
 */
export function parseWebhook(payload: unknown): ParsedWebhook {
  const root = asRecord(payload);
  const out: ParsedWebhook = { messages: [], statuses: [], errors: [] };
  if (!root) return out;

  for (const cv of changeValues(root, "messages")) {
    for (const raw of asArray(cv.value["messages"])) {
      const record = asRecord(raw);
      const parsed = record ? parseMessage(record, cv) : null;
      if (parsed) out.messages.push(parsed);
    }
    for (const raw of asArray(cv.value["statuses"])) {
      const s = asRecord(raw);
      if (!s) continue;
      const error = asRecord(asArray(s["errors"])[0]);
      const status: StatusUpdate = {
        messageId: asString(s["id"]),
        status: asString(s["status"]),
        recipient: asString(s["recipient_id"]),
        timestamp: asUnixSeconds(s["timestamp"]),
        phoneNumberId: cv.phoneNumberId,
      };
      if (error) status.error = errorOf(error);
      out.statuses.push(status);
    }
    for (const raw of asArray(cv.value["errors"])) {
      const e = asRecord(raw);
      if (e) out.errors.push(errorOf(e));
    }
  }
  return out;
}

function errorOf(error: Rec): { code?: number; title: string; detail: string } {
  return {
    code: asNumber(error["code"]),
    title: asString(error["title"]) || asString(error["message"]),
    detail:
      asString(asRecord(error["error_data"])?.["details"]) ||
      asString(error["message"]) ||
      asString(error["title"]),
  };
}
