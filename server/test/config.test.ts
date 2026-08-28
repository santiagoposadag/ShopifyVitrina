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
    process.env["SHOPIFY_STORE_DOMAIN"] = "tienda.myshopify.com";
    process.env["SHOPIFY_ADMIN_TOKEN"] = "shpat_x";
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

// The store is the catalog. These two are required because there is no local
// fallback to degrade to: without them every product tool fails on its first
// call, and the fail-fast boot is what turns that into a startup error instead
// of an apology to the owner.
describe("loadConfig Shopify block", () => {
  const OWNED = [
    "SHOPIFY_STORE_DOMAIN",
    "SHOPIFY_ADMIN_TOKEN",
    "SHOPIFY_CLIENT_ID",
    "SHOPIFY_CLIENT_SECRET",
    "ECHO_MODE",
    "SHOPIFY_API_VERSION",
    "SHOPIFY_LOCATION_ID",
    "CATALOG_CACHE_TTL_MS",
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
    process.env["SHOPIFY_STORE_DOMAIN"] = "tienda.myshopify.com";
    process.env["SHOPIFY_ADMIN_TOKEN"] = "shpat_x";
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("refuses to boot without the store domain", () => {
    delete process.env["SHOPIFY_STORE_DOMAIN"];
    expect(() => loadConfig()).toThrow(/SHOPIFY_STORE_DOMAIN/);
  });

  // Two ways to hold Shopify credentials and neither is individually required.
  // Shopify stopped allowing new admin-created custom apps in January 2026, so a
  // new store has a Dev Dashboard client id and secret and NO token to paste;
  // a legacy custom app has only the token. Demanding either specifically makes
  // one of the two real deployments impossible to boot.
  it("boots on Dev Dashboard client credentials with no admin token", () => {
    delete process.env["SHOPIFY_ADMIN_TOKEN"];
    process.env["SHOPIFY_CLIENT_ID"] = "cid";
    process.env["SHOPIFY_CLIENT_SECRET"] = "csecret";

    const config = loadConfig();
    expect(config.shopifyAdminToken).toBe("");
    expect(config.shopifyClientId).toBe("cid");
    expect(config.shopifyClientSecret).toBe("csecret");
  });

  it("boots on a ready-made admin token with no client credentials", () => {
    const config = loadConfig();
    expect(config.shopifyAdminToken).toBe("shpat_x");
    expect(config.shopifyClientId).toBe("");
  });

  it("refuses to boot with NO Shopify credential at all", () => {
    // Fail here, not on the owner's first "¿qué tengo?".
    delete process.env["SHOPIFY_ADMIN_TOKEN"];
    expect(() => loadConfig()).toThrow(/Missing Shopify credential/);
  });

  // ECHO_MODE exists to prove the WhatsApp transport before a store and a model
  // are wired in. Requiring their credentials to boot into it would defeat the
  // entire point — the failure it diagnoses is the one where all three are new.
  it("boots with NO Shopify credential at all in echo mode", () => {
    delete process.env["SHOPIFY_ADMIN_TOKEN"];
    delete process.env["SHOPIFY_STORE_DOMAIN"];
    process.env["ECHO_MODE"] = "true";

    const config = loadConfig();
    expect(config.echoMode).toBe(true);
    expect(config.shopifyStoreDomain).toBe("");
  });

  it("boots with no AGENT credential either in echo mode", () => {
    // No turn ever runs, so there is nothing for a model key to authorise.
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["SHOPIFY_ADMIN_TOKEN"];
    process.env["ECHO_MODE"] = "true";

    expect(() => loadConfig()).not.toThrow();
  });

  it("still demands both credentials when echo mode is OFF", () => {
    // The relaxation must be scoped to the flag: a real deployment keeps its
    // fail-fast boot.
    process.env["ECHO_MODE"] = "false";
    delete process.env["SHOPIFY_ADMIN_TOKEN"];
    expect(() => loadConfig()).toThrow(/Missing Shopify credential/);
  });

  it("defaults echo mode OFF", () => {
    expect(loadConfig().echoMode).toBe(false);
  });

  it("refuses HALF a client credential pair", () => {
    // An id without a secret buys nothing, and the token request would fail on
    // the first catalog call instead of at boot — which is the whole point of
    // checking here.
    delete process.env["SHOPIFY_ADMIN_TOKEN"];
    process.env["SHOPIFY_CLIENT_ID"] = "cid";
    expect(() => loadConfig()).toThrow(/Missing Shopify credential/);

    delete process.env["SHOPIFY_CLIENT_ID"];
    process.env["SHOPIFY_CLIENT_SECRET"] = "csecret";
    expect(() => loadConfig()).toThrow(/Missing Shopify credential/);
  });

  // Everyone copies the domain out of a browser address bar, and the client
  // builds https://<domain>/admin/... — a scheme left on would produce a URL
  // with two of them and every catalog call would fail at DNS.
  it("strips a scheme and a trailing slash from the store domain", () => {
    process.env["SHOPIFY_STORE_DOMAIN"] = "https://tienda.myshopify.com/";
    expect(loadConfig().shopifyStoreDomain).toBe("tienda.myshopify.com");
  });

  // Pinned, not "latest": Shopify ships quarterly and deprecates on a rolling
  // schedule, so a silently-moving API is a silently-changing agent.
  it("pins an API version by default and lets it be overridden", () => {
    expect(loadConfig().shopifyApiVersion).toBe("2026-01");
    process.env["SHOPIFY_API_VERSION"] = "2026-07";
    expect(loadConfig().shopifyApiVersion).toBe("2026-07");
  });

  // A single-location store never has to be told which location, so this stays
  // optional; catalog.ts resolveLocation is what refuses to guess when there
  // is more than one.
  it("leaves the default location empty when it is not set", () => {
    expect(loadConfig().shopifyLocationId).toBe("");
  });

  // Zero is legal and means "never cache" — a store whose owner edits in the
  // Shopify admin while chatting wants exactly that.
  it("defaults the catalog cache TTL and accepts zero", () => {
    expect(loadConfig().catalogCacheTtlMs).toBe(60_000);
    process.env["CATALOG_CACHE_TTL_MS"] = "0";
    expect(loadConfig().catalogCacheTtlMs).toBe(0);
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

describe("loadConfig WhatsApp transport", () => {
  const OWNED = [
    "WHATSAPP_PROVIDER",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_VERIFY_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_GRAPH_VERSION",
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
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-1";
    process.env["SHOPIFY_STORE_DOMAIN"] = "tienda.myshopify.com";
    process.env["SHOPIFY_ADMIN_TOKEN"] = "shpat_x";
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function cloudEnv(): void {
    process.env["WHATSAPP_PROVIDER"] = "cloud";
    process.env["WHATSAPP_APP_SECRET"] = "app-secret";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "verify-token";
    process.env["WHATSAPP_PHONE_NUMBER_ID"] = "1234567890";
    process.env["WHATSAPP_ACCESS_TOKEN"] = "system-user-token";
  }

  function bridgeEnv(): void {
    process.env["BRIDGE_WEBHOOK_SECRET"] = "whsec";
    process.env["BRIDGE_URL"] = "http://bridge:3002";
    process.env["BRIDGE_API_TOKEN"] = "tok";
    process.env["BRIDGE_STAGING_DIR"] = "/tmp/inbound";
  }

  // The bridge stays the default so an existing deployment boots unchanged
  // after this merge, without anyone setting a new variable first.
  it("runs the bridge when nothing says otherwise", () => {
    bridgeEnv();
    expect(loadConfig().whatsappProvider).toBe("bridge");
  });

  it("boots a Cloud API deployment that has no bridge variables at all", () => {
    // There is no sidecar and no staging volume in that deployment. Requiring
    // BRIDGE_URL there would make the officially-supported transport the one
    // that cannot be deployed.
    cloudEnv();
    const config = loadConfig();
    expect(config.whatsappProvider).toBe("cloud");
    expect(config.whatsappPhoneNumberId).toBe("1234567890");
    // Empty, and both consumers already read that as "nothing staged here".
    expect(config.bridgeStagingDir).toBe("");
  });

  it("verifies inbound signatures with the app secret on the Cloud API", () => {
    // Meta signs with the app secret; the bridge signs with its own. Getting
    // this wrong rejects every inbound message with a perfectly valid signature.
    cloudEnv();
    expect(loadConfig().webhookSecret).toBe("app-secret");
    bridgeEnv();
    delete process.env["WHATSAPP_PROVIDER"];
    expect(loadConfig().webhookSecret).toBe("whsec");
  });

  it("refuses to boot a Cloud API deployment missing a credential", () => {
    // Every one of these fails on the first real message instead, which is the
    // failure this check exists to convert into a startup error.
    for (const missing of [
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_VERIFY_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_ACCESS_TOKEN",
    ]) {
      cloudEnv();
      delete process.env[missing];
      expect(() => loadConfig()).toThrow(new RegExp(missing));
    }
  });

  it("rejects a misspelled provider instead of silently running the other one", () => {
    bridgeEnv();
    process.env["WHATSAPP_PROVIDER"] = "meta";
    expect(() => loadConfig()).toThrow(/WHATSAPP_PROVIDER/);
  });

  it("pins the Graph version and lets a deploy bump it", () => {
    cloudEnv();
    expect(loadConfig().whatsappGraphVersion).toBe("v23.0");
    process.env["WHATSAPP_GRAPH_VERSION"] = "v24.0";
    expect(loadConfig().whatsappGraphVersion).toBe("v24.0");
  });
});
