import type { Config } from "../config.js";
import { normalizePhone } from "../config.js";
import type { WhatsAppChannel } from "./channel.js";

/**
 * Client for Meta's official WhatsApp Business Cloud API.
 *
 * Send:  POST https://graph.facebook.com/<version>/<phoneNumberId>/messages
 * Auth:  Authorization: Bearer <system user token>
 * Body:  { messaging_product: "whatsapp", ... }
 *
 * This is the same wire format the retired Kapso client spoke (Kapso was a 1:1
 * proxy of this API), which is why the shape below will look familiar — the
 * difference is the credential header and that media now takes TWO round trips
 * instead of one signed URL.
 *
 * Outbound is text-only, exactly as the bridge is: a product's photos live on
 * its storefront page and the assistant relays that link. Adding sendImage back
 * should be a decision, not a method that happens to be within reach.
 */

/** Graph hosts that may receive our access token. See isAllowedMediaHost. */
const META_MEDIA_HOSTS = ["graph.facebook.com", "lookaside.fbsbx.com"];
const META_MEDIA_SUFFIXES = [".fbsbx.com", ".fbcdn.net", ".facebook.com"];

/**
 * WhatsApp rejects a text body over 4096 characters outright. The bridge
 * answered such a reply with a 400 and the batcher retried it forever; Meta
 * does the same with error 131009. Splitting is the only option that delivers
 * the whole answer — see splitForWhatsApp.
 */
export const MAX_TEXT_BODY_CHARS = 4096;

/**
 * Two network round trips (resolve the media URL, then download it) instead of
 * a local file read, so the bridge's 5s ceiling is far too tight here. Still
 * bounded: this runs inside the webhook request.
 */
const MEDIA_FETCH_TIMEOUT_MS = 15_000;

/**
 * Only Meta hosts may receive our access token.
 *
 * The download URL is read out of a Graph API response and we attach a
 * permanent system-user token to it — the credential that can send WhatsApp
 * messages as the business. A response that ever names another host must not
 * be dereferenced with that token attached. Same reasoning as the retired
 * Kapso client's host check, and as isAllowedMediaPath on the bridge side:
 * validate before you dereference.
 *
 * Exported for tests.
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
  // The leading dot matters: "evil-fbcdn.net" is a suffix match on "fbcdn.net"
  // and is emphatically not Meta.
  return META_MEDIA_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Cut a reply into WhatsApp-sized pieces, preferring paragraph then line
 * breaks so a split never lands mid-sentence.
 *
 * Returns [""] for an empty body rather than [], so callers keep failing loudly
 * on an empty reply instead of silently sending nothing.
 *
 * Exported for tests.
 */
export function splitForWhatsApp(body: string, limit = MAX_TEXT_BODY_CHARS): string[] {
  if (body.length <= limit) return [body];
  const chunks: string[] = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer a paragraph break, then any line break, then a hard cut.
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const end = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
  };
}

/**
 * Errors worth naming in a log line, because the fix is a decision and not a
 * retry. 131047 is the one this deployment will actually hit: a free-form
 * reply is only legal within 24 hours of the person's last message, and after
 * that only an approved template goes through.
 */
const NAMED_ERRORS: Record<number, string> = {
  131047:
    "outside the 24h customer service window — free-form replies are not allowed, only an approved template",
  131026: "the recipient cannot receive this message (no WhatsApp account, or it is unreachable)",
  131009: "a parameter was rejected (a text body over 4096 chars is the usual cause)",
  100: "invalid parameter — check WHATSAPP_PHONE_NUMBER_ID and the request shape",
  190: "the access token is invalid or expired — regenerate the system user token",
};

function describeMetaError(status: number, raw: string): string {
  let parsed: MetaErrorBody | undefined;
  try {
    parsed = JSON.parse(raw) as MetaErrorBody;
  } catch {
    return `HTTP ${status}: ${raw.slice(0, 500)}`;
  }
  const err = parsed?.error;
  if (!err) return `HTTP ${status}: ${raw.slice(0, 500)}`;
  const named = err.code !== undefined ? NAMED_ERRORS[err.code] : undefined;
  const detail = err.error_data?.details ?? err.message ?? "";
  return `HTTP ${status} code ${err.code ?? "?"}${named ? ` (${named})` : ""}: ${detail}`;
}

