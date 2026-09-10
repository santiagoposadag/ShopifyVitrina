import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/data/db.js";
import { InboxBatcher } from "../src/inbox/batcher.js";
import { PerConversationQueue } from "../src/inbox/queue.js";
import { inProcessAgentsPort } from "../src/inbox/agents-port.js";
import { MAX_HOP } from "../src/inbox/a2a.js";
import { AgentReplies } from "../src/egress/agent-reply.js";
import { Responders } from "../src/egress/responder.js";
import { insertInboxMessage } from "../src/data/repo.js";
import { agentConversationKey } from "../src/inbox/envelope.js";
import type { WhatsAppChannel } from "../src/whatsapp/channel.js";
import type { Envelope } from "../src/inbox/envelope.js";
import type { TurnContext } from "../src/types.js";
import { AGENT_IDS } from "../src/router.js";

/**
 * One agent asking another, in process, through the whole pipeline.
 *
 * The adapter under test is the one the composition root wires (index.ts), and
 * the turns below stand in for the model: each "agent" is a function that reads
 * its envelope and may ask another agent, exactly as `ask_agent` would.
 *
 * What this file exists for is the LOOP. A super-agent asking an agent that
 * asks it back is not an error anyone sees — it is a bill — so the thing to
 * prove is that a cycle of otherwise-legitimate calls terminates, and that the
 * counter it terminates on cannot be reset by the message itself.
 */

const A = "agent-a";
const B = "agent-b";

const silentLog = { error: () => undefined, warn: () => undefined, info: () => undefined };

const forbiddenChannel: WhatsAppChannel = {
  sendText: async () => {
    throw new Error("no chain test may reach WhatsApp");
  },
  downloadMedia: async () => {
    throw new Error("no chain test may download media");
  },
};

interface Chain {
  db: DB;
  batcher: InboxBatcher;
  /** Every turn that ran, in order: which agent, at which hop, on what text. */
  turns: { agentId: string; hop: number; text: string; conversationKey: string }[];
  /** What each agent did when its turn ran. */
  ask: (from: string, to: string, question: string, turn: TurnContext) => Promise<string>;
}

interface ChainOptions {
  reach: Record<string, string[]>;
  /** What each agent answers with, after any asking it does. */
  answer?: (envelope: Envelope) => string;
  /** Which agent asks which, once, on its own turn. */
  asksOnTurn?: Record<string, string>;
}

function chain(options: ChainOptions): Chain {
  const db = openDb(":memory:");
  const queue = new PerConversationQueue();
  const turns: Chain["turns"] = [];
  const replies = new AgentReplies({ log: silentLog, syncTimeoutMs: 5000 });
  // This suite is about the chain terminating, not about the conversation
  // record — a no-op recorder keeps it out of scope, the same way
  // forbiddenChannel keeps WhatsApp out of scope.
  const responders = new Responders({
    channel: forbiddenChannel,
    recorder: { record: () => undefined },
    log: silentLog,
    agentReplies: replies,
  });

  const agents = inProcessAgentsPort({
    db,
    batcher: () => batcher,
    replies: () => replies,
    reachOf: (agentId) => options.reach[agentId] ?? [],
    isKnownAgent: (agentId) => agentId === A || agentId === B,
  });

  const ask: Chain["ask"] = async (from, to, question, turn) => {
    // Exactly what tools/packs/agents.ts computes: the outbound hop comes from
    // the TURN, and the correlation from the turn key.
    const result = await agents.ask({
      from,
      to,
      text: question,
      hop: turn.hop + 1,
      correlationId: turn.turnKey,
    });
    return result.ok ? result.reply : `refused: ${result.reason}`;
  };

  const batcher = new InboxBatcher({
    db,
    queue,
    log: silentLog as never,
    debounceMs: 8000,
    maxWaitMs: 45000,
    mediaDebounceMs: 45000,
    mediaMaxWaitMs: 120000,
    route: () => ({ role: "owner", agentId: AGENT_IDS.owner }),
    onMessage: async (envelope, ctx) => {
      turns.push({
        agentId: envelope.agentId,
        hop: ctx.hop,
        text: envelope.text,
        conversationKey: envelope.conversationKey,
      });
      let body = options.answer ? options.answer(envelope) : `${envelope.agentId} says hello`;
      const target = options.asksOnTurn?.[envelope.agentId];
      if (target) {
        const heard = await ask(envelope.agentId, target, `relayed: ${envelope.text}`, ctx);
        body = `${envelope.agentId} heard [${heard}]`;
      }
      await responders
        .for(
          envelope.principal,
          { agentId: envelope.agentId, turnKey: envelope.turnKey },
          { conversationKey: envelope.conversationKey },
        )
        .deliver(body);
    },
  });

  return { db, batcher, turns, ask };
}

