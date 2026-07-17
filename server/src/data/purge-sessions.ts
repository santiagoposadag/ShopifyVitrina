import { loadDotEnv, loadOwnerPhoneNumbers, resolveDataPath } from "../config.js";
import { openDb } from "./db.js";
import { purgeCustomerSessions } from "./purge.js";
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

  const db = openDb(dbPath);
  try {
    const { purged, kept, swept } = purgeCustomerSessions(db, config, root);
    console.log(`Purged ${purged} customer session(s); kept ${kept} owner session(s).`);
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