export type CloudApiConfig = Pick<
  Config,
  "whatsappPhoneNumberId" | "whatsappAccessToken" | "whatsappGraphBaseUrl" | "whatsappGraphVersion"
>;

export class CloudApiChannel implements WhatsAppChannel {
  private readonly messagesUrl: string;
  private readonly graphBase: string;
  private readonly token: string;

  /** The webhook reads this instead of assuming a local file read. */
  readonly mediaTimeoutMs = MEDIA_FETCH_TIMEOUT_MS;

  constructor(
    config: CloudApiConfig,
    // Injectable for the same reason ShopifyClient takes one: the whole channel
    // is then testable against a plain function, with no network and no casts.
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.graphBase = `${config.whatsappGraphBaseUrl}/${config.whatsappGraphVersion}`;
    this.messagesUrl = `${this.graphBase}/${config.whatsappPhoneNumberId}/messages`;
    this.token = config.whatsappAccessToken;
  }

  private get authHeader(): string {
    return `Bearer ${this.token}`;
  }

  async sendText(to: string, body: string): Promise<void> {
    // Digits only, built here and never taken from an incoming payload — the
    // same rule the bridge enforces before constructing a JID.
    const recipient = normalizePhone(to);
    if (!recipient) throw new Error(`Refusing to send to an unusable recipient: "${to}"`);

    // Sequential on purpose: these are the pieces of ONE answer, and a
    // concurrent map would let them arrive shuffled.
    for (const chunk of splitForWhatsApp(body)) {
      const res = await this.fetchImpl(this.messagesUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.authHeader,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "text",
          // Link previews are off: the assistant sends storefront and checkout
          // links, and an unfurled card pushes the actual reply off screen.
          text: { preview_url: false, body: chunk },
        }),
      });
      if (!res.ok) {
        const raw = await res.text().catch(() => "");
        // Throwing reaches the batcher, which retries the whole turn with backoff.
        throw new Error(`Cloud API send failed — ${describeMetaError(res.status, raw)}`);
      }
    }
  }

  /**
   * Download one inbound media file. `ref` is Meta's media id, not a URL.
   *
   * Two steps, and the order matters: the URL that step one hands back expires
   * about five minutes later, so it must be resolved at download time and never
   * cached from the webhook payload. The media id itself stays valid for far
   * longer, which is why the id is what travels through our pipeline.
   */
  async downloadMedia(ref: string, signal?: AbortSignal): Promise<Buffer> {
    if (!ref) throw new Error("Refusing to download media without an id");

    const lookup = await this.fetchImpl(`${this.graphBase}/${encodeURIComponent(ref)}`, {
      headers: { Authorization: this.authHeader },
      signal,
    });
    if (!lookup.ok) {
      const raw = await lookup.text().catch(() => "");
      throw new Error(`Cloud API media lookup failed — ${describeMetaError(lookup.status, raw)}`);
    }
    const meta = (await lookup.json().catch(() => ({}))) as { url?: string };
    const url = typeof meta.url === "string" ? meta.url : "";
    if (!isAllowedMediaHost(url)) {
      // Never attach the access token to a host we do not trust.
      throw new Error(`Refusing to download media from untrusted host: ${url || "(no url)"}`);
    }

    const download = await this.fetchImpl(url, {
      headers: {
        Authorization: this.authHeader,
        // Meta's CDN answers 403 to a request with no User-Agent.
        "User-Agent": "vitrina/1.0",
      },
      signal,
    });
    if (!download.ok) {
      throw new Error(`Cloud API media download failed (${download.status}) for media ${ref}`);
    }
    return Buffer.from(await download.arrayBuffer());
  }
}