let open: Chain | undefined;

function start(options: ChainOptions): Chain {
  open = chain(options);
  return open;
}

afterEach(() => {
  if (open) {
    open.batcher.stop();
    open.db.close();
    open = undefined;
  }
});

/** A WhatsApp turn context, as the batcher builds one for a person's burst. */
function personTurn(agentId: string): TurnContext {
  return {
    principal: { kind: "whatsapp", phone: "573001112233" },
    phone: "573001112233",
    role: "owner",
    agentId,
    conversationKey: "573001112233",
    turnKey: "msg:1",
    hop: 0,
  };
}

describe("an in-process ask reaches the other agent's turn", () => {
  it("carries the question and returns that agent's answer", async () => {
    const c = start({ reach: { [A]: [B] }, answer: (e) => `${e.agentId}: ${e.text}` });

    const heard = await c.ask(A, B, "¿cuántas CAM-NEG-M quedan?", personTurn(A));

    expect(heard).toBe(`${B}: ¿cuántas CAM-NEG-M quedan?`);
    expect(c.turns).toEqual([
      {
        agentId: B,
        hop: 1,
        text: "¿cuántas CAM-NEG-M quedan?",
        conversationKey: agentConversationKey(A, B, "msg:1"),
      },
    ]);
  });

  it("settles the row it wrote, like any other message", async () => {
    const c = start({ reach: { [A]: [B] } });

    await c.ask(A, B, "hola", personTurn(A));

    const rows = c.db.prepare(`SELECT * FROM inbox`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "done",
      agent_id: B,
      principal_kind: "agent",
      principal_id: A,
      hop: 1,
    });
  });

  it("refuses an agent the definition does not reach, without writing a row", async () => {
    const c = start({ reach: { [A]: [] } });

    const heard = await c.ask(A, B, "hola", personTurn(A));

    expect(heard).toBe("refused: reach_denied");
    expect(c.turns).toEqual([]);
    expect(c.db.prepare(`SELECT COUNT(*) AS n FROM inbox`).get()).toEqual({ n: 0 });
  });

  it("refuses an agent this build does not serve", async () => {
    const c = start({ reach: { [A]: ["ghost"] } });

    expect(await c.ask(A, "ghost", "hola", personTurn(A))).toBe("refused: unknown_agent");
  });

  it("keeps a person's own conversation out of it", async () => {
    const c = start({ reach: { [A]: [B] } });
    insertInboxMessage(c.db, {
      dedupe_key: "msg:waiting",
      phone: "573001112233",
      agent_text: "hola, ¿tienen camisas?",
    });

    await c.ask(A, B, "consulta interna", personTurn(A));

    // The turn key of the asking turn is the person's own message id, so this
    // is the case where a namespace is the only thing keeping the two apart.
    expect(c.turns.map((t) => t.text)).toEqual(["consulta interna"]);
    const waiting = c.db.prepare(`SELECT status FROM inbox WHERE dedupe_key = 'msg:waiting'`).get();
    expect(waiting).toEqual({ status: "pending" });
  });
});

describe("a loop terminates on the hop cap", () => {
  // A asks B, B asks A, A asks B... every leg is a call each side is permitted
  // to make. Only the hop counter ends it.
  it("stops a mutual chain at the cap instead of running forever", async () => {
    const c = start({
      reach: { [A]: [B], [B]: [A] },
      asksOnTurn: { [A]: B, [B]: A },
    });

    const heard = await c.ask(A, B, "empieza", personTurn(A));

    // Hops 1, 2, 3 ran; the call that would have been hop 4 was refused.
    expect(c.turns.map((t) => t.hop)).toEqual([1, 2, 3]);
    expect(c.turns.map((t) => t.agentId)).toEqual([B, A, B]);
    expect(c.turns).toHaveLength(MAX_HOP);
    expect(heard).toContain("refused: hop_limit_exceeded");
  });

  // The counter has to come from the TURN. This is the same chain with each leg
  // asking at a hop it chose for itself — which is what an implementation that
  // read the hop from the message would produce.
  it("would not terminate if a caller could choose its own hop", async () => {
    const c = start({ reach: { [A]: [B], [B]: [A] } });
    let legs = 0;

    // Deliberately NOT ctx.hop + 1: a fixed hop, as a forged message would
    // carry. Bounded by the loop below rather than by the guard, which is the
    // point — nothing in the pipeline stops it.
    for (let i = 0; i < MAX_HOP + 2; i++) {
      const result = await c.ask(A, B, `leg ${i}`, { ...personTurn(A), turnKey: `msg:${i}` });
      if (result.startsWith("refused")) break;
      legs += 1;
    }

    expect(legs).toBe(MAX_HOP + 2);
  });
});
