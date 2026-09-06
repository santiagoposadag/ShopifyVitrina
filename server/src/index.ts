import Fastify from "fastify";
import { runAgentTurn } from "./agent/runtime.js";
import { buildEchoReply } from "./agent/echo.js";
import { checkAgentCredential } from "./agent/preflight.js";
import { transcribe, transcriptionEnabled } from "./agent/transcribe.js";
import { ConsecutiveFailureAlert } from "./inbox/alerts.js";
import { InboxBatcher } from "./inbox/batcher.js";
import { isOwner, loadConfig, loadDotEnv } from "./config.js";
import { openDb } from "./data/db.js";
import { BridgeChannel, sweepStagedMedia } from "./whatsapp/bridge.js";
import type { WhatsAppChannel } from "./whatsapp/channel.js";
import { CloudApiChannel } from "./whatsapp/cloud.js";
import { registerMediaRoutes, saveAudio, saveMedia } from "./whatsapp/media.js";
import { PerConversationQueue } from "./inbox/queue.js";
import { RateLimiter } from "./inbox/rate-limit.js";
import {
  deleteStaleInboxRows,
  deleteStalePendingMedia,
  listSessions,
  upsertContact,
} from "./data/repo.js";
import { sweepOrphanedTranscripts, transcriptsDir } from "./data/transcripts.js";
import { CatalogCache } from "./shopify/cache.js";
import { ShopifyClient } from "./shopify/client.js";
import { registerWebhook, type WebhookDeps } from "./inbox/webhook.js";
import { Responders } from "./egress/responder.js";
import { agentIdForPhone, AGENT_IDS } from "./router.js";
import { toolUniverse } from "./tools/registry.js";
import { shopifyCatalogPort } from "./shopify/catalog-port.js";
import { sqliteLeadsPort, sqliteMediaPort } from "./data/tool-ports.js";
import type { ToolPorts } from "./tools/ports.js";
import { loadAndValidateDefinitions } from "./agent/definition.js";
import { countIndexedChunks, estimateTokens, loadKnowledgeBase } from "./knowledge/store.js";
import type { TurnContext } from "./types.js";

const RATE_LIMIT_NOTICE =
  "Estamos recibiendo muchos mensajes tuyos en poco tiempo. Dame unos minutos y escríbeme de nuevo, por favor.";
const CUSTOMER_UNAVAILABLE_NOTICE =
  "Hola, gracias por escribirnos. En este momento nuestro asistente de ventas no está disponible. Por favor intenta más tarde.";
const AGENT_ERROR_APOLOGY =
  "Disculpa, tuve un inconveniente para responder. ¿Podrías intentarlo de nuevo?";
