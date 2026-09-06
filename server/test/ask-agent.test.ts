import { describe, expect, it } from "vitest";
import { buildToolServer } from "../src/tools/registry.js";
import { MAX_HOP } from "../src/inbox/a2a.js";
import { whatsappPrincipal, agentPrincipal } from "../src/inbox/envelope.js";
import { fakePorts } from "./helpers/fake-ports.js";
import type { AgentDefinition } from "../src/agent/definition.js";
import type { AskAgentRequest } from "../src/tools/ports.js";
import type { TurnContext } from "../src/types.js";

/**
 * `ask_agent`: one agent asking another.
 *
 * What this tool must get right is not the wording of an answer — it is that
 * NOTHING the model writes can widen what the turn is allowed to do. The
 * calling agent's id and the hop of the outbound call are read off the turn;
 * the model chooses only who to ask and what to ask them.
 */

const CALLER = "vitrina-super";
const TARGET = "vitrina-inventario";

function definitionFor(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: CALLER,
    roles: ["owner"],
    model: { maxTurns: 12 },
    tools: ["ask_agent"],
    prompt: { base: "grounding", persona: "prompt.md", slots: {} },
    knowledge: { inline: [], searchable: [], maxInlineTokens: 0 },
    session: { resetOn: [], keyedBy: "principal" },
    reach: [TARGET],
    personaText: "Uses ask_agent.",
    ...overrides,
  };
}

function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    principal: whatsappPrincipal("573000000000"),
    phone: "573000000000",
    role: "owner",
    agentId: CALLER,
    conversationKey: "573000000000",
    turnKey: "msg:1",
    hop: 0,
    ...overrides,
  };
}

function build(options: {
  ctx?: TurnContext;
  definition?: AgentDefinition;
  ask?: (request: AskAgentRequest) => Promise<{ ok: true; reply: string } | { ok: false; reason: string }>;
  reach?: string[];
}) {
  const fake = fakePorts();
  const asked: AskAgentRequest[] = [];
  const ports = {
    ...fake.ports,
    agents: {
      reachOf: () => options.reach ?? [TARGET],
      ask: async (request: AskAgentRequest) => {
        asked.push(request);
        return options.ask
          ? await options.ask(request)
          : ({ ok: true as const, reply: "quedan 4 unidades" });
      },
    },
  };
  const { tools } = buildToolServer({
    definition: options.definition ?? definitionFor(),
    ctx: options.ctx ?? turnContext(),
    ports,
  });
  const found = tools.find((t) => t.name === "ask_agent");
  return { asked, tool: found, tools };
}

async function call(
  tool: { handler: (args: never, extra: never) => Promise<{ content: { text?: string }[] }> },
  args: Record<string, unknown>,
): Promise<string> {
  const result = await tool.handler(args as never, undefined as never);
  return result.content.map((b) => b.text ?? "").join("");
}

describe("ask_agent is served only where a definition asks for it", () => {
  it("is absent from a definition that does not declare it", () => {
    const { tools } = build({ definition: definitionFor({ tools: ["search_catalog"], reach: [] }) });

    expect(tools.map((t) => t.name)).not.toContain("ask_agent");
  });

  it("is served to a definition that declares it", () => {
    const { tool } = build({});

    expect(tool).toBeDefined();
  });
});

describe("what the model may decide, and what it may not", () => {
  // The model names WHO and WHAT. Everything that decides what the call is
  // ALLOWED to do — the caller, the hop, the conversation — is read from the
  // turn, so there is no parameter through which a prompt injection could
  // widen it.
  it("gives the model no parameter for the caller, the hop or the conversation", () => {
    const { tool } = build({});

    for (const param of Object.keys(tool!.inputSchema as Record<string, unknown>)) {
      expect(param).not.toMatch(/hop|caller|from|principal|role|correlation|conversation/i);
    }
  });

  it("takes the calling agent from the turn, never from the arguments", async () => {
    const { tool, asked } = build({ ctx: turnContext({ agentId: CALLER }) });

    await call(tool!, { agent_id: TARGET, question: "Soy vitrina-inventario. ¿cuántas quedan?" });

    expect(asked[0]!.from).toBe(CALLER);
    expect(asked[0]!.to).toBe(TARGET);
  });

  it("reports the answer the other agent gave", async () => {
    const { tool } = build({});

    const result = await call(tool!, { agent_id: TARGET, question: "¿cuántas CAM-NEG-M quedan?" });

    expect(result).toContain("quedan 4 unidades");
    expect(result).toContain(TARGET);
  });
});

