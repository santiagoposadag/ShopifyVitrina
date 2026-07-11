import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import type { KapsoClient } from "./kapso.js";
import { saveMedia } from "./media.js";
import {
  addPendingMedia,
  getInboxRow,
  insertInboxMessage,
  listReplayableInbox,
  markInboxDone,
  markInboxFailed,
  markInboxProcessing,
} from "./repo.js";
import type { PerPhoneQueue } from "./queue.js";
import type { TurnContext } from "./types.js";

export const SIGNATURE_HEADER = "x-webhook-signature";

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

/**
 * Process one persisted inbox row through the agent worker. The status
 * transitions are what make delivery at-least-once: a crash leaves the row
 * 'pending' or 'processing', and replayPendingInbox re-enqueues it on boot.
 * Never throws — a failure marks the row 'failed' and is logged.
 */
async function processInboxRow(
  deps: WebhookDeps,
  log: FastifyBaseLogger,
  id: number,
): Promise<void> {
  const row = getInboxRow(deps.db, id);
  if (!row || row.status === "done") return;
  markInboxProcessing(deps.db, id);
  const ctx: TurnContext = { phone: row.phone, role: deps.roleFor(row.phone) };
  try {
    await deps.onMessage(ctx, row.agent_text);
    markInboxDone(deps.db, id);
  } catch (err) {
    markInboxFailed(deps.db, id);
    log.error({ err, phone: row.phone, inboxId: id }, "inbox message failed");
  }
}

/**
 * Re-enqueue inbox rows a previous process accepted but never finished. Call
 * once on boot, BEFORE listening, so replayed messages enter each phone's
 * queue ahead of new webhook traffic and per-phone ordering holds.
 */
export function replayPendingInbox(log: FastifyBaseLogger, deps: WebhookDeps): number {
  const rows = listReplayableInbox(deps.db);
  for (const row of rows) {
    void deps.queue.enqueue(row.phone, () => processInboxRow(deps, log, row.id));
  }
  if (rows.length > 0) log.info(`Replaying ${rows.length} unfinished inbox message(s)`);
  return rows.length;
}

export function registerWebhook(app: FastifyInstance, deps: WebhookDeps): void {
  const { config, db, kapso, queue, roleFor } = deps;

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

    // Shared budget so the ACK never blocks on unbounded media downloads, even
    // across a batch. Media tokens expire in ~4 min, so we still download now.
    const mediaDeadline = AbortSignal.timeout(MEDIA_DOWNLOAD_BUDGET_MS);

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
      });
      if (!row) continue; // Retry of an event we already persisted.

      // Persist inbound media ONLY for owners (they ingest listings). Customers'
      // images are acknowledged in the agent context but never stored/served.
      // Download is bounded and non-fatal so a slow fetch cannot delay the ACK.
      if (inbound.media && roleFor(inbound.from) === "owner") {
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

      // Enqueue with per-phone serialization; do NOT await the agent inline.
      void queue.enqueue(row.phone, () => processInboxRow(deps, request.log, row.id));
    }

    // ACK fast; the agent runs on the async worker.
    return reply.code(200).send({ status: "ok" });
  });
}
