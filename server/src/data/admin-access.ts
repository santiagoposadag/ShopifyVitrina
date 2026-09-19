import { loadDotEnv, loadOwnerPhoneNumbers, normalizePhone, resolveDataPath } from "../config.js";
import { refusingLegacyAgentIdFor } from "../router.js";
import {
  ADMIN_CLAIM_TTL_MINUTES,
  ADMIN_SESSION_TTL_HOURS,
  issueAdminSession,
  listAdminSessions,
  listLiveAdminSessions,
  revokeAdminSession,
  revokeAdminSessionsForPhone,
} from "./admin-sessions.js";
import { roleForPhone } from "./assignments.js";
import { buildConsoleLink } from "./console-link.js";
import { openDb, type DB } from "./db.js";
import { isEntryPoint } from "./entry-point.js";

/**
 * Ops lever for admin access: see who can currently reach the console, cut
 * somebody off, and — as BREAK GLASS — issue a link from a terminal.
 *
 * Run under compose:  docker compose --profile ops run --rm admin-access list
 * Locally:            npm run admin -w server -- list
 *
 * THE NORMAL PATH IS NOT THIS COMMAND. An admin asks from their own WhatsApp
 * and is sent a link (see the intercept in index.ts). This exists for the
 * failure that path cannot survive on its own: WhatsApp is down, the bridge has
 * been unlinked, or Meta is rejecting sends — and the alternative to a
 * break-glass would be a store whose operator cannot see their own
 * conversations until the transport comes back.
 *
 * IT ISSUES THE SAME KIND OF SESSION, not a second kind of credential. Same
 * table, same deadlines, same revocation — only `issued_via` differs, so a
 * terminal-issued session is visible as such in a listing rather than looking
 * like a request somebody made from their phone. That is the whole reason
 * there is no durable credential to reintroduce here: whoever can run this
 * already has the database, so a permanent token would add exposure without
 * adding access.
 *
 * Reads the environment directly rather than loadConfig(), like the other ops
 * entry points: this needs no ANTHROPIC or SHOPIFY secrets, and cutting off an
 * admin must not be blocked by an unrelated key being absent.
 */

const USAGE = `Usage:
  admin-access list [--all]
  admin-access issue <phone>
  admin-access revoke <session-id>
  admin-access revoke-phone <phone>

  list          live sessions; --all includes expired and revoked ones.
  issue         BREAK GLASS. Mints a link from here instead of over WhatsApp.
                Normally an admin just writes "panel" to the business number.
  revoke        kills one session on its next request, with no restart.
  revoke-phone  kills every live session for a phone.

A session is valid for ${ADMIN_CLAIM_TTL_MINUTES} minutes until the link is
opened, then for ${ADMIN_SESSION_TTL_HOURS} hours. Removing someone's owner
role stops them asking for a NEW link; it does not touch a session already
issued — use revoke-phone for that.`;

function printLink(phone: string, token: string): void {
  const { link, path, placeholder } = buildConsoleLink(
    "/admin",
    token,
    process.env["PUBLIC_BASE_URL"],
  );
  console.log(`Admin link for ${phone} is shown ONCE:\n`);
  console.log(`  ${link ?? path}\n`);
  if (placeholder) {
    console.log(
      "PUBLIC_BASE_URL is unset or still a placeholder, so only the path is shown above. " +
        "Prepend this deployment's real, publicly reachable origin before sending it.\n",
    );
  }
  console.log(
    `It must be OPENED within ${ADMIN_CLAIM_TTL_MINUTES} minutes or it dies unused; once ` +
      `opened it lasts ${ADMIN_SESSION_TTL_HOURS} hours. Only its SHA-256 is kept, so it ` +
      "cannot be recovered — issue another one instead.\n",
  );
  console.log(
    "IT READS EVERY CONVERSATION IN THE STORE and can reply inside one as the business:\n" +
      "every customer's phone number, every message, and every catalog operation performed\n" +
      "on their behalf. Those customers are third parties covered by Ley 1581.",
  );
}

function list(db: DB, all: boolean): void {
  // Liveness is decided in SQL, by the same predicate authentication uses.
  // Re-deriving it here from a JS clock would be a second answer to "is this
  // session still good", and the two would disagree the moment either changed.
  const sessions = all ? listAdminSessions(db) : listLiveAdminSessions(db);
  if (sessions.length === 0) {
    console.log(
      all
        ? "No admin sessions have ever been issued."
        : "No live admin sessions. The console authenticates nobody and answers 404.",
    );
    return;
  }
  for (const s of sessions) {
    const state = s.revoked_at
      ? `revoked ${s.revoked_at}`
      : s.claimed_at
        ? `open since ${s.claimed_at}, expires ${s.expires_at}`
        : `unopened, link dies ${s.expires_at}`;
    console.log(`#${s.id}  ${s.phone}  via ${s.issued_via}  issued ${s.created_at}  — ${state}`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const [command = "list", argument, ...rest] = process.argv.slice(2);
  const dbPath = resolveDataPath(process.env["DB_PATH"]?.trim() || "./data/vitrina.db");

  const db = openDb(dbPath, {
    // Same reasoning as the sibling ops entry points: opening the database may
    // migrate legacy sessions, and with no allowlist to resolve them by, the
    // owner's session would be filed under the customer agent.
    legacyAgentIdFor: refusingLegacyAgentIdFor(loadOwnerPhoneNumbers()),
  });
  try {
    if (command === "list") return list(db, argument === "--all" || rest.includes("--all"));

    if (command === "issue") {
      const phone = normalizePhone(argument ?? "");
      if (phone.length === 0) throw new Error(`"${argument ?? ""}" contains no digits.\n\n${USAGE}`);
      // A WARNING, NOT A REFUSAL. The owner check belongs to the WhatsApp
      // intercept, where it decides whether a request is honoured at all; here
      // the caller already holds the database and refusing would just mean they
      // run `role-assignments set` first and come back. Saying so is what stops
      // a link being issued to the wrong number by a typo.
      if (roleForPhone(db, phone) !== "owner") {
        console.warn(
          `WARNING: "${phone}" does not read as an owner in the assignments table. This link ` +
            "will still work — a session is a token, not a role lookup — but that phone cannot " +
            "request one itself, and you may have meant a different number.\n",
        );
      }
      const { token } = issueAdminSession(db, { phone, issuedVia: "cli" });
      printLink(phone, token);
      return;
    }

    if (command === "revoke") {
      const id = Number(argument);
      if (!Number.isInteger(id)) throw new Error(`"${argument ?? ""}" is not a session id.\n\n${USAGE}`);
      console.log(
        revokeAdminSession(db, id)
          ? `Revoked session #${id}. It stops working on its next request.`
          : `No live session #${id}; nothing to revoke.`,
      );
      return;
    }

    if (command === "revoke-phone") {
      const phone = normalizePhone(argument ?? "");
      if (phone.length === 0) throw new Error(`"${argument ?? ""}" contains no digits.\n\n${USAGE}`);
      const revoked = revokeAdminSessionsForPhone(db, phone);
      console.log(
        revoked > 0
          ? `Revoked ${revoked} live session(s) for "${phone}".`
          : `No live sessions for "${phone}"; nothing to revoke.`,
      );
      return;
    }

    throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  } finally {
    db.close();
  }
}

// Guarded for the reason entry-point.ts states: an unconditional main() would
// run this CLI's default `list` against the REAL database at DB_PATH as a side
// effect of any import of this module.
if (isEntryPoint(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("admin-access failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
