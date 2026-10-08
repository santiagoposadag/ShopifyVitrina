/** Credentials and endpoint for one WhatsApp Business phone number. */
export interface CloudApiConfig {
  /** The phone number ID from the Meta panel — NOT the phone number itself. */
  phoneNumberId: string;
  /**
   * A System User token. The 24h token shown under "API setup" is for a first
   * curl only: a deployment running on it fails every send the next day.
   */
  accessToken: string;
  /** Defaults to "v23.0". */
  graphVersion?: string;
  /** Defaults to "https://graph.facebook.com". Override only in tests. */
  graphBaseUrl?: string;
  /** Meta's CDN answers 403 to a download with no User-Agent. Defaults to "whatsapp-cloud-client/1.0". */
  userAgent?: string;
}

/** A media attachment on an inbound message. */
export interface InboundMedia {
  /**
   * Meta's media id, NOT a URL. The URL it resolves to expires in ~5 minutes,
   * so the id is what you store and the URL is resolved at download time
   * (see WhatsAppCloudClient.downloadMedia).
   */
  id: string;
  mimeType?: string;
  /** Only documents carry a real name; for other media it is synthesised from the mime type. */
  filename?: string;
  sha256?: string;
}

export type InboundKind =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "contacts"
  | "interactive"
  | "button"
  | "reaction"
  | "order"
  | "unsupported";

/** One inbound message, flattened out of Meta's webhook payload. */
export interface InboundMessage {
  /** The sender's wa_id (digits only, no "+"). This is also who you reply to. */
  from: string;
  /** The wamid. REQUIRED: it is the only dedupe key that survives a POST carrying several messages. */
  id: string;
  /** Meta's raw `type`, normalised ("voice" becomes "audio"). */
  kind: InboundKind;
  /**
   * When WhatsApp says the person sent it, in unix seconds. Meta does NOT
   * guarantee webhook ordering, so order by this rather than by arrival when
   * order matters (e.g. a burst of photos). Second resolution: ties are real.
   */
  timestamp?: number;
  /** Body for text; caption for image/video/document; empty otherwise. */
  text: string;
  media?: InboundMedia;
  /** A tap on an interactive button/list (`interactive`) or a template quick reply (`button`). */
  reply?: { id: string; title: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  reaction?: { messageId: string; emoji: string };
  /** Item count of a cart sent from a WhatsApp catalog. */
  orderItemCount?: number;
  /** The wamid this message quotes, when the person replied to a specific message. */
  contextMessageId?: string;
  /** The sender's WhatsApp profile name, from `value.contacts[]`, when present. */
  profileName?: string;
  /** The phone number id that RECEIVED it — lets one webhook serve several numbers. */
  phoneNumberId?: string;
  /** The untouched message object, for anything this parser does not flatten. */
  raw: Record<string, unknown>;
}

/** A delivery receipt for a message WE sent. */
export interface StatusUpdate {
  /** The wamid returned when the message was sent. */
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed" | (string & {});
  recipient: string;
  timestamp?: number;
  /** Present only on `failed`: the ONLY place a send Meta accepted and then could not deliver shows up. */
  error?: { code?: number; title: string; detail: string };
  phoneNumberId?: string;
}

/** Everything one webhook POST carried. */
export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
  /** Account-level errors from `value.errors[]`. */
  errors: { code?: number; title: string; detail: string }[];
}

/** One approved template, filled in. */
export interface TemplateMessage {
  /** The approved template's name, exactly as Meta has it. */
  name: string;
  /** The approved language code, e.g. "es". A template exists PER language. */
  language: string;
  /**
   * The body's {{1}}, {{2}}, … IN ORDER — parameters are positional.
   * Each must be non-empty and free of newlines, tabs and long runs of spaces:
   * Meta rejects the SEND (code 132012), not the template. See templateParam.
   */
  bodyParams?: string[];
  /**
   * What is appended to a dynamic URL button's base. THE SUFFIX ALONE: Meta
   * stores the base with the approved template and concatenates, so a full URL
   * here produces the origin twice.
   */
  buttonUrlSuffix?: string;
  /** Which button the suffix belongs to. Defaults to 0. */
  buttonIndex?: number;
}

/** What Graph answers to a successful POST /messages. */
export interface SendResult {
  /** The wamid of each message sent, in order. Match these against StatusUpdate.messageId. */
  messageIds: string[];
}
