import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/data/db.js";
import {
  countOpenLeads,
  deleteConversationHandoffs,
  findOpenDuplicateLead,
  insertLead,
  isConversationPaused,
  listConversationHandoffs,
  listLeads,
  listPausedConversations,
  pauseConversation,
  releaseConversation,
  setLeadStatus,
} from "../src/data/repo.js";
import { sqliteLeadsPort } from "../src/data/tool-ports.js";
import { buildLeadNotice } from "../src/egress/lead-notice.js";
import { AGENT_IDS } from "../src/router.js";

/**
 * ESCALATION: what happens after the assistant decides it cannot close.
 *
 * The sales agent tells the customer that a team member will follow up. Before
 * this slice that promise was a row nobody read, on a conversation the agent
 * kept answering — so the person was talking to a bot standing in front of the
 * human who was supposed to help them. Three things had to become true:
 *
 *  1. THE LEAD REACHES SOMEBODY, once, without paging the owner every time an
 *     impatient customer repeats themselves.
 *  2. THE LEAD HAS A LIFECYCLE, so a second reading of the list distinguishes
 *     what is done from what is waiting.
 *  3. A HUMAN CAN TAKE THE CONVERSATION and the agent goes silent for it.
 */

const CUSTOMER = "573001112233";
const ADMIN = "573009998877";
const SALES = AGENT_IDS.customer;
const INVENTORY = AGENT_IDS.owner;

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("capturing a lead", () => {
  it("links the lead to the exact turn that produced it", async () => {
    const port = sqliteLeadsPort(db);

    const { lead, created } = await port.save({
      phone: CUSTOMER,
      type: "follow_up",
      note: "quiere 40 unidades",
      conversationKey: CUSTOMER,
      agentId: SALES,
      turnKey: "t-42",
    });

    expect(created).toBe(true);
    // The link is what makes a lead actionable rather than a phone number and a
    // guess: an operator can open the exchange behind it.
    expect(lead).toMatchObject({
      conversation_key: CUSTOMER,
      agent_id: SALES,
      turn_key: "t-42",
      status: "new",
    });
  });

  /**
   * A customer who asks three times about the same sold-out item is ONE promise
   * to contact them. Three rows make the list longer without making it more
   * informative, which is how a list stops being read.
   */
  it("returns the open duplicate instead of writing a second row", async () => {
    const port = sqliteLeadsPort(db);
    const first = await port.save({ phone: CUSTOMER, type: "back_in_stock", productCode: "SKU-1" });
    const second = await port.save({ phone: CUSTOMER, type: "back_in_stock", productCode: "SKU-1" });

    expect(second.created).toBe(false);
    expect(second.lead.id).toBe(first.lead.id);
    expect(listLeads(db)).toHaveLength(1);
  });

  it("treats a different product, or a different kind of ask, as a different promise", async () => {
    const port = sqliteLeadsPort(db);
    await port.save({ phone: CUSTOMER, type: "back_in_stock", productCode: "SKU-1" });
    await port.save({ phone: CUSTOMER, type: "back_in_stock", productCode: "SKU-2" });
    await port.save({ phone: CUSTOMER, type: "follow_up", productCode: "SKU-1" });

    expect(listLeads(db)).toHaveLength(3);
  });

  /**
   * A closed lead has been answered, so the customer asking again is a NEW
   * request. Collapsing onto it would file today's ask under something already
   * marked done.
   */
  it("opens a new lead when the previous one was closed", async () => {
    const port = sqliteLeadsPort(db);
    const first = await port.save({ phone: CUSTOMER, type: "back_in_stock", productCode: "SKU-1" });
    setLeadStatus(db, { id: first.lead.id, status: "closed", claimedBy: ADMIN });

    const second = await port.save({ phone: CUSTOMER, type: "back_in_stock", productCode: "SKU-1" });

    expect(second.created).toBe(true);
    expect(second.lead.id).not.toBe(first.lead.id);
  });

  it("does not merge a general ask with one about a specific product", () => {
    insertLead(db, { phone: CUSTOMER, type: "inquiry" });
    expect(
      findOpenDuplicateLead(db, { phone: CUSTOMER, type: "inquiry", product_code: "SKU-1" }),
    ).toBeNull();
  });
});

