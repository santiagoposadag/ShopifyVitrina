import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { InboxBatcher } from "./batcher.js";
import type { Config } from "../config.js";
import type { DB } from "../data/db.js";
import { downloadInboundMedia, type MediaDownloadBudget } from "./media-download.js";
import type { KapsoClient } from "../whatsapp/kapso.js";
import { saveMedia } from "../whatsapp/media.js";
import { addPendingMedia, insertInboxMessage } from "../data/repo.js";
import type { TurnContext } from "../types.js";

export const SIGNATURE_HEADER = "x-webhook-signature";

/**
 * Time budget for downloading inbound media during a single webhook request.
 *
 * `totalMs` is wall-clock for the whole burst and stays well under Kapso's 10s
 * ACK deadline, so the response never waits on an unbounded network call.
 * `perDownloadMs` bounds each file separately: with only a shared budget, the
 * first slow photo drained it and every other photo in the burst failed without
 * being attempted. See downloadInboundMedia.
 */
export const MEDIA_DOWNLOAD_BUDGET: MediaDownloadBudget = {
  totalMs: 6000,
  perDownloadMs: 5000,
};

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
      // The caption and nothing else. An uncaptioned photo carries no text: the
      // row's `kind` is what says a photo arrived, and buildBatchText is what
      // announces it. Substituting the placeholder here made a photo's text
      // indistinguishable from a caption the owner actually wrote — it was then
      // stored as the photo's caption, and a captioned photo, having no
      // placeholder, stopped counting as a photo at all.
      agentText: caption,
      media: { url: mediaUrl, filename, contentType },
    };
  }

  return { from, id, kind: "other", agentText: "" };
}

const rawBodies = new WeakMap<FastifyRequest, string>();

/**
 * Download an owner's inbound photos and record them as pending, ready for
 * attach_pending_photos. Never throws: one unreachable file must not cost the
 * ACK or the rest of the listing.
 *
 * Rows are written in arrival order even though the fetches race, because photo
 * order is the listing's order — the first photo becomes the storefront's cover.
 */
async function storeInboundMedia(
  items: InboundMessage[],
  deps: {
    config: Config;
    db: DB;
    kapso: KapsoClient;
    log: Pick<FastifyRequest["log"], "warn">;
  },
): Promise<void> {
  if (items.length === 0) return;

  const results = await downloadInboundMedia(
    items,
    (item, signal) => deps.kapso.downloadMedia(item.media!.url, signal),
    MEDIA_DOWNLOAD_BUDGET,
  );

  for (const [index, result] of results.entries()) {
    const item = items[index]!;
    if (!result.ok) {
      // Timeout, network failure, or a rejected host: record and move on. The
      // message still reaches the agent — it just arrives without its image.
      deps.log.warn({ err: result.error, phone: item.from }, "inbound media not stored");
      continue;
    }
    try {
      const saved = await saveMedia(deps.config, result.buffer, {
        mimeType: item.media!.contentType,
        suggestedName: item.media!.filename,
      });
      addPendingMedia(deps.db, {
        phone: item.from,
        file_path: saved.filePath,
        public_path: saved.publicPath,
        // Only what the owner actually wrote about this photo, or nothing.
        caption: item.agentText.trim() || null,
      });
    } catch (err) {
      deps.log.warn({ err, phone: item.from }, "inbound media not stored");
    }
  }
}

export interface WebhookDeps {
  config: Config;
  db: DB;
  kapso: KapsoClient;
  /** Coalesces each phone's burst into a single agent turn, off the ACK path. */
  batcher: InboxBatcher;
  /** Maps a phone number to its role (owner vs customer). */
  roleFor: (phone: string) => TurnContext["role"];
}

export function registerWebhook(app: FastifyInstance, deps: WebhookDeps): void {
  const { config, db, kapso, batcher, roleFor } = deps;

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

    const events = normalizeEvents(request.body);

    // Media to fetch once every row is persisted. Collected rather than
    // downloaded inline so the whole burst can be fetched concurrently under one
    // budget; downloading inside this loop meant photo N+1 waited on photo N.
    const toDownload: InboundMessage[] = [];

    for (const event of events) {
      const inbound = extractInbound(event);
      if (!inbound) continue;
      // No agent-worthy content and no media side effects: skip entirely.
      if (inbound.agentText.trim().length === 0 && inbound.kind !== "image") continue;

      // Persist BEFORE processing: the UNIQUE dedupe key absorbs Kapso's
      // 10/40/90s retries, and a crash before the agent runs is replayed on
      // boot instead of silently losing the message (at-least-once).
      const row = insertInboxMessage(db, {
        dedupe_key: stableEventKey(event, inbound.id),
        phone: inbound.from,
        agent_text: inbound.agentText,
        // Stored, not inferred later: a captioned photo's text IS the caption,
        // so nothing downstream could tell it apart from someone typing.
        kind: inbound.media ? "media" : "text",
      });
      if (!row) continue; // Retry of an event we already persisted.

      // Persist inbound media ONLY for owners (they ingest listings). Customers'
      // images are acknowledged in the agent context but never stored/served.
      if (inbound.media && roleFor(inbound.from) === "owner") toDownload.push(inbound);

      // Hand the row to the batcher; it debounces and runs the agent on the
      // async worker. Only the timer state is touched here, so the ACK stays
      // fast. The media flag comes from the parsed event — a photo burst needs
      // a much longer window than chat (see InboxBatcher).
      batcher.schedule(row.phone, inbound.media ? "media" : "text");
    }

    await storeInboundMedia(toDownload, { config, db, kapso, log: request.log });

    // ACK fast; the agent runs on the async worker.
    return reply.code(200).send({ status: "ok" });
  });
}
