import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { mediaDir } from "@/lib/paths";

export const dynamic = "force-dynamic";

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Serve product photos from the shared MEDIA_DIR. This keeps the storefront
 * self-contained (it does not depend on the WhatsApp server being reachable).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await params;
  const safeName = basename(decodeURIComponent(file));
  const filePath = join(mediaDir(), safeName);

  if (!safeName || !existsSync(filePath)) {
    return new Response("Not found", { status: 404 });
  }

  const buffer = readFileSync(filePath);
  const contentType = CONTENT_TYPE_BY_EXT[extname(safeName).toLowerCase()] ?? "application/octet-stream";
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