describe("notifying whoever has to act", () => {
  it("tells the notifier once, on a real capture", async () => {
    const leadCaptured = vi.fn();
    const port = sqliteLeadsPort(db, { leadCaptured });

    await port.save({ phone: CUSTOMER, type: "follow_up" });

    expect(leadCaptured).toHaveBeenCalledTimes(1);
  });

  /**
   * Notifying on a duplicate would page the owner every time an impatient
   * customer repeats themselves, which is how a notification stops being read
   * at all.
   */
  it("stays quiet on a duplicate", async () => {
    const leadCaptured = vi.fn();
    const port = sqliteLeadsPort(db, { leadCaptured });

    await port.save({ phone: CUSTOMER, type: "follow_up" });
    await port.save({ phone: CUSTOMER, type: "follow_up" });

    expect(leadCaptured).toHaveBeenCalledTimes(1);
  });

  it("carries what the owner needs to act without opening anything", () => {
    const lead = insertLead(db, {
      phone: CUSTOMER,
      type: "follow_up",
      name: "Ana",
      note: "quiere 40 unidades para un evento",
      product_code: "SKU-1",
    });

    const notice = buildLeadNotice(lead);

    expect(notice).toContain(CUSTOMER);
    expect(notice).toContain("SKU-1");
    expect(notice).toContain("Ana");
    expect(notice).toContain("quiere 40 unidades para un evento");
    // It tells them how to act, and deliberately carries NO link: attaching one
    // would mint a session nobody asked for on every lead.
    expect(notice).toContain("panel");
    expect(notice).not.toContain("http");
  });

  it("says which kind of promise was made, so a restock ping reads differently from a negotiation", () => {
    const restock = buildLeadNotice(insertLead(db, { phone: CUSTOMER, type: "back_in_stock" }));
    const followUp = buildLeadNotice(insertLead(db, { phone: CUSTOMER, type: "follow_up" }));

    expect(restock).not.toBe(followUp);
  });
});

describe("the lead lifecycle", () => {
  it("counts only what still owes somebody a contact", () => {
    const a = insertLead(db, { phone: CUSTOMER, type: "inquiry" });
    insertLead(db, { phone: CUSTOMER, type: "follow_up" });
    setLeadStatus(db, { id: a.id, status: "closed", claimedBy: ADMIN });

    expect(countOpenLeads(db)).toBe(1);
    expect(listLeads(db, { openOnly: true })).toHaveLength(1);
    expect(listLeads(db)).toHaveLength(2);
  });

  it("records who took a lead and stamps when it moved", () => {
    const lead = insertLead(db, { phone: CUSTOMER, type: "follow_up" });

    const taken = setLeadStatus(db, { id: lead.id, status: "in_progress", claimedBy: ADMIN });

    expect(taken).toMatchObject({ status: "in_progress", claimed_by: ADMIN });
    expect(taken?.status_changed_at).not.toBeNull();
  });

  /**
   * A lead nobody is handling must not keep naming somebody — that is how one
   * sits untouched while everyone assumes the named person has it.
   */
  it("clears the holder when a lead is reopened", () => {
    const lead = insertLead(db, { phone: CUSTOMER, type: "follow_up" });
    setLeadStatus(db, { id: lead.id, status: "in_progress", claimedBy: ADMIN });

    expect(setLeadStatus(db, { id: lead.id, status: "new" })?.claimed_by).toBeNull();
  });

  it("answers null for a lead that does not exist", () => {
    expect(setLeadStatus(db, { id: 999, status: "closed" })).toBeNull();
  });

  /**
   * The unbounded list was reachable from the `list_leads` tool and put every
   * lead the store had ever captured into the model's context, one line each,
   * on a turn the owner was waiting for.
   */
  it("is bounded by default", () => {
    for (let i = 0; i < 150; i++) insertLead(db, { phone: CUSTOMER, type: "inquiry" });
    expect(listLeads(db)).toHaveLength(100);
    expect(listLeads(db, { limit: 10 })).toHaveLength(10);
  });
});

