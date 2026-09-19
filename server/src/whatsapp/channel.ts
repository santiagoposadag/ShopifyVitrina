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
   * How long the webhook may spend fetching one inbound media file, when this
   * transport needs longer than a local read.
   *
   * The bridge hands over a path on a shared volume, so its ceiling is small.
   * The Cloud API needs two network round trips for the same file and would
   * time out under that ceiling on every photo — a limit that belongs to the
   * transport, not to the route that calls it.
   */
  readonly mediaTimeoutMs?: number;

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

  /**
   * Deliver an APPROVED template, the only message a transport may send outside
   * the 24-hour customer service window.
   *
   * OPTIONAL BECAUSE IT IS A PROPERTY OF THE TRANSPORT, not a gap. The Cloud API
   * enforces that window and rejects a free-form reply past it with code 131047;
   * the linked-device bridge has no window at all and no notion of a template,
   * so implementing this there would mean faking a concept the transport does
   * not have. A caller checks for the method rather than for a provider name —
   * "can this transport send a template" is the question, and the shape answers
   * it.
   */
  sendTemplate?(to: string, template: TemplateMessage): Promise<void>;
}

/**
 * One approved template, filled in.
 *
 * NAMED AND VERSIONED BY DATA, not by code: the name and language identify a
 * template Meta approved, and neither is ours to invent at runtime. They come
 * from configuration so that renaming an approved template — or approving a
 * second language — is a variable and a restart rather than a deploy.
 */
export interface TemplateMessage {
  /** The approved template's name, exactly as Meta has it. */
  name: string;
  /** The approved language code, e.g. "es". A template exists PER language. */
  language: string;
  /**
   * The body's `{{1}}`, `{{2}}`, … in order.
   *
   * EVERY ONE MUST BE NON-EMPTY and free of newlines, tabs and long runs of
   * spaces — Meta rejects the SEND, not the template, when one is not. The
   * caller sanitises, because only the caller knows what a sensible stand-in
   * for a missing value is.
   */
  bodyParams: string[];
  /**
   * What is appended to the URL button's base, when the template has a dynamic
   * one.
   *
   * THE SUFFIX ALONE, never the whole URL: Meta stores the base with the
   * approved template and concatenates. Sending a full URL here produces a link
   * with the origin twice, which fails as a 404 for the person who taps it and
   * as nothing at all in any log.
   */
  buttonUrlSuffix?: string;
}
