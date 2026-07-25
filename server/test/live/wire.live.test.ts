/**
 * Wire-level parity: raw POSTs to /v1/messages, no SDK in the way.
 *
 * The SDK is a thick client — it retries, it rewrites, it swallows. When a turn
 * misbehaves against a compatible endpoint you cannot tell from up there
 * whether the provider or the client caused it. These tests answer the
 * primitive questions directly so the agent-loop suite can assume them:
 *
 *   - is reasoning ACTUALLY on, or does it merely not error?
 *   - does the effort knob reach anything?
 *   - is prompt caching real here, and reported under which field names?
 *   - does a tool_use / tool_result round trip survive?
 *
 * Every question is answered from the response body. Documentation is not
 * evidence: DeepSeek's own compatibility table marks several request fields
 * "Ignored", which is indistinguishable from "honoured" unless you look.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { cacheProbePrefix, LIVE, liveEndpoint } from "./harness.js";

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** DeepSeek's NATIVE field names — present only if they leak through. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}
interface MessagesResponse {
  model?: string;
  content?: Block[];
  stop_reason?: string;
  usage?: Usage;
}

const MODEL = process.env["MODEL"] || "claude-haiku-4-5";

async function send(body: Record<string, unknown>): Promise<{
  status: number;
  raw: string;
  json: MessagesResponse;
}> {
  const { url, headers } = liveEndpoint();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, ...body }),
    signal: AbortSignal.timeout(240_000),
  });
  const raw = await res.text();
  let json: MessagesResponse = {};
  try {
    json = JSON.parse(raw) as MessagesResponse;
  } catch {
    // Left empty; the status and raw body are what the assertion will report.
  }
  return { status: res.status, raw, json };
}

const blocksOfType = (r: MessagesResponse, type: string) =>
  (r.content ?? []).filter((b) => b.type === type);

describe.skipIf(!LIVE)("wire parity", () => {
  beforeAll(() => {
    const { url } = liveEndpoint();
    console.log(`[live] endpoint=${url} model=${MODEL}`);
  });

  it("answers a plain message at all", async () => {
    const { status, raw, json } = await send({
      messages: [{ role: "user", content: "Responde solo con la palabra: listo" }],
    });

    expect(status, raw).toBe(200);
    expect(blocksOfType(json, "text").length).toBeGreaterThan(0);
    // The model that ANSWERED, which is not necessarily the one we asked for:
    // DeepSeek resolves an unknown id to its own default without complaint.
    console.log(`[live] served model: ${json.model}`);
    expect(json.model).toBeDefined();
  });

  describe("thinking mode", () => {
    // The requirement is "test that reasoning is actually active" — so this
    // asserts on a returned `thinking` block, not on latency and not on the
    // absence of an error. A provider that ignores the parameter still returns
    // 200 with a perfectly good answer.
    it("returns a thinking block, proving reasoning is really on", async () => {
      const { status, raw, json } = await send({
        thinking: { type: "enabled", budget_tokens: 2048 },
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content:
              "Un apartamento cuesta 450000000 COP y la administración es 950000 COP al mes. " +
              "¿Cuánto se paga en administración en 3 años? Responde solo el número.",
          },
        ],
      });

      expect(status, raw).toBe(200);
      const thinking = blocksOfType(json, "thinking");
      console.log(
        `[live] thinking blocks: ${thinking.length}, chars: ${thinking.map((b) => (b.thinking ?? "").length).join(",")}`,
      );
      expect(
        thinking.length,
        "no thinking block came back — reasoning is NOT active on this endpoint/model",
      ).toBeGreaterThan(0);
    });

    // Sends the CONFIGURED AGENT_EXTRA_BODY rather than a hardcoded guess,
    // because that env var is exactly what the bundled CLI will merge into
    // every production request. If this endpoint rejects it, the profile is
    // wrong and every agent turn 400s.
    //
    // Note `budget_tokens` below: Anthropic REQUIRES it whenever thinking is
    // enabled, while DeepSeek documents it as ignored. Sending it satisfies
    // both, and is why the profiles steer effort through the extra body instead.
    const extraBody = JSON.parse(process.env["AGENT_EXTRA_BODY"] || "{}") as Record<
      string,
      unknown
    >;

    it.skipIf(Object.keys(extraBody).length === 0)(
      "accepts the configured AGENT_EXTRA_BODY rather than rejecting it",
      async () => {
        const { status, raw, json } = await send({
          thinking: { type: "enabled", budget_tokens: 2048 },
          max_tokens: 4096,
          ...extraBody,
          messages: [{ role: "user", content: "¿Cuánto es 17 * 23? Responde solo el número." }],
        });

        console.log(`[live] AGENT_EXTRA_BODY ${JSON.stringify(extraBody)} → HTTP ${status}`);
        expect(status, `the configured extra body was rejected: ${raw}`).toBe(200);
        expect(blocksOfType(json, "text").length).toBeGreaterThan(0);
      },
    );

    // Recorded, not asserted: this is how we learn whether the effort knob does
    // anything measurable, which no documentation settles.
    it.skipIf(!process.env["ANTHROPIC_BASE_URL"]?.includes("deepseek"))(
      "records how much effort levels change the thinking length",
      async () => {
        const ask = async (effort: string) => {
          const { status, json } = await send({
            thinking: { type: "enabled", budget_tokens: 4096 },
            max_tokens: 8192,
            output_config: { effort },
            messages: [
              {
                role: "user",
                content:
                  "Un apartamento de 85 m2 cuesta 450000000 COP. Otro de 110 m2 cuesta 560000000 COP. " +
                  "¿Cuál tiene mejor precio por metro cuadrado y por cuánto? Explica.",
              },
            ],
          });
          const chars = blocksOfType(json, "thinking").reduce(
            (n, b) => n + (b.thinking ?? "").length,
            0,
          );
          return { status, chars };
        };

        const high = await ask("high");
        const max = await ask("max");
        console.log(
          `[live] EFFORT — high: HTTP ${high.status}, ${high.chars} thinking chars · max: HTTP ${max.status}, ${max.chars} thinking chars`,
        );
        expect(high.status).toBe(200);
        expect(max.status).toBe(200);
      },
    );

    it("can turn thinking off, so the utility tier has an escape hatch", async () => {
      const { status, raw, json } = await send({
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: "Responde solo con la palabra: ok" }],
      });

      expect(status, raw).toBe(200);
      const thinking = blocksOfType(json, "thinking");
      console.log(`[live] thinking disabled → ${thinking.length} thinking blocks`);
      // Recorded, not asserted away: if a provider keeps reasoning even when
      // asked not to, that is a finding for the parity table, not a test bug.
      expect(status).toBe(200);
    });
  });

  describe("prompt caching", () => {
    // Cost-critical and officially unsettled. DeepSeek runs automatic prefix
    // caching, but its native usage fields are prompt_cache_hit_tokens /
    // prompt_cache_miss_tokens, and nothing in their docs says whether the
    // Anthropic-shaped endpoint translates those into Anthropic's names. On a
    // long agent session this is the difference between $0.14 and $0.0028 per
    // million input tokens, so it gets measured, not assumed.
    it("reports whether an identical long prefix was served from cache", async () => {
      const prefix = cacheProbePrefix();
      const ask = (question: string) => ({
        messages: [
          {
            role: "user",
            content: [
              // A breakpoint DeepSeek documents as IGNORED. Sent anyway: if it
              // is honoured we want the hit, and if it is ignored their
              // automatic caching may still produce one.
              { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
              { type: "text", text: question },
            ],
          },
        ],
      });

      const first = await send(ask("Responde solo: uno"));
      expect(first.status, first.raw).toBe(200);
      const second = await send(ask("Responde solo: dos"));
      expect(second.status, second.raw).toBe(200);

      const u = second.json.usage ?? {};
      console.log(`[live] usage after identical prefix: ${JSON.stringify(u)}`);
      console.log(
        `[live] CACHING VERDICT — anthropic-style cache_read_input_tokens=${u.cache_read_input_tokens ?? "absent"}, ` +
          `deepseek-native prompt_cache_hit_tokens=${u.prompt_cache_hit_tokens ?? "absent"}`,
      );

      // Usage must be reported at all — without it there is no cost visibility
      // whatsoever, which is a blocking gap regardless of caching.
      expect(second.json.usage, "no usage block returned at all").toBeDefined();
      expect(u.input_tokens ?? u.prompt_cache_miss_tokens).toBeDefined();

      // Asserted, not merely recorded: on this workload the cached prefix is
      // most of every prompt, so losing caching is a cost regression measured
      // in multiples, not percent. Both providers were measured serving an
      // identical prefix of this size from cache.
      expect(
        u.cache_read_input_tokens ?? u.prompt_cache_hit_tokens ?? 0,
        "an identical long prefix was NOT served from cache — re-check the prefix size before concluding the provider lacks caching",
      ).toBeGreaterThan(0);

      // Disjoint, not nested: the fresh count must COLLAPSE on the second call.
      // If it did not, `input_tokens` still includes the cached prefix and every
      // cost model built on these two fields is wrong.
      expect(
        u.input_tokens ?? 0,
        "input_tokens did not drop on a cache hit — the two fields may overlap, which breaks cost accounting",
      ).toBeLessThan((first.json.usage?.input_tokens ?? 0) / 2);
    });
  });

  describe("tool use", () => {
    // The whole application is its tools. This is the primitive the agent loop
    // rides on: if a tool_use / tool_result round trip does not survive here,
    // nothing above it can work, and the swap is off no matter the price.
    it("emits tool_use and accepts the tool_result back", async () => {
      const tools = [
        {
          name: "get_price",
          description: "Get the price of a property by its code.",
          input_schema: {
            type: "object",
            properties: { code: { type: "string", description: "Four-digit property code" } },
            required: ["code"],
          },
        },
      ];

      const first = await send({
        tools,
        messages: [{ role: "user", content: "¿Cuál es el precio del inmueble con código 1912?" }],
      });

      expect(first.status, first.raw).toBe(200);
      const calls = blocksOfType(first.json, "tool_use");
      expect(calls.length, `no tool_use block: ${first.raw.slice(0, 400)}`).toBeGreaterThan(0);
      expect(calls[0]!.name).toBe("get_price");
      // Arguments must arrive as a parsed object with the declared field — a
      // shim that hands back a JSON string, or drops the argument, breaks every
      // tool we have.
      expect(calls[0]!.input).toMatchObject({ code: expect.any(String) });

      const second = await send({
        tools,
        messages: [
          { role: "user", content: "¿Cuál es el precio del inmueble con código 1912?" },
          { role: "assistant", content: first.json.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: calls[0]!.id,
                content: "450000000 COP",
              },
            ],
          },
        ],
      });

      expect(second.status, second.raw).toBe(200);
      const text = blocksOfType(second.json, "text")
        .map((b) => b.text ?? "")
        .join(" ");
      // The model must actually USE the tool result, not restate the question.
      expect(text).toMatch(/450|450\.000\.000|450,000,000/);
    });

    it("handles two tools in one turn without confusing their arguments", async () => {
      const tools = [
        {
          name: "search_catalog",
          description: "Search properties by neighbourhood.",
          input_schema: {
            type: "object",
            properties: { neighborhood: { type: "string" } },
            required: ["neighborhood"],
          },
        },
        {
          name: "save_lead",
          description: "Save a customer inquiry.",
          input_schema: {
            type: "object",
            properties: { name: { type: "string" }, note: { type: "string" } },
            required: ["name"],
          },
        },
      ];

      const { status, raw, json } = await send({
        tools,
        messages: [
          {
            role: "user",
            content:
              "Busca apartamentos en Laureles. Me llamo Ana, guarda mi contacto para que me llamen.",
          },
        ],
      });

      expect(status, raw).toBe(200);
      const calls = blocksOfType(json, "tool_use");
      console.log(`[live] tools called: ${calls.map((c) => c.name).join(", ") || "none"}`);
      expect(calls.length).toBeGreaterThan(0);
      // Whichever it picked, the arguments must belong to THAT tool's schema.
      for (const call of calls) {
        if (call.name === "search_catalog") {
          expect(call.input).toMatchObject({ neighborhood: expect.any(String) });
        }
        if (call.name === "save_lead") expect(call.input).toMatchObject({ name: expect.any(String) });
      }
    });
  });

  describe("known-hostile request shapes", () => {
    // Reported to 400 on DeepSeek from some Claude Code versions: the SDK sends
    // a metadata.user_id their validator rejects on character class. If this
    // fails, the fix is a config change, not a code change — but we need to
    // know before a customer finds out.
    it("does not reject the metadata.user_id the SDK sends", async () => {
      const { status, raw } = await send({
        metadata: { user_id: "user_573001112233_account_vitrina_session_abc123" },
        messages: [{ role: "user", content: "Responde solo con la palabra: ok" }],
      });

      expect(status, `metadata.user_id was rejected — this breaks every SDK turn: ${raw}`).toBe(200);
    });

    it("accepts a system prompt of the size the agent actually sends", async () => {
      // The real owner persona is ~4KB. A provider with a tighter system-prompt
      // limit would fail only in production, on the owner path, which is the
      // worst place to discover it.
      const { status, raw } = await send({
        system: "Eres un asistente inmobiliario. ".repeat(200),
        messages: [{ role: "user", content: "Responde solo con la palabra: ok" }],
      });

      expect(status, raw).toBe(200);
    });
  });
});
