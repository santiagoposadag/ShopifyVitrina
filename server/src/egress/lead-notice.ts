import type { TemplateMessage } from "../whatsapp/channel.js";
import type { Lead } from "../types.js";

/**
 * How an owner is told that the assistant escalated something.
 *
 * ITS OWN MODULE FOR THE REASON agent/echo.ts IS: `index.ts` runs `main()` on
 * import, so text defined there can only be exercised by booting a server —
 * and this is user-visible copy that an owner reads on their phone, at the
 * moment they most need to act.
 *
 * WHY IT EXISTS AT ALL: the sales agent tells the customer that a team member
 * will follow up, and before this it then wrote a row nothing ever read. The
 * promise depended on the owner remembering to ask. This is what makes the
 * promise true.
 *
 * TWO SHAPES FOR ONE MESSAGE, and the difference is the 24-hour window. A
 * TEMPLATE is the only thing Meta delivers outside it, and it is also the only
 * shape that can carry a BUTTON — which is the whole point here, because the
 * button opens the conversation. Free-form text is the fallback: it works
 * inside the window, on a transport with no templates (the bridge), and on a
 * deployment that has not approved one yet.
 */

/**
 * The stand-in for a value the customer never gave.
 *
 * TEMPLATE PARAMETERS MAY NOT BE EMPTY — Meta rejects the SEND, not the
 * template — and `product_code` and `note` are nullable by design. An em dash
 * reads as "nothing here" to a person and satisfies the rule.
 */
const MISSING = "—";

/**
 * How much of a free-text note travels in a notification.
 *
 * A notification is a nudge, not the record: the full note is in the panel, one
 * tap away. Capping also keeps a pasted wall of text from pushing the phone
 * number and the button off a phone screen.
 */
const MAX_NOTE_CHARS = 280;

/**
 * What KIND of promise was made, in one clause.
 *
 * Shared by both shapes so the template and the fallback cannot drift into
 * describing the same lead differently — which is exactly the kind of
 * difference nobody notices until an owner compares two notifications.
 */
export function leadKindPhrase(lead: Lead): string {
  if (lead.type === "back_in_stock") return "quiere que le avisemos cuando vuelva a haber";
  if (lead.type === "inquiry") return "preguntó por algo que no tenemos";
  return "pidió que lo contactaran";
}

/**
 * Make a value safe to send as a template parameter.
 *
 * META REJECTS THE SEND, NOT THE TEMPLATE, for an empty parameter or one
 * carrying newlines, tabs or long runs of spaces — and a customer's own note is
 * free text typed into WhatsApp, so it routinely has all of them. The failure
 * would arrive as a notification that silently never went out, which is the
 * exact hole this whole feature exists to close.
 *
 * So: collapse every run of whitespace to one space, trim, cap, and fall back
 * to a visible stand-in rather than an empty string.
 */
export function templateParam(value: string | null | undefined, maxChars = 1000): string {
  const collapsed = (value ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return MISSING;
  if (collapsed.length <= maxChars) return collapsed;
  // The ellipsis is part of the parameter, so the reader can tell a cut from a
  // note that simply ended.
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

/**
 * The approved template, filled in.
 *
 * THE ORDER IS THE APPROVED ORDER and cannot be rearranged here: Meta matches
 * parameters positionally against the body it approved, and a swap produces a
 * notification naming the wrong field with no error anywhere. The body is:
 *
 *   Un cliente {{1}}.
 *   Teléfono: {{2}}
 *   Producto: {{3}}
 *   Nota: {{4}}
 *
 * `landingCode` is the URL button's suffix — the code alone, never a full URL,
 * because Meta concatenates it onto the base it stored at approval.
 */
export function buildLeadTemplate(input: {
  lead: Lead;
  name: string;
  language: string;
  landingCode: string;
}): TemplateMessage {
  return {
    name: input.name,
    language: input.language,
    bodyParams: [
      templateParam(leadKindPhrase(input.lead)),
      templateParam(input.lead.phone),
      templateParam(input.lead.product_code),
      templateParam(input.lead.note, MAX_NOTE_CHARS),
    ],
    buttonUrlSuffix: input.landingCode,
  };
}

/**
 * The free-form fallback.
 *
 * IT CARRIES THE LINK AS TEXT, which the first version of this notice
 * deliberately did not. That refusal was right when no link existed: attaching
 * one would have minted a session nobody asked for on every lead. It is wrong
 * now — the template path mints a landing code for the button anyway, so
 * omitting it from the fallback would mean the person gets a worse message
 * precisely when the better one could not be delivered.
 *
 * `landingUrl` stays optional because the fallback also runs where no code was
 * minted at all: a transport with no templates, or a deployment that turned the
 * template off. There the owner writes "panel", as they did before.
 */
export function buildLeadNotice(lead: Lead, landingUrl?: string): string {
  const lines = [
    `🔔 Nuevo lead #${lead.id}: un cliente ${leadKindPhrase(lead)}.`,
    `Teléfono: ${lead.phone}`,
  ];
  if (lead.product_code) lines.push(`Producto: ${lead.product_code}`);
  if (lead.name) lines.push(`Nombre: ${lead.name}`);
  if (lead.note) lines.push(`Nota: ${lead.note}`);
  lines.push(
    landingUrl
      ? `Abre la conversación para responderle tú mismo:\n${landingUrl}`
      : 'Escribe "panel" para abrirlo y seguir tú la conversación.',
  );
  return lines.join("\n");
}