describe("handing a conversation to a human", () => {
  it("is not paused until somebody pauses it", () => {
    expect(isConversationPaused(db, CUSTOMER, SALES)).toBe(false);
  });

  it("pauses and releases, keeping the history both times", () => {
    pauseConversation(db, {
      conversationKey: CUSTOMER,
      agentId: SALES,
      pausedBy: ADMIN,
      reason: "pedido al por mayor",
    });
    expect(isConversationPaused(db, CUSTOMER, SALES)).toBe(true);

    expect(releaseConversation(db, { conversationKey: CUSTOMER, agentId: SALES, releasedBy: ADMIN })).toBe(1);
    expect(isConversationPaused(db, CUSTOMER, SALES)).toBe(false);

    // The row survives: "who took this over, when, and how long did it sit
    // paused" is the traceability an audit asks for after a complaint.
    const history = listConversationHandoffs(db, CUSTOMER, SALES);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      paused_by: ADMIN,
      released_by: ADMIN,
      reason: "pedido al por mayor",
    });
  });

  /**
   * Two admins opening the same thread and both hitting pause is ordinary. A
   * second row would make release ambiguous: it would close one and leave the
   * conversation paused by the other, with the console showing it live.
   */
  it("is idempotent", () => {
    const first = pauseConversation(db, { conversationKey: CUSTOMER, agentId: SALES, pausedBy: ADMIN });
    const second = pauseConversation(db, { conversationKey: CUSTOMER, agentId: SALES, pausedBy: "573000000000" });

    expect(second.id).toBe(first.id);
    // The FIRST holder stays named: whoever actually took it over is who the
    // history has to show.
    expect(second.paused_by).toBe(ADMIN);
    expect(listConversationHandoffs(db, CUSTOMER, SALES)).toHaveLength(1);
  });

  it("scopes to one persona, so the same phone's other thread keeps answering", () => {
    pauseConversation(db, { conversationKey: CUSTOMER, agentId: SALES, pausedBy: ADMIN });

    expect(isConversationPaused(db, CUSTOMER, SALES)).toBe(true);
    expect(isConversationPaused(db, CUSTOMER, INVENTORY)).toBe(false);
  });

  it("reports releasing something that was never paused, rather than pretending", () => {
    expect(releaseConversation(db, { conversationKey: CUSTOMER, agentId: SALES, releasedBy: ADMIN })).toBe(0);
  });

  it("lists everything a human currently holds, oldest first", () => {
    pauseConversation(db, { conversationKey: CUSTOMER, agentId: SALES, pausedBy: ADMIN });
    pauseConversation(db, { conversationKey: "573004445566", agentId: SALES, pausedBy: ADMIN });
    releaseConversation(db, { conversationKey: CUSTOMER, agentId: SALES, releasedBy: ADMIN });

    expect(listPausedConversations(db).map((h) => h.conversation_key)).toEqual(["573004445566"]);
  });

  /**
   * `paused_by` and `reason` are notes a human wrote ABOUT a named customer, so
   * a purge that left them behind would report that person forgotten while a
   * record of them sat in a third table.
   */
  it("is deleted with the conversation, scoped by agent", () => {
    pauseConversation(db, { conversationKey: CUSTOMER, agentId: SALES, pausedBy: ADMIN });
    pauseConversation(db, { conversationKey: CUSTOMER, agentId: INVENTORY, pausedBy: ADMIN });

    expect(deleteConversationHandoffs(db, CUSTOMER, SALES)).toBe(1);
    expect(listConversationHandoffs(db, CUSTOMER, INVENTORY)).toHaveLength(1);
  });
});
