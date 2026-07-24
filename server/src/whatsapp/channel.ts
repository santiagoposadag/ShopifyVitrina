/**
 * The provider-agnostic seam between the message pipeline and WhatsApp.
 *
 * Everything downstream of the webhook — batcher, queue, agent — talks to this
 * interface and never to a provider's client, so adding a second channel is a
 * new implementation rather than an edit to the pipeline.
 *
 * The surface is deliberately two methods wide. KapsoClient also carries
 * sendInteractiveButtons, and it stays there rather than moving here: nothing
 * calls it, and interactive buttons are a Cloud API feature that a linked-device
 * client cannot render on consumer WhatsApp. Promoting it would promise every
 * future provider something only one of them can keep.
 */
export interface WhatsAppChannel {
  /**
   * Deliver a plain-text reply. Outbound is text-only by design: a product's
   * photos live on its storefront page and the assistant relays that link.
   */
  sendText(to: string, body: string): Promise<void>;

  /**
   * Fetch one inbound media file by the reference this provider's own webhook
   * produced.
   *
   * The reference is opaque and provider-shaped — hence `ref`, not `url`. Kapso
   * yields a short-lived signed URL, so its implementation validates the host
   * before attaching credentials; a provider that decrypts media itself would
   * hand back a local path and validate nothing.
   *
   * `signal` carries the caller's deadline and implementations MUST honour it:
   * this runs inside the webhook request, where an unbounded fetch costs the
   * ACK (see inbox/media-download.ts).
   */
  downloadMedia(ref: string, signal?: AbortSignal): Promise<Buffer>;
}
