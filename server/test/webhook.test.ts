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
    // The whole point of the deferral: this must stay EMPTY for the request.
    const downloaded: string[] = [];

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
        downloadMedia: async (ref: string) => {
          downloaded.push(ref);
          return Buffer.from("fake-opus-bytes");
        },
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

    return { app, db, post, scheduled, released, downloaded, dir };
  }

  it("persists a voice note instead of silently dropping it", async () => {
    const h = await harness();

    const res = await h.post(AUDIO_EVENT);

    expect(res.statusCode).toBe(200);
    const rows = h.db.prepare(`SELECT * FROM inbox`).all() as {
      audio_path: string | null;
      media_ref: string | null;
      media_kind: string | null;
      media_name: string | null;
    }[];
    expect(rows).toHaveLength(1);
    // The REFERENCE is what survives the ACK. Without it the row is a message
    // with no content at all — the bug this whole path exists to fix.
    expect(rows[0]!.media_ref).toBe("note.bin");
    expect(rows[0]!.media_kind).toBe("audio");
    // The file name rides along because the transcription API reads the format
    // off the extension; losing it here makes the transcript fail later.
    expect(rows[0]!.media_name).toBe("audio.ogg");
    // Still unfetched: audio_path is set by the worker, and the two states must
    // stay distinguishable or a retried batch re-downloads what it already has.
    expect(rows[0]!.audio_path).toBeNull();
    expect(h.scheduled).toHaveLength(1);
    await h.app.close();
  });

  it("downloads NOTHING inside the request", async () => {
    // The ACK is the contract. Fetching here cost one or two network round trips
    // per message before the 200: Meta retries a slow webhook and eventually
    // disables the subscription, and the bridge's outbox is strictly sequential,
    // so every message queued behind this one waited too. The worker fetches.
    const h = await harness();

    await h.post(AUDIO_EVENT);

    expect(h.downloaded).toEqual([]);
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

  it("does NOT release the first copy's file when the bridge redelivers", async () => {
    // The reversal that came with deferring the fetch, and the easiest way to
    // reintroduce silent data loss. While the handler downloaded the file
    // itself, a redelivery's copy was spent and releasing it was tidy-up. Now
    // the FIRST row still owns that reference and has not fetched it — so the
    // same release would delete the file that row is waiting for, and the
    // owner's photo or voice note would vanish between the ACK and the worker.
    const h = await harness();

    await h.post(AUDIO_EVENT);
    await h.post(AUDIO_EVENT);

    expect(h.db.prepare(`SELECT COUNT(*) n FROM inbox`).get()).toEqual({ n: 1 });
    expect(h.released).toEqual([]);
    // The surviving row still points at the file the worker will fetch.
    const row = h.db.prepare(`SELECT media_ref FROM inbox`).get() as { media_ref: string };
    expect(row.media_ref).toBe("note.bin");
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

/**
 * The Cloud API half of the same route.
 *
 * Two things here are not variations on the bridge's behaviour but reversals of
 * it: one POST can carry several messages, and Meta gives NO ordering guarantee
 * where the bridge's outbox gave a strict one.
 */
describe("Meta Cloud API webhook", () => {
  const APP_SECRET = "meta-app-secret";
  const VERIFY_TOKEN = "vitrina-verify-token";

  function metaPayload(messages: Record<string, unknown>[]): Record<string, unknown> {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "573001112233",
                  phone_number_id: "1234567890",
                },
                messages,
              },
            },
          ],
        },
      ],
    };
  }

  function photo(id: string, caption: string, timestamp: number): Record<string, unknown> {
    return {
      from: "573001112233",
      id,
      timestamp: String(timestamp),
      type: "image",
      image: { id: `MEDIA_${id}`, mime_type: "image/jpeg", caption },
    };
  }

  async function harness() {
    const { default: Fastify } = await import("fastify");
    const { registerWebhook } = await import("../src/inbox/webhook.js");

    const dir = await mkdtemp(join(tmpdir(), "vitrina-cloud-"));
    const db = openDb(":memory:");
    const scheduled: { phone: string; kind: string }[] = [];

    const app = Fastify();
    registerWebhook(app, {
      config: {
        whatsappProvider: "cloud",
        webhookSecret: APP_SECRET,
        whatsappVerifyToken: VERIFY_TOKEN,
        audioDir: join(dir, "audio"),
        mediaDir: join(dir, "media"),
        publicBaseUrl: "http://localhost:3001",
        transcriptionMaxBytes: 25 * 1024 * 1024,
      } as never,
      db,
      channel: {
        sendText: async () => undefined,
        downloadMedia: async () => Buffer.from("jpeg-bytes"),
      } as never,
      batcher: {
        schedule: (phone: string, kind: string) => {
          scheduled.push({ phone, kind });
        },
      } as never,
      roleFor: () => "owner",
    });
    await app.ready();

    const post = async (body: Record<string, unknown>) => {
      const raw = JSON.stringify(body);
      return app.inject({
        method: "POST",
        url: "/webhook",
        headers: {
          "content-type": "application/json",
          // Meta always sends the prefixed form, keyed with the APP SECRET.
          "x-hub-signature-256": `sha256=${sign(raw, APP_SECRET)}`,
        },
        payload: raw,
      });
    };

    return { app, db, post, scheduled };
  }

  it("echoes hub.challenge back as raw text so the panel can save the URL", async () => {
    const h = await harness();

    const res = await h.app.inject({
      method: "GET",
      url: `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    });

    expect(res.statusCode).toBe(200);
    // Raw, NOT JSON: a quoted copy fails Meta's check and the URL is refused.
    expect(res.body).toBe("1158201444");
    await h.app.close();
  });

  it("refuses the handshake when the verify token does not match", async () => {
    const h = await harness();

    const res = await h.app.inject({
      method: "GET",
      url: "/webhook?hub.mode=subscribe&hub.verify_token=guessed&hub.challenge=123",
    });

    expect(res.statusCode).toBe(403);
    await h.app.close();
  });

  it("rejects a payload signed with anything but the app secret", async () => {
    const h = await harness();
    const raw = JSON.stringify(metaPayload([]));

    const res = await h.app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${sign(raw, "not-the-app-secret")}`,
      },
      payload: raw,
    });

    expect(res.statusCode).toBe(401);
    await h.app.close();
  });

  it("persists EVERY message in one POST, not just the first", async () => {
    // The bridge posts one event per request, so the handler used to read one.
    // Meta nests an array, and a burst can share a single POST.
    const h = await harness();

    await h.post(
      metaPayload([
        {
          from: "573001112233",
          id: "wamid.1",
          timestamp: "1756200000",
          type: "text",
          text: { body: "uno" },
        },
        {
          from: "573001112233",
          id: "wamid.2",
          timestamp: "1756200001",
          type: "text",
          text: { body: "dos" },
        },
      ]),
    );

    const rows = h.db.prepare(`SELECT agent_text FROM inbox ORDER BY id`).all();
    expect(rows).toEqual([{ agent_text: "uno" }, { agent_text: "dos" }]);
    expect(h.scheduled).toHaveLength(2);
    await h.app.close();
  });

  it("carries WhatsApp's send stamp onto the row, for a burst that arrives backwards", async () => {
    // The invariant this replaces: the bridge's outbox delivered a burst
    // strictly in order, so arrival order was listing order and the first photo
    // became the cover. Meta gives no such guarantee — these three arrive
    // backwards, and the stamp is the only thing that can put them right.
    //
    // The gallery itself is assembled on the worker now; that half is pinned in
    // batcher.test.ts ("orders a photo burst by WHEN IT WAS SENT").
    const h = await harness();

    await h.post(metaPayload([photo("wamid.C", "tercera", 1756200002)]));
    await h.post(metaPayload([photo("wamid.A", "primera", 1756200000)]));
    await h.post(metaPayload([photo("wamid.B", "segunda", 1756200001)]));

    const rows = h.db
      .prepare(`SELECT agent_text, media_ref, media_sent_at FROM inbox ORDER BY media_sent_at`)
      .all() as { agent_text: string; media_ref: string; media_sent_at: number }[];
    expect(rows.map((r) => r.agent_text)).toEqual(["primera", "segunda", "tercera"]);
    // The media id, never the URL: what Meta hands back expires in ~5 minutes,
    // so resolving it at download time is the only thing that works.
    expect(rows.map((r) => r.media_ref)).toEqual([
      "MEDIA_wamid.A",
      "MEDIA_wamid.B",
      "MEDIA_wamid.C",
    ]);
    await h.app.close();
  });

  it("absorbs Meta's redelivery on the message id", async () => {
    const h = await harness();
    const body = metaPayload([
      {
        from: "573001112233",
        id: "wamid.DUP",
        timestamp: "1756200000",
        type: "text",
        text: { body: "hola" },
      },
    ]);

    await h.post(body);
    await h.post(body);

    expect(h.db.prepare(`SELECT COUNT(*) n FROM inbox`).get()).toEqual({
      n: 1,
    });
    await h.app.close();
  });

  it("ACKs a status-only callback without inventing an agent turn", async () => {
    // These outnumber real messages, and one parsed as inbound would answer a
    // customer who never wrote.
    const h = await harness();

    const res = await h.post({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "1234567890" },
                statuses: [
                  {
                    id: "wamid.OUT",
                    status: "failed",
                    recipient_id: "573001112233",
                    errors: [{ code: 131047 }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(h.db.prepare(`SELECT COUNT(*) n FROM inbox`).get()).toEqual({
      n: 0,
    });
    expect(h.scheduled).toHaveLength(0);
    await h.app.close();
  });
});
