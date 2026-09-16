import { loadDotEnv, loadOwnerPhoneNumbers, resolveDataPath } from "../config.js";
import { refusingLegacyAgentIdFor } from "../router.js";
import {
  addAdminEntry,
  deleteAdminEntry,
  listAdminEntries,
  rotateAdminToken,
} from "./admin-roster.js";
import { buildConsoleLink } from "./console-link.js";
import { openDb, type DB } from "./db.js";
import { isEntryPoint } from "./entry-point.js";

/**
 * Ops lever: who may read every conversation in this deployment, and — because
 * `admin-roster.ts` refuses to let anything served over HTTP call
 * `addAdminEntry` or `rotateAdminToken` — the ONLY way somebody gets that
 * access. A console that could enrol a reader is a console that grants itself
 * reach; this command is the door that stays outside it.
 *
 * Run under compose:  docker compose --profile ops run --rm admin-credentials list
 * Locally:            npm run admin -w server -- list
 *
 * A COMMAND, NOT CONFIGURATION (same reasoning as agent-credentials.ts,
 * role-assignments.ts and test-console-credentials.ts): the token is printed
 * once and stored only as a hash. Putting it in an environment variable would
 * put it in a deployment's shell history, its process listing and its container
 * inspect output.
 *
 * Reads the environment directly rather than loadConfig(), like the other ops
 * entry points: this needs no ANTHROPIC or SHOPIFY secrets, and enrolling or
 * revoking an admin must not be blocked by an unrelated key being absent.
 */

const USAGE = `Usage:
  admin-credentials list
  admin-credentials add <name> --label <text>
  admin-credentials rotate <name>
  admin-credentials remove <name>

  add     enrols an admin and prints their console LINK once.
  rotate  replaces the token; the previous link stops working immediately.
  remove  revokes the admin; their link stops working on its next request.

  <name> is an identifier for the person or the machine holding the link
  (letters, digits, dot, dash, underscore) — not a phone number. An admin is
  not a WhatsApp principal and no role is ever resolved for them.`;

interface AddOptions {
  label: string;
}

function parseAddOptions(argv: string[]): AddOptions {
  let label: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--label") {
      if (!value) throw new Error("--label needs a value");
      label = value.trim();
      i++;
    } else {
      throw new Error(`unknown option "${flag ?? ""}"`);
    }
  }
  if (!label) throw new Error(`--label is required, so two links can be told apart.\n\n${USAGE}`);
  return { label };
}

/**
 * Print a minted link, with the warning it needs.
 *
 * THE WARNING IS DELIBERATELY STRONGER THAN THE TEST CONSOLE'S, because what
 * leaks is different in kind. A leaked test-console link lets someone flip one
 * phone's own role — annoying, reversible, and it grants no owner tools because
 * using those means sending WhatsApp messages from a phone the interceptor does
 * not have (DEUDA #12 works this through). A leaked link from HERE is every
 * customer's phone number and every word they typed: third parties who never
 * agreed to anything, covered by Ley 1581. It is worth the extra three lines.
 */
function printLink(name: string, token: string, label: string): void {
  const { link, path, placeholder } = buildConsoleLink(
    "/admin",
    token,
    process.env["PUBLIC_BASE_URL"],
  );
  console.log(`Admin link for ${name} ("${label}") is shown ONCE:\n`);
  if (link) {
    console.log(`  ${link}\n`);
  } else {
    console.log(`  ${path}\n`);
    console.log(
      "PUBLIC_BASE_URL is unset or still a placeholder, so only the path is shown above. " +
        "Prepend this deployment's real, publicly reachable origin before sending it to anyone.\n",
    );
  }
  console.log(
    "Send it directly to its holder now. Only its SHA-256 is kept here, so it cannot be\n" +
      "recovered — a lost link is replaced with `rotate`, not looked up.\n",
  );
  console.log(
    "THIS IS A BEARER CREDENTIAL THAT READS EVERY CONVERSATION IN THE STORE: every\n" +
      "customer's phone number, every message they sent, every reply they received, and\n" +
      "every catalog operation the assistant performed on their behalf. Those customers\n" +
      "are third parties to this decision and their data is covered by Ley 1581. Do not\n" +
      "forward it, do not paste it into a shared chat, and revoke it with `remove` the\n" +
      "moment its holder no longer needs it.",
  );
}

function list(db: DB): void {
  const entries = listAdminEntries(db);
  if (entries.length === 0) {
    console.log("No admins enrolled. The admin console authenticates nobody and answers 404.");
    return;
  }
  for (const entry of entries) {
    const rotated = entry.rotated_at ? `, rotated ${entry.rotated_at}` : "";
    console.log(`${entry.name}  "${entry.label}"  enrolled ${entry.created_at}${rotated}`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const [command = "list", nameArg, ...rest] = process.argv.slice(2);
  const dbPath = resolveDataPath(process.env["DB_PATH"]?.trim() || "./data/vitrina.db");

  const db = openDb(dbPath, {
    // Same reasoning as the sibling ops entry points: opening the database
    // migrates legacy sessions, and with no allowlist to resolve them by, the
    // owner's session would be filed under the customer agent. Asked only when
    // such rows exist.
    legacyAgentIdFor: refusingLegacyAgentIdFor(loadOwnerPhoneNumbers()),
  });
  try {
    if (command === "list") return list(db);

    const name = (nameArg ?? "").trim();
    if (name.length === 0) {
      throw new Error(`a name is required.\n\n${USAGE}`);
    }

    if (command === "add") {
      const options = parseAddOptions(rest);
      // addAdminEntry itself refuses a second `add` for the same name, and its
      // message already names `rotate` as the remedy.
      const { name: key, token } = addAdminEntry(db, name, options.label);
      printLink(key, token, options.label);
      return;
    }

    if (command === "rotate") {
      const { name: key, token } = rotateAdminToken(db, name);
      console.log("The previous link stops working with this write. There is no overlap window.");
      // The label survives rotation; read it back purely to echo it, so the
      // operator still knows which link this was two lines later.
      const entry = listAdminEntries(db).find((e) => e.name === key);
      printLink(key, token, entry?.label ?? "(unknown label)");
      return;
    }

    if (command === "remove") {
      const removed = deleteAdminEntry(db, name);
      console.log(
        removed
          ? `Removed "${name}". Their admin link stops working on its next request.`
          : `No admin credential for "${name}"; nothing to remove.`,
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
    console.error("admin-credentials failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
