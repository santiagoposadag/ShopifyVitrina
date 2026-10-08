import type { CloudApiConfig, SendResult, TemplateMessage } from "./types.js";

/**
 * Client for Meta's WhatsApp Business Cloud API.
 *
 *   Send:  POST {graphBase}/{version}/{phoneNumberId}/messages
 *   Auth:  Authorization: Bearer <system user token>
 *   Body:  { messaging_product: "whatsapp", ... }
 *
 * Every failure THROWS a WhatsAppApiError; what a failure means (retry the
 * turn, fall back to a template, give up) is the caller's decision, never the
 * transport's.
 *
 * `fetchImpl` is injectable so the whole client is testable against a plain
 * function, with no network and no mocking library.
 */

/** WhatsApp rejects a text body over 4096 characters outright (error 131009). */
export const MAX_TEXT_BODY_CHARS = 4096;

/** Graph hosts that may receive the access token. See isAllowedMediaHost. */
const META_MEDIA_HOSTS = ["graph.facebook.com", "lookaside.fbsbx.com"];
const META_MEDIA_SUFFIXES = [".fbsbx.com", ".fbcdn.net", ".facebook.com"];

/**
 * Only Meta hosts may receive the access token.
 *
 * The download URL is read out of a Graph response and the token attached to
 * it can send WhatsApp messages as the business. Validate before you
 * dereference: a response that ever names another host must not get the token.
 */
