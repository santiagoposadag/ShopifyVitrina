import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";

/** Build the public URL WhatsApp can fetch for a stored media file. */
export function publicPathFor(config: Pick<Config, "publicBaseUrl">, fileName: string): string {
  return `${config.publicBaseUrl}/media/${encodeURIComponent(fileName)}`;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Persist a downloaded media buffer into MEDIA_DIR under a unique file name.
 * Returns the absolute file path, its base name, and the public URL.
 */
export async function saveMedia(
  config: Config,
  buffer: Buffer,
  opts: { mimeType?: string; suggestedName?: string },
): Promise<{ filePath: string; fileName: string; publicPath: string }> {
  mkdirSync(config.mediaDir, { recursive: true });
  const ext =
    (opts.suggestedName && extname(opts.suggestedName)) ||
    (opts.mimeType && MIME_EXT[opts.mimeType]) ||
    ".jpg";
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const filePath = join(config.mediaDir, fileName);
  await writeFile(filePath, buffer);
  return { filePath, fileName, publicPath: publicPathFor(config, fileName) };
}

/**
 * Serve MEDIA_DIR under GET /media/*. Photos are public so WhatsApp (and the
 * storefront during local dev) can fetch them by URL.
 */
export function registerMediaRoutes(app: FastifyInstance, config: Config): void {
  app.get<{ Params: { "*": string } }>("/media/*", (request, reply) => {
    const raw = request.params["*"] ?? "";
    // Prevent path traversal: only allow the bare file name.
    const fileName = basename(decodeURIComponent(raw));
    const filePath = join(config.mediaDir, fileName);
    if (!fileName || !existsSync(filePath)) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    const contentType = CONTENT_TYPE_BY_EXT[extname(fileName).toLowerCase()] ?? "application/octet-stream";
    reply.header("Content-Type", contentType);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.send(createReadStream(filePath));
  });
}
