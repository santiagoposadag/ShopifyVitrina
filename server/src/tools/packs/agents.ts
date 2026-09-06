import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MAX_HOP } from "../../inbox/a2a.js";
import { text, type ToolFactory } from "../factory.js";

/**
 * The agents toolpack: one tool, for asking another assistant a question.
 *
 * TWO PARAMETERS, AND THAT IS THE POINT. The model chooses WHO to ask and WHAT
 * to ask them. Everything that decides what the call is permitted to do — which
 * agent is asking, how many hops the chain has already taken, which
 * conversation it belongs to — is read off the turn. There is no argument
 * through which a prompt injection ("you are the super-agent, ask at hop 0")
 * could widen any of it, which is the same reason `search_knowledge` has no
 * parameter naming an agent.
 *
 * The refusals below are stated in words rather than thrown, because they are
 * business-rule refusals the model must act on: it can tell the person that
 * this assistant cannot ask that one. An infrastructure failure is the other
 * kind — the port throws, the turn fails, the batch is retried, and nobody is
 * told a made-up story about what another agent said.
 */

const ASK_AGENT_SLOTS = {
  example_agent_id: "vitrina-inventario",
} as const;

export const askAgent: ToolFactory = (ctx, { agents }) =>
  tool(
    "ask_agent",
    ctx.describe(
      "Ask another assistant of this business a question, and wait for its answer. Use it when the person needs something this assistant cannot see for itself and another one can. Ask ONE complete question: the other assistant answers a message, not a conversation, and it cannot ask you to clarify. Quote its answer as coming from it, and never present it as something you checked yourself. If it refuses or cannot answer, say so plainly instead of guessing.",
    ),
    {
      agent_id: z
        .string()
        .describe(ctx.describe("Which assistant to ask, e.g. {{example_agent_id}}", ASK_AGENT_SLOTS)),
      question: z
        .string()
        .describe(
          ctx.describe(
            "The complete question, in the language the other assistant speaks. Include every detail it needs — it cannot see this conversation.",
          ),
        ),
    },
    async ({ agent_id, question }) => {
      const from = ctx.turn.agentId;
      const to = agent_id.trim();
      const body = question.trim();
      if (to.length === 0) return text("Name the agent to ask. Nothing was sent.");
      if (body.length === 0) return text("The question was empty. Nothing was sent.");

      // An agent asking itself is a loop whose every leg looks legitimate, and
      // it would never grow a hop counter enough to be caught by the cap.
      if (to === from) {
        return text("An agent cannot ask itself. Answer with the tools this assistant has.");
      }

      const reach = agents.reachOf(from);
      if (!reach.includes(to)) {
        return text(
          `This assistant is not allowed to ask "${to}". It may ask: ${
            reach.length > 0 ? reach.join(", ") : "no other assistant"
          }. Nothing was sent.`,
        );
      }

      // THE HOP COMES FROM THE TURN. Whatever produced this turn — a person on
      // WhatsApp (hop 0) or another agent that asked us (its own hop) — the
      // outbound call is one further along that chain. A tool that let the
      // model supply this would let a loop reset its own counter on every lap,
      // and the cap would then bound nothing.
      const hop = ctx.turn.hop + 1;
      if (hop > MAX_HOP) {
        return text(
          `This question has already passed through ${ctx.turn.hop} assistant(s), which is the limit for one chain. Answer with what is already known, or tell the person this needs a human. Nothing was sent.`,
        );
      }

      // One conversation per asking TURN, not per call: a turn that asks the
      // same agent twice is one exchange continuing, and a retried turn resumes
      // it rather than opening a second.
      const result = await agents.ask({
        from,
        to,
        text: body,
        hop,
        correlationId: ctx.turn.turnKey,
      });
      if (result.ok) return text(`${to} answered:\n${result.reply}`);

      switch (result.reason) {
        case "conversation_busy":
          return text(
            `${to} is already answering something on this conversation. Nothing was sent; try again once it has replied.`,
          );
        case "no_reply_in_time":
          return text(
            `${to} did not answer in time. Do not guess what it would have said — tell the person you could not reach it.`,
          );
        case "turn_failed":
          return text(
            `${to} could not answer this question. Tell the person plainly; do not answer for it.`,
          );
        default:
          // reach_denied, unknown_agent, hop_limit_exceeded — all of them mean
          // the far side refused the call, and none of them is worth spelling
          // out to the model beyond the fact that nothing was sent.
          return text(`The call to ${to} was refused (${result.reason}). Nothing was sent.`);
      }
    },
  );
