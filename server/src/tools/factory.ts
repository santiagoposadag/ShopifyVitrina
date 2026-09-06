import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { ShopifyError } from "../shopify/client.js";
import type { TurnContext } from "../types.js";
import type { ToolPorts } from "./ports.js";

/**
 * One tool as the SDK takes it.
 *
 * `any` for the schema, exactly as `createSdkMcpServer` declares its own
 * `tools` array: every tool has a different parameter shape and the server
 * holds them in one list. The handler is widened for the same reason — the
 * SDK's generic resolves its argument to an index signature, which no concrete
 * tool's handler is assignable to.
 */
type AnySdkTool = SdkMcpToolDefinition<any>;
export type SdkTool = Omit<AnySdkTool, "handler"> & {
  handler: (args: any, extra: unknown) => ReturnType<AnySdkTool["handler"]>;
};

/**
 * What a toolpack knows about the turn it is being built for.
 *
 * Not `TurnContext` itself: a factory needs the turn (who is asking, and the
 * key that makes a retry safe) plus two things only the registry can provide —
 * the definition's slot values, and the ONE per-turn counter every tool shares.
 */
export interface ToolContext {
  /**
   * The turn. `sessionAfterTurn` is the only field a tool writes, and it is
   * still the single in-process channel from a tool back to the runtime.
   */
  turn: TurnContext;

  /**
   * Render a description template.
   *
   * Descriptions are English templates with `{{slots}}`; `defaults` are the
   * pack's own values for them and the definition's `prompt.slots` override.
   * Both shipped definitions declare none, so every description renders to the
   * literal it replaced — pinned byte for byte in test/tool-surface.test.ts,
   * because a description is prompt surface and rewording one changes how the
   * model behaves with nothing failing.
   */
  describe(template: string, defaults?: Readonly<Record<string, string>>): string;

  /**
   * The idempotency key for ONE stock movement in this turn.
   *
   * `turnKey` is stable across retries of the same batch, which is what makes a
   * replayed delta safe. Two adjustments in ONE turn ("vendí 3 negras y 2
   * blancas") would share it and Shopify would silently discard the second as a
   * duplicate, so each call takes the next slot. The counter belongs to the
   * TURN and not to a pack or a tool: a second stock-moving tool with its own
   * sequence would collide on its very first call. The sequence lines up on a
   * retry because the turn re-runs from the same messages.
   */
  nextInventoryKey(): string;
}

/** Build one tool for this turn. The only shape a registry entry may take. */
export type ToolFactory = (ctx: ToolContext, ports: ToolPorts) => SdkTool;

const SLOT_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Substitute `{{slot}}` values into a description template.
 *
 * Throws on a slot nothing fills, because the alternative is shipping the
 * literal braces to the model inside an otherwise plausible sentence: it
 * renders, it deploys, and nothing but a reading of the prompt would catch it.
 *
 * Exported for tests.
 */
export function renderDescription(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const missing: string[] = [];
  const rendered = template.replace(SLOT_PATTERN, (match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      missing.push(name);
      return match;
    }
    return value;
  });
  if (missing.length > 0) {
    throw new Error(`Tool description has no value for slot(s): ${missing.join(", ")}`);
  }
  return rendered;
}

/**
 * The per-turn context every tool in a turn shares.
 *
 * Created once by `buildToolServer`, which is what makes the inventory counter
 * one sequence per turn rather than one per pack.
 */
export function newToolContext(
  turn: TurnContext,
  slots: Readonly<Record<string, string>>,
): ToolContext {
  let inventorySequence = 0;
  return {
    turn,
    describe: (template, defaults = {}) => renderDescription(template, { ...defaults, ...slots }),
    nextInventoryKey: () => {
      inventorySequence += 1;
      return `${turn.turnKey}:${inventorySequence}`;
    },
  };
}

/** A tool result, in the one content shape every tool here returns. */
export function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/**
 * Render a port error as something the agent can act on, not a stack trace.
 *
 * Only a business-rule refusal is reported back to the model; anything else is
 * rethrown so the turn fails, the inbox batch is retried, and the person gets
 * the apology rather than an invented answer. A port signals the first kind by
 * throwing `ShopifyError` — the one place the catalog adapter's own error type
 * still shows through the port, and what a second implementation would have to
 * throw for a refusal it wants the model to hear.
 */
export function failure(action: string, err: unknown): ReturnType<typeof text> {
  if (err instanceof ShopifyError) return text(`${action} failed. ${err.message}`);
  throw err;
}
