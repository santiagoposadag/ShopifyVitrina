import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { InboxBatcher } from "./batcher.js";
import type { Config } from "../config.js";
import type { DB } from "../data/db.js";
import { extractInbound } from "./whatsmeow.js";
import type { WhatsAppChannel } from "../whatsapp/channel.js";
import { saveAudio, saveMedia } from "../whatsapp/media.js";
import { addPendingMedia, insertInboxMessage } from "../data/repo.js";
import type { InboundMessage, MessageKind, TurnContext } from "../types.js";

export const SIGNATURE_HEADER = "x-webhook-signature";

/**
 * Ceiling on reading one staged media file.
 *
 * Generous because it should never be reached: the bridge decrypts media itself
 * and hands over a path on a volume this process already has mounted, so this is
 * a local read, not a network fetch. It exists so a wedged filesystem cannot hold
 * the request open forever.
 */
export const MEDIA_READ_TIMEOUT_MS = 5000;

/**
 * Verify a webhook HMAC-SHA256 signature against the RAW request body.
 * Constant-time comparison. Returns false on any malformed input.
 *
 * The bridge signs the exact bytes it sends (bridge/delivery.go), so this must
 * hash the raw body rather than a re-serialised copy — re-encoding could reorder
 * keys and every signature would fail.
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

/**
 * Stable per-event dedupe key. Prefers the WhatsApp message id; when absent,
 * falls back to a hash of the event content. This is what makes the bridge's
 * outbox safe to retry: a redelivered event lands on the same key and the UNIQUE
 * constraint absorbs it.
 */
