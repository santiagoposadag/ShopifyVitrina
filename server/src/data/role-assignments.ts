import { loadDotEnv, loadOwnerPhoneNumbers, normalizePhone, resolveDataPath } from "../config.js";
import { refusingLegacyAgentIdFor } from "../router.js";
import type { Role } from "../types.js";
import {
  assignRole,
  countAssignedOwners,
  listAssignments,
  unassignPhone,
} from "./assignments.js";
import { openDb, type DB } from "./db.js";

/**
 * Ops lever: who is an owner of this store, and who is a customer.
 *
 * The `assignments` table is what the router reads for every inbound message
 * (see router.ts), so this command is how the owner boundary is changed without
 * a redeploy. OWNER_PHONE_NUMBERS still works and is copied into the table at
 * boot for phones that have no row — but only as a SEED:
 *
 *   REMOVING A PHONE FROM THE VARIABLE DOES NOT REVOKE IT. The row is what
 *   grants the role now, and only `set <phone> customer` or `remove <phone>`
 *   takes it away. That is deliberate — see data/assignments.ts for why syncing
 *   to the variable would make an unread .env revoke the owner of the store —
 *   and it is the one thing an operator has to know, so every command below
 *   that touches the seeded half says it out loud.
 *
 * Run under compose:  ./scripts/with-secrets.sh docker compose --profile ops run --rm role-assignments list
 * Locally:            npm run roles -w server -- list
 *
 * A COMMAND, NOT CONFIGURATION (deliberate, same as agent-credentials.ts): a
 * privilege that is granted by an environment variable is a privilege that a
 * missing .env file can withdraw, silently, on a restart.
 *
 * Reads the environment directly rather than loadConfig(), like backup.ts: this
 * needs no ANTHROPIC or SHOPIFY secrets, and locking a stranger out must not be
 * blocked by an unrelated key being absent.
 */

const USAGE = `Usage:
  role-assignments list
  role-assignments set <phone> <owner|customer>
  role-assignments remove <phone>

  list    every assignment, and how it compares with OWNER_PHONE_NUMBERS.
  set     grants or withdraws the owner role. Takes effect on the next message,
          with no restart, and survives one (the table outranks the variable).
  remove  drops the row; the phone reads as a customer again — until the next
          boot re-seeds it, if OWNER_PHONE_NUMBERS still names it.`;

/**
 * E.164 allows at most 15 digits and no real number is shorter than 7 or 8.
 * A WARNING and not a refusal: what this catches is a WhatsApp LID pasted in
 * where a phone number belongs (see CLAUDE.md — its digits look exactly like
 * one), and an operator with an unusual short code must still be able to
 * proceed. The seeded half accepts whatever the variable already held, so
 * refusing here would also make this command stricter than the seed it audits.
 */
function warnUnlikelyPhone(phone: string): void {
  if (phone.length < 7 || phone.length > 15) {
    console.warn(
      `WARNING: "${phone}" has ${phone.length} digits, which is not an E.164 phone number. ` +
        "A WhatsApp LID is not a phone number and will never match an inbound message.",
    );
  }
}

/** The digits an inbound message would be looked up by, or a refusal. */
function phoneArg(raw: string | undefined): string {
  const phone = normalizePhone(raw ?? "");
  if (phone.length === 0) throw new Error(`"${raw ?? ""}" contains no digits.\n\n${USAGE}`);
  return phone;
}

function roleArg(raw: string | undefined): Role {
  if (raw === "owner" || raw === "customer") return raw;
  throw new Error(`"${raw ?? ""}" is not a role; expected "owner" or "customer".\n\n${USAGE}`);
}

/**
 * Said whenever a command leaves the store with nobody in charge of it.
 *
 * Not a refusal: an operator who means to withdraw the last owner is allowed
 * to, and the recovery (set the phone again, or restart with the variable set)
 * is one command. But the failure it produces is silent — the owner keeps
 * writing and gets the sales assistant — so it cannot go unsaid.
 */
function warnIfNoOwnersLeft(db: DB, seed: ReadonlySet<string>): void {
  if (countAssignedOwners(db) > 0) return;
  console.warn(
    seed.size > 0
      ? "WARNING: no owner is assigned. OWNER_PHONE_NUMBERS still names " +
          `${seed.size} phone(s), so the next server boot will seed them back as owners.`
      : "WARNING: no owner is assigned and OWNER_PHONE_NUMBERS is empty. Every phone now " +
          "reads as a customer, the store's owner included, and no restart changes that.",
  );
}

