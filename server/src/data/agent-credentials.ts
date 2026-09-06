import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv, loadOwnerPhoneNumbers, resolveDataPath } from "../config.js";
import { agentIdForPhone } from "../router.js";
import {
  deleteAgentCredential,
  findAgentByToken,
  listAgentCredentials,
  mintAgentToken,
  upsertAgentCredential,
} from "./agent-registry.js";
import { openDb, type DB } from "./db.js";

/**
 * Ops lever: who may speak through the agent door, and what each may reach.
 *
 * The registry IS the switch (see data/db.ts): with no rows, POST
 * /agents/:id/messages refuses every request. This command is how the first row
 * is created, which makes it the only thing that opens that door.
 *
 * Run under compose:  docker compose --profile ops run --rm agent-credentials list
 * Locally:            npm run agent:credentials -w server -- list
 *
 * A COMMAND, NOT CONFIGURATION (deliberate, same as purge-sessions.ts): a token
 * in an environment variable is a token in the deployment's shell history, its
 * process listing and its container inspect output. This mints one, stores only
 * its hash, and prints the plaintext ONCE — there is nowhere to read it back
 * from afterwards, by design.
 *
 * Reads the environment directly rather than loadConfig(), like backup.ts: this
 * needs no ANTHROPIC or SHOPIFY secrets, and rotating a leaked credential must
 * not be blocked by an unrelated key being absent.
 */

/**
 * An agent id is data an operator types, and it ends up inside a conversation
 * key that other machinery claims by. The same charset the wire accepts for a
 * correlation id (inbox/a2a.ts), for the same reason: no separator this build
 * uses may appear inside one.
 */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const USAGE = `Usage:
  agent-credentials list
  agent-credentials add <agent-id> --reach <id,id,...> [--callback <url-prefix>]
  agent-credentials rotate <agent-id>
  agent-credentials remove <agent-id>

  add     mints a token, stores only its hash, and prints the token ONCE.
  rotate  replaces the token; the previous one stops working immediately.
  remove  closes the door for that caller.`;

interface Options {
  reach: string[];
  callback?: string;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { reach: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--reach") {
      if (!value) throw new Error("--reach needs a comma-separated list of agent ids");
      options.reach = value
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      i++;
    } else if (flag === "--callback") {
      if (!value) throw new Error("--callback needs a URL prefix");
      options.callback = value.trim();
      i++;
    } else {
      throw new Error(`unknown option "${flag ?? ""}"`);
    }
  }
  return options;
}

/**
 * A callback prefix must end in '/', and the reason is a real attack rather
 * than tidiness: "https://super.internal/callbacks" also prefixes
 * "https://super.internal/callbacks.evil.example/x", and the door's own origin
 * check should not be the only thing standing between a typo and a request we
 * make on a caller's say-so.
 */
