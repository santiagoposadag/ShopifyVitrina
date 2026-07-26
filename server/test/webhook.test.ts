import { createHmac } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * The bug this whole path exists to fix: an owner sent a voice note and got
 * TOTAL silence. Not a wrong answer, not an error — the message was dropped in
 * the handler before it was ever persisted, so no batch was scheduled and no
 * turn ran. These tests drive the real route.
 */
describe("inbound audio reaches the inbox", () => {
  const AUDIO_EVENT = {
    provider: "whatsmeow",
    id: "3EB0AUDIO",
    from: "573001112233",
    timestamp: 1,
    type: "audio",
    // Empty on purpose: WhatsApp has no caption field for audio, and an empty
    // body is exactly what used to make the handler discard the message.
    text: "",
    media: { path: "note.bin", filename: "audio.ogg", contentType: "audio/ogg; codecs=opus" },
  };

  async function harness(opts: { role?: "owner" | "customer" } = {}) {
    const { default: Fastify } = await import("fastify");
    const { registerWebhook } = await import("../src/inbox/webhook.js");

    const dir = await mkdtemp(join(tmpdir(), "vitrina-audio-"));
    const db = openDb(":memory:");
    const scheduled: { phone: string; kind: string }[] = [];
    const released: string[] = [];

    const app = Fastify();
    registerWebhook(app, {
      config: {
        webhookSecret: SECRET,
        audioDir: join(dir, "audio"),
        mediaDir: join(dir, "media"),
        publicBaseUrl: "http://localhost:3001",
        transcriptionMaxBytes: 25 * 1024 * 1024,
      } as never,
      db,
      channel: {
        sendText: async () => undefined,
        downloadMedia: async () => Buffer.from("fake-opus-bytes"),
        releaseMedia: async (ref: string) => {
          released.push(ref);
        },
      } as never,
      batcher: {
        schedule: (phone: string, kind: string) => {
          scheduled.push({ phone, kind });
        },
      } as never,
      roleFor: () => opts.role ?? "owner",
    });
    await app.ready();

    const post = async (event: Record<string, unknown>) => {
      const body = JSON.stringify(event);
      return app.inject({
        method: "POST",
        url: "/webhook",
        headers: { "content-type": "application/json", "x-webhook-signature": sign(body) },
        payload: body,
      });
    };

    return { app, db, post, scheduled, released, dir };
  }

  it("persists a voice note instead of silently dropping it", async () => {
    const h = await harness();

    const res = await h.post(AUDIO_EVENT);

    expect(res.statusCode).toBe(200);
    const rows = h.db.prepare(`SELECT * FROM inbox`).all() as { audio_path: string | null }[];
    expect(rows).toHaveLength(1);
    // The path is what the worker transcribes from. Without it the row is a
    // message with no content at all.
    expect(rows[0]!.audio_path).toBeTruthy();
    expect(h.scheduled).toHaveLength(1);
    await h.app.close();
  });

  it("schedules audio on the TEXT window, not the 45s media one", async () => {
    // The media window exists for photo sets arriving in waves. Applying it to
    // one voice note would make the person wait 45s for a reply.
    const h = await harness();

    await h.post(AUDIO_EVENT);

    expect(h.scheduled[0]!.kind).toBe("text");
    await h.app.close();
  });

  it("works for a CUSTOMER too, unlike photos", async () => {
    // Photos are owner-only because only owners build listings. A customer's
    // voice note IS the customer's question — dropping it is the bug.
    const h = await harness({ role: "customer" });

    await h.post(AUDIO_EVENT);

    expect(h.db.prepare(`SELECT COUNT(*) n FROM inbox`).get()).toEqual({ n: 1 });
    await h.app.close();
  });

  it("NEVER writes audio to pending_media, for either role", async () => {
    // attach_pending_photos consumes every unattached row for a phone with no
    // type filter, so a stored voice note would be attached to the next product
    // and published to the public storefront as a photo.
    for (const role of ["owner", "customer"] as const) {
      const h = await harness({ role });
      await h.post(AUDIO_EVENT);
      expect(h.db.prepare(`SELECT COUNT(*) n FROM pending_media`).get()).toEqual({ n: 0 });
      await h.app.close();
    }
  });

  it("does not leave an orphan file when the bridge redelivers", async () => {
    // The audio is stored BEFORE the insert, because the row must carry its
    // path — so a redelivery that dedupes would otherwise strand the file.
    const h = await harness();

    await h.post(AUDIO_EVENT);
    await h.post(AUDIO_EVENT);

    expect(h.db.prepare(`SELECT COUNT(*) n FROM inbox`).get()).toEqual({ n: 1 });
    const stored = await readdir(join(h.dir, "audio"));
    expect(stored).toHaveLength(1);
    await h.app.close();
  });

  it("still drops an event kind that carries nothing at all", async () => {
    // Settling unsupported kinds quietly is deliberate and must survive this
    // change — audio joined that exemption, it did not remove it.
    const h = await harness();

    await h.post({ ...AUDIO_EVENT, type: "other", media: undefined });

    expect(h.db.prepare(`SELECT COUNT(*) n FROM inbox`).get()).toEqual({ n: 0 });
    await h.app.close();
  });
});
