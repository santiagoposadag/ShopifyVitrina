/**
 * Best-effort extraction of structured fields from the emoji-formatted,
 * conversational listing messages a seller sends over WhatsApp.
 *
 * This is deliberately simple and deterministic (no model call): the owner
 * agent uses Claude for the hard parsing at runtime, but the seed script and
 * tests need a predictable extractor for the two example properties.
 *
 * Correction handling: when a field (code, price) appears multiple times across
 * the messages, the LAST occurrence wins — mirroring how a seller corrects an
 * earlier value in a later message ("El código 008 no es... Ya es código 1912").
 */

export interface ParsedListing {
  code?: string;
  price?: number;
  area_m2?: number;
}

/** Parse a Colombian-formatted amount like "1.150.000.000" -> 1150000000. */
function parseAmount(raw: string): number {
  return Number.parseInt(raw.replace(/\./g, ""), 10);
}

export function parseListing(messages: string[]): ParsedListing {
  const text = messages.join("\n");

  // Code: "Código 916", "Codigo\n1912". Take the LAST match (corrections win).
  let code: string | undefined;
  const codeRe = /c[oó]digo\s*:?\s*\n?\s*(\d{2,})/gi;
  for (let m = codeRe.exec(text); m !== null; m = codeRe.exec(text)) {
    if (m[1]) code = m[1];
  }

  // Price: amounts with at least millions magnitude (two dot-separated groups
  // of 3), e.g. 670.000.000 or 1.150.000.000. Admin fees like 270.000 (one
  // group) are excluded. Take the largest such amount.
  let price: number | undefined;
  const priceRe = /\b(\d{1,3}(?:\.\d{3}){2,})\b/g;
  for (let m = priceRe.exec(text); m !== null; m = priceRe.exec(text)) {
    if (m[1]) {
      const value = parseAmount(m[1]);
      if (price === undefined || value > price) price = value;
    }
  }

  // Area: "230 metros cuadrados", "78m²", "78 m2".
  let area_m2: number | undefined;
  const areaRe = /(\d{2,4})\s*(?:m²|m2|metros\s+cuadrados)/i;
  const areaMatch = areaRe.exec(text);
  if (areaMatch && areaMatch[1]) area_m2 = Number.parseInt(areaMatch[1], 10);

  return { code, price, area_m2 };
}
