import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/data/db.js";
import { insertInboxMessage } from "../src/data/repo.js";
import { extractInbound } from "../src/inbox/whatsmeow.js";
import { stableEventKey, verifySignature } from "../src/inbox/webhook.js";

const SECRET = "test_webhook_secret";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("verifySignature", () => {
  const body = JSON.stringify({ hello: "world", n: 1 });

  it("accepts a valid signature", () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("accepts a sha256= prefixed signature", () => {
    expect(verifySignature(body, `sha256=${sign(body)}`, SECRET)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifySignature(body, sign(body, "wrong_secret"), SECRET)).toBe(false);
  });

  it("rejects when the body was tampered with", () => {
    const tampered = body.replace("world", "moon");
    expect(verifySignature(tampered, sign(body), SECRET)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
  });
});

/**
 * The other half of the bridge's signature contract.
 *
 * These three constants are duplicated verbatim in bridge/delivery_test.go. The
 * bridge signs in Go and this server verifies in Node, so nothing else proves
 * the two agree — a change to either side that is not mirrored would break every
 * inbound message while both suites stayed green.
 */
describe("bridge signature contract (pinned across languages)", () => {
  const PINNED_SECRET = "bridge-test-secret";
  const PINNED_BODY = '{"provider":"whatsmeow","id":"3EB0ABC","from":"573001112233"}';
  const PINNED_SIGNATURE = "5fdd6a2dc000ccd74070f754429c98b6547a4a18008f2522a53a29ac95f338e5";

  it("accepts the exact signature the Go bridge produces", () => {
    expect(verifySignature(PINNED_BODY, PINNED_SIGNATURE, PINNED_SECRET)).toBe(true);
  });

  it("still accepts it with the sha256= prefix", () => {
    expect(verifySignature(PINNED_BODY, `sha256=${PINNED_SIGNATURE}`, PINNED_SECRET)).toBe(true);
  });

  it("rejects the signature when a single body byte changes", () => {
    const tampered = PINNED_BODY.replace("573001112233", "573001112234");
    expect(verifySignature(tampered, PINNED_SIGNATURE, PINNED_SECRET)).toBe(false);
  });
});

describe("per-event dedupe via the inbox", () => {
  const event = {
    provider: "whatsmeow",
    id: "3EB0ABC",
    from: "573001112233",
    type: "text",
    text: "hi",
  };

  it("dedupes on the WhatsApp message id across redeliveries", () => {
    const db = openDb(":memory:");
    const inbound = extractInbound(event);
    const key = stableEventKey(event, inbound?.id);
    expect(key).toBe("msg:3EB0ABC");
    // The bridge's outbox retries until the server confirms; the second copy of
    // the same message must not become a second row.
    expect(
      insertInboxMessage(db, { dedupe_key: key, phone: "573001112233", agent_text: "hi" }),
    ).not.toBeNull();
    expect(
      insertInboxMessage(db, { dedupe_key: key, phone: "573001112233", agent_text: "hi" }),
    ).toBeNull();
    db.close();
  });

  it("falls back to a stable content hash when no message id is present", () => {
    const db = openDb(":memory:");
    const anonymous = { ...event, id: undefined };
    const key1 = stableEventKey(anonymous, undefined);
    const key2 = stableEventKey(anonymous, undefined);
    expect(key1).toBe(key2); // deterministic
    expect(key1.startsWith("evt:")).toBe(true);
    expect(
      insertInboxMessage(db, { dedupe_key: key1, phone: "573001112233", agent_text: "hi" }),
    ).not.toBeNull();
    expect(
      insertInboxMessage(db, { dedupe_key: key2, phone: "573001112233", agent_text: "hi" }),
    ).toBeNull();
    db.close();
  });

  it("produces different keys for different events", () => {
    const a = stableEventKey({ ...event, text: "a" }, undefined);
    const b = stableEventKey({ ...event, text: "b" }, undefined);
    expect(a).not.toBe(b);
  });
});
