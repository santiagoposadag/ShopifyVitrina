import type { Config } from "./config.js";

/**
 * Minimal REST client for Kapso's WhatsApp Cloud API proxy.
 *
 * Base:   POST https://api.kapso.ai/meta/whatsapp/v24.0/{phoneNumberId}/messages
 * Auth:   header  X-API-Key: <KAPSO_API_KEY>
 * Body:   Meta Cloud API format  ({ messaging_product: "whatsapp", ... })
 *
 * Verified against https://docs.kapso.ai/docs/whatsapp/send-messages/* (text,
 * image, buttons). Media download uses the signed url returned on the inbound
 * webhook (message.kapso.media_data.url); token expires ~4 minutes so callers
 * MUST download at webhook receipt, not from the agent job.
 */

const KAPSO_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";

export interface ReplyButton {
  id: string;
  title: string; // WhatsApp caps button titles at 20 chars.
}

/**
 * Only allow media downloads (which carry our X-API-Key) to Kapso hosts. The
 * download URL comes from the webhook payload, so this prevents a spoofed
 * payload from exfiltrating the API key to an attacker-controlled host.
 */
export function isAllowedMediaHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "kapso.ai" || host.endsWith(".kapso.ai");
  } catch {
    return false;
  }
}

export class KapsoClient {
  private readonly apiKey: string;
  private readonly phoneNumberId: string;

  constructor(config: Pick<Config, "kapsoApiKey" | "kapsoPhoneNumberId">) {
    this.apiKey = config.kapsoApiKey;
    this.phoneNumberId = config.kapsoPhoneNumberId;
  }

  private get messagesUrl(): string {
    return `${KAPSO_BASE}/${this.phoneNumberId}/messages`;
  }

  private async post(body: unknown): Promise<unknown> {
    const res = await fetch(this.messagesUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kapso send failed (${res.status}): ${text}`);
    }
    return res.json().catch(() => ({}));
  }

  async sendText(to: string, body: string): Promise<void> {
    await this.post({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    });
  }

  async sendImage(to: string, link: string, caption?: string): Promise<void> {
    await this.post({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: caption ? { link, caption } : { link },
    });
  }

  /** WhatsApp allows at most 3 reply buttons; extra buttons are dropped. */
  async sendInteractiveButtons(
    to: string,
    bodyText: string,
    buttons: ReplyButton[],
  ): Promise<void> {
    await this.post({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  }

  /**
   * Download an inbound media file from its signed url. The url is short-lived
   * (~4 min). We send the API key too; the signed token authorizes it either
   * way but this is harmless and covers both Kapso auth modes.
   */
  async downloadMedia(downloadUrl: string, signal?: AbortSignal): Promise<Buffer> {
    if (!isAllowedMediaHost(downloadUrl)) {
      // Never send the API key to a host we do not trust.
      throw new Error(`Refusing to download media from untrusted host: ${downloadUrl}`);
    }
    const res = await fetch(downloadUrl, {
      headers: { "X-API-Key": this.apiKey },
      signal,
    });
    if (!res.ok) {
      throw new Error(`Kapso media download failed (${res.status}) for ${downloadUrl}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
