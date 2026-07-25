import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeChannel, isAllowedMediaPath, sweepStagedMedia } from "../src/whatsapp/bridge.js";

async function staging(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vitrina-staging-"));
}

describe("isAllowedMediaPath", () => {
  const DIR = "/data/inbound";

  it("allows a file inside the staging directory", () => {
    expect(isAllowedMediaPath(DIR, "/data/inbound/abc.bin")).toBe(true);
    expect(isAllowedMediaPath(DIR, "abc.bin")).toBe(true);
  });

  it("refuses to escape the staging directory", () => {
    // The ref arrives in a signed body, but a signature proves origin, not good
    // behaviour — and this value is fed straight to readFile.
    expect(isAllowedMediaPath(DIR, "../vitrina.db")).toBe(false);
    expect(isAllowedMediaPath(DIR, "/data/vitrina.db")).toBe(false);
    expect(isAllowedMediaPath(DIR, "/etc/passwd")).toBe(false);
    expect(isAllowedMediaPath(DIR, "/data/inbound/../../etc/passwd")).toBe(false);
  });

  it("refuses a sibling directory that merely shares the prefix", () => {
    // A naive startsWith check passes this one.
    expect(isAllowedMediaPath(DIR, "/data/inbound-evil/x.bin")).toBe(false);
  });

  it("refuses a NUL byte, which would truncate the path inside libuv", () => {
    expect(isAllowedMediaPath(DIR, "abc.bin\0../../etc/passwd")).toBe(false);
  });

  it("refuses the directory itself and empty input", () => {
    expect(isAllowedMediaPath(DIR, DIR)).toBe(false);
    expect(isAllowedMediaPath(DIR, "")).toBe(false);
    expect(isAllowedMediaPath("", "abc.bin")).toBe(false);
  });
});

describe("BridgeChannel media", () => {
  let dir: string;
  let channel: BridgeChannel;

  beforeEach(async () => {
    dir = await staging();
    channel = new BridgeChannel({
      bridgeUrl: "http://bridge:3002",
      bridgeApiToken: "token",
      bridgeStagingDir: dir,
    });
  });

  it("reads a staged file and deletes it", async () => {
    const path = join(dir, "photo.bin");
    await writeFile(path, "jpeg-bytes");

    const buffer = await channel.downloadMedia(path);

    expect(buffer.toString()).toBe("jpeg-bytes");
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps the file when the read fails, so a photo is not destroyed unread", async () => {
    const path = join(dir, "photo.bin");
    await writeFile(path, "jpeg-bytes");
    const signal = AbortSignal.abort();

    await expect(channel.downloadMedia(path, signal)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["photo.bin"]);
  });

  it("refuses a ref outside the staging directory WITHOUT reading it", async () => {
    await expect(channel.downloadMedia("../../etc/passwd")).rejects.toThrow(
      /outside the staging directory/,
    );
  });

  it("releases a file we chose not to store", async () => {
    // Customers' photos are never stored, and nothing else would delete them.
    const path = join(dir, "customer.bin");
    await writeFile(path, "x");

    await channel.releaseMedia(path);

    expect(await readdir(dir)).toEqual([]);
  });

  it("never throws when releasing something already gone", async () => {
    // A redelivery from the bridge's outbox names a file the first pass consumed.
    await expect(channel.releaseMedia(join(dir, "missing.bin"))).resolves.toBeUndefined();
    await expect(channel.releaseMedia("../../etc/passwd")).resolves.toBeUndefined();
  });
});

describe("BridgeChannel.sendText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const channel = new BridgeChannel({
    bridgeUrl: "http://bridge:3002",
    bridgeApiToken: "s3cret",
    bridgeStagingDir: "/data/inbound",
  });

  it("posts the reply with a bearer token", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await channel.sendText("573001112233", "hola");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://bridge:3002/send");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer s3cret");
    expect(JSON.parse(init.body as string)).toEqual({ to: "573001112233", body: "hola" });
  });

  it("throws on a failed send so the batcher retries the turn", async () => {
    vi.stubGlobal("fetch", async () => new Response("device offline", { status: 502 }));
    await expect(channel.sendText("573001112233", "hola")).rejects.toThrow(/502/);
  });
});

describe("sweepStagedMedia", () => {
  it("removes orphans past the TTL and leaves fresh files alone", async () => {
    // The gap this covers: the bridge writes a file, then something dies before
    // the event is delivered. Nothing else references that file, ever.
    const dir = await staging();
    const old = join(dir, "orphan.bin");
    const fresh = join(dir, "in-flight.bin");
    await writeFile(old, "x");
    await writeFile(fresh, "y");
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(old, longAgo, longAgo);

    const removed = await sweepStagedMedia(dir, 24);

    expect(removed).toBe(1);
    // A file written seconds ago may belong to an event still in the outbox.
    expect(await readdir(dir)).toEqual(["in-flight.bin"]);
  });

  it("is inert when no staging directory is configured", async () => {
    // Under Kapso the setting is empty, and housekeeping still runs every hour.
    expect(await sweepStagedMedia("", 24)).toBe(0);
    expect(await sweepStagedMedia("/nonexistent/path/xyz", 24)).toBe(0);
  });
});
