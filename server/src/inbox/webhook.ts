import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { InboxBatcher } from "./batcher.js";
import type { Config } from "../config.js";
import type { DB } from "../data/db.js";
import { extractCloudInbound, extractCloudStatusErrors } from "./cloud.js";
import { extractInbound } from "./whatsmeow.js";
import type { WhatsAppChannel } from "../whatsapp/channel.js";
import { insertInboxMessage, type InboxMediaKind } from "../data/repo.js";
import type { InboundMessage, MessageKind, TurnContext } from "../types.js";

export const SIGNATURE_HEADER = "x-webhook-signature";

/**
 * Meta's signature header. Same construction as the bridge's — HMAC-SHA256 over
 * the raw body — but keyed with the app secret and always "sha256=" prefixed,
 * which verifySignature already accepts.
 */
export const META_SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * Constant-time string compare, for the webhook verification token.
 *
 * Meta's handshake is a plain query-string comparison, and `===` on a secret
 * leaks its prefix through timing the same way a signature check would.
 */
function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

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

  // Defaults to the bridge, so every deployment and test harness that predates
  // the Cloud API keeps its exact behaviour without setting a new variable.
  const provider = config.whatsappProvider ?? "bridge";
  const signatureHeader = provider === "cloud" ? META_SIGNATURE_HEADER : SIGNATURE_HEADER;

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

  // Meta's verification handshake, and the ONLY reason this route is a GET.
  // Meta calls it when the callback URL is first saved and again on every edit;
  // it must echo hub.challenge back as raw text, because a JSON-quoted copy
  // fails the check and the panel simply refuses to save the URL.
  if (provider === "cloud") {
    app.get("/webhook", async (request, reply) => {
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const mode = query["hub.mode"];
      const token = query["hub.verify_token"] ?? "";
      const challenge = query["hub.challenge"] ?? "";
      if (mode === "subscribe" && secretEquals(token, config.whatsappVerifyToken)) {
        return reply.code(200).type("text/plain").send(challenge);
      }
      request.log.warn({ mode }, "rejected a webhook verification attempt");
      return reply.code(403).send({ error: "verification_failed" });
    });
  }

  app.post("/webhook", async (request, reply) => {
    const rawBody = rawBodies.get(request) ?? "";
    const signature = request.headers[signatureHeader];
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
    // A no-op on the Cloud API, which stages nothing on our disk.
    const release = async (ref: string | undefined): Promise<void> => {
      if (!ref) return;
      try {
        await channel.releaseMedia?.(ref);
      } catch (err) {
        // Tidying up is never worth the ACK or the message.
        request.log.warn({ err, ref }, "could not release unused inbound media");
      }
    };

    if (provider === "cloud") {
      // A send Meta ACCEPTED and then could not deliver surfaces ONLY here: the
      // POST that carried the reply already returned 200, so without this line
      // a reply that fell outside the 24h window is invisible.
      for (const failure of extractCloudStatusErrors(event)) {
        request.log.warn(
          {
            recipient: failure.recipient,
            code: failure.code,
            detail: failure.detail,
          },
          "WhatsApp could not deliver a message we sent",
        );
      }
    }

    // One POST carries at most one message from the bridge, and any number from
    // the Cloud API. Handled sequentially, in the order Meta listed them: this
    // is a photo burst's order, and the first photo becomes the cover.
    const inboundItems =
      provider === "cloud"
        ? extractCloudInbound(event)
        : ((item) => (item ? [item] : []))(extractInbound(event));

    for (const inbound of inboundItems) {
      // No agent-worthy content and no media side effects: nothing to do.
      if (inbound.agentText.trim().length === 0 && !hasContentWithoutText(inbound)) {
        await release(inbound.media?.ref);
        continue;
      }

      // A voice note is persisted as 'text', not 'media'. Its transcript is a line
      // the person spoke, not a caption under a photo count — and the media
      // debounce window exists for photo bursts arriving in waves, which would
      // make a single voice note wait 45s for an answer.
      const persistedKind: MessageKind =
        inbound.media && inbound.kind !== "audio" ? "media" : "text";

      // WHICH files this deployment actually wants. Audio, for both roles: a
      // customer's voice note is the customer's question. Photos, for owners
      // only: they ingest listings, while a customer's image is acknowledged in
      // the agent context and never stored.
      //
      // Decided HERE rather than on the worker because it is a pure role check
      // with no I/O, and a reference we have already decided to drop has no
      // business being persisted as work for someone else to discover.
      const wantedMedia: InboxMediaKind | null = !inbound.media
        ? null
        : inbound.kind === "audio"
          ? "audio"
          : roleFor(inbound.from) === "owner"
            ? "photo"
            : null;

      // Persist BEFORE processing: the UNIQUE dedupe key absorbs the transport's
      // retries — the bridge's outbox and Meta's own redelivery alike — and a
      // crash before the agent runs is replayed on boot instead of silently
      // losing the message (at-least-once).
      //
      // The file itself is NOT fetched here, only referenced. Downloading it
      // would put one or two network round trips per message inside the request,
      // and both transports punish a slow handler: Meta retries the webhook and
      // eventually disables the subscription, and the bridge's outbox is strictly
      // sequential, so every message behind this one waits. The reference is
      // durable in the row, so the worker can resolve it after the ACK without
      // the file becoming lost work (see batcher.resolveMedia).
      const row = insertInboxMessage(db, {
        dedupe_key: stableEventKey(event, inbound.id),
        phone: inbound.from,
        agent_text: inbound.agentText,
        // Stored, not inferred later: a captioned photo's text IS the caption,
        // so nothing downstream could tell it apart from someone typing.
        kind: persistedKind,
        media_ref: wantedMedia ? inbound.media!.ref : null,
        media_kind: wantedMedia,
        media_mime: inbound.media?.contentType ?? null,
        media_name: inbound.media?.filename ?? null,
        media_sent_at: inbound.sentAt ?? null,
      });
      if (!row) {
        // Redelivery of an event we already handled. The first copy's row still
        // OWNS this reference and has not fetched it yet, so releasing it here
        // would delete the file that row is waiting for — which is exactly what
        // the old download-in-the-handler ordering made safe, and no longer is.
        // A genuinely orphaned staging file is swept (bridge.ts sweepStagedMedia).
        continue;
      }

      // A file we are not keeping still has to be let go of, or it sits on the
      // bridge's staging volume forever — nothing else deletes it. A local unlink,
      // and a no-op on the Cloud API, which stages nothing on our disk.
      if (inbound.media && !wantedMedia) await release(inbound.media.ref);

      // Hand the row to the batcher; it debounces and runs the agent on the async
      // worker. Only timer state is touched here, so the ACK stays fast. The media
      // flag comes from the parsed event — a photo burst needs a much longer
      // window than chat (see InboxBatcher).
      batcher.schedule(row.phone, persistedKind);
    }

    return reply.code(200).send({ status: "ok" });
  });
}
