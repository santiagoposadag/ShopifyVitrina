/**
 * How an owner asks for the admin console, over WhatsApp.
 *
 * ITS OWN MODULE FOR THE REASON agent/echo.ts IS: `index.ts` runs `main()` on
 * import, so anything defined there can only be tested by booting a server. The
 * matching rule below is the part most worth a test — it decides whether a
 * message is answered with a live credential — so it lives where a test can
 * reach it.
 *
 * IT IS DELIBERATELY NOT A TOOL. A model that decides when to mint a credential
 * is a model that can be talked into minting one, and the credential would land
 * in `conversation_messages` — readable from the very console it opens, so one
 * leaked session could mint its own successors forever. The intercept in
 * index.ts runs this BEFORE any agent does, against a phone the `assignments`
 * table says is an owner.
 */

/**
 * The exact words that mean "send me the panel".
 *
 * EXACT MATCH ON THE WHOLE MESSAGE, never a substring. An owner writing "abre
 * el panel de la camisa negra" is talking about a product, and a substring rule
 * would answer them with a credential instead. Requiring the whole coalesced
 * batch to be one of these also means a burst carrying a photo can never
 * trigger it, since the batch text then contains a photo line as well.
 *
 * A SMALL SET, because every entry is a word an owner can no longer use as an
 * ordinary message. "panel" and "consola" are already borderline for a store
 * that sells furniture; anything more generic would start eating real
 * conversations.
 */
export const ADMIN_LINK_REQUESTS: ReadonlySet<string> = new Set([
  "panel",
  "admin",
  "consola",
  "panel admin",
  "acceso admin",
]);

/**
 * What is WRITTEN DOWN in place of the link.
 *
 * The link itself is sent straight to the channel and deliberately never
 * recorded: it is a live credential, and `conversation_messages` is readable
 * from the console it opens. But recording NOTHING would reproduce DEUDA #9
 * exactly — the record would show the owner asking and no answer, which is
 * indistinguishable from a message that was never processed. So the record gets
 * the fact without the secret.
 */
export const ADMIN_LINK_RECORDED_PLACEHOLDER =
  "🔐 (enlace de acceso al panel enviado por WhatsApp; no se guarda en el historial)";

/**
 * Is this whole message a request for the admin link?
 *
 * Lowercased, stripped of accents and of anything that is not a letter, digit
 * or space, then collapsed — so "Panel!", "PANEL" and " panel " are one word
 * while "el panel de control" is not. Accents go because a phone keyboard
 * produces both spellings and an owner should not have to know which one we
 * happened to store.
 */
export function isAdminLinkRequest(text: string): boolean {
  const normalised = text
    .toLowerCase()
    .normalize("NFD")
    // Unicode combining marks: what NFD split the accents into.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return ADMIN_LINK_REQUESTS.has(normalised);
}

/**
 * What the owner actually receives: the link, and what it costs them to lose it.
 *
 * The two deadlines are stated because they are the whole security model of
 * this delivery channel, and because an owner who does not know the link dies
 * in minutes is an owner who lets it sit in their chat.
 */
export function buildAdminLinkMessage(
  link: string,
  ttl: { claimMinutes: number; sessionHours: number },
): string {
  return [
    "🔐 Tu acceso al panel de administración:",
    "",
    link,
    "",
    `Ábrelo en los próximos ${ttl.claimMinutes} minutos o deja de servir; una vez abierto dura ${ttl.sessionHours} horas.`,
    "No lo reenvíes a nadie: da acceso a todas las conversaciones con clientes.",
  ].join("\n");
}
