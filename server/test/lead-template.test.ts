import { beforeEach, describe, expect, it } from "vitest";
import { CloudApiChannel } from "../src/whatsapp/cloud.js";
import {
  buildLeadNotice,
  buildLeadTemplate,
  leadKindPhrase,
  templateParam,
} from "../src/egress/lead-notice.js";
import { openDb, type DB } from "../src/data/db.js";
import { insertLead } from "../src/data/repo.js";
import type { Lead } from "../src/types.js";

/**
 * THE APPROVED TEMPLATE THAT CARRIES A LEAD TO AN OWNER.
 *
 * A free-form reply is only legal within 24 hours of the person's last message
 * — Meta rejects the rest with 131047 — so an owner who has not written to the
 * business number since yesterday simply never hears that a customer was
 * escalated. That is the exact failure the notification exists to prevent, and
 * a template is the only shape that survives it.
 *
 * It is also the only shape that can carry a BUTTON, which is the feature: the
 * button opens that conversation in the panel.
 *
 * What this suite defends:
 *
 *  1. THE WIRE SHAPE IS WHAT META APPROVED. Parameters are positional, so a
 *     reordering names the wrong field with no error anywhere; the button
 *     parameter is the SUFFIX alone, because Meta concatenates.
 *  2. NO PARAMETER CAN BE REJECTED AT SEND TIME. Empty values, newlines and
 *     tabs are all rejected by Meta — and a customer's note routinely has them.
 *  3. THE FALLBACK STILL SAYS EVERYTHING. When the template cannot be sent, the
 *     owner still learns about the lead and still gets the link.
 */

const OWNER = "573001112233";
const CUSTOMER = "573004445566";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

function seedLead(overrides: Partial<Parameters<typeof insertLead>[1]> = {}): Lead {
  return insertLead(db, {
    phone: CUSTOMER,
    type: "follow_up",
    note: "quiere 40 unidades para un evento",
    product_code: "LUM-COL-40",
    conversation_key: CUSTOMER,
    agent_id: "vitrina-ventas",
    ...overrides,
  });
}