function list(db: DB, seed: ReadonlySet<string>): void {
  const assignments = listAssignments(db);
  if (assignments.length === 0) {
    console.log("No assignments.");
  }
  for (const assignment of assignments) {
    // Whether the variable also names it, because that is what decides whether
    // `remove` sticks. Computed live rather than stored: the variable can
    // change between two runs of this command, and a column would be a copy of
    // it that nobody updates.
    const seeded = seed.has(assignment.phone)
      ? assignment.role === "owner"
        ? " (also in OWNER_PHONE_NUMBERS)"
        : " (OWNER_PHONE_NUMBERS still names it as an owner; this row wins)"
      : "";
    console.log(`${assignment.phone}  ${assignment.role}${seeded}  since ${assignment.created_at}`);
  }
  // Phones the variable names that have no row yet. They are not owners RIGHT
  // NOW — the seed runs at boot — and an operator reading only the rows above
  // would conclude the variable had been ignored.
  const unseeded = [...seed].filter((phone) => !assignments.some((a) => a.phone === phone)).sort();
  for (const phone of unseeded) {
    console.log(`${phone}  (in OWNER_PHONE_NUMBERS, no row yet — the next boot seeds it as owner)`);
  }
  if (countAssignedOwners(db) === 0 && unseeded.length === 0) {
    console.log(
      "\nNo owner is assigned: every phone reads as a customer. Grant one with " +
        "`role-assignments set <phone> owner`.",
    );
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const [command = "list", ...rest] = process.argv.slice(2);
  const dbPath = resolveDataPath(process.env["DB_PATH"]?.trim() || "./data/vitrina.db");
  const seed = loadOwnerPhoneNumbers();

  const db = openDb(dbPath, {
    // Refusing rather than guessing, exactly as the other ops entry points do:
    // opening the database is what re-keys sessions written before they had an
    // agent id, and with no allowlist to resolve them by, the owner's would be
    // filed under the customer agent. Asked only when such rows exist.
    legacyAgentIdFor: refusingLegacyAgentIdFor(seed),
  });
  // NOT seeded here, deliberately. Seeding is a WRITE, and an ops command that
  // reports the state should not be the thing that changes it — `list` run
  // before the first boot must show that the variable has not been applied yet,
  // rather than apply it and report success.
  try {
    if (command === "list") return list(db, seed);

    if (command === "set") {
      const phone = phoneArg(rest[0]);
      const role = roleArg(rest[1]);
      warnUnlikelyPhone(phone);
      // The ROW, not the effective role: a phone with no row already reads as a
      // customer, and reporting `set <phone> customer` on it as "nothing
      // changed" would hide the thing that just changed — it now has a row, and
      // a row is what the boot seed cannot promote.
      const before = listAssignments(db).find((a) => a.phone === phone);
      assignRole(db, phone, role);
      const article = role === "owner" ? "an owner" : "a customer";
      console.log(
        before === undefined
          ? `${phone} is now ${article}, and has a row of its own from here on. ` +
              "It takes effect on the next message — no restart."
          : before.role === role
            ? `${phone} was already ${article}; the row is unchanged.`
            : `${phone} is now ${article} (was a ${before.role}). ` +
                "It takes effect on the next message — no restart.",
      );
      if (role === "customer" && seed.has(phone)) {
        // The demotion an operator most needs to trust: it OUTLASTS the seed,
        // because seeding only inserts rows that are missing.
        console.log(
          "OWNER_PHONE_NUMBERS still names this phone. The row wins and the next boot will " +
            "not re-promote it, but the variable now says something untrue — the server logs " +
            "that disagreement on every boot until it is corrected.",
        );
      }
      warnIfNoOwnersLeft(db, seed);
      return;
    }

    if (command === "remove") {
      const phone = phoneArg(rest[0]);
      const removed = unassignPhone(db, phone);
      console.log(
        removed
          ? `Removed ${phone}; it reads as a customer from the next message.`
          : `No assignment for ${phone}; nothing to remove.`,
      );
      if (seed.has(phone)) {
        // The one way this command silently fails to do what it looks like it
        // did: the row comes back on the next restart.
        console.warn(
          `WARNING: OWNER_PHONE_NUMBERS still names ${phone}, so the NEXT SERVER BOOT will ` +
            "seed it back as an owner. Drop it from the variable as well, or use " +
            `\`role-assignments set ${phone} customer\`, which the seed cannot undo.`,
        );
      }
      warnIfNoOwnersLeft(db, seed);
      return;
    }

    throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error("role-assignments failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
