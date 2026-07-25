import { describe, expect, it } from "vitest";
import { buildAgentEnv } from "../src/agent/agent.js";
import type { Config } from "../src/config.js";

/**
 * Only the fields buildAgentEnv reads. Typed as a Pick rather than a full
 * Config so adding an unrelated config field never touches this file.
 */
type EnvConfig = Pick<
  Config,
  | "anthropicApiKey"
  | "agentAuthToken"
  | "agentBaseUrl"
  | "model"
  | "smallFastModel"
  | "agentExtraBody"
  | "maxThinkingTokens"
>;

const ANTHROPIC: EnvConfig = {
  anthropicApiKey: "sk-ant-1",
  agentAuthToken: "",
  agentBaseUrl: "https://api.anthropic.com",
  model: "claude-haiku-4-5",
  smallFastModel: "claude-haiku-4-5",
  agentExtraBody: {},
  maxThinkingTokens: 0,
};

const DEEPSEEK: EnvConfig = {
  anthropicApiKey: "",
  agentAuthToken: "ds-token",
  agentBaseUrl: "https://api.deepseek.com/anthropic",
  model: "deepseek-v4-flash",
  smallFastModel: "deepseek-v4-flash",
  agentExtraBody: { output_config: { effort: "high" } },
  maxThinkingTokens: 4096,
};

const build = (config: EnvConfig) => buildAgentEnv(config as Config);

describe("buildAgentEnv", () => {
  // NOT cosmetic. The SDK's `env` option REPLACES the environment rather than
  // merging into it, so dropping the spread strips PATH and the Claude Code
  // subprocess never starts at all.
  it("keeps the ambient environment, so the subprocess can still run", () => {
    process.env["TEST_AMBIENT_MARKER"] = "present";
    try {
      const env = build(ANTHROPIC);
      expect(env["TEST_AMBIENT_MARKER"]).toBe("present");
      expect(env["PATH"]).toBe(process.env["PATH"]);
    } finally {
      delete process.env["TEST_AMBIENT_MARKER"];
    }
  });

  // Config is the single source of truth: a stray shell variable must not
  // outvote it and quietly send production traffic to another provider.
  it("overrides an ambient endpoint with the configured one", () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://leftover.example";
    try {
      expect(build(DEEPSEEK)["ANTHROPIC_BASE_URL"]).toBe("https://api.deepseek.com/anthropic");
    } finally {
      delete process.env["ANTHROPIC_BASE_URL"];
    }
  });

  describe("credential form", () => {
    it("sends x-api-key style when only an Anthropic key is configured", () => {
      const env = build(ANTHROPIC);
      expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-1");
      expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    });

    it("sends Bearer style when an auth token is configured", () => {
      const env = build(DEEPSEEK);
      expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("ds-token");
      expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    });

    // Leaving a stale ANTHROPIC_API_KEY in the subprocess environment alongside
    // a Bearer token lets the CLI pick whichever it resolves first — a
    // coin-flip between providers is not a deployment.
    it("never leaks an ambient Anthropic key into a Bearer deployment", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-leftover";
      try {
        expect(build(DEEPSEEK)["ANTHROPIC_API_KEY"]).toBeUndefined();
      } finally {
        delete process.env["ANTHROPIC_API_KEY"];
      }
    });
  });

  describe("model tiers", () => {
    // The CLI resolves the utility tier through several code paths. An unset
    // one keeps asking for the compiled-in Haiku default — which DeepSeek
    // answers by SILENTLY substituting its own model rather than erroring, so
    // the mistake hides behind a perfectly good reply.
    it("pins every small/fast resolution path, not just the main model", () => {
      const env = build(DEEPSEEK);
      expect(env["ANTHROPIC_MODEL"]).toBe("deepseek-v4-flash");
      expect(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"]).toBe("deepseek-v4-flash");
      expect(env["ANTHROPIC_SMALL_FAST_MODEL"]).toBe("deepseek-v4-flash");
      expect(env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBe("deepseek-v4-flash");
    });

    it("keeps the two tiers independent when they are configured apart", () => {
      const env = build({ ...DEEPSEEK, smallFastModel: "deepseek-v4-pro" });
      expect(env["ANTHROPIC_MODEL"]).toBe("deepseek-v4-flash");
      expect(env["ANTHROPIC_SMALL_FAST_MODEL"]).toBe("deepseek-v4-pro");
    });
  });

  describe("thinking knobs", () => {
    it("omits both knobs entirely when neither is configured", () => {
      const env = build(ANTHROPIC);
      expect(env["MAX_THINKING_TOKENS"]).toBeUndefined();
      expect(env["CLAUDE_CODE_EXTRA_BODY"]).toBeUndefined();
    });

    it("passes the thinking budget as a string", () => {
      expect(build(DEEPSEEK)["MAX_THINKING_TOKENS"]).toBe("4096");
    });

    // The ONLY lever that reaches DeepSeek's effort control: it ignores
    // thinking.budget_tokens outright, and SDK 0.1.77's CLAUDE_CODE_EFFORT_LEVEL
    // silently discards the "max" value DeepSeek's own docs prescribe.
    it("serialises the extra body the CLI merges into the request", () => {
      expect(build(DEEPSEEK)["CLAUDE_CODE_EXTRA_BODY"]).toBe(
        '{"output_config":{"effort":"high"}}',
      );
    });

    it("round-trips as JSON the CLI can parse", () => {
      const raw = build(DEEPSEEK)["CLAUDE_CODE_EXTRA_BODY"]!;
      expect(JSON.parse(raw)).toEqual({ output_config: { effort: "high" } });
    });
  });
});
