import { describe, expect, it } from "vitest";
import {
  AGENT_CONVERSATION_PREFIX,
  agentConversationKey,
  isAgentConversationKey,
  MAX_HOP,
} from "../src/a2a-protocol.js";
import { normalizePhone } from "../src/config.js";

/**
 * The two rules more than one layer has to agree on.
 *
 * Every other suite uses these SYMBOLICALLY — a2a.test.ts posts at `MAX_HOP`,
 * purge.test.ts builds keys through `agentConversationKey` — so a change to
 * either VALUE moves every assertion with it and the suite stays green. These
 * are the tests that would notice. That matters most for the prefix: it is
 * written into `sessions.conversation_key` and `inbox.conversation_key`, so a
 * changed spelling orphans every row already stored under the old one.
 */

describe("the agent conversation namespace", () => {
  it("is 'a2a:'", () => {
    expect(AGENT_CONVERSATION_PREFIX).toBe("a2a:");
  });

  it("recognises a key it minted", () => {
    expect(isAgentConversationKey(agentConversationKey("super", "vitrina-inventario", "corr-1"))).toBe(
      true,
    );
  });

  it("carries both ends and the correlation, in that order", () => {
    expect(agentConversationKey("super", "vitrina-inventario", "corr-1")).toBe(
      "a2a:super:vitrina-inventario:corr-1",
    );
  });

  // The reason the namespace exists: a caller that could name a bare phone
  // would claim, answer and settle that person's pending WhatsApp messages.
  // normalizePhone leaves nothing but digits, so no phone can ever carry it.
  it("cannot be spelled by a normalized phone", () => {
    const phone = normalizePhone("+57 300 111 2233");
    expect(phone).toMatch(/^\d+$/);
    expect(isAgentConversationKey(phone)).toBe(false);
  });
});

describe("the hop cap", () => {
  it("is 3", () => {
    expect(MAX_HOP).toBe(3);
  });
});
