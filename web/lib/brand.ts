export const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME?.trim() || "Alberto Posada Bienes Raíces";

/**
 * WhatsApp number for wa.me deep links, sanitized to bare digits (wa.me rejects
 * '+', spaces, or dashes). Empty when unconfigured.
 */
export const WHATSAPP_NUMBER = (process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? "").replace(/[^\d]/g, "");

/** Whether a usable WhatsApp number is configured. */
export const HAS_WHATSAPP_NUMBER = WHATSAPP_NUMBER.length > 0;

/** Build a wa.me deep link with an optional prefilled message, or null if unconfigured. */
export function whatsappLink(message?: string): string | null {
  if (!HAS_WHATSAPP_NUMBER) return null;
  const base = `https://wa.me/${WHATSAPP_NUMBER}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}
