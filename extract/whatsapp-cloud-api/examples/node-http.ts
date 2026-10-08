/**
 * Minimal end-to-end wiring with nothing but node:http: handshake, signed POST,
 * fast ACK, then work off the request path. An echo bot.
 *
 *   WHATSAPP_APP_SECRET=... WHATSAPP_VERIFY_TOKEN=... \
 *   WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_ACCESS_TOKEN=... \
 *   npx tsx examples/node-http.ts
 */
import { createServer } from "node:http";
import {
  SIGNATURE_HEADER,
  WhatsAppCloudClient,
  handleVerification,
  parseWebhook,
  verifySignature,
  type InboundMessage,
} from "../src/index.js";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
};

const appSecret = env("WHATSAPP_APP_SECRET");
const verifyToken = env("WHATSAPP_VERIFY_TOKEN");
const client = new WhatsAppCloudClient({
  phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
  accessToken: env("WHATSAPP_ACCESS_TOKEN"),
});

// Meta redelivers. In production this is a UNIQUE column in a database,
// written BEFORE the ACK so a crash is replayed instead of lost.
const seen = new Set<string>();

async function handle(msg: InboundMessage): Promise<void> {
  if (msg.media) {
    const { data, mimeType } = await client.downloadMedia(msg.media.id, AbortSignal.timeout(15_000));
    await client.sendText(msg.from, `Recibí un archivo ${mimeType ?? ""} de ${data.length} bytes.`);
    return;
  }
  await client.sendText(msg.from, msg.text ? `Eco: ${msg.text}` : `Recibí un mensaje de tipo ${msg.kind}.`, {
    replyTo: msg.id,
  });
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/webhook") return void res.writeHead(404).end();

  if (req.method === "GET") {
    const result = handleVerification(Object.fromEntries(url.searchParams), verifyToken);
    return void res.writeHead(result.status, { "Content-Type": "text/plain" }).end(result.body);
  }

  if (req.method !== "POST") return void res.writeHead(405).end();

  // Collect the RAW bytes: the signature is over them, not over parsed JSON.
  const parts: Buffer[] = [];
  req.on("data", (c: Buffer) => parts.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(parts);
    const sig = req.headers[SIGNATURE_HEADER];
    if (!verifySignature(raw, Array.isArray(sig) ? sig[0] : sig, appSecret)) {
      return void res.writeHead(401).end();
    }

    let parsed;
    try {
      parsed = parseWebhook(JSON.parse(raw.toString("utf8")));
    } catch {
      return void res.writeHead(400).end();
    }

    // ACK first. Everything below runs after Meta already has its 200.
    res.writeHead(200).end();

    for (const s of parsed.statuses) {
      if (s.status === "failed") console.warn("delivery failed", s.recipient, s.error);
    }
    // Sequential, in Meta's order. For strict per-sender ordering use a per-sender queue.
    void (async () => {
      for (const msg of parsed.messages) {
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);
        try {
          await handle(msg);
        } catch (err) {
          console.error("failed to handle", msg.id, err);
        }
      }
    })();
  });
}).listen(Number(process.env.PORT ?? 3000), () => console.log("listening"));
