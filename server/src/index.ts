import Fastify from "fastify";
import { runAgentTurn } from "./agent.js";
import { ConsecutiveFailureAlert } from "./alerts.js";
import { InboxBatcher } from "./batcher.js";
import { isOwner, loadConfig, loadDotEnv } from "./config.js";
import { openDb } from "./db.js";
import { KapsoClient } from "./kapso.js";
import { registerMediaRoutes } from "./media.js";
import { PerPhoneQueue } from "./queue.js";
import { RateLimiter } from "./rate-limit.js";
import { deleteStaleInboxRows, deleteStalePendingMedia, upsertContact } from "./repo.js";
import { registerWebhook, type WebhookDeps } from "./webhook.js";
import type { TurnContext } from "./types.js";

const RATE_LIMIT_NOTICE =
  "Estamos recibiendo muchos mensajes tuyos en poco tiempo. Dame unos minutos y escríbeme de nuevo, por favor.";
const AGENT_ERROR_APOLOGY =
  "Disculpa, tuve un inconveniente para responder. ¿Podrías intentarlo de nuevo?";
const OWNER_FAILURE_ALERT =
  "⚠️ Vitrina: hubo varios errores consecutivos al responder mensajes. Revisa los logs del servidor.";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const kapso = new KapsoClient(config);
  const queue = new PerPhoneQueue();
  const rateLimiter = new RateLimiter({
    perPhonePerHour: config.rateLimitPerPhonePerHour,
    globalPerDay: config.rateLimitGlobalPerDay,
  });
  const failureAlert = new ConsecutiveFailureAlert();

  const app = Fastify({ logger: true });

  // Housekeeping on boot and hourly: purge unattached inbound media older than
  // 48h and settled inbox rows past their TTL.
  const PENDING_MEDIA_TTL_HOURS = 48;
  const runHousekeeping = (): void => {
    try {
      const media = deleteStalePendingMedia(db, PENDING_MEDIA_TTL_HOURS);
      const inbox = deleteStaleInboxRows(db);
      if (media > 0 || inbox > 0) {
        app.log.info(
          `Housekeeping: removed ${media} stale pending media file(s), ${inbox} settled inbox row(s)`,
        );
      }
    } catch (err) {
      app.log.error({ err }, "housekeeping failed");
    }
  };
  runHousekeeping();
  const housekeepingTimer = setInterval(runHousekeeping, 60 * 60 * 1000);
  housekeepingTimer.unref();

  app.get("/health", async () => ({ status: "ok", time: new Date().toISOString() }));

  registerMediaRoutes(app, config);

  const notifyOwnersOfFailures = async (): Promise<void> => {
    for (const owner of config.ownerPhoneNumbers) {
      try {
        await kapso.sendText(owner, OWNER_FAILURE_ALERT);
      } catch {
        // Best effort; the failure is already in the logs.
      }
    }
  };

  const roleFor = (phone: string): TurnContext["role"] =>
    isOwner(config, phone) ? "owner" : "customer";

  const batcher = new InboxBatcher({
    db,
    queue,
    log: app.log,
    debounceMs: config.batchDebounceMs,
    maxWaitMs: config.batchMaxWaitMs,
    mediaDebounceMs: config.batchMediaDebounceMs,
    mediaMaxWaitMs: config.batchMediaMaxWaitMs,
    roleFor,
    onMessage: async (ctx: TurnContext, text: string) => {
      upsertContact(db, ctx.phone, ctx.role);

      // Cost protection: customers are rate limited; owners are exempt.
      if (ctx.role !== "owner") {
        const decision = rateLimiter.check(ctx.phone);
        if (decision !== "ok") {
          app.log.warn({ phone: ctx.phone, decision }, "agent turn rate limited");
          if (decision === "phone_limited" && rateLimiter.shouldNotify(ctx.phone)) {
            try {
              await kapso.sendText(ctx.phone, RATE_LIMIT_NOTICE);
            } catch {
              // Best effort.
            }
          }
          return; // Deliberately consumed; the inbox batch settles as done.
        }
      }

      // A throw here reaches the batcher, which retries the batch with backoff
      // and settles it as failed once the attempt budget is spent — the
      // user-facing side effects live in onBatchFailure below.
      await runAgentTurn({ db, kapso, config, log: app.log }, ctx, text);
      failureAlert.recordSuccess();
    },
    onBatchFailure: async (ctx, { final }) => {
      // The streak counts EVERY failed attempt, not only terminal ones: this
      // alert is the pilot's outage monitor, and waiting for terminal failures
      // would delay detection by the whole retry budget. The cooldown plus the
      // success reset keep it from spamming.
      if (failureAlert.recordFailure()) void notifyOwnersOfFailures();
      if (!final) return; // the retry may still answer; apologize only when it cannot
      try {
        await kapso.sendText(ctx.phone, AGENT_ERROR_APOLOGY);
      } catch {
        // Best effort; the failure is already in the logs.
      }
    },
  });

  const deps: WebhookDeps = { config, db, kapso, batcher, roleFor };

  registerWebhook(app, deps);

  // Un-flushed bursts must not hold the process open on shutdown; their rows
  // stay pending and are replayed on the next boot.
  app.addHook("onClose", async () => {
    batcher.stop();
  });

  // Recover messages a previous process accepted but never finished, before
  // taking new traffic so per-phone ordering holds.
  batcher.replayPending();

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`Vitrina server listening on :${config.port}`);
}

main().catch((err: unknown) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
