import type { ShopifyProduct, ShopifyVariant } from "./types.js";

/**
 * Relevance ranking for the catalog.
 *
 * Shopify's own `products(query:)` is prefix/keyword matching: no accent
 * folding, no tolerance for a typo, and — decisively — no comparable score.
 * Handing the agent raw Shopify hits would silently delete the two things this
 * scorer exists to provide: the `match=NN%` a tool result carries on every
 * line, and the approximate-match warning that keeps the agent from confidently
 * offering something that merely resembles what was asked for.
 *
 * So Shopify stays the source of truth for the FACTS and this stays the source
 * of truth for RELEVANCE, scoring a set fetched through shopify/cache.ts.
 */

/**
 * How much of what was asked for a product must account for to come back at all.
 *
 * A floor rather than a knob the caller tunes per question: the agent decides
 * which survivors to show, but it does not get to widen its own search until
 * something appears. Empty means empty — we have nothing like that.
 */
export const DEFAULT_MIN_SCORE = 0.6;

/** Above this, the text answered the request rather than merely resembling it. */
export const CONFIDENT_MATCH_SCORE = 0.8;

/**
 * Cap on what a CUSTOMER search returns, so a large catalog cannot flood the
 * turn. Deliberately not applied to the owner's report: an inventory answered
 * with 10 of 300 rows reads as the whole inventory, and nothing on screen says
 * otherwise.
 */
export const MAX_SEARCH_RESULTS = 10;

/** Below this length a word is too short for an edit-distance guess to mean anything. */
const FUZZY_MIN_LENGTH = 4;
const FUZZY_MIN_RATIO = 0.8;
const FUZZY_SCORE = 0.8;

/**
 * Spanish function words, plus the words that name the catalog itself.
 *
 * Left in, they would drag every score down by the length of the sentence:
 * "tienes camisetas negras" would cap at 2/3 even against a perfect match.
 * "producto", "talla" and friends are here for the same reason "propiedad" was
 * in the real-estate build — every item is a producto, so the word cannot tell
 * two of them apart, and counting it as a miss punishes the natural way of
 * asking.
 */
const STOPWORDS = new Set([
  "a", "al", "algun", "alguna", "algunas", "alguno", "algunos", "con", "cual", "cuales", "de",
  "del", "el", "en", "es", "esta", "hay", "la", "las", "lo", "los", "me", "mi", "o", "para", "por",
  "que", "se", "si", "sin", "su", "sus", "tenemos", "tiene", "tienen", "tienes", "un", "una",
  "unas", "unos", "y",

  "algo", "articulo", "articulos", "busca", "buscamos", "buscando", "busco", "disponible",
  "disponibles", "necesito", "producto", "productos", "quiero", "venden", "vendes",
]);

/** Lowercase, unaccented, punctuation-free. Applied to BOTH sides of every comparison. */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    // Strip the combining marks NFD just split off. Doing it BEFORE the
    // punctuation pass matters: left in, an accent would become a space and
    // "algodon" would arrive as two words.
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  if (!value) return [];
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/**
 * Every word of a product's text, PLUS every adjacent pair glued together.
 *
 * The pairs are what make word boundaries stop mattering in either direction: a
 * search for "manga larga" finds a product that says "mangalarga", and a search
 * for "mangalarga" finds one that says "Manga Larga" because each token is
 * contained in that single word. Gluing the whole haystack instead would invent
 * matches across unrelated words, so the joins stay pairwise.
 */
function wordsAndPairs(raw: string): string[] {
  const words = normalize(raw).split(" ").filter(Boolean);
  const pairs = words.slice(0, -1).map((word, i) => word + words[i + 1]);
  return [...words, ...pairs];
}

/**
 * The structured facts, said the way a shopper would say them.
 *
 * Nobody asks for "una camiseta" — they ask for "una camiseta negra talla M".
 * Size and colour live in variant options, so without this the words "negra"
 * and "M" are guaranteed misses that drag the product that actually answers the
 * question below the floor.
 */
function variantText(product: ShopifyProduct): string {
  const parts: string[] = [];
  for (const variant of product.variants) {
    for (const option of variant.selectedOptions) {
      // The option NAME ("Talla") is catalog scaffolding; the VALUE ("M") is
      // what someone types. Including both would let "talla" match everything.
      if (option.value && option.value !== "Default Title") parts.push(option.value);
    }
    if (variant.sku) parts.push(variant.sku);
  }
  return [...new Set(parts)].join(" ");
}

function haystackFor(product: ShopifyProduct): string[] {
  return wordsAndPairs(
    [
      product.title,
      product.description,
      product.handle,
      product.productType,
      product.vendor,
      product.tags.join(" "),
      variantText(product),
    ].join(" "),
  );
}

