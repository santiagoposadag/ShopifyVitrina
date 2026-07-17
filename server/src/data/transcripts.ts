import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The Agent SDK's conversation transcripts on disk. The SQLite `sessions` table
 * holds the session id; the transcript itself lives under the SDK's home dir
 * (the `vitrina-sessions` volume), so the two stores can diverge — this module
 * is the only place that knows that layout:
 *
 *   <projects>/<project>/<session-id>.jsonl   the transcript
 *   <projects>/<project>/<session-id>/        a sibling directory kept with it
 *
 * Both are orphaned when a session id is dropped, and nothing else deletes them.
 *
 * THE ROOT HAS NO DEFAULT, AND MUST NOT GET ONE (critical):
 * the SDK derives it as $HOME/.claude/projects/<cwd-with-slashes-as-dashes>. On
 * a developer machine the server's cwd is this repo, which munges to the SAME
 * directory as that developer's own Claude Code transcripts for this repo — so a
 * "sensible default" here would make `npm run purge:sessions` delete real work.
 * The container sets AGENT_TRANSCRIPTS_DIR explicitly; everywhere else the sweep
 * is inert. That is the entire safety story.
 *
 * The root may be either the projects directory or a single project directory:
 * we search both levels rather than reconstruct that `<cwd-with-slashes-as-dashes>`
 * name, which is the SDK's private business. Guessing it wrong would not corrupt
 * anything — it would silently match nothing and leave the leak running.
 */

/** A session id, as the SDK names its files. Anything else is not ours to touch. */
const SESSION_ID_RE = /^[0-9a-f-]{36}$/i;

/** The configured transcript root, or undefined when unset (see above). */
export function transcriptsDir(): string | undefined {
  const dir = process.env["AGENT_TRANSCRIPTS_DIR"]?.trim();
  return dir ? dir : undefined;
}

/** The root plus its immediate subdirectories: transcripts live at one level or the other. */
function searchDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const dirs = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !SESSION_ID_RE.test(entry.name)) dirs.push(join(root, entry.name));
  }
  return dirs;
}

/**
 * Delete one session's transcript and its sibling directory, wherever under the
 * root they live. Safe by construction: callers pass ids read from OUR database,
 * so an id we never stored can never be deleted.
 */
export function deleteTranscript(root: string, sessionId: string): boolean {
  if (!SESSION_ID_RE.test(sessionId)) return false;
  let removed = false;
  for (const dir of searchDirs(root)) {
    for (const target of [join(dir, `${sessionId}.jsonl`), join(dir, sessionId)]) {
      if (!existsSync(target)) continue;
      rmSync(target, { recursive: true, force: true });
      removed = true;
    }
  }
  return removed;
}

/**
 * Delete transcripts that no session row references AND that are older than the
 * session expiry window. Returns the number of session ids removed.
 *
 * Unreferenced means dead: the `sessions` table is the only path to a session
 * id, so a transcript nothing points at can never be resumed again.
 *
 * The age check is NOT redundant — it closes a race. runAgentTurn persists the
 * session id only AFTER the turn, so mid-turn a live transcript exists that no
 * row references yet; sweeping on "unreferenced" alone would delete the
 * conversation out from under an in-flight reply. Past the expiry window,
 * getSessionId would refuse to resume it anyway, so deleting is safe.
 */
export function sweepOrphanedTranscripts(
  root: string,
  liveSessionIds: Iterable<string>,
  maxAgeDays: number,
): number {
  const live = new Set(liveSessionIds);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  // A session's transcript and its directory are touched independently, so age
  // the pair by its NEWEST artifact: a stale .jsonl beside a fresh directory is
  // an active session, and judging either artifact alone would delete it.
  const lastTouched = new Map<string, number>();
  for (const dir of searchDirs(root)) {
    for (const entry of readdirSync(dir)) {
      const sessionId = entry.endsWith(".jsonl") ? entry.slice(0, -".jsonl".length) : entry;
      if (!SESSION_ID_RE.test(sessionId) || live.has(sessionId)) continue;
      const mtime = statSync(join(dir, entry)).mtimeMs;
      lastTouched.set(sessionId, Math.max(lastTouched.get(sessionId) ?? 0, mtime));
    }
  }

  let removed = 0;
  for (const [sessionId, mtime] of lastTouched) {
    if (mtime >= cutoff) continue; // still in play — an in-flight turn has no row yet
    if (deleteTranscript(root, sessionId)) removed += 1;
  }
  return removed;
}
