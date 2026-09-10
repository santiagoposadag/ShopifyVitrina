import { loadDotEnv, loadOwnerPhoneNumbers, normalizePhone, resolveDataPath } from "../config.js";
import { refusingLegacyAgentIdFor } from "../router.js";
import {
  addRosterEntry,
  deleteRosterEntry,
  listRosterEntries,
  rotateRosterToken,
} from "./test-roster.js";
import { openDb, type DB } from "./db.js";
import { isEntryPoint } from "./entry-point.js";

/**
 * Ops lever: who is enrolled in the TEMPORARY test console, and — because
 * `test-roster.ts` refuses to let anything served over HTTP call
 * `addRosterEntry` or `rotateRosterToken` — the ONLY way a phone gets onto
 * that roster. A console that could enrol itself would be a console that
 * grants itself reach; this command is the door that stays outside it.
 *
 * Run under compose:  ./scripts/with-secrets.sh docker compose --profile ops run --rm test-console list
 * Locally:            npm run test-console -w server -- list
 *
 * A COMMAND, NOT CONFIGURATION (same reasoning as agent-credentials.ts and
 * role-assignments.ts): the roster's token, like the agent door's, is printed
 * once and stored only as a hash. Putting it in an environment variable would
 * put it in a deployment's shell history, its process listing and its
 * container inspect output.
 *
 * Reads the environment directly rather than loadConfig(), like the other ops
 * entry points: this needs no ANTHROPIC or SHOPIFY secrets, and enrolling or
 * revoking a test phone must not be blocked by an unrelated key being absent.
 */

const USAGE = `Usage:
  test-console list
  test-console add <phone> --label <text>
  test-console rotate <phone>
  test-console remove <phone>

  add     enrols a phone and prints its console LINK once.
  rotate  replaces the token; the previous link stops working immediately.
  remove  revokes the phone; its link stops working on its next request.`;

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

export interface RosterLink {
  /** The full URL, ready to hand to the phone's holder — or null, see `placeholder`. */
  link: string | null;
  /** The path alone, always present, so it can still be relayed with a placeholder base. */
  path: string;
  /** True when PUBLIC_BASE_URL is missing or does not look like a real deployed host. */
  placeholder: boolean;
}

/**
 * Hosts that are real syntactically but never reachable from a phone. Not an
 * exhaustive list — a false negative here just means an operator gets a link
 * that does not work and notices immediately; a false positive would hide a
 * working link behind an unnecessary warning, which is the worse failure.
 */
function isPlaceholderHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") return true;
  return hostname === "example.com" || hostname.endsWith(".example.com") || hostname.endsWith(".example");
}

/**
 * Builds the console link for a minted token.
 *
 * THE TOKEN RIDES THE URL FRAGMENT, NEVER A QUERY STRING. Fastify runs with
 * `logger: true` (server/src/index.ts), so a `?t=` token would be written
 * into the request log on every single page load the holder makes. A fragment
 * is never sent to the server at all — the browser keeps it client-side — so
 * it never reaches that log, nor any proxy or CDN log in front of it. Do NOT
 * "tidy" this into a query string.
 */
export function buildRosterLink(token: string, publicBaseUrl: string | undefined): RosterLink {
  const path = `/test-console#t=${token}`;
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

function printLink(phone: string, token: string, label: string): void {
  const { link, path, placeholder } = buildRosterLink(token, process.env["PUBLIC_BASE_URL"]);
  console.log(`Console link for ${phone} ("${label}") is shown ONCE:\n`);
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
    "Send it to the phone's holder now. Only its SHA-256 is kept here, so it cannot be\n" +
      "recovered — a lost link is replaced with `rotate`, not looked up. It is a BEARER\n" +
      "CREDENTIAL: whoever holds it can flip that phone's own role, so it must not be\n" +
      "forwarded, pasted into a shared chat, or sent anywhere but directly to that phone.",
  );
}

