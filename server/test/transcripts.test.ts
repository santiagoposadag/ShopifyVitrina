import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteTranscript,
  sweepOrphanedTranscripts,
  transcriptsDir,
} from "../src/data/transcripts.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const MAX_AGE_DAYS = 7;

let root: string;

/** Write a session's two artifacts — the transcript and its sibling directory. */
function seed(sessionId: string, ageDays: number): void {
  const file = join(root, `${sessionId}.jsonl`);
  const dir = join(root, sessionId);
  writeFileSync(file, "{}\n");
  mkdirSync(dir, { recursive: true });
  const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(file, when, when);
  utimesSync(dir, when, when);
}

function exists(sessionId: string): boolean {
  return existsSync(join(root, `${sessionId}.jsonl`)) || existsSync(join(root, sessionId));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vitrina-transcripts-"));
  delete process.env["AGENT_TRANSCRIPTS_DIR"];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env["AGENT_TRANSCRIPTS_DIR"];
});

// The whole safety story of the sweep. The SDK derives its transcript root from
// $HOME/.claude/projects/<cwd-as-dashes>, which on a developer machine is the
// SAME directory as their own Claude Code history for this repo — so a default
// here would make `npm run purge:sessions` delete real work. There must not be one.
describe("transcriptsDir", () => {
  it("is undefined when AGENT_TRANSCRIPTS_DIR is unset — it never guesses a root", () => {
    expect(transcriptsDir()).toBeUndefined();
  });

  it("is undefined when the variable is present but blank", () => {
    process.env["AGENT_TRANSCRIPTS_DIR"] = "   ";
    expect(transcriptsDir()).toBeUndefined();
  });

  it("uses the configured root when one is set explicitly", () => {
    process.env["AGENT_TRANSCRIPTS_DIR"] = "/home/node/.claude/projects";
    expect(transcriptsDir()).toBe("/home/node/.claude/projects");
  });
});

describe("deleteTranscript", () => {
  it("removes both the transcript and its sibling directory", () => {
    seed(ID_A, 0);
    expect(deleteTranscript(root, ID_A)).toBe(true);
    expect(existsSync(join(root, `${ID_A}.jsonl`))).toBe(false);
    expect(existsSync(join(root, ID_A))).toBe(false);
  });

  it("ignores a name that is not a session id, whatever it points at", () => {
    // The ids come from our own DB, but this is the last line of defence
    // between a bad value and rm -rf on someone's home directory.
    writeFileSync(join(root, "notes.md"), "important");
    expect(deleteTranscript(root, "../../../etc")).toBe(false);
    expect(deleteTranscript(root, "notes.md")).toBe(false);
    expect(existsSync(join(root, "notes.md"))).toBe(true);
  });

  it("reports false when there was nothing to remove", () => {
    expect(deleteTranscript(root, ID_A)).toBe(false);
  });
});

describe("sweepOrphanedTranscripts", () => {
  it("removes a transcript no session row references once it is past the expiry window", () => {
    seed(ID_A, MAX_AGE_DAYS + 1);
    expect(sweepOrphanedTranscripts(root, [], MAX_AGE_DAYS)).toBe(1);
    expect(exists(ID_A)).toBe(false);
  });

  it("keeps a referenced transcript no matter how old it is", () => {
    // The row is what makes it resumable; age alone is not permission to delete.
    seed(ID_A, MAX_AGE_DAYS * 10);
    expect(sweepOrphanedTranscripts(root, [ID_A], MAX_AGE_DAYS)).toBe(0);
    expect(exists(ID_A)).toBe(true);
  });

  it("keeps an unreferenced transcript that is still fresh", () => {
    // The race the age check exists for: runAgentTurn persists the session id
    // only AFTER the turn, so an in-flight conversation has a transcript that no
    // row points at yet. Sweeping on "unreferenced" alone would delete it
    // mid-reply.
    seed(ID_A, 0);
    expect(sweepOrphanedTranscripts(root, [], MAX_AGE_DAYS)).toBe(0);
    expect(exists(ID_A)).toBe(true);
  });

  it("ages a session by its NEWEST artifact, not whichever it reads first", () => {
    // A stale .jsonl beside a freshly-touched directory is an active session.
    // Judging either artifact on its own would delete a live transcript.
    seed(ID_A, MAX_AGE_DAYS + 1);
    const now = new Date();
    utimesSync(join(root, ID_A), now, now);

    expect(sweepOrphanedTranscripts(root, [], MAX_AGE_DAYS)).toBe(0);
    expect(exists(ID_A)).toBe(true);
  });

  it("leaves files that are not session transcripts alone", () => {
    writeFileSync(join(root, "config.json"), "{}");
    const old = new Date(Date.now() - MAX_AGE_DAYS * 10 * 24 * 60 * 60 * 1000);
    utimesSync(join(root, "config.json"), old, old);

    expect(sweepOrphanedTranscripts(root, [], MAX_AGE_DAYS)).toBe(0);
    expect(existsSync(join(root, "config.json"))).toBe(true);
  });

  it("sweeps only the orphans, leaving the live session untouched", () => {
    seed(ID_A, MAX_AGE_DAYS + 1); // orphan
    seed(ID_B, MAX_AGE_DAYS + 1); // old, but still referenced

    expect(sweepOrphanedTranscripts(root, [ID_B], MAX_AGE_DAYS)).toBe(1);
    expect(exists(ID_A)).toBe(false);
    expect(exists(ID_B)).toBe(true);
  });

  it("does nothing when the root does not exist", () => {
    expect(sweepOrphanedTranscripts(join(root, "missing"), [], MAX_AGE_DAYS)).toBe(0);
  });
});

// How the container actually stores them: <projects>/<munged-cwd>/<id>.jsonl.
// We search the root AND one level down rather than rebuild that munged name,
// which is the SDK's private business — guessing it wrong would not corrupt
// anything, it would silently sweep nothing and leave the leak running.
describe("nested project directories", () => {
  const PROJECT = "-app"; // what /app munges to inside the container

  function seedNested(sessionId: string, ageDays: number): void {
    const dir = join(root, PROJECT);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    writeFileSync(file, "{}\n");
    const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    utimesSync(file, when, when);
  }

  it("sweeps an orphan inside a project directory", () => {
    seedNested(ID_A, MAX_AGE_DAYS + 1);
    expect(sweepOrphanedTranscripts(root, [], MAX_AGE_DAYS)).toBe(1);
    expect(existsSync(join(root, PROJECT, `${ID_A}.jsonl`))).toBe(false);
  });

  it("keeps a referenced transcript inside a project directory", () => {
    seedNested(ID_A, MAX_AGE_DAYS + 1);
    expect(sweepOrphanedTranscripts(root, [ID_A], MAX_AGE_DAYS)).toBe(0);
    expect(existsSync(join(root, PROJECT, `${ID_A}.jsonl`))).toBe(true);
  });

  it("deletes a named session's transcript from inside a project directory", () => {
    seedNested(ID_A, 0);
    expect(deleteTranscript(root, ID_A)).toBe(true);
    expect(existsSync(join(root, PROJECT, `${ID_A}.jsonl`))).toBe(false);
  });
});