export function isAllowedMediaHost(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    // A token on a plaintext hop is a leaked token.
    if (parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (META_MEDIA_HOSTS.includes(host)) return true;
  // The leading dot matters: "evil-fbcdn.net" ends with "fbcdn.net" and is not Meta.
  return META_MEDIA_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Cut a body into WhatsApp-sized pieces, preferring paragraph then line breaks
 * so a split never lands mid-sentence.
 *
 * Returns [""] for an empty body rather than [], so a caller sending an empty
 * reply fails loudly at Meta instead of silently sending nothing.
 */
export function splitText(body: string, limit = MAX_TEXT_BODY_CHARS): string[] {
  if (body.length <= limit) return [body];
  const chunks: string[] = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const end = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Make a value safe to use as a template parameter.
 *
 * Meta rejects the SEND (not the template) when a parameter is empty or
 * carries newlines, tabs or long runs of spaces — so the failure is a
 * notification that silently never went out. Free text typed into WhatsApp
 * routinely has all of these.
 */
export function templateParam(value: string | null | undefined, maxChars = 1000, missing = "—"): string {
  const collapsed = (value ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return missing;
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

/**
 * Error codes worth naming, because the fix is a decision and not a retry.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
export const NAMED_ERRORS: Record<number, string> = {
  131047:
    "outside the 24h customer service window — free-form messages are not allowed, only an approved template",
  132001: "no approved template with that name and language — the language code must match the approved one exactly",
  132000: "the template's parameter count does not match what was approved",
  132012: "a template parameter was rejected: no empty values, newlines, tabs or long runs of spaces",
  131026: "the recipient cannot receive this message (no WhatsApp account, or unreachable)",
  131009: "a parameter was rejected (a text body over 4096 chars is the usual cause)",
  131056: "too many messages to the same recipient in a short time (pair rate limit)",
  130429: "throughput limit reached for this phone number",
  100: "invalid parameter — check the phone number id and the request shape",
  190: "the access token is invalid or expired — regenerate the system user token",
};

/** A Graph API failure, with Meta's error code when the body carried one. */
export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "WhatsAppApiError";
  }

  /** True when only an approved template can reach this recipient now. */
  get outsideServiceWindow(): boolean {
    return this.code === 131047;
  }
}

interface MetaErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
  };
}

async function toApiError(action: string, res: Response): Promise<WhatsAppApiError> {
  const raw = await res.text().catch(() => "");
  let err: MetaErrorBody["error"];
  try {
    err = (JSON.parse(raw) as MetaErrorBody).error;
  } catch {
    err = undefined;
  }
  if (!err) return new WhatsAppApiError(`${action} failed — HTTP ${res.status}: ${raw.slice(0, 500)}`, res.status);
  const named = err.code !== undefined ? NAMED_ERRORS[err.code] : undefined;
  const detail = err.error_data?.details ?? err.message ?? "";
  return new WhatsAppApiError(
    `${action} failed — HTTP ${res.status} code ${err.code ?? "?"}${named ? ` (${named})` : ""}: ${detail}`,
    res.status,
    err.code,
    err.error_subcode,
    detail,
  );
}

/** Digits only. Built here and never taken verbatim from a payload. */
export function normalizeRecipient(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export class WhatsAppCloudClient {
  private readonly graphBase: string;
  private readonly messagesUrl: string;
  private readonly authHeader: string;
  private readonly userAgent: string;

  constructor(
    config: CloudApiConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const base = (config.graphBaseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "");
    this.graphBase = `${base}/${config.graphVersion ?? "v23.0"}`;
    this.messagesUrl = `${this.graphBase}/${config.phoneNumberId}/messages`;
    this.authHeader = `Bearer ${config.accessToken}`;
    this.userAgent = config.userAgent ?? "whatsapp-cloud-client/1.0";
  }

  /** POST one message object to /messages. The building block for every send below. */
  async sendMessage(payload: Record<string, unknown>, action = "send"): Promise<string> {
    const res = await this.fetchImpl(this.messagesUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.authHeader },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    if (!res.ok) throw await toApiError(action, res);
    const body = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[] };
    return body.messages?.[0]?.id ?? "";
  }

  private recipientOf(to: string): string {
    const recipient = normalizeRecipient(to);
    if (!recipient) throw new Error(`Refusing to send to an unusable recipient: "${to}"`);
    return recipient;
  }

  /**
   * Send free-form text. Only legal within 24h of the person's last message
   * (otherwise code 131047, see WhatsAppApiError.outsideServiceWindow).
   *
   * Bodies over 4096 chars are split and sent SEQUENTIALLY — they are pieces
   * of one answer, and a concurrent send would let them arrive shuffled. Note
   * each piece is billed as its own message.
   */
  async sendText(
    to: string,
    body: string,
    opts: { previewUrl?: boolean; replyTo?: string } = {},
  ): Promise<SendResult> {
    const recipient = this.recipientOf(to);
    const messageIds: string[] = [];
    for (const [i, chunk] of splitText(body).entries()) {
      messageIds.push(
        await this.sendMessage(
          {
            recipient_type: "individual",
            to: recipient,
            type: "text",
            // Quote only from the first piece: the rest continue it.
            ...(opts.replyTo && i === 0 ? { context: { message_id: opts.replyTo } } : {}),
            text: { preview_url: opts.previewUrl ?? false, body: chunk },
          },
          "send text",
        ),
      );
    }
    return { messageIds };
  }

  /**
   * Send an APPROVED template — the only thing Meta accepts outside the 24h
   * window. One request, never chunked: the body is fixed at approval.
   */
  async sendTemplate(to: string, template: TemplateMessage): Promise<SendResult> {
    const recipient = this.recipientOf(to);
    const components: unknown[] = [];
    if (template.bodyParams && template.bodyParams.length > 0) {
      components.push({
        type: "body",
        parameters: template.bodyParams.map((text) => ({ type: "text", text })),
      });
    }
    if (template.buttonUrlSuffix !== undefined) {
      components.push({
        type: "button",
        sub_type: "url",
        index: String(template.buttonIndex ?? 0),
        parameters: [{ type: "text", text: template.buttonUrlSuffix }],
      });
    }
    const id = await this.sendMessage(
      {
        recipient_type: "individual",
        to: recipient,
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language },
          ...(components.length > 0 ? { components } : {}),
        },
      },
      `send template ${template.name}/${template.language}`,
    );
    return { messageIds: [id] };
  }

  /** Mark an inbound message as read (blue ticks). Optional nicety; never needed for delivery. */
  async markAsRead(messageId: string): Promise<void> {
    await this.sendMessage({ status: "read", message_id: messageId }, "mark as read");
  }

  /**
   * Download one inbound media file by its media id.
   *
   * Two steps, and the order matters: the URL step one returns expires ~5
   * minutes later, so it is resolved at download time and never cached. The
   * media id stays valid much longer, which is why the id is what you persist.
   *
   * Do NOT call this inside the webhook handler: it is two network round trips
   * per file and one POST can carry a whole burst. ACK first, download on a
   * worker. `signal` lets the caller bound it.
   */
  async downloadMedia(mediaId: string, signal?: AbortSignal): Promise<{ data: Buffer; mimeType?: string }> {
    if (!mediaId) throw new Error("Refusing to download media without an id");

    const lookup = await this.fetchImpl(`${this.graphBase}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: this.authHeader },
      signal,
    });
    if (!lookup.ok) throw await toApiError("media lookup", lookup);
    const meta = (await lookup.json().catch(() => ({}))) as { url?: string; mime_type?: string };
    const url = typeof meta.url === "string" ? meta.url : "";
    if (!isAllowedMediaHost(url)) {
      throw new Error(`Refusing to download media from untrusted host: ${url || "(no url)"}`);
    }

    const download = await this.fetchImpl(url, {
      headers: { Authorization: this.authHeader, "User-Agent": this.userAgent },
      signal,
    });
    if (!download.ok) {
      throw new WhatsAppApiError(`media download failed (${download.status}) for media ${mediaId}`, download.status);
    }
    return { data: Buffer.from(await download.arrayBuffer()), mimeType: meta.mime_type };
  }
}
