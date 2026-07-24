import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Config } from "../config.js";
import type { WhatsAppChannel } from "./channel.js";

/**
 * Client for the whatsmeow bridge sidecar (see bridge/).
 *
 * The bridge speaks the WhatsApp Web multidevice protocol as a linked device, so
 * unlike Kapso there is no Cloud API, no phone number id, and no per-conversation
 * fee — and no official standing with Meta either.
 *
 * The two halves are asymmetric on purpose. Sending is an HTTP call to the
 * sidecar, because only it holds the session. Receiving media is a FILE READ:
 * whatsmeow decrypts inbound media itself, so the bridge writes the plaintext to
 * a directory both containers mount and hands us a path. A burst of 37 photos
 * therefore moves zero image bytes over HTTP.
 */

/**
 * Confine a media ref to the staging directory.
 *
 * The ref arrives inside a signed webhook body, but a signature proves origin,
 * not good behaviour — and this value is fed straight to readFile. Without this,
 * a ref of "../../data/vitrina.db" would hand the database to the agent as if it
 * were a photo. Same reasoning as isAllowedMediaHost on the Kapso side: validate
 * before you dereference.
 *
 * Exported for tests.
 */
export function isAllowedMediaPath(stagingDir: string, ref: string): boolean {
  if (!stagingDir || !ref) return false;
  // A NUL byte truncates the path inside libuv, so a ref like "ok.bin\0../../x"
  // could pass a string check and open something else entirely.
  if (ref.includes("\0")) return false;
  const dir = resolve(stagingDir);
  const target = resolve(dir, ref);
  // The separator matters: "/data/inbound-evil" is a prefix match on
  // "/data/inbound" but is emphatically not inside it.
  return target.startsWith(dir + sep);
}

/**
 * Delete staged files older than maxAgeHours, returning how many went.
 *
 * The normal path already cleans up: the server reads a file and unlinks it, or
 * releases it unread. This is for the gap between those — the bridge writes a
 * file, then the server (or the bridge) dies before the event is delivered. The
 * file is referenced only by a queued payload that will never arrive, so nothing
 * else will ever remove it.
 *
 * The age check is what makes this safe to run on a live system: a file written
 * seconds ago may belong to an event still sitting in the outbox.
 */
export async function sweepStagedMedia(stagingDir: string, maxAgeHours: number): Promise<number> {
  if (!stagingDir) return 0;
  let entries: string[];
  try {
    entries = await readdir(stagingDir);
  } catch {
    return 0; // Not configured, or not created yet.
  }
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    const path = join(stagingDir, entry);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.mtimeMs >= cutoff) continue;
      await unlink(path);
      removed += 1;
    } catch {
      // Raced with a real download, or vanished. Either way, not ours to worry about.
    }
  }
  return removed;
}

export class BridgeChannel implements WhatsAppChannel {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly stagingDir: string;

  constructor(config: Pick<Config, "bridgeUrl" | "bridgeApiToken" | "bridgeStagingDir">) {
    this.baseUrl = config.bridgeUrl;
    this.token = config.bridgeApiToken;
    this.stagingDir = config.bridgeStagingDir;
  }

  async sendText(to: string, body: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ to, body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Throwing reaches the batcher, which retries the whole turn with backoff.
      throw new Error(`Bridge send failed (${res.status}): ${text}`);
    }
  }

  /**
   * Read a decrypted file the bridge staged, then delete it. Reading is the
   * whole download: the bytes are already plaintext on a shared volume.
   *
   * The unlink happens only after a successful read, so a failure leaves the
   * file for the housekeeping sweep rather than destroying a photo we never
   * managed to store.
   */
  async downloadMedia(ref: string, signal?: AbortSignal): Promise<Buffer> {
    if (!isAllowedMediaPath(this.stagingDir, ref)) {
      throw new Error(`Refusing to read media outside the staging directory: ${ref}`);
    }
    const buffer = await readFile(resolve(this.stagingDir, ref), { signal });
    await this.releaseMedia(ref);
    return buffer;
  }

  /** Drop a staged file we will not store. Never throws — tidying is best effort. */
  async releaseMedia(ref: string): Promise<void> {
    if (!isAllowedMediaPath(this.stagingDir, ref)) return;
    try {
      await unlink(resolve(this.stagingDir, ref));
    } catch {
      // Already gone (a redelivery of an event we handled), or never written.
    }
  }
}