/**
 * Standard Levenshtein, two rows. Only ever runs on single words.
 *
 * Every `?? 0` below is unreachable — both rows are built to length b.length+1
 * and every index is bounded by its loop — but noUncheckedIndexedAccess cannot
 * see that, and a fallback reads better here than an assertion.
 */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitute = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insert = (current[j - 1] ?? 0) + 1;
      const remove = (previous[j] ?? 0) + 1;
      current.push(Math.min(substitute, insert, remove));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** 1 for a contained word, FUZZY_SCORE for a probable typo, 0 for a miss. */
function scoreToken(token: string, haystack: string[]): number {
  // A number is a value, not a word fragment: "talla 38" must not be answered
  // by a price of 380. Exact word only, and never fuzzy — a mistyped number is
  // a different number, not a misspelling.
  if (/^\d+$/.test(token)) return haystack.includes(token) ? 1 : 0;

  if (haystack.some((word) => word.includes(token))) return 1;
  if (token.length < FUZZY_MIN_LENGTH) return 0;

  for (const word of haystack) {
    // A word that differs in length by more than a couple of characters is a
    // different word, not a misspelling — and skipping it keeps the glued pairs
    // from fuzzy-matching short tokens.
    if (Math.abs(word.length - token.length) > 2) continue;
    const ratio = 1 - editDistance(token, word) / Math.max(token.length, word.length);
    if (ratio >= FUZZY_MIN_RATIO) return FUZZY_SCORE;
  }
  return 0;
}

export interface SearchFilters {
  query?: string;
  min_price?: number;
  max_price?: number;
  /** Drop products with nothing in stock. Only meaningful for tracked variants. */
  in_stock_only?: boolean;
  /** Relevance floor, 0..1. Defaults to DEFAULT_MIN_SCORE. */
  min_score?: number;
  /** Cap on results. Uncapped when absent — only the customer search sets one. */
  limit?: number;
}

export interface SearchHit {
  product: ShopifyProduct;
  score: number;
}

/**
 * The lowest variant price, as a number, for COMPARISON only.
 *
 * A float is safe here and only here: the value is compared against a budget
 * and then discarded. Every price the agent ever sees or quotes is the decimal
 * string Shopify returned, which is why ShopifyVariant.price is a string.
 */
function lowestPrice(product: ShopifyProduct): number | null {
  const prices = product.variants
    .map((v) => Number.parseFloat(v.price))
    .filter((n) => Number.isFinite(n));
  return prices.length > 0 ? Math.min(...prices) : null;
}

/**
 * True when THIS variant can be sold right now.
 *
 * An untracked variant always sells: Shopify is not counting it, so a quantity
 * of 0 on it means "unknown", not "sold out".
 */
export function variantSellable(variant: ShopifyVariant): boolean {
  return !variant.inventoryTracked || (variant.inventoryQuantity ?? 0) > 0;
}

/** True when at least one variant can actually be sold right now. */
export function hasStock(product: ShopifyProduct): boolean {
  return product.variants.some(variantSellable);
}

/**
 * Rank an already-fetched set by how much of the request each product answers.
 *
 * Two kinds of filter, deliberately not treated alike:
 *
 * - price and stock EXCLUDE. They are constraints someone stated, not
 *   preferences to weigh: an item at five times the budget is not a partial
 *   match, and one that is sold out cannot be bought at any relevance.
 * - `query` SCORES. It is prose, it arrives however the person happened to say
 *   it, and it should never be the reason a real product goes unmentioned.
 *
 * Kept separate from the fetching so the customer search and the owner's
 * inventory report rank identically — the ONLY difference between them is which
 * products they fetch and how many they keep.
 */
export function rankProducts(products: ShopifyProduct[], filters: SearchFilters): SearchHit[] {
  const tokens = tokenize(filters.query ?? "");
  const minScore = filters.min_score ?? DEFAULT_MIN_SCORE;

  const hits: SearchHit[] = [];
  for (const product of products) {
    const price = lowestPrice(product);
    if (filters.min_price !== undefined && (price ?? 0) < filters.min_price) continue;
    if (filters.max_price !== undefined && (price ?? Number.MAX_SAFE_INTEGER) > filters.max_price)
      continue;
    if (filters.in_stock_only && !hasStock(product)) continue;

    // No text asked for means every survivor answers the request equally.
    if (tokens.length === 0) {
      hits.push({ product, score: 1 });
      continue;
    }

    const haystack = haystackFor(product);
    const score =
      tokens.reduce((sum, token) => sum + scoreToken(token, haystack), 0) / tokens.length;
    if (score < minScore) continue;
    hits.push({ product, score });
  }

  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, filters.limit ?? Number.POSITIVE_INFINITY);
}
