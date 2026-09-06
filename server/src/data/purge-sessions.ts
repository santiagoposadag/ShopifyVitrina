import { loadDotEnv, loadOwnerPhoneNumbers, resolveDataPath } from "../config.js";
import { agentIdForPhone } from "../router.js";
import { openDb } from "./db.js";
import { assertOwnerAllowlist, purgeCustomerSessions } from "./purge.js";
import { transcriptsDir } from "./transcripts.js";

/**
 * Ops lever: drop every customer conversation history, so customers start fresh
 * on their next message. Owner sessions are kept (see purge.ts).
 *
 * Run under compose:  docker compose --profile purge run --rm purge-sessions
 * Locally:            npm run purge:sessions -w server
 *
 * A COMMAND, NOT A BOOT FLAG (deliberate): an env var checked at startup would
 * re-fire on every container restart and wipe live conversations each time the
 * server came back up. Purging is a decision, so it takes an explicit act.
 *
 * Reads the environment directly rather than loadConfig(), like backup.ts: this
 * needs no ANTHROPIC/KAPSO secrets, and an emergency purge must not be blocked
 * by an unrelated key being absent.
 */
const SESSION_MAX_AGE_DAYS_DEFAULT = 7;

async function main(): Promise<void> {
  loadDotEnv();
  const dbPath = resolveDataPath(process.env["DB_PATH"]?.trim() || "./data/vitrina.db");
  const maxAgeRaw = Number.parseInt(process.env["SESSION_MAX_AGE_DAYS"]?.trim() || "", 10);
  const config = {
    ownerPhoneNumbers: loadOwnerPhoneNumbers(),
    sessionMaxAgeDays:
      Number.isNaN(maxAgeRaw) || maxAgeRaw < 1 ? SESSION_MAX_AGE_DAYS_DEFAULT : maxAgeRaw,
  };
  const root = transcriptsDir();

  // BEFORE opening the database, not after. Opening it runs the schema
  // migration, and a database from an older build has its sessions keyed by
  // phone alone — so the migration is where those rows are assigned to an
  // agent, using this same allowlist. With an empty one it would file the
  // owner's session under the customer agent, and the refusal inside
  // purgeCustomerSessions would then be guarding a decision already made.
  assertOwnerAllowlist(config);

  // Resolved, not dropped: this tool's entire contract is that owner sessions
  // survive it, and opening the database without a resolver would delete every
  // legacy session — the owner's included — before the purge ran at all. The
  // mapping is the server's own, so a session migrated here is one the server
  // will still find.
  const db = openDb(dbPath, { legacyAgentIdFor: (phone) => agentIdForPhone(config, phone) });
  try {
    const { purged, kept, keptAgent, swept } = purgeCustomerSessions(db, config, root);
    console.log(`Purged ${purged} customer session(s); kept ${kept} owner session(s).`);
    // Said out loud rather than folded into "kept": these are exchanges with
    // another agent, they are kept on purpose (see purge.ts), and an operator
    // who expected this command to empty the sessions table should see why it
    // did not.
    if (keptAgent > 0) {
      console.log(`Kept ${keptAgent} agent-to-agent exchange(s); they are not customer histories.`);
    }
    if (root === undefined) {
      // See transcripts.ts: without an explicit root we do NOT guess, because the
      // obvious guess is the developer's own Claude Code history for this repo.
      console.log("AGENT_TRANSCRIPTS_DIR is not set — skipped the transcript sweep.");
    } else {
      console.log(`Swept ${swept} orphaned transcript(s) from ${root}.`);
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error("Purge failed:", err);
  process.exit(1);
});