/** A fetch that records what was sent and answers however the test wants. */
function recordingFetch(calls: { url: string; body: unknown }[], ok = true, status = 400) {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return {
      ok,
      status: ok ? 200 : status,
      text: async () =>
        ok ? "{}" : JSON.stringify({ error: { code: 132001, message: "template not found" } }),
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const CLOUD_CONFIG = {
  whatsappPhoneNumberId: "123456",
  whatsappAccessToken: "token",
  whatsappGraphBaseUrl: "https://graph.example.test",
  whatsappGraphVersion: "v23.0",
};

describe("the template's parameters", () => {
  it("fills the approved body in the approved order", () => {
    const template = buildLeadTemplate({
      lead: seedLead(),
      name: "lead_capturado",
      language: "es",
      landingCode: "CODE123",
    });

    // Positional against the body Meta approved:
    //   Un cliente {{1}}. / Teléfono: {{2}} / Producto: {{3}} / Nota: {{4}}
    // A swap here names the wrong field with no error anywhere.
    expect(template.bodyParams).toEqual([
      "pidió que lo contactaran",
      CUSTOMER,
      "LUM-COL-40",
      "quiere 40 unidades para un evento",
    ]);
  });

  /**
   * Meta concatenates the parameter onto the base URL it stored at approval.
   * Sending a whole URL yields the origin twice — a 404 for whoever taps it,
   * and nothing at all in any log.
   */
  it("passes the button's SUFFIX, never a whole URL", () => {
    const template = buildLeadTemplate({
      lead: seedLead(),
      name: "lead_capturado",
      language: "es",
      landingCode: "CODE123",
    });

    expect(template.buttonUrlSuffix).toBe("CODE123");
    expect(template.buttonUrlSuffix).not.toContain("http");
    expect(template.buttonUrlSuffix).not.toContain("/go/");
  });

  it("takes the template's name and language from configuration, not a literal", () => {
    const template = buildLeadTemplate({
      lead: seedLead(),
      name: "otro_nombre",
      language: "es_MX",
      landingCode: "X",
    });

    expect(template).toMatchObject({ name: "otro_nombre", language: "es_MX" });
  });

  it("describes each kind of lead differently", () => {
    const kinds = (["back_in_stock", "inquiry", "follow_up"] as const).map((type) =>
      leadKindPhrase(seedLead({ type })),
    );
    expect(new Set(kinds).size).toBe(3);
  });
});

describe("what Meta rejects at SEND time, not at approval", () => {
  /**
   * The failure this sanitiser exists for: a note is free text a customer typed
   * into WhatsApp, so it routinely carries newlines. Meta rejects the send, the
   * notification never goes out, and the only trace is a log line.
   */
  it("collapses newlines and tabs, which would be rejected", () => {
    const template = buildLeadTemplate({
      lead: seedLead({ note: "quiero 40\nunidades\t\tpara el 15" }),
      name: "lead_capturado",
      language: "es",
      landingCode: "X",
    });

    const note = template.bodyParams[3] ?? "";
    expect(note).toBe("quiero 40 unidades para el 15");
    expect(note).not.toMatch(/[\n\t]/);
  });

  it("collapses long runs of spaces", () => {
    expect(templateParam("hola      mundo")).toBe("hola mundo");
  });

  /** An empty parameter is rejected, and product_code and note are nullable. */
  it("substitutes a visible stand-in for a missing value", () => {
    const template = buildLeadTemplate({
      lead: seedLead({ note: null, product_code: null }),
      name: "lead_capturado",
      language: "es",
      landingCode: "X",
    });

    expect(template.bodyParams[2]).toBe("—");
    expect(template.bodyParams[3]).toBe("—");
    // Nothing may be empty or whitespace-only.
    for (const param of template.bodyParams) {
      expect(param.trim().length).toBeGreaterThan(0);
    }
  });

  it("treats a whitespace-only value as missing", () => {
    expect(templateParam("   \n\t ")).toBe("—");
    expect(templateParam(undefined)).toBe("—");
  });

  it("caps a long note and marks the cut", () => {
    const template = buildLeadTemplate({
      lead: seedLead({ note: "x".repeat(1000) }),
      name: "lead_capturado",
      language: "es",
      landingCode: "X",
    });

    const note = template.bodyParams[3] ?? "";
    expect(note.length).toBeLessThanOrEqual(280);
    expect(note.endsWith("…")).toBe(true);
  });
});

describe("the Cloud API wire shape", () => {
  it("sends type=template with body and button components", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const channel = new CloudApiChannel(CLOUD_CONFIG, recordingFetch(calls));

    await channel.sendTemplate(OWNER, {
      name: "lead_capturado",
      language: "es",
      bodyParams: ["a", "b"],
      buttonUrlSuffix: "CODE123",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: OWNER,
      type: "template",
      template: {
        name: "lead_capturado",
        language: { code: "es" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "CODE123" }],
          },
        ],
      },
    });
  });

  /**
   * ONE REQUEST, unlike sendText, which chunks. A template's body is fixed at
   * approval and rendered by Meta; splitting would produce two copies of an
   * approved message rather than one long one.
   */
  it("never chunks, whatever the parameters contain", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const channel = new CloudApiChannel(CLOUD_CONFIG, recordingFetch(calls));

    await channel.sendTemplate(OWNER, {
      name: "lead_capturado",
      language: "es",
      bodyParams: ["x".repeat(900)],
    });

    expect(calls).toHaveLength(1);
  });

  it("omits the button component when the template has no dynamic URL", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const channel = new CloudApiChannel(CLOUD_CONFIG, recordingFetch(calls));

    await channel.sendTemplate(OWNER, { name: "t", language: "es", bodyParams: ["a"] });

    const components = (calls[0]?.body as { template: { components: unknown[] } }).template
      .components;
    expect(components).toHaveLength(1);
  });

  it("normalises the recipient and refuses one with no digits", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const channel = new CloudApiChannel(CLOUD_CONFIG, recordingFetch(calls));

    await channel.sendTemplate("+57 300 111 2233", { name: "t", language: "es", bodyParams: [] });
    expect((calls[0]?.body as { to: string }).to).toBe("573001112233");

    await expect(
      channel.sendTemplate("sin dígitos", { name: "t", language: "es", bodyParams: [] }),
    ).rejects.toThrow(/unusable recipient/);
  });

  /**
   * A rejection has to name the template, because a 132001 is almost always a
   * name or language that drifted from what Meta approved — and neither is
   * visible anywhere else in the system.
   */
  it("throws with the template named, so a rejection is diagnosable", async () => {
    const channel = new CloudApiChannel(CLOUD_CONFIG, recordingFetch([], false));

    await expect(
      channel.sendTemplate(OWNER, { name: "lead_capturado", language: "es", bodyParams: [] }),
    ).rejects.toThrow(/lead_capturado\/es/);
  });

  it("explains 132001 in words rather than a bare code", async () => {
    const channel = new CloudApiChannel(CLOUD_CONFIG, recordingFetch([], false));

    await expect(
      channel.sendTemplate(OWNER, { name: "x", language: "es", bodyParams: [] }),
    ).rejects.toThrow(/no approved template with that name and language/);
  });
});

describe("the free-form fallback", () => {
  it("still says everything the template would have", () => {
    const lead = seedLead({ name: "Ana" });
    const notice = buildLeadNotice(lead, "https://luminiere.pasiolum.com/go/CODE123");

    expect(notice).toContain(CUSTOMER);
    expect(notice).toContain("LUM-COL-40");
    expect(notice).toContain("Ana");
    expect(notice).toContain("quiere 40 unidades para un evento");
    // The link the button would have carried, as text.
    expect(notice).toContain("https://luminiere.pasiolum.com/go/CODE123");
  });

  /**
   * The fallback also runs where no code was minted at all: a transport with no
   * templates, or an origin still set to a placeholder. There the owner writes
   * "panel", exactly as before any of this existed.
   */
  it("tells the owner to write panel when there is no link to give", () => {
    const notice = buildLeadNotice(seedLead());

    expect(notice).toContain("panel");
    expect(notice).not.toContain("http");
  });

  it("describes the lead the same way the template does", () => {
    const lead = seedLead({ type: "back_in_stock" });
    expect(buildLeadNotice(lead)).toContain(leadKindPhrase(lead));
  });
});
