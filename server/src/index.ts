import Fastify from "fastify";
import { runAgentTurn } from "./agent.js";
import { isOwner, loadConfig, loadDotEnv } from "./config.js";
import { openDb } from "./db.js";
import { KapsoClient } from "./kapso.js";
import { registerMediaRoutes } from "./media.js";
import { PerPhoneQueue } from "./queue.js";
import { deleteStalePendingMedia, upsertContact } from "./repo.js";
import { registerWebhook } from "./webhook.js";
import type { TurnContext } from "./types.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const kapso = new KapsoClient(config);
  const queue = new PerPhoneQueue();

  const app = Fastify({ logger: true });

  // Purge unattached inbound media older than 48h, on boot and hourly.
  const PENDING_MEDIA_TTL_HOURS = 48;
  const runPendingMediaCleanup = (): void => {
    try {
      const removed = deleteStalePendingMedia(db, PENDING_MEDIA_TTL_HOURS);
      if (removed > 0) app.log.info(`Cleaned up ${removed} stale pending media file(s)`);
    } catch (err) {
      app.log.error({ err }, "pending media cleanup failed");
    }
  };
  runPendingMediaCleanup();
  const cleanupTimer = setInterval(runPendingMediaCleanup, 60 * 60 * 1000);
  cleanupTimer.unref();

  app.get("/health", async () => ({ status: "ok", time: new Date().toISOString() }));

  registerMediaRoutes(app, config);

  registerWebhook(app, {
    config,
    db,
    kapso,
    queue,
    roleFor: (phone) => (isOwner(config, phone) ? "owner" : "customer"),
    onMessage: async (ctx: TurnContext, text: string) => {
      upsertContact(db, ctx.phone, ctx.role);
      try {
        await runAgentTurn({ db, kapso, config }, ctx, text);
      } catch (err) {
        app.log.error({ err, phone: ctx.phone }, "agent turn failed");
        try {
          await kapso.sendText(
            ctx.phone,
            "Disculpa, tuve un inconveniente para responder. ¿Podrías intentarlo de nuevo?",
          );
        } catch {
          // Best effort; nothing else to do if the send also fails.
        }
      }
    },
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`Vitrina server listening on :${config.port}`);
}

main().catch((err: unknown) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
