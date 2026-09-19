import type { FastifyInstance, FastifyReply } from "fastify";
import { redeemAdminDeepLink } from "../data/admin-deep-links.js";
import type { DB } from "../data/db.js";

/**
 * The landing route a WhatsApp notification points at: `/go/<code>`.
 *
 * WHY IT IS ITS OWN PATH AND NOT UNDER /admin. Two reasons, and both are
 * load-bearing.
 *
 * FIRST, META. A template's URL button takes exactly ONE variable and it is
 * appended at the END of a fixed base URL — so the base has to be short,
 * stable, and end in a slash. It is also FROZEN at approval: changing it later
 * means submitting a new template, so it must not be a path that might be
 * reorganised.
 *
 * SECOND, THE GATE. Every route under /admin answers 404 while no admin
 * session is live, because the console is shipped closed. This one must work in
 * exactly that state — opening it is what CREATES the first session. Its gate
 * is the same shape one level down: an empty `admin_deep_links` table matches
 * nothing, so an unknown code is refused with no session ever minted.
 *
 * THE TOKEN IS HANDED OVER IN A DOCUMENT, NOT A REDIRECT. A 302 would carry the
 * session token in a `Location` header, and the reverse proxies this runs
 * behind (Coolify's, and whatever sits in front of it) are far more likely to
 * log response headers than Fastify is. The page below sets `location.replace`
 * instead, so the token exists in a response BODY — which nothing logs — and
 * reaches the browser as a fragment, which is where every other token in this
 * system already lives.
 */

/** The prefix, deliberately short and stable: it is frozen inside an approved template. */
const PREFIX = "/go";

export interface DeepLinkDeps {
  db: DB;
  /**
   * This deployment's public origin, already trimmed of a trailing slash.
   *
   * Passed rather than read from config here so this module stays testable
   * without a whole Config, matching how the rest of the admin surface takes
   * exactly what it uses.
   */
  publicBaseUrl: string;
}

function guardHeaders(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex");
}

/**
 * Where a redeemed link lands, as a fragment.
 *
 * EVERYTHING RIDES THE FRAGMENT, including which conversation to open. The
 * token has to (it is a credential, and a query string would be written into
 * the request log on every page load), and the conversation key travels
 * alongside it rather than as a query parameter for a smaller but real reason:
 * that key IS a customer's phone number, and keeping it out of the log costs
 * nothing here.
 */
function landingFragment(input: {
  token: string;
  conversationKey: string | null;
  agentId: string | null;
}): string {
  const parts = [`t=${encodeURIComponent(input.token)}`];
  if (input.conversationKey && input.agentId) {
    parts.push(`c=${encodeURIComponent(input.conversationKey)}`);
    parts.push(`g=${encodeURIComponent(input.agentId)}`);
  }
  return parts.join("&");
}

export function registerDeepLinks(app: FastifyInstance, deps: DeepLinkDeps): void {
  const { db, publicBaseUrl } = deps;

  /**
   * Spend a code and hand the browser its session, or explain that it is dead.
   *
   * ONE ANSWER FOR EVERY WAY A CODE CAN FAIL — unknown, expired, already
   * spent. A visitor who is told "this one was already used" learns that the
   * code was real, and a visitor who is told "no such code" learns that
   * guessing is detectable. The person holding a dead link needs one sentence
   * and a way forward; nobody needs the diagnosis.
   *
   * IT ANSWERS 200, NOT 404 OR 410, and that is not sloppiness. This URL is
   * submitted to Meta as a template's sample and opened by a human reviewer
   * during approval; a non-200 reads to a reviewer, and to every link checker,
   * as a broken destination. The page says what happened in words.
   */
  app.get(`${PREFIX}/:code`, async (request, reply) => {
    const { code } = request.params as { code?: string };
    const redeemed = redeemAdminDeepLink(db, code);

    if (!redeemed) {
      // The code is NEVER logged, even on failure: a near-miss in a log is a
      // live code if the miss was a typo in the log rather than in the link.
      request.log.info("admin deep link: a code was presented and is not live");
      return guardHeaders(reply).type("text/html; charset=utf-8").code(200).send(EXPIRED_PAGE);
    }

    request.log.warn(
      {
        admin: redeemed.session.phone,
        session: redeemed.session.id,
        deepLink: redeemed.link.id,
        conversationKey: redeemed.link.conversation_key,
      },
      "admin deep link: opened, and a session was issued",
    );

    const target = `${publicBaseUrl}/admin#${landingFragment({
      token: redeemed.token,
      conversationKey: redeemed.link.conversation_key,
      agentId: redeemed.link.agent_id,
    })}`;

    return guardHeaders(reply)
      .type("text/html; charset=utf-8")
      .code(200)
      .send(handoffPage(target));
  });
}

