import { describe, expect, it } from "vitest";
import { buildRosterLink } from "../src/data/test-console-credentials.js";

/**
 * `test-console-credentials.ts` is a CLI entry point in the same shape as
 * `agent-credentials.ts` and `role-assignments.ts` — neither of which has a
 * test file of its own, because their logic is either a thin argv parse or a
 * call straight through to an already-tested data-layer function
 * (`test-roster.test.ts` covers add/rotate/list/find). `buildRosterLink` is
 * the one piece of genuinely new logic this file adds — the fragment-vs-query
 * choice and placeholder-host detection — so it is exported and tested
 * directly rather than driving the CLI's `main()` through argv and stdout.
 */

const TOKEN = "a".repeat(64);

describe("buildRosterLink", () => {
  it("puts the token in the URL FRAGMENT, never a query string", () => {
    const { link, path } = buildRosterLink(TOKEN, "https://shop.example.org");
    expect(link).toBe(`https://shop.example.org/test-console#t=${TOKEN}`);
    expect(path).toBe(`/test-console#t=${TOKEN}`);
    expect(link).not.toContain("?t=");
  });

  it("strips a trailing slash from the base before joining", () => {
    const { link } = buildRosterLink(TOKEN, "https://shop.example.org/");
    expect(link).toBe(`https://shop.example.org/test-console#t=${TOKEN}`);
  });

  it("treats an unset base as a placeholder and returns only the path", () => {
    const result = buildRosterLink(TOKEN, undefined);
    expect(result.link).toBeNull();
    expect(result.placeholder).toBe(true);
    expect(result.path).toBe(`/test-console#t=${TOKEN}`);
  });

  it("treats an empty or whitespace-only base as a placeholder", () => {
    expect(buildRosterLink(TOKEN, "").placeholder).toBe(true);
    expect(buildRosterLink(TOKEN, "   ").placeholder).toBe(true);
  });

  it("treats a malformed URL as a placeholder rather than throwing", () => {
    const result = buildRosterLink(TOKEN, "not a url");
    expect(result.link).toBeNull();
    expect(result.placeholder).toBe(true);
  });

  // localhost is the default a bare `optional("PUBLIC_BASE_URL", ...)` would
  // fall back to in config.ts — real on a developer's machine, useless to a
  // phone holder anywhere else.
  it("treats localhost and 127.0.0.1 as placeholders", () => {
    expect(buildRosterLink(TOKEN, "http://localhost:3001").placeholder).toBe(true);
    expect(buildRosterLink(TOKEN, "http://127.0.0.1:3001").placeholder).toBe(true);
  });

  // The literal sample value in env.sample, so a deployment that copied it
  // without editing gets caught rather than handed a dead link.
  it("treats the env.sample placeholder host as a placeholder", () => {
    const result = buildRosterLink(TOKEN, "https://your-tunnel.example.com");
    expect(result.link).toBeNull();
    expect(result.placeholder).toBe(true);
  });

  it("accepts a real-looking host", () => {
    const result = buildRosterLink(TOKEN, "https://vitrina.mystore.com");
    expect(result.link).toBe(`https://vitrina.mystore.com/test-console#t=${TOKEN}`);
    expect(result.placeholder).toBe(false);
  });
});
