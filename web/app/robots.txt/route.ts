import { headers } from "next/headers";
import { isAnonHost } from "@/lib/hosts";

export const dynamic = "force-dynamic";

/** Everything on the anonymous host; the two unlisted paths on the branded one. */
const ANON_ROBOTS = "User-agent: *\nDisallow: /\n";
const BRANDED_ROBOTS = "User-agent: *\nAllow: /\nDisallow: /preview/\nDisallow: /ver/\n";

/**
 * robots.txt, per host. A route handler rather than the `app/robots.ts` metadata
 * file because the answer depends on which domain asked, and only a handler gets
 * the request headers.
 *
 * The anonymous host disallows everything: its pages are private links passed
 * between agents, and an indexed /ver/<token> would put a listing we deliberately
 * de-branded into a search engine, where the token stops being the only way in.
 * The branded host keeps the same two unlisted paths out of the index, for the
 * reasons those pages already state — a draft is unreviewed data, and /ver is
 * anonymous — while the catalog itself is meant to be found.
 */
export async function GET(): Promise<Response> {
  const host = (await headers()).get("host");

  return new Response(isAnonHost(host) ? ANON_ROBOTS : BRANDED_ROBOTS, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
