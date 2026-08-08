/**
 * The two public hosts this one app answers on: the BRANDED storefront and the
 * ANONYMOUS share host. Coolify routes both domains to this same container, so
 * without a check every domain would serve every page — and a client who
 * truncates an anonymous /ver/<token> URL down to "/" would land on the branded
 * catalog, which defeats the entire point of the anonymous link.
 *
 * Read at RUNTIME from plain server-side env, deliberately NOT NEXT_PUBLIC_:
 * changing a domain is a restart, not a rebuild of the web image. Every consumer
 * is a server component or route handler, so these values never reach the
 * browser bundle where Next would inline them at build time.
 */

/** The host (with port, if any) of a base URL. Empty for unset or malformed input. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    // Unset or unparseable: report no host, so the split below stays OFF rather
    // than being half-applied against an empty string.
    return "";
  }
}

function trimUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/** Public base URL of the branded storefront. */
export const STOREFRONT_BASE_URL = trimUrl(process.env.STOREFRONT_BASE_URL);

/**
 * Public base URL of the anonymous host. Falls back to the branded one, which is
 * the single-domain deployment. MIRRORS the same fallback in the server's
 * config.ts — the server mints these links and this app resolves them, so the
 * two must not disagree about which host an anonymous link lives on.
 */
export const ANON_BASE_URL = trimUrl(process.env.ANON_BASE_URL) || STOREFRONT_BASE_URL;

export const BRANDED_HOST = hostOf(STOREFRONT_BASE_URL);
export const ANON_HOST = hostOf(ANON_BASE_URL);

/**
 * Whether the domains are actually split. Both must be configured AND differ, so
 * a single-domain deploy and every dev machine keep today's behaviour with all
 * host checks inert. This is what makes the guards safe to add everywhere: they
 * cannot 404 a deployment that never opted into the split.
 */
export const HOSTS_SPLIT = BRANDED_HOST !== "" && ANON_HOST !== "" && BRANDED_HOST !== ANON_HOST;

function normalizeHost(host: string | null): string {
  return (host ?? "").trim().toLowerCase();
}

/** Whether a request's Host header names the anonymous host. Always false when unsplit. */
export function isAnonHost(host: string | null): boolean {
  return HOSTS_SPLIT && normalizeHost(host) === ANON_HOST;
}

/** Whether a request's Host header names the branded host. Always false when unsplit. */
export function isBrandedHost(host: string | null): boolean {
  return HOSTS_SPLIT && normalizeHost(host) === BRANDED_HOST;
}
