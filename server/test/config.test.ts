import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv, optionalBool, REPO_ROOT } from "../src/config.js";

const VAR = "TEST_OPTIONAL_BOOL";

describe("optionalBool", () => {
  afterEach(() => {
    delete process.env[VAR];
  });

  it("returns the fallback when the variable is unset or empty", () => {
    expect(optionalBool(VAR, true)).toBe(true);
    expect(optionalBool(VAR, false)).toBe(false);
    process.env[VAR] = "   ";
    expect(optionalBool(VAR, true)).toBe(true);
  });

  it("parses true/false/1/0 case-insensitively", () => {
    for (const [raw, parsed] of [
      ["true", true],
      ["TRUE", true],
      ["1", true],
      ["false", false],
      ["False", false],
      ["0", false],
    ] as const) {
      process.env[VAR] = raw;
      expect(optionalBool(VAR, !parsed)).toBe(parsed); // fallback must not win
    }
  });

  it("rejects anything else instead of silently disabling a feature", () => {
    process.env[VAR] = "yes";
    expect(() => optionalBool(VAR, true)).toThrow(/expected true\/false\/1\/0/);
  });
});

// Vitest runs from server/ — the same cwd as `npm run dev:server`, which is
// exactly what broke this: a relative ".env" resolved to server/.env, missed,
// and was swallowed by the catch below it, so every variable silently fell back
// to its default. Invisible for most of them, but an empty OWNER_PHONE_NUMBERS
// makes every phone read as a customer — the owner included.
describe("loadDotEnv", () => {
  it("reads the repo-root .env even when the cwd is the server workspace", () => {
    if (!existsSync(join(REPO_ROOT, ".env"))) return; // nothing to assert against
    delete process.env["OWNER_PHONE_NUMBERS"];

    loadDotEnv();

    expect(process.env["OWNER_PHONE_NUMBERS"]).toBeDefined();
  });
});