export function stableEventKey(event: Record<string, unknown>, messageId?: string): string {
  if (messageId) return `msg:${messageId}`;
  return `evt:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
}

const rawBodies = new WeakMap<FastifyRequest, string>();

/**
 * Read one of the owner's inbound photos and record it as pending, ready for
 * attach_pending_photos. Never throws: an unreadable file must not cost the ACK
 * or the rest of the listing.
 *
 * One photo per request, because the bridge delivers one event per POST in
 * strict order — which is also what preserves photo order, and photo order is
 * the listing's order: the first photo becomes the storefront's cover.
 */
async function storeInboundMedia(
  item: InboundMessage,
  deps: {
    config: Config;
    db: DB;
    channel: WhatsAppChannel;
    log: Pick<FastifyRequest["log"], "warn">;
  },
): Promise<void> {
  try {
    const buffer = await deps.channel.downloadMedia(
      item.media!.ref,
      AbortSignal.timeout(MEDIA_READ_TIMEOUT_MS),
    );
    const saved = await saveMedia(deps.config, buffer, {
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
    // The message still reaches the agent — it just arrives without its image.
    deps.log.warn({ err, phone: item.from }, "inbound media not stored");
  }
}

/**
 * Read an inbound voice note off the staging volume and keep it until the
 * worker can transcribe it. Returns the stored path, or null if nothing usable
 * arrived — never throws, for the same reason storeInboundMedia does not.
 *
 * Transcription itself is NOT done here. The bridge's outbox is strictly
 * sequential, so every message behind this one waits for the handler to return;
 * a local read off a shared volume is affordable, a call to a speech API is
 * not. That work belongs to the batcher (see batcher.ts).
 *
 * Runs for BOTH roles, unlike photos. A customer's voice note is the customer's
 * actual question — dropping it is the bug this whole path exists to fix — but
 * it must never reach pending_media, because attach_pending_photos consumes
 * every unattached row for a phone with no type filter and would publish it to
 * the storefront as a product photo.
 */
async function storeInboundAudio(
  item: InboundMessage,
  deps: {
    config: Config;
    channel: WhatsAppChannel;
    log: Pick<FastifyRequest["log"], "warn">;
  },
): Promise<string | null> {
  try {
    const buffer = await deps.channel.downloadMedia(
      item.media!.ref,
      AbortSignal.timeout(MEDIA_READ_TIMEOUT_MS),
    );
    if (buffer.byteLength > deps.config.transcriptionMaxBytes) {
      deps.log.warn(
        { phone: item.from, bytes: buffer.byteLength },
        "inbound audio too large to transcribe; dropping the audio",
      );
      return null;
    }
    const saved = await saveAudio(deps.config, buffer, { suggestedName: item.media!.filename });
    return saved.filePath;
  } catch (err) {
    // The message still reaches the agent, and the batcher's fallback turns it
    // into a reply asking for text — which beats the silence this replaced.
    deps.log.warn({ err, phone: item.from }, "inbound audio not stored");
    return null;
  }
}

/**
 * Whether this message is worth persisting despite carrying no text.
 *
 * Both cases are messages whose CONTENT is not words: an uncaptioned photo, and
 * a voice note whose transcript does not exist yet. Everything else with an
 * empty body is an event kind we do not handle, and settling those quietly is
 * deliberate. This is a predicate rather than a chain of `kind !== ...` because
 * that chain is exactly what silently swallowed the first voice note.
 */
function hasContentWithoutText(item: InboundMessage): boolean {
  return item.kind === "image" || item.kind === "audio";
}

export interface WebhookDeps {
  config: Config;
  db: DB;
  channel: WhatsAppChannel;
  /** Coalesces each phone's burst into a single agent turn, off the ACK path. */
  batcher: InboxBatcher;
  /** Maps a phone number to its role (owner vs customer). */
  roleFor: (phone: string) => TurnContext["role"];
}

export function registerWebhook(app: FastifyInstance, deps: WebhookDeps): void {
  const { config, db, channel, batcher, roleFor } = deps;

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

    if (!verifySignature(rawBody, signatureValue, config.webhookSecret)) {
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const event =
      typeof request.body === "object" && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};

    // A file the bridge already wrote and we decide not to keep has to be
    // released, or it sits on the volume forever — nothing else deletes it.
    const release = async (ref: string | undefined): Promise<void> => {
      if (!ref) return;
      try {
        await channel.releaseMedia?.(ref);
      } catch (err) {
        // Tidying up is never worth the ACK or the message.
        request.log.warn({ err, ref }, "could not release unused inbound media");
      }
    };

    const inbound = extractInbound(event);
    // No agent-worthy content and no media side effects: nothing to do.
    if (!inbound || (inbound.agentText.trim().length === 0 && !hasContentWithoutText(inbound))) {
      await release(inbound?.media?.ref);
      return reply.code(200).send({ status: "ok" });
    }

    // Audio is stored BEFORE the insert, because the row has to carry the path
    // the worker will transcribe from. That ordering can orphan a file when the
    // insert turns out to be a redelivery, so the dedupe branch below unlinks it.
    const audioPath =
      inbound.kind === "audio"
        ? await storeInboundAudio(inbound, { config, channel, log: request.log })
        : null;

    // A voice note is persisted as 'text', not 'media'. Its transcript is a line
    // the person spoke, not a caption under a photo count — and the media
    // debounce window exists for photo bursts arriving in waves, which would
    // make a single voice note wait 45s for an answer.
    const persistedKind: MessageKind =
      inbound.media && inbound.kind !== "audio" ? "media" : "text";

    // Persist BEFORE processing: the UNIQUE dedupe key absorbs the bridge's
    // outbox retries, and a crash before the agent runs is replayed on boot
    // instead of silently losing the message (at-least-once).
    const row = insertInboxMessage(db, {
      dedupe_key: stableEventKey(event, inbound.id),
      phone: inbound.from,
      agent_text: inbound.agentText,
      // Stored, not inferred later: a captioned photo's text IS the caption,
      // so nothing downstream could tell it apart from someone typing.
      kind: persistedKind,
      audio_path: audioPath,
    });
    if (!row) {
      // Redelivery of an event we already handled; its media went with the first
      // pass, so this copy is released rather than left behind.
      await release(inbound.media?.ref);
      if (audioPath) {
        // The first pass already stored this note and will transcribe it. This
        // copy would otherwise sit in the audio directory forever, unreferenced.
        await unlink(audioPath).catch(() => undefined);
      }
      return reply.code(200).send({ status: "ok" });
    }

    // Persist inbound PHOTOS only for owners (they ingest listings). Customers'
    // images are acknowledged in the agent context but never stored or served —
    // and "never stored" still means a file to clean up. Audio took its own path
    // above, for both roles, and deliberately never reaches pending_media.
    if (inbound.media && inbound.kind !== "audio") {
      if (roleFor(inbound.from) === "owner") {
        await storeInboundMedia(inbound, { config, db, channel, log: request.log });
      } else {
        await release(inbound.media.ref);
      }
    }

    // Hand the row to the batcher; it debounces and runs the agent on the async
    // worker. Only timer state is touched here, so the ACK stays fast. The media
    // flag comes from the parsed event — a photo burst needs a much longer
    // window than chat (see InboxBatcher).
    batcher.schedule(row.phone, persistedKind);

    return reply.code(200).send({ status: "ok" });
  });
}