/**
 * OWNER_PHONE_NUMBERS is only a SEED (see role-assignments.ts): the row this
 * console writes, or later flips to "customer", is what actually decides the
 * role, and the row wins over the variable. But the variable is still READ at
 * every boot, and when it names a phone whose row disagrees, the server logs
 * that disagreement on every restart — correct behaviour that reads like a
 * config error. Enrolling a phone that is already in the variable all but
 * guarantees that warning the moment someone tests the customer flow, so
 * `add` says so up front rather than leaving an operator to trace it back
 * from a boot log later.
 */
function warnOwnerOverlap(phone: string, seed: ReadonlySet<string>): void {
  if (!seed.has(phone)) return;
  console.warn(
    `WARNING: "${phone}" is also named in OWNER_PHONE_NUMBERS. The moment this console flips ` +
      "it to \"customer\", that variable disagrees with the assignments row, and the server " +
      "logs that disagreement on every boot from here on. Keep test phones OUT of " +
      "OWNER_PHONE_NUMBERS: give them their role once with `role-assignments set <phone> " +
      "owner` instead, then enrol them here.",
  );
}

function list(db: DB): void {
  const entries = listRosterEntries(db);
  if (entries.length === 0) {
    console.log("No test phones enrolled. The console authenticates nobody.");
    return;
  }
  for (const entry of entries) {
    const rotated = entry.rotated_at ? `, rotated ${entry.rotated_at}` : "";
    console.log(`${entry.phone}  "${entry.label}"  enrolled ${entry.created_at}${rotated}`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const [command = "list", phoneArg, ...rest] = process.argv.slice(2);
  const dbPath = resolveDataPath(process.env["DB_PATH"]?.trim() || "./data/vitrina.db");
  const ownerPhoneNumbers = loadOwnerPhoneNumbers();

  const db = openDb(dbPath, {
    // Same reasoning as agent-credentials.ts and role-assignments.ts: opening
    // the database migrates legacy sessions, and with no allowlist to resolve
    // them by, the owner's session would be filed under the customer agent.
    // Asked only when such rows exist.
    legacyAgentIdFor: refusingLegacyAgentIdFor(ownerPhoneNumbers),
  });
  try {
    if (command === "list") return list(db);

    const phone = normalizePhone(phoneArg ?? "");
    if (phone.length === 0) {
      throw new Error(`"${phoneArg ?? ""}" contains no digits.\n\n${USAGE}`);
    }

    if (command === "add") {
      const options = parseAddOptions(rest);
      // addRosterEntry itself refuses a second `add` for the same phone, and
      // its own message already names `rotate` as the remedy — nothing to add
      // here, and wrapping it would just be a second message saying the same
      // thing worse.
      const { token } = addRosterEntry(db, phone, options.label);
      warnOwnerOverlap(phone, ownerPhoneNumbers);
      printLink(phone, token, options.label);
      return;
    }

    if (command === "rotate") {
      const { token } = rotateRosterToken(db, phone);
      console.log("The previous link stops working with this write. There is no overlap window.");
      // The label survives rotation (rotateRosterToken carries it over); read
      // it back purely to echo it, so the operator still knows which phone
      // this was for two lines later.
      const entry = listRosterEntries(db).find((e) => e.phone === phone);
      printLink(phone, token, entry?.label ?? "(unknown label)");
      return;
    }

    if (command === "remove") {
      const removed = deleteRosterEntry(db, phone);
      console.log(
        removed
          ? `Removed "${phone}". Its console link stops working on its next request.`
          : `No test-console entry for "${phone}"; nothing to remove.`,
      );
      return;
    }

    throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  } finally {
    db.close();
  }
}

// This file exports `buildRosterLink` for a unit test to import, and an
// unconditional `main()` would run the CLI's default `list` command — against
// the REAL database at DB_PATH — as a side effect of that import. That is how
// this guard came to exist; every sibling CLI now shares it. See entry-point.ts.
if (isEntryPoint(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("test-console-credentials failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
