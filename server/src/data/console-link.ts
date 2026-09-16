/**
 * Building the link that carries a console credential to its holder.
 *
 * SHARED BY TWO CONSOLES with different lifetimes, which is why it is its own
 * module rather than a function one of them exports. The test console is
 * TEMPORARY and its removal checklist deletes whole files (see
 * data/test-roster.ts); the admin console is not. A shared helper living inside
 * the temporary one would make deleting it a breaking change for the durable
 * one — and the dependency has to run temporary → durable, never back.
 * Nothing here imports either console.
 */

export interface ConsoleLink {
  /** The full URL, ready to hand to its holder — or null, see `placeholder`. */
  link: string | null;
  /** The path alone, always present, so it can still be relayed with a placeholder base. */
  path: string;
  /** True when PUBLIC_BASE_URL is missing or does not look like a real deployed host. */
  placeholder: boolean;
}

/**
 * Hosts that are real syntactically but never reachable from someone else's
 * browser. Not an exhaustive list — a false negative here just means an
 * operator gets a link that does not work and notices immediately; a false
 * positive would hide a working link behind an unnecessary warning, which is
 * the worse failure.
 */
function isPlaceholderHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") return true;
  return (
    hostname === "example.com" ||
    hostname.endsWith(".example.com") ||
    hostname.endsWith(".example")
  );
}

/**
 * Compose a console link for a minted token.
 *
 * THE TOKEN RIDES THE URL FRAGMENT, NEVER A QUERY STRING. Fastify runs with
 * `logger: true` (server/src/index.ts), so a `?t=` token would be written into
 * the request log on every single page load the holder makes. A fragment is
 * never sent to the server at all — the browser keeps it client-side — so it
 * never reaches that log, nor any proxy or CDN log in front of it. Do NOT
 * "tidy" this into a query string.
 *
 * `route` is the console's own path, with no fragment and no trailing slash.
 */
export function buildConsoleLink(
  route: string,
  token: string,
  publicBaseUrl: string | undefined,
): ConsoleLink {
  const path = `${route}#t=${token}`;
  const trimmed = publicBaseUrl?.trim();
  if (!trimmed) return { link: null, path, placeholder: true };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { link: null, path, placeholder: true };
  }
  if (isPlaceholderHost(url.hostname)) return { link: null, path, placeholder: true };

  const base = trimmed.replace(/\/+$/, "");
  return { link: `${base}${path}`, path, placeholder: false };
}
