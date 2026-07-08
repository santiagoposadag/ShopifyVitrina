import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import type { KapsoClient } from "./kapso.js";
import { saveMedia } from "./media.js";
import { addPendingMedia, markProcessed } from "./repo.js";
import type { PerPhoneQueue } from "./queue.js";
import type { TurnContext } from "./types.js";

export const SIGNATURE_HEADER = "x-webhook-signature";
export const IDEMPOTENCY_HEADER = "x-idempotency-key";

// Total wall-clock budget for downloading inbound media during a single webhook
// request. Kept well under Kapso's 10s ACK deadline so the response never waits
// on an unbounded network call. Shared across all media in one request.
export const MEDIA_DOWNLOAD_BUDGET_MS = 6000;

/**
 * Verify a Kapso webhook HMAC-SHA256 signature against the RAW request body.
 * Constant-time comparison. Returns false on any malformed input.
 *
 * NOTE: Kapso docs express the signed content as JSON.stringify(payload); for
 * requests Kapso sends, that equals the raw body bytes we receive, so we sign
 * the raw body (the robust choice — re-serializing could reorder keys).
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  // Accept either a bare hex digest or a "sha256=" prefixed one.
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface BatchEnvelope {
  batch?: boolean;
  data?: unknown[];
}

/**
 * Normalize a webhook body into a flat list of event objects. Handles both a
 * single event and the batch envelope ({ batch: true, data: [...] }).
 */
export function normalizeEvents(payload: unknown): Record<string, unknown>[] {
  if (payload === null || typeof payload !== "object") return [];
  const envelope = payload as BatchEnvelope;
  if (envelope.batch === true && Array.isArray(envelope.data)) {
    return envelope.data.filter(
      (e): e is Record<string, unknown> => typeof e === "object" && e !== null,
    );
  }
  return [payload as Record<string, unknown>];
}

export interface InboundMessage {
  from: string;
  kind: "text" | "image" | "interactive" | "other";
  /** WhatsApp message id (wamid...), when present — used for per-event dedupe. */
  id?: string;
  /** Text to feed the agent (button title, caption, or body). */
  agentText: string;
  media?: { url: string; filename?: string; contentType?: string };
}

/**
 * Stable per-event dedupe key. Prefers the WhatsApp message id; when absent,
 * falls back to a hash of the event content. This makes retries idempotent even
 * when the request-level x-idempotency-key header is missing or rotates.
 */
