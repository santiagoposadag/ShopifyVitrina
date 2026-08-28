/**
 * The canned reply that stands in for an agent turn while ECHO_MODE is on.
 *
 * This occupies exactly the slot runAgentTurn does, and does none of its work:
 * no Claude call, no Shopify request, no session. It exists so the transport
 * can be proven on its own — webhook signature, inbox persistence, the debounce
 * window, the per-phone queue, the outbound send — before a store and a model
 * are wired in. When all three are new at once, a message that never comes back
 * has three candidate causes and no way to tell them apart.
 *
 * The reply deliberately ECHOES what arrived. That is the diagnostic: it is the
 * only way to see that a burst was coalesced into one turn, that a photo was
 * counted, or that a voice note reached transcription — none of which the
 * outbound leg would reveal on its own.
 */

/**
 * Spanish, like every other user-facing string, and unmistakably a test.
 *
 * Not plausible business answers on purpose: if this mode is ever left on by
 * accident, a real customer must be able to tell at a glance that they are not
 * talking to the store.
 */
export const ECHO_OPENERS = [
  "Llegó tu mensaje.",
  "Recibido, fuerte y claro.",
  "Mensaje recibido correctamente.",
  "Te leo perfecto.",
  "Confirmado: llegó completo.",
  "Recibido sin problemas.",
] as const;

/** Marks every reply as a test, in the first characters the person reads. */
export const ECHO_PREFIX = "🧪 MODO PRUEBA";

/**
 * How much of the received text is quoted back.
 *
 * A 37-photo listing joins into a long prompt, and the point here is to confirm
 * it arrived whole, not to relay it. WhatsApp's own limit is 4096 and the Cloud
 * API channel splits at it, but three screens of quoted text is a worse
 * diagnostic than one.
 */
export const ECHO_MAX_QUOTED = 600;

/**
 * Build the reply for one coalesced burst.
 *
 * `pick` is injectable for the same reason every other collaborator here is:
 * a test asserting on a random opener would either be flaky or have to reach
 * for a global mock.
 */
export function buildEchoReply(
  text: string,
  pick: (upperExclusive: number) => number = (n) => Math.floor(Math.random() * n),
): string {
  const index = Math.min(Math.max(pick(ECHO_OPENERS.length), 0), ECHO_OPENERS.length - 1);
  const opener = ECHO_OPENERS[index]!;

  const trimmed = text.trim();
  // An empty batch never reaches here — the batcher settles those without a
  // turn — but saying so beats quoting nothing and looking broken.
  const quoted =
    trimmed.length === 0
      ? "(sin texto)"
      : trimmed.length > ECHO_MAX_QUOTED
        ? `${trimmed.slice(0, ECHO_MAX_QUOTED)}…`
        : trimmed;

  return `${ECHO_PREFIX} — ${opener}\n\nEsto fue lo que recibí:\n${quoted}`;
}
