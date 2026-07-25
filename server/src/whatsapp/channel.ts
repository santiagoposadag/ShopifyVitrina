/**
 * The seam between the message pipeline and WhatsApp.
 *
 * Everything downstream of the webhook — batcher, queue, agent — talks to this
 * interface and never to an HTTP client. BridgeChannel is the only
 * implementation, and the interface still earns its place: it is what lets the
 * whole pipeline be exercised with a plain object, no HTTP and no paired device
 * anywhere in the tests.
 *
 * The surface is deliberately narrow. Interactive buttons and list messages are
 * absent on purpose rather than unimplemented: they are a Cloud API feature that
 * a linked-device client cannot render on consumer WhatsApp, so promising them
 * here would be promising something the transport cannot keep.
 */
export interface WhatsAppChannel {
  /**
   * Deliver a plain-text reply. Outbound is text-only by design: a product's
   * photos live on its storefront page and the assistant relays that link.
   */
  sendText(to: string, body: string): Promise<void>;

  /**
   * Fetch one inbound media file by the reference its own webhook produced.
   *
   * `ref` rather than `url`: the bridge decrypts media itself and hands over a
   * path in its staging directory. The name stays neutral because the value is
   * whatever the transport produced, and only the transport knows how to
   * resolve it — or how to validate it, which it MUST.
   *
   * `signal` carries the caller's deadline and implementations MUST honour it:
   * this runs inside the webhook request, and the bridge's outbox is strictly
   * sequential, so a stalled read holds up every message behind it.
   */
  downloadMedia(ref: string, signal?: AbortSignal): Promise<Buffer>;

  /**
   * Release whatever the transport is holding for a ref we will NOT download.
   *
   * The bridge has already written a decrypted file to disk by the time we see
   * it, and customers' photos are never stored — so without this, every customer
   * photo would leak onto the volume forever. Optional because a transport that
   * holds nothing on our behalf has nothing to release.
   *
   * Implementations must not throw: failing to tidy up is a logged warning, not
   * a reason to lose the message.
   */
  releaseMedia?(ref: string): Promise<void>;
}
