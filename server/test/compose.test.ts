import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT } from "../src/config.js";

/**
 * `compose.yaml` IS DEPLOYMENT, and nothing else in this repo checks it.
 *
 * WHY THIS EXISTS, written from the failure that caused it: an edit to the ops
 * services left three orphan lines behind — a stray `volumes:` key at the wrong
 * indentation — which made the whole document invalid YAML. Every test passed,
 * the typecheck passed, the build passed, and the deploy died with
 * `Error: no such service: server`. A malformed compose file is invisible to
 * every other check this repo has, because no other check reads it.
 *
 * It is also the one file that carries paths NOTHING ELSE VALIDATES. CLAUDE.md
 * states the invariant — entry-point paths appear in `compose.yaml` commands and
 * in `server/package.json` scripts, so moving one means updating both — and an
 * invariant stated in prose is one a rename silently breaks. The `dist/` path in
 * an entrypoint is a string to YAML, to TypeScript and to the bundler alike; the
 * only thing that notices it is wrong is an operator running the command.
 */

const COMPOSE_PATH = join(REPO_ROOT, "compose.yaml");

interface ComposeFile {
  services?: Record<string, { entrypoint?: string[]; command?: string[]; profiles?: string[] }>;
  volumes?: Record<string, unknown>;
}

function compose(): ComposeFile {
  return parse(readFileSync(COMPOSE_PATH, "utf8")) as ComposeFile;
}

describe("compose.yaml is a valid deployment", () => {
  /**
   * THE ONE THAT WOULD HAVE CAUGHT IT. A stray key at the wrong indentation
   * makes the document unparseable, and compose then reports "no such service"
   * for every service — including ones plainly written in the file.
   */
  it("parses, and its top-level shape is what compose expects", () => {
    const file = compose();

    expect(file.services).toBeTypeOf("object");
    expect(file.volumes).toBeTypeOf("object");
  });

  /**
   * The two that run continuously. Coolify builds `server` by name, so losing
   * it is a failed deploy rather than a degraded one.
   */
  it("defines the two long-running services", () => {
    const services = compose().services ?? {};

    expect(Object.keys(services)).toEqual(expect.arrayContaining(["server", "bridge"]));
    // Neither may sit behind a profile: a profiled service is not started by a
    // plain `up`, so the store would deploy green and answer nothing.
    expect(services["server"]?.profiles).toBeUndefined();
    expect(services["bridge"]?.profiles).toBeUndefined();
  });

  it("defines every ops entry point, each behind a profile", () => {
    const services = compose().services ?? {};

    for (const name of [
      "backup",
      "purge-sessions",
      "agent-credentials",
      "role-assignments",
      "test-console",
      "admin-access",
    ]) {
      expect(services[name], `${name} is missing from compose.yaml`).toBeDefined();
      // Behind a profile, or a plain `up` would run a one-shot ops command as
      // if it were a service — a purge on every deploy, in the worst case.
      expect(services[name]?.profiles?.length ?? 0).toBeGreaterThan(0);
    }
  });

  /**
   * CLAUDE.md states this as an invariant in prose: an entry-point path lives in
   * compose AND in package.json, and moving it means updating both. Prose is
   * what a rename silently breaks — the path is just a string everywhere it
   * appears, so nothing but an operator running the command ever notices.
   *
   * Checked against the SOURCE file rather than `dist/`, because dist only
   * exists after a build and a test that passes only sometimes is worse than no
   * test.
   */
  it("points every entry point at a source file that exists", () => {
    const services = compose().services ?? {};
    const entryPoints: string[] = [];

    for (const service of Object.values(services)) {
      for (const token of [...(service.entrypoint ?? []), ...(service.command ?? [])]) {
        if (typeof token === "string" && token.startsWith("server/dist/")) entryPoints.push(token);
      }
    }

    // A guard on the guard: if this ever finds nothing, the check above has
    // stopped looking at what it thinks it is looking at.
    expect(entryPoints.length).toBeGreaterThan(0);

    for (const distPath of entryPoints) {
      const sourcePath = join(
        REPO_ROOT,
        distPath.replace("server/dist/", "server/src/").replace(/\.js$/, ".ts"),
      );
      expect(existsSync(sourcePath), `${distPath} has no source at ${sourcePath}`).toBe(true);
    }
  });

  /**
   * A service that mounts nothing cannot see the database, and the failure is a
   * fresh empty SQLite file rather than an error — so a purge would report
   * nothing to purge, and `admin-access list` would report no sessions, both
   * perfectly calmly.
   */
  it("gives every database-touching entry point the data volume", () => {
    const services = compose().services ?? {};

    for (const name of [
      "backup",
      "purge-sessions",
      "agent-credentials",
      "role-assignments",
      "test-console",
      "admin-access",
      "server",
    ]) {
      const mounts = (services[name] as { volumes?: string[] } | undefined)?.volumes ?? [];
      expect(
        mounts.some((mount) => mount.startsWith("vitrina-data:")),
        `${name} does not mount vitrina-data`,
      ).toBe(true);
    }
  });
});
