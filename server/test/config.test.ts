import { afterEach, describe, expect, it } from "vitest";
import { optionalBool } from "../src/config.js";

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