function checkCallback(prefix: string): void {
  let url: URL;
  try {
    url = new URL(prefix);
  } catch {
    throw new Error(`--callback "${prefix}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--callback must be an http(s) URL");
  }
  if (!prefix.endsWith("/")) {
    throw new Error("--callback must end with '/', so it cannot prefix a neighbouring host or path");
  }
}

/** Warn, never refuse: a credential may legitimately be created before its agent ships. */
function warnUnknownReach(reach: string[], agentsDir: string): void {
  for (const id of reach) {
    if (!existsSync(join(agentsDir, id, "agent.yaml"))) {
      console.warn(
        `WARNING: reach names "${id}", which has no definition in ${agentsDir}. ` +
          "Calls to it will be refused until that agent exists.",
      );
    }
  }
}

function printCredential(agentId: string, token: string): void {
  console.log(`Credential for "${agentId}" written. The token is shown ONCE:\n`);
  console.log(`  ${token}\n`);
  console.log(
    "Store it in the CALLER's configuration now. Only its SHA-256 is kept here, so it\n" +
      "cannot be recovered — a lost token is replaced with `rotate`, not looked up.",
  );
}

function list(db: DB): void {
  const credentials = listAgentCredentials(db);
  if (credentials.length === 0) {
    console.log("No credentials. The agent door is CLOSED: every request is refused with 401.");
    return;
  }
  for (const credential of credentials) {
    const reach = credential.reach.length > 0 ? credential.reach.join(", ") : "(nothing)";
    const callback = credential.callbackPrefix ?? "(none)";
    console.log(`${credential.agentId}\n  reach: ${reach}\n  callback prefix: ${callback}`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const [command = "list", agentId, ...rest] = process.argv.slice(2);
  const dbPath = resolveDataPath(process.env["DB_PATH"]?.trim() || "./data/vitrina.db");
  const agentsDir = resolveDataPath(process.env["AGENT_DEFINITIONS_DIR"]?.trim() || "agents");
  const ownerPhoneNumbers = loadOwnerPhoneNumbers();

  // BEFORE opening the database. Opening it runs the schema migration, and a
  // database from an older build has its sessions keyed by phone alone — the
  // migration is where those rows are assigned to an agent, using this
  // allowlist. With an empty one every session, the owner's included, would be
  // filed under the customer agent, and an owner mid-listing would lose it.
  // Managing a credential must not cost that; the same refusal guards the purge
  // tool (data/purge.ts), for the same reason.
  if (ownerPhoneNumbers.size === 0) {
    throw new Error(
      "OWNER_PHONE_NUMBERS is empty — refusing to open the database, since doing so may migrate " +
        "sessions and would file the owner's under the customer agent. Set the allowlist and retry.",
    );
  }

  const db = openDb(dbPath, {
    // The server's own mapping: a session migrated here must be one the server
    // will still find.
    legacyAgentIdFor: (phone: string) => agentIdForPhone({ ownerPhoneNumbers }, phone),
  });
  try {
    if (command === "list") return list(db);

    if (!agentId || !AGENT_ID.test(agentId)) {
      throw new Error(`"${agentId ?? ""}" is not a valid agent id.\n\n${USAGE}`);
    }

    if (command === "add") {
      // `add` NEVER overwrites. The write itself is an upsert, so a second
      // `add` would silently replace a live token and the caller using it would
      // start failing with 401 for no reason anyone would connect to this
      // command. Replacing a credential is `rotate`, and it has to be asked for.
      if (listAgentCredentials(db).some((c) => c.agentId === agentId)) {
        throw new Error(
          `"${agentId}" already has a credential. Use \`rotate\` to replace its token, or ` +
            "`remove` first if the reach or callback must change.",
        );
      }
      const options = parseOptions(rest);
      for (const id of options.reach) {
        if (!AGENT_ID.test(id)) throw new Error(`"${id}" is not a valid agent id in --reach`);
      }
      if (options.reach.includes(agentId)) {
        throw new Error("an agent cannot reach itself; the door refuses such a call anyway");
      }
      if (options.callback !== undefined) checkCallback(options.callback);
      warnUnknownReach(options.reach, agentsDir);
      const token = mintAgentToken();
      // A token that already identifies somebody is a collision no operator
      // could diagnose. 256 bits make this impossible in practice; the check
      // costs one scan of a handful of rows and rules it out entirely.
      if (findAgentByToken(db, token)) throw new Error("minted a token that is already in use");
      upsertAgentCredential(db, {
        agentId,
        token,
        reach: options.reach,
        ...(options.callback !== undefined ? { callbackPrefix: options.callback } : {}),
      });
      printCredential(agentId, token);
      return;
    }

    if (command === "rotate") {
      const existing = listAgentCredentials(db).find((c) => c.agentId === agentId);
      if (!existing) throw new Error(`no credential for "${agentId}"; use \`add\` to create one`);
      const token = mintAgentToken();
      // Reach and callback are CARRIED OVER: rotation is about the secret, and
      // a rotate that silently reset the permissions would look like it worked
      // and then refuse every call the caller used to make.
      upsertAgentCredential(db, {
        agentId,
        token,
        reach: existing.reach,
        ...(existing.callbackPrefix !== undefined
          ? { callbackPrefix: existing.callbackPrefix }
          : {}),
      });
      console.log("The previous token stops working with this write. There is no overlap window.");
      printCredential(agentId, token);
      return;
    }

    if (command === "remove") {
      const removed = deleteAgentCredential(db, agentId);
      console.log(
        removed
          ? `Removed "${agentId}". Its next request is refused with 401.`
          : `No credential for "${agentId}"; nothing to remove.`,
      );
      return;
    }

    throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error("agent-credentials failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