/**
 * The handoff. A document whose only job is to replace itself.
 *
 * `location.replace`, not `href`: the landing URL must not enter history, or
 * the back button re-requests a code that is now spent and the person lands on
 * the expired page from inside a working session.
 *
 * THE TARGET IS BUILT HERE AND JSON-ENCODED INTO THE SCRIPT. It contains a
 * token, so it must not be interpolated into markup where a stray character
 * could break out; `JSON.stringify` produces a quoted JavaScript string literal
 * with everything escaped. There is no other interpolation in this document.
 *
 * The `<noscript>` link is a real fallback rather than decoration: it puts the
 * same URL in an href, and a person who taps it arrives exactly as the script
 * would have sent them. The token is in a fragment either way.
 */
function handoffPage(target: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Abriendo el panel…</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px; text-align: center;
  }
  p { color: #6b7280; }
  a { color: inherit; }
</style>
</head>
<body>
<div>
  <p>Abriendo el panel…</p>
  <noscript><p><a href="${escapeHtmlAttribute(target)}">Toca aquí para continuar</a></p></noscript>
</div>
<script>
  // replace(), not assign(): the spent code must not stay in history, or the
  // back button lands the person on "this link expired" from inside a working
  // session.
  window.location.replace(${JSON.stringify(target)});
</script>
</body>
</html>
`;
}

/**
 * The one place this file puts a value into markup rather than into script.
 *
 * Only for the `<noscript>` href, and only the five characters that can end an
 * attribute or open a tag. The value is built by us from a configured origin
 * and a minted token, so this is belt-and-braces rather than a real escape
 * hatch — but "we built it" is exactly the assumption that stops being true
 * when somebody changes how the origin is configured.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * What a dead code shows.
 *
 * WRITTEN FOR TWO READERS AT ONCE, which is why it says more than "expired".
 * One is the owner tapping a notification from last week; they need the next
 * step, which is one word in WhatsApp. The other is a Meta reviewer opening the
 * template's sample URL during approval — they see a real page belonging to a
 * real business that explains itself, rather than a 404, and that is the whole
 * reason this route exists before the template that points at it.
 *
 * NO VARIABLES AND NO INTERPOLATION: it is a constant, so nothing a visitor
 * sends can reach it.
 */
const EXPIRED_PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Este enlace ya no sirve</title>
<style>
  :root { color-scheme: light dark; --dim: #6b7280; --line: #d1d5db; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px;
  }
  main { max-width: 420px; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { color: var(--dim); margin: 0 0 16px; }
  .word {
    display: inline-block; border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 20px; font-weight: 600; color: inherit; margin-bottom: 16px;
  }
  .fine { font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>Este enlace ya no sirve</h1>
  <p>
    Los enlaces de acceso al panel caducan por seguridad, y cada uno se puede
    abrir una sola vez.
  </p>
  <p>Para entrar, escribe esta palabra al WhatsApp del negocio:</p>
  <div class="word">panel</div>
  <p class="fine">
    Recibirás un enlace nuevo en el momento. Si no eres administrador de esta
    tienda, no hay nada que hacer aquí.
  </p>
</main>
</body>
</html>
`;