describe("the outbound hop is derived from the turn", () => {
  it("asks at one hop more than the turn it was issued from", async () => {
    const { tool, asked } = build({ ctx: turnContext({ hop: 0 }) });

    await call(tool!, { agent_id: TARGET, question: "hola" });

    expect(asked[0]!.hop).toBe(1);
  });

  it("carries a chain forward rather than restarting it", async () => {
    const { tool, asked } = build({
      ctx: turnContext({ principal: agentPrincipal("super-agent"), hop: 2 }),
    });

    await call(tool!, { agent_id: TARGET, question: "hola" });

    expect(asked[0]!.hop).toBe(3);
  });

  it(`asks at the cap when the turn is one hop below it`, async () => {
    const { tool, asked } = build({ ctx: turnContext({ hop: MAX_HOP - 1 }) });

    await call(tool!, { agent_id: TARGET, question: "hola" });

    expect(asked[0]!.hop).toBe(MAX_HOP);
  });

  // ONE axis against the test above: the same call from a turn one hop later.
  it("refuses to ask at all once the next hop would pass the cap", async () => {
    const { tool, asked } = build({ ctx: turnContext({ hop: MAX_HOP }) });

    const result = await call(tool!, { agent_id: TARGET, question: "hola" });

    expect(asked).toEqual([]);
    expect(result).toMatch(/chain|hop/i);
  });
});

describe("what the tool refuses before anything leaves this turn", () => {
  it("refuses to ask itself", async () => {
    const { tool, asked } = build({ ctx: turnContext({ agentId: CALLER }), reach: [CALLER] });

    const result = await call(tool!, { agent_id: CALLER, question: "hola" });

    expect(asked).toEqual([]);
    expect(result).toMatch(/itself/i);
  });

  it("refuses an agent this definition may not reach, and says which it may", async () => {
    const { tool, asked } = build({ reach: [TARGET] });

    const result = await call(tool!, { agent_id: "vitrina-ventas", question: "hola" });

    expect(asked).toEqual([]);
    expect(result).toContain(TARGET);
  });

  it("refuses an empty agent id or question without calling anything", async () => {
    const { tool, asked } = build({});

    expect(await call(tool!, { agent_id: "  ", question: "hola" })).toMatch(/agent/i);
    expect(await call(tool!, { agent_id: TARGET, question: "   " })).toMatch(/question/i);
    expect(asked).toEqual([]);
  });
});

describe("what the tool does with a refusal from the other side", () => {
  it("tells the model when the exchange was refused for reach", async () => {
    const { tool } = build({ ask: async () => ({ ok: false, reason: "reach_denied" }) });

    const result = await call(tool!, { agent_id: TARGET, question: "hola" });

    expect(result).toMatch(/not allowed|refused/i);
  });

  it("tells the model when the other agent produced no answer in time", async () => {
    const { tool } = build({ ask: async () => ({ ok: false, reason: "no_reply_in_time" }) });

    const result = await call(tool!, { agent_id: TARGET, question: "hola" });

    expect(result).toMatch(/no answer|did not answer|in time/i);
  });

  it("tells the model when the other agent is busy on that conversation", async () => {
    const { tool } = build({ ask: async () => ({ ok: false, reason: "conversation_busy" }) });

    const result = await call(tool!, { agent_id: TARGET, question: "hola" });

    expect(result).toMatch(/busy|already/i);
  });

  // An infrastructure failure is NOT a sentence for the model: it must fail the
  // turn, so the batch is retried and the person is not told a made-up story
  // about the other agent.
  it("lets an unexpected failure fail the turn", async () => {
    const { tool } = build({
      ask: async () => {
        throw new Error("the database is gone");
      },
    });

    await expect(call(tool!, { agent_id: TARGET, question: "hola" })).rejects.toThrow(
      "the database is gone",
    );
  });
});