export function stableEventKey(event: Record<string, unknown>, messageId?: string): string {
  if (messageId) return `msg:${messageId}`;
  return `evt:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

/**
 * Extract an inbound WhatsApp message from a single event. Returns null for
 * events that are not inbound received messages (status updates, contacts...).
 */
export function extractInbound(event: Record<string, unknown>): InboundMessage | null {
  // The message may sit at event.data.message, event.message, or event itself.
  const data = asRecord(event["data"]);
  const message =
    asRecord(event["message"]) ??
    asRecord(data?.["message"]) ??
    (event["type"] && event["from"] ? event : undefined);
  const msg = asRecord(message);
  if (!msg) return null;

  const kapso = asRecord(msg["kapso"]);
  if (kapso && typeof kapso["direction"] === "string" && kapso["direction"] !== "inbound") {
    return null;
  }

  const from = typeof msg["from"] === "string" ? (msg["from"] as string) : undefined;
  if (!from) return null;

  const id = typeof msg["id"] === "string" ? (msg["id"] as string) : undefined;
  const type = typeof msg["type"] === "string" ? (msg["type"] as string) : "other";

  // Media (image and other media types carry kapso.media_data.url).
  const mediaData = asRecord(kapso?.["media_data"]);
  const mediaUrl =
    (typeof mediaData?.["url"] === "string" && (mediaData["url"] as string)) ||
    (typeof kapso?.["media_url"] === "string" && (kapso["media_url"] as string)) ||
    undefined;

  if (type === "text") {
    const text = asRecord(msg["text"]);
    const body = typeof text?.["body"] === "string" ? (text["body"] as string) : "";
    return { from, id, kind: "text", agentText: body };
  }

  if (type === "interactive") {
    const interactive = asRecord(msg["interactive"]);
    const buttonReply = asRecord(interactive?.["button_reply"]);
    const listReply = asRecord(interactive?.["list_reply"]);
    const reply = buttonReply ?? listReply;
    const title = typeof reply?.["title"] === "string" ? (reply["title"] as string) : "";
    const label = typeof reply?.["id"] === "string" ? ` (id ${reply["id"] as string})` : "";
    return { from, id, kind: "interactive", agentText: `Seleccionó: ${title}${label}` };
  }

  if (mediaUrl) {
    const image = asRecord(msg["image"]);
    const caption =
      (typeof image?.["caption"] === "string" && (image["caption"] as string)) || "";
    const filename =
      typeof mediaData?.["filename"] === "string" ? (mediaData["filename"] as string) : undefined;
    const contentType =
      typeof mediaData?.["content_type"] === "string"
        ? (mediaData["content_type"] as string)
        : undefined;
    return {
      from,
      id,
      kind: "image",
      agentText: caption || "(El usuario envió una foto)",
      media: { url: mediaUrl, filename, contentType },
    };
  }

  return { from, id, kind: "other", agentText: "" };
}

const rawBodies = new WeakMap<FastifyRequest, string>();

export interface WebhookDeps {
  config: Config;
  db: DB;
  kapso: KapsoClient;
  queue: PerPhoneQueue;
  /** Async worker invoked (via the queue) once per inbound message. */
  onMessage: (ctx: TurnContext, text: string) => Promise<void>;
  /** Maps a phone number to its role (owner vs customer). */
  roleFor: (phone: string) => TurnContext["role"];
}

export function registerWebhook(app: FastifyInstance, deps: WebhookDeps): void {
  const { config, db, kapso, queue, onMessage, roleFor } = deps;

  // Keep the raw body so we can verify the signature over exact bytes.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      const raw = typeof body === "string" ? body : body.toString("utf8");
      rawBodies.set(req, raw);
      try {
        done(null, raw.length > 0 ? JSON.parse(raw) : {});
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.post("/webhook", async (request, reply) => {
    const rawBody = rawBodies.get(request) ?? "";
    const signature = request.headers[SIGNATURE_HEADER];
    const signatureValue = Array.isArray(signature) ? signature[0] : signature;

    if (!verifySignature(rawBody, signatureValue, config.kapsoWebhookSecret)) {
      return reply.code(401).send({ error: "invalid_signature" });
    }

    // Idempotency: drop duplicates that Kapso retries at 10/40/90s.
    const idemHeader = request.headers[IDEMPOTENCY_HEADER];
    const idemKey = Array.isArray(idemHeader) ? idemHeader[0] : idemHeader;
    if (idemKey) {
      const fresh = markProcessed(db, idemKey);
      if (!fresh) return reply.code(200).send({ status: "duplicate" });
    }

    const events = normalizeEvents(request.body);

    // Shared budget so the ACK never blocks on unbounded media downloads, even
    // across a batch. Media tokens expire in ~4 min, so we still download now.
    const mediaDeadline = AbortSignal.timeout(MEDIA_DOWNLOAD_BUDGET_MS);

    for (const event of events) {
      const inbound = extractInbound(event);
      if (!inbound) continue;

      // Per-event dedupe with a stable fallback key: makes Kapso's 10/40/90s
      // retries idempotent even when the request-level header is absent.
      const dedupeKey = stableEventKey(event, inbound.id);
      if (!markProcessed(db, dedupeKey)) continue;

      const ctx: TurnContext = { phone: inbound.from, role: roleFor(inbound.from) };

      // Persist inbound media ONLY for owners (they ingest listings). Customers'
      // images are acknowledged in the agent context but never stored/served.
      // Download is bounded and non-fatal so a slow fetch cannot delay the ACK.
      if (inbound.media && ctx.role === "owner") {
        try {
          const buffer = await kapso.downloadMedia(inbound.media.url, mediaDeadline);
          const saved = await saveMedia(config, buffer, {
            mimeType: inbound.media.contentType,
            suggestedName: inbound.media.filename,
          });
          addPendingMedia(db, {
            phone: inbound.from,
            file_path: saved.filePath,
            public_path: saved.publicPath,
            caption: inbound.agentText,
          });
        } catch (err) {
          // Timeout, network failure, or a rejected host: record and move on.
          request.log.warn({ err, phone: inbound.from }, "inbound media not stored");
        }
      }

      if (inbound.agentText.trim().length === 0 && inbound.kind !== "image") continue;

      // Enqueue with per-phone serialization; do NOT await the agent inline.
      void queue.enqueue(ctx.phone, () => onMessage(ctx, inbound.agentText));
    }

    // ACK fast; the agent runs on the async worker.
    return reply.code(200).send({ status: "ok" });
  });
}
