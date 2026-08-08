import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadDotEnv, optionalBool, optionalJsonObject, REPO_ROOT } from "../src/config.js";

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

const JSON_VAR = "TEST_OPTIONAL_JSON";

describe("optionalJsonObject", () => {
  afterEach(() => {
    delete process.env[JSON_VAR];
  });

  it("returns the fallback when unset or empty", () => {
    expect(optionalJsonObject(JSON_VAR, { a: 1 })).toEqual({ a: 1 });
    process.env[JSON_VAR] = "  ";
    expect(optionalJsonObject(JSON_VAR, {})).toEqual({});
  });

  it("parses a JSON object", () => {
    process.env[JSON_VAR] = '{"output_config":{"effort":"high"}}';
    expect(optionalJsonObject(JSON_VAR, {})).toEqual({ output_config: { effort: "high" } });
  });

  // The bundled CLI only LOGS an error for an unparseable CLAUDE_CODE_EXTRA_BODY
  // and carries on with an empty object, so a typo would silently disable the
  // knob for the life of the deploy. Failing the boot is the whole point.
  it("rejects malformed JSON instead of silently sending nothing", () => {
    process.env[JSON_VAR] = "{not json}";
    expect(() => optionalJsonObject(JSON_VAR, {})).toThrow(/expected a JSON object/);
  });

  it("rejects a JSON array or scalar — the CLI merges an object or nothing", () => {
    process.env[JSON_VAR] = "[1,2]";
    expect(() => optionalJsonObject(JSON_VAR, {})).toThrow(/expected a JSON object/);
    process.env[JSON_VAR] = '"high"';
    expect(() => optionalJsonObject(JSON_VAR, {})).toThrow(/expected a JSON object/);
    process.env[JSON_VAR] = "null";
    expect(() => optionalJsonObject(JSON_VAR, {})).toThrow(/expected a JSON object/);
  });
});

describe("loadConfig agent credential and model tiers", () => {
  const OWNED = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "MODEL",
    "SMALL_FAST_MODEL",
    "BRIDGE_WEBHOOK_SECRET",
    "BRIDGE_URL",
    "BRIDGE_API_TOKEN",
    "BRIDGE_STAGING_DIR",
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of OWNED) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    // The unrelated required ones, so loadConfig reaches the credential rule.
    process.env["BRIDGE_WEBHOOK_SECRET"] = "whsec";
    process.env["BRIDGE_URL"] = "http://bridge:3002";
    process.env["BRIDGE_API_TOKEN"] = "tok";
    process.env["BRIDGE_STAGING_DIR"] = "/tmp/inbound";
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // A DeepSeek deployment has no Anthropic key at all, so a hard
  // required("ANTHROPIC_API_KEY") would make the provider swap impossible to
  // actually deploy.
  it("accepts a Bearer token with no Anthropic key at all", () => {
    process.env["ANTHROPIC_AUTH_TOKEN"] = "ds-token";
    const config = loadConfig();
    expect(config.agentAuthToken).toBe("ds-token");
    expect(config.anthropicApiKey).toBe("");
  });

  it("accepts an Anthropic key with no Bearer token", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-1";
    expect(loadConfig().anthropicApiKey).toBe("sk-ant-1");
  });

  // The old fail-fast guarantee: a credential-less boot must still die here
  // rather than on the first customer message.
  it("still refuses to boot with neither credential", () => {
    expect(() => loadConfig()).toThrow(/Missing agent credential/);
  });

  it("defaults the endpoint to Anthropic and strips a trailing slash", () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    expect(loadConfig().agentBaseUrl).toBe("https://api.anthropic.com");
    process.env["ANTHROPIC_BASE_URL"] = "https://api.deepseek.com/anthropic/";
    expect(loadConfig().agentBaseUrl).toBe("https://api.deepseek.com/anthropic");
  });

  // Two tiers, one variable when they agree — but they stay SEPARATE config
  // values so they can be re-split later without a code change.
  it("defaults the small/fast tier to the main model, and lets it differ", () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    process.env["MODEL"] = "deepseek-v4-flash";
    expect(loadConfig().smallFastModel).toBe("deepseek-v4-flash");

    process.env["SMALL_FAST_MODEL"] = "deepseek-v4-pro";
    const config = loadConfig();
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.smallFastModel).toBe("deepseek-v4-pro");
  });
});

// Two storefront hosts: the branded one customers see and the anonymous one a
// colleague's client sees. They are separate config values because the domain is
// the one piece of branding a de-branded PAGE cannot hide.
describe("loadConfig storefront hosts", () => {
  const OWNED = [
    "STOREFRONT_BASE_URL",
    "ANON_BASE_URL",
    "ANTHROPIC_API_KEY",
    "BRIDGE_WEBHOOK_SECRET",
    "BRIDGE_URL",
    "BRIDGE_API_TOKEN",
    "BRIDGE_STAGING_DIR",
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of OWNED) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    process.env["ANTHROPIC_API_KEY"] = "k";
    process.env["BRIDGE_WEBHOOK_SECRET"] = "whsec";
    process.env["BRIDGE_URL"] = "http://bridge:3002";
    process.env["BRIDGE_API_TOKEN"] = "tok";
    process.env["BRIDGE_STAGING_DIR"] = "/tmp/inbound";
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // A deployment on one domain must keep working untouched — and every dev
  // machine is such a deployment. The web app mirrors this exact fallback, so
  // the two cannot disagree about which host an anonymous link lives on.
  it("defaults the anonymous host to the branded one", () => {
    process.env["STOREFRONT_BASE_URL"] = "https://marca.example.com";
    const config = loadConfig();
    expect(config.storefrontBaseUrl).toBe("https://marca.example.com");
    expect(config.anonBaseUrl).toBe("https://marca.example.com");
  });

  it("keeps the two hosts apart once the anonymous one is set", () => {
    process.env["STOREFRONT_BASE_URL"] = "https://marca.example.com";
    process.env["ANON_BASE_URL"] = "https://anonimo.example.net";
    const config = loadConfig();
    expect(config.storefrontBaseUrl).toBe("https://marca.example.com");
    expect(config.anonBaseUrl).toBe("https://anonimo.example.net");
  });

  it("strips a trailing slash from both, so a link never carries a double slash", () => {
    process.env["STOREFRONT_BASE_URL"] = "https://marca.example.com/";
    process.env["ANON_BASE_URL"] = "https://anonimo.example.net/";
    const config = loadConfig();
    expect(config.storefrontBaseUrl).toBe("https://marca.example.com");
    expect(config.anonBaseUrl).toBe("https://anonimo.example.net");
  });

  // An empty value is how Coolify presents a variable that was added and left
  // blank — it must read as "unset", not as an empty host.
  it("treats an empty ANON_BASE_URL as unset", () => {
    process.env["STOREFRONT_BASE_URL"] = "https://marca.example.com";
    process.env["ANON_BASE_URL"] = "   ";
    expect(loadConfig().anonBaseUrl).toBe("https://marca.example.com");
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
