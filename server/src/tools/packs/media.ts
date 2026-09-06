import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { failure, text, type ToolFactory } from "../factory.js";

/**
 * The media toolpack: photos this conversation already sent, on their way to a
 * product.
 *
 * Nothing here can push media INTO the chat — the tools have no WhatsApp client
 * and the turn's single reply belongs to the runtime.
 */

export const attachPendingPhotos: ToolFactory = (ctx, { catalog, media }) =>
  tool(
    "attach_pending_photos",
    ctx.describe(
      "Upload the photos this owner recently sent in this chat (not yet uploaded to any product) to the given product. Use after the owner sends a product's photos. They are uploaded in the order they arrived, so the first photo the owner sent becomes the product's main image.",
    ),
    { ref: z.string().describe("SKU, handle, or Shopify id of the product to upload them to") },
    async ({ ref }) => {
      // Pending photos belong to a CHAT: they were sent to us by a person, and
      // they are claimed by that person's phone. A turn with no phone has no
      // pending photos by construction, and asking for "everyone's" would upload
      // one owner's product shots to whatever product another caller named.
      const phone = ctx.turn.phone;
      if (!phone) {
        return text("This conversation has no photos of its own to upload. Nothing was uploaded.");
      }
      try {
        const resolved = await catalog.resolve(ref);
        if (!resolved) {
          return text(`No product found for "${ref}". Create it first with create_product.`);
        }
        const pending = await media.listPending(phone);
        if (pending.length === 0) return text("No pending photos from this chat to upload.");

        // Arrival order is the order the owner shot them in, and the first one
        // becomes the cover — the list is passed through unsorted and unbatched.
        const result = await catalog.uploadPhotos(
          resolved.product.id,
          pending.map((photo) => ({ path: photo.path, alt: photo.caption })),
        );

        // Only the ones that actually landed are marked, so a partial failure
        // leaves the rest claimable by a second attempt instead of silently
        // dropping them.
        await media.markAttached(
          pending.slice(0, result.uploaded).map((photo) => photo.id),
          resolved.product.id,
        );

        if (result.failed > 0) {
          return text(
            `Uploaded ${result.uploaded} photo(s) to ${resolved.product.handle}; ${result.failed} failed and are still pending. Tell the owner some photos did not go through.`,
          );
        }
        return text(`Uploaded ${result.uploaded} photo(s) to ${resolved.product.handle}.`);
      } catch (err) {
        return failure("Uploading photos", err);
      }
    },
  );
