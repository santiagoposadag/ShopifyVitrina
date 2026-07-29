/**
 * Speech to text for inbound voice notes.
 *
 * Neither Claude nor DeepSeek accepts audio, so a voice note has to become text
 * before the agent can answer it at all. This posts to an OpenAI-shaped
 * `/audio/transcriptions` endpoint, chosen entirely by environment — the same
 * arrangement the agent provider uses, so Groq, OpenAI or anything compatible
 * is a variable change rather than a code change.
 *
 * WhatsApp sends voice notes as Opus in an Ogg container, which these APIs
 * accept directly. That is the reason this is an HTTP call and not a local
 * model: no ffmpeg, no conversion step, and nothing added to the server image.
 *
 * NEVER call this from the webhook. The bridge's outbox is strictly sequential,
 * so every message behind one being handled waits for the handler to return.
 * This belongs on the batcher's async worker.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Config } from "../config.js";

export type TranscriptionConfig = Pick<
  Config,
  "transcriptionBaseUrl" | "transcriptionApiKey" | "transcriptionModel"
>;

/** No key configured means the feature is off — not that it failed. */
export function transcriptionEnabled(config: TranscriptionConfig): boolean {
  return config.transcriptionApiKey.trim().length > 0;
}

/**
 * Generous, because a slow transcript still beats no answer and this runs on
 * the worker where nothing else is blocked. Short enough that a hung provider
 * cannot pin a batch until its own retry budget runs out.
 */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

export interface TranscriptionResult {
  text: string;
  durationMs: number;
}

/**
 * Transcribe one audio file. Returns null when the feature is off, the file is
 * unreadable, or the provider refuses — the caller turns that into a reply
 * asking for text, which is the whole point: a voice note must never again
 * produce silence.
 *
 * `fetchImpl` is injectable so the tests never touch the network.
 */
export async function transcribe(
  filePath: string,
  config: TranscriptionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<TranscriptionResult | null> {
  if (!transcriptionEnabled(config)) return null;

  const startedAt = Date.now();
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    return null;
  }

  const form = new FormData();
  // The filename carries the format. The bridge stages every file as
  // <random>.bin and puts the real extension in its `filename` field, which is
  // what this path was named from — an extensionless upload is rejected or
  // silently misread by these APIs.
  form.append("file", new Blob([new Uint8Array(bytes)]), basename(filePath));
  form.append("model", config.transcriptionModel);
  // Spanish is the only language this product speaks. Naming it is both more
  // accurate than autodetection on short, noisy clips and faster, since the
  // model skips the detection pass.
  form.append("language", "es");
  // Plain text back: we want the words, not segments, timings or confidences.
  form.append("response_format", "text");

  try {
    const res = await fetchImpl(`${config.transcriptionBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.transcriptionApiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    // response_format=text returns a bare string, but a provider that ignores
    // the parameter answers with the JSON envelope instead. Accept both rather
    // than losing a transcript we were actually given.
    const raw = (await res.text()).trim();
    const text = raw.startsWith("{") ? extractJsonText(raw) : raw;
    if (!text) return null;

    return { text, durationMs: Date.now() - startedAt };
  } catch {
    // Timeout, DNS, TLS, provider outage — all the same to the caller.
    return null;
  }
}

function extractJsonText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}