const OWNER_FAILURE_ALERT =
  "⚠️ Vitrina: hubo varios errores consecutivos al responder mensajes. Revisa los logs del servidor.";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const db = openDb(config.dbPath, {
    // Sessions used to be keyed by phone alone. A row written by an older build
    // therefore names a person and not an assistant, and only the composition
    // root can tell which one they were talking to — data/db.ts cannot see the
    // owner allowlist, and this is the one caller that can. Without it those
    // rows are dropped (see SchemaOptions), which for a live deployment means
    // every conversation restarting on the upgrade; with it, an owner's
    // in-progress listing survives.
    //
    // Same rule the router applies to live traffic, deliberately: a session
    // migrated under an id the router never produces is a row nothing will ever
    // read again.
    legacyAgentIdFor: (phone: string) => agentIdForPhone(config, phone),
  });
  // The composition root is the only place that names the transport. Everything
  // below takes the WhatsAppChannel interface, which is what lets the pipeline
  // be tested without an HTTP client or a paired device anywhere in sight — and
  // what makes the choice between Meta's official API and the linked-device
  // bridge one variable rather than a rewrite.
  const channel: WhatsAppChannel =
    config.whatsappProvider === "cloud" ? new CloudApiChannel(config) : new BridgeChannel(config);
  // One client and one cache for the whole process: the cache exists so a burst
  // of messages does not pay for a full catalog fetch per turn, which only works
  // if every turn shares it.
  const shopify = new ShopifyClient(config);
  const cache = new CatalogCache(shopify, config.catalogCacheTtlMs);
  // Fails BOOT, not the first turn that reaches a broken agent: a typo in
  // agent.yaml or a prompt naming a tool it was never given is a deploy-time
  // mistake, not a transient one, so unlike the credential check below there
  // is nothing to gain by letting the process come up anyway.
  const definitions = Object.fromEntries(
    loadAndValidateDefinitions(config.agentDefinitionsDir, Object.values(AGENT_IDS), toolUniverse()),
  );
  // Fails BOOT for the same reasons the definitions above do: a knowledge path
  // that does not exist, a document nothing declares, a document naming a tool
  // this agent was not given, or inline documents that do not fit their
  // declared budget are all deploy-time typos in a data file. Unlike the
  // credential check further down, none of them fixes itself while the process
  // runs, and an agent booted with half its knowledge answers confidently from
  // the half it has.
  //
  // Also where the searchable tier is indexed (SQLite FTS5, same file as the
  // inbox). The index is derived from the documents and rebuilt here, so it is
  // replaced rather than appended to — a restart is routine and must not
  // duplicate a chunk.
  const knowledge = loadKnowledgeBase({
    db,
    agentsDir: config.agentDefinitionsDir,
    definitions: Object.values(definitions),
    universe: toolUniverse(),
  });
  // What the tools may reach, assembled here and nowhere else: the packs state
  // policy, these four decide what performs it. The catalog adapter is the one
  // that holds the client and the shared cache.
  const ports: ToolPorts = {
    catalog: shopifyCatalogPort({ client: shopify, cache, config }),
    leads: sqliteLeadsPort(db),
    media: sqliteMediaPort(db),
    knowledge,
  };
  const queue = new PerConversationQueue();
  const rateLimiter = new RateLimiter({
    perPhonePerHour: config.rateLimitPerPhonePerHour,
    globalPerDay: config.rateLimitGlobalPerDay,
  });
  const failureAlert = new ConsecutiveFailureAlert();
  // Where a turn's reply goes. The runtime returns the reply and this decides
  // who receives it, from the principal that asked — which is what lets a
  // second kind of caller be answered without touching the agent loop.
  const responders = new Responders(channel);

  const app = Fastify({ logger: true });

  // Housekeeping on boot and hourly: purge unattached inbound media older than
  // 48h, settled inbox rows past their TTL, and agent transcripts no session row
  // can resume any more. The transcript sweep is what keeps expired sessions from
  // leaking files onto the sessions volume forever — clearing a session id only
  // drops the SQLite row, and nothing else ever deletes what it pointed at.
  // Inert unless AGENT_TRANSCRIPTS_DIR is set (see data/transcripts.ts).
  const PENDING_MEDIA_TTL_HOURS = 48;
  // Staged files are normally consumed within seconds. This TTL only catches the
  // ones orphaned by a crash between the bridge writing and us reading, and it is
  // generous on purpose: the bridge's outbox retries indefinitely, so a file may
  // legitimately wait out a long server outage before its event arrives.
  const STAGED_MEDIA_TTL_HOURS = 24;
  const runHousekeeping = async (): Promise<void> => {
    try {
      const media = deleteStalePendingMedia(db, PENDING_MEDIA_TTL_HOURS);
      const inbox = deleteStaleInboxRows(db);
      const root = transcriptsDir();
      const transcripts = root
        ? sweepOrphanedTranscripts(
            root,
            listSessions(db).map((s) => s.agent_session_id),
            config.sessionMaxAgeDays,
          )
        : 0;
      const staged = await sweepStagedMedia(config.bridgeStagingDir, STAGED_MEDIA_TTL_HOURS);
      if (media > 0 || inbox > 0 || transcripts > 0 || staged > 0) {
        app.log.info(
          `Housekeeping: removed ${media} stale pending media file(s), ${inbox} settled inbox row(s), ${transcripts} orphaned transcript(s), ${staged} orphaned staged file(s)`,
        );
      }
    } catch (err) {
      app.log.error({ err }, "housekeeping failed");
    }
  };
  void runHousekeeping();
  const housekeepingTimer = setInterval(() => void runHousekeeping(), 60 * 60 * 1000);
  housekeepingTimer.unref();

  app.get("/health", async () => ({ status: "ok", time: new Date().toISOString() }));

  // Said once at boot: which transport is live decides where an inbound message
  // that never arrives should be chased — Meta's webhook delivery panel, or the
  // bridge's /status. They fail in completely different ways.
  app.log.info(
    config.whatsappProvider === "cloud"
      ? `WhatsApp transport: Meta Cloud API (phone number id ${config.whatsappPhoneNumberId}, ${config.whatsappGraphVersion})`
      : "WhatsApp transport: whatsmeow bridge (linked device)",
  );

  // Said once at boot, per agent, because the ways a knowledge base goes wrong
  // after it loads are all quiet: a definition whose lists someone emptied, a
  // document that shrank to nothing, an index that swept more than it should
  // have. "0 chunks" here is the difference between an agent that has no
  // knowledge and one that lost it.
  for (const definition of Object.values(definitions)) {
    const forPrompt = knowledge.promptFor(definition.id);
    app.log.info(
      {
        agentId: definition.id,
        inlineDocuments: definition.knowledge.inline.length,
        inlineTokensEstimated: forPrompt ? estimateTokens(forPrompt.inlineText) : 0,
        maxInlineTokens: definition.knowledge.maxInlineTokens,
        searchableDocuments: definition.knowledge.searchable.length,
        indexedChunks: countIndexedChunks(db, definition.id),
      },
      `knowledge base ready for ${definition.id}`,
    );
  }

  if (config.echoMode) {
    app.log.warn(
      "ECHO_MODE IS ON — every inbound message gets a canned test reply. No agent turn, " +
        "no Claude call, no Shopify request. Unset ECHO_MODE before serving real customers.",
    );
  }

  // Never blocks startup: a credential problem must not stop the server from
  // accepting and PERSISTING inbound messages. The inbox is durable, so messages
  // that arrive during an outage are replayed once the key is fixed — refusing to
  // boot would drop them on the floor instead.
  // Said once at boot rather than discovered per voice note: without a key,
  // every voice note gets the "please write it" fallback, and that is a
  // configuration choice worth seeing in the startup log.
  if (!transcriptionEnabled(config)) {
    app.log.warn(
      "TRANSCRIPTION_API_KEY is not set — inbound voice notes will be answered with a request to write instead",
    );
  }

  const credentialName = config.agentAuthToken ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
  // Skipped in echo mode: no turn ever runs, and there may be no credential at
  // all to check — reporting one as REJECTED would be noise about a thing that
  // is not being used.
  if (!config.echoMode) void checkAgentCredential(config).then((result) => {
    if (result.status === "invalid") {
      app.log.error(
        { detail: result.detail, endpoint: config.agentBaseUrl },
        `${credentialName} is REJECTED by the API — every agent turn will fail with ` +
          '"Claude Code process exited with code 1". Fix the credential and restart.',
      );
    } else if (result.status === "unknown") {
      app.log.warn(
        { detail: result.detail, endpoint: config.agentBaseUrl },
        `could not verify ${credentialName} at boot`,
      );
    }
  });

  registerMediaRoutes(app, config);

  const notifyOwnersOfFailures = async (): Promise<void> => {
    for (const owner of config.ownerPhoneNumbers) {
      try {
        await channel.sendText(owner, OWNER_FAILURE_ALERT);
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
    // Fetching an inbound file belongs to the worker, not the webhook: the
    // handler records a reference and ACKs, and this resolves it once the
    // burst's debounce window closes. Meta retries a slow webhook and can
    // disable the subscription outright; the bridge's outbox is sequential and
    // stalls every message behind a slow handler. Both bills land here instead,
    // where a burst was already waiting.
    media: {
      // The timeout is the transport's to declare — two Graph round trips need
      // far longer than a read off a mounted volume — and it stays bounded so a
      // hung fetch cannot pin one phone's queue forever.
      download: (ref: string) =>
        channel.downloadMedia(ref, AbortSignal.timeout(channel.mediaTimeoutMs ?? 5000)),
      savePhoto: (buffer, opts) => saveMedia(config, buffer, opts),
      saveAudio: (buffer, opts) => saveAudio(config, buffer, opts),
      maxAudioBytes: config.transcriptionMaxBytes,
    },
    log: app.log,
    debounceMs: config.batchDebounceMs,
    maxWaitMs: config.batchMaxWaitMs,
    mediaDebounceMs: config.batchMediaDebounceMs,
    mediaMaxWaitMs: config.batchMediaMaxWaitMs,
    roleFor,
    // Runs on the worker, never in the webhook — see transcribe.ts. With no
    // TRANSCRIPTION_API_KEY this returns null and a voice note gets a reply
    // asking for text, rather than the silence it used to get.
    transcribeAudio: async (filePath: string) => {
      const result = await transcribe(filePath, config);
      return result?.text ?? null;
    },
    onMessage: async (envelope, ctx) => {
      upsertContact(db, ctx.phone, ctx.role);

      // Diagnostic mode, and deliberately the FIRST thing here. It sits ahead of
      // both gates below because a mode whose only job is to show that a message
      // came back must not be the mode that silently swallows the reply — and
      // neither gate is protecting anything on this path: the kill switch exists
      // to stop Claude calls, the rate limiter to bound their cost, and this
      // makes none. Logged at every turn so a deployment left in it is obvious.
      if (config.echoMode) {
        app.log.warn({ phone: ctx.phone, role: ctx.role }, "ECHO_MODE: replying without an agent turn");
        await channel.sendText(ctx.phone, buildEchoReply(envelope.text));
        return; // Consumed; the inbox batch settles as done.
      }

      // Kill switch: with the customer path disabled, non-owners get a static
      // notice and the agent never runs (no Claude call). One reply per
      // coalesced burst, so a message barrage cannot turn this into spam.
      if (ctx.role !== "owner" && !config.customerAgentEnabled) {
        try {
          await channel.sendText(ctx.phone, CUSTOMER_UNAVAILABLE_NOTICE);
        } catch {
          // Best effort.
        }
        return; // Deliberately consumed; the inbox batch settles as done.
      }

      // Cost protection: customers are rate limited; owners are exempt.
      if (ctx.role !== "owner") {
        const decision = rateLimiter.check(ctx.phone);
        if (decision !== "ok") {
          app.log.warn({ phone: ctx.phone, decision }, "agent turn rate limited");
          if (decision === "phone_limited" && rateLimiter.shouldNotify(ctx.phone)) {
            try {
              await channel.sendText(ctx.phone, RATE_LIMIT_NOTICE);
            } catch {
              // Best effort.
            }
          }
          return; // Deliberately consumed; the inbox batch settles as done.
        }
      }

      // A throw from EITHER of the two steps below reaches the batcher, which
      // retries the batch with backoff and settles it as failed once the
      // attempt budget is spent — the user-facing side effects live in
      // onBatchFailure below. That includes a failed send: swallowing it would
      // settle the batch as done with nothing delivered, and the person would
      // wait forever for a reply that exists nowhere. The retry costs a second
      // agent turn, which is the cheaper mistake and is what ctx.turnKey makes
      // safe against on the Shopify side.
      const reply = await runAgentTurn(
        { db, config, ports, definitions, knowledge, log: app.log },
        ctx,
        envelope.text,
      );
      // Answered through the principal the DOOR authenticated, carried here in
      // the envelope. Rebuilding one from ctx.phone would work today and would
      // be a lie tomorrow: it hard-codes "everyone who asks has a phone" into
      // the one place that is supposed to be indifferent to who asked.
      await responders.for(envelope.principal).deliver(reply);
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
        await channel.sendText(ctx.phone, AGENT_ERROR_APOLOGY);
      } catch {
        // Best effort; the failure is already in the logs.
      }
    },
  });

  const deps: WebhookDeps = { config, db, channel, batcher, roleFor };

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
