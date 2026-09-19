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
 * IT CARRIES NO LINK, deliberately. Attaching one would mint a session nobody
 * asked for, on every lead, and put a live credential into a notification that
 * may arrive while the phone is on a table. The owner writes "panel" when they
 * are ready, which costs them one message and keeps the credential tied to a
 * deliberate act.
 */
export function buildLeadNotice(lead: Lead): string {
  // The customer's own words carry the detail; this line is only what KIND of
  // promise was made, so the owner can tell a restock ping from a real
  // negotiation without opening anything.
  const kind =
    lead.type === "back_in_stock"
      ? "quiere que le avisemos cuando vuelva a haber"
      : lead.type === "inquiry"
        ? "preguntó por algo que no tenemos"
        : "pidió que lo contactaran";

  const lines = [`🔔 Nuevo lead #${lead.id}: un cliente ${kind}.`, `Teléfono: ${lead.phone}`];
  if (lead.product_code) lines.push(`Producto: ${lead.product_code}`);
  if (lead.name) lines.push(`Nombre: ${lead.name}`);
  if (lead.note) lines.push(`Nota: ${lead.note}`);
  lines.push('Escribe "panel" para abrirlo y seguir tú la conversación.');
  return lines.join("\n");
}
