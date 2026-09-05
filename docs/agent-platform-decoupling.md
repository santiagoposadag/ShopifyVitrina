# Decoupling the Agent into a Platform

**Goal:** one runtime that can host N agents. Each agent is **data** (a definition: behaviour, knowledge, tool set), the runtime is **code**, and a request reaches an agent through one inbox whether it comes from a WhatsApp user or from another agent. Planning only — nothing here is implemented.

**Supersedes** [agent-catalog-decoupling.md](agent-catalog-decoupling.md), which was written ten days before the Shopify migration and describes a `repo.ts` catalog that no longer exists. **Complements** [agent-roles-routing.md](agent-roles-routing.md), which decides *who* reaches *which* agent; this page decides what an agent *is* and how a message gets in and out.

---

## 1. AS IS — one process, one agent, two personas

### 1.1 What depends on what

```mermaid
flowchart TB
  subgraph INGRESS["ingress · server/src/inbox"]
    WH["webhook.ts<br/>HMAC · dedupe · ACK"]
    BA["batcher.ts<br/>debounce per phone"]
    QU["queue.ts<br/>PerPhoneQueue"]
  end

  subgraph AGENT["agent · server/src/agent"]
    RT["agent.ts · runAgentTurn<br/>SDK loop · session resume · fallback"]
    SP["agent.ts · systemPrompt(role)<br/>97 lines · owner | customer"]
    TL["tools.ts · buildToolServer<br/>941 lines · 14 tools"]
  end

  subgraph DOMAIN["domain · server/src/shopify"]
    CAT["catalog.ts"]
    CLI["client.ts"]
    RK["rank.ts"]
    CA["cache.ts"]
  end

  subgraph STATE["state · server/src/data"]
    DB[("SQLite<br/>inbox · sessions · contacts<br/>leads · pending_media")]
  end

  subgraph EGRESS["egress · server/src/whatsapp"]
    CH["channel.ts · WhatsAppChannel"]
    BR["bridge.ts"]
    CL["cloud.ts"]
  end

  IDX["index.ts · composition root<br/>roleFor = isOwner(phone)"]

  WH --> BA --> QU --> RT
  RT -->|"systemPrompt(ctx.role)"| SP
  RT -->|"buildToolServer({db,config,shopify,cache,ctx})"| TL
  RT -->|"channel.sendText(ctx.phone)"| CH
  RT --> DB
  TL -->|"import * as catalog · 16 call sites"| CAT
  TL --> CLI
  TL --> RK
  TL --> CA
  TL --> DB
  CH --> BR
  CH --> CL
  IDX -.->|wires| WH
  IDX -.->|wires| BA
  IDX -.->|wires| RT
  IDX -.->|wires| CH

  classDef agent fill:#f7e6df,stroke:#cd5f40,color:#1a2230;
  classDef domain fill:#d7efec,stroke:#1f8a80,color:#1a2230;
  classDef data fill:#dbe8f6,stroke:#2d6aa8,color:#1a2230;
  classDef io fill:#f1e6c8,stroke:#a9781f,color:#1a2230;
  class RT,SP,TL agent;
  class CAT,CLI,RK,CA domain;
  class DB data;
  class WH,BA,QU,CH,BR,CL,IDX io;
```

| Arrow | Anchor | Why it is coupling |
|---|---|---|
| runtime → prompt | `server/src/agent/agent.ts:340` | Prompt is a function in the same file, selected by a two-value `Role` |
| runtime → tools | `server/src/agent/agent.ts:324` | Runtime knows the Shopify client and cache only to hand them to tools |
| runtime → WhatsApp | `server/src/agent/agent.ts:554` | The turn **sends** the reply itself; the caller cannot route it elsewhere |
| tools → Shopify | `server/src/agent/tools.ts:5` | Direct imports; the tool set *is* the Shopify adapter |
| prompt ↔ tools | `server/src/agent/agent.ts:47` | Eleven tool names as string literals; nothing checks they exist |
| identity | `server/src/types.ts:74` | `TurnContext.phone` is the session key, the reply address and the role source |
| role | `server/src/config.ts:430` | `isOwner(phone)` — one env allowlist, two roles, no third |

### 1.2 One message today

```mermaid
sequenceDiagram
  autonumber
  participant WA as WhatsApp
  participant WH as webhook.ts
  participant BA as batcher.ts
  participant RT as runAgentTurn
  participant SDK as Agent SDK
  participant TL as tools.ts
  participant SH as Shopify

  WA->>WH: POST /webhook (signed)
  WH->>WH: insert inbox row · 200 ACK
  WH->>BA: schedule(phone)
  BA->>BA: debounce · claimInboxBatch
  BA->>RT: ctx {phone, role, turnKey}, text
  RT->>RT: getSessionId(phone)
  RT->>SDK: query(systemPrompt(role), mcp: buildToolServer(ctx))
  SDK->>TL: mcp__vitrina__*
  TL->>SH: GraphQL
  SDK-->>RT: reply · session_id · usage
  RT->>RT: set/clear session by phone
  RT->>WA: channel.sendText(phone, reply)
```

### 1.3 Where each concern lives today

```mermaid
quadrantChart
  title Reusable for a second business? (x) · Parametrizable today? (y)
  x-axis "No" --> "Yes"
  y-axis "Hardcoded" --> "Configurable"
  "Runtime loop (agent.ts)": [0.80, 0.55]
  "Provider env (buildAgentEnv)": [0.90, 0.90]
  "systemPrompt": [0.15, 0.10]
  "Tool descriptions": [0.10, 0.10]
  "Tool set selection": [0.20, 0.15]
  "Shopify layer": [0.60, 0.70]
  "Inbox pipeline": [0.75, 0.60]
  "WhatsAppChannel": [0.85, 0.75]
  "Knowledge base": [0.05, 0.05]
```

> ⚠️ There is **no knowledge base** today. Business facts the model needs (an example SKU, the option axes, what "publicar" means) live inside tool descriptions and the prompt. `server/src/agent/tools.ts:499`, `server/src/agent/agent.ts:89`

---

## 2. TO BE — one runtime, N agent definitions, one inbox

### 2.1 The shape

```mermaid
flowchart TB
  subgraph PRINCIPALS["who talks to an agent"]
    P1["WhatsApp user<br/>phone"]
    P2["another agent<br/>agentId + token"]
  end

  subgraph INGRESS["ingress · one inbox, two doors"]
    WH["webhook.ts<br/>WhatsApp · bridge | cloud"]
    A2A["a2a.ts · POST /agents/:id/messages<br/>agent-to-agent"]
    ENV["Envelope<br/>{principal, agentId, conversationKey,<br/>text, media, replyTo, hop}"]
    INB[("inbox<br/>durable · at-least-once")]
    BA["batcher<br/>debounce · WhatsApp only"]
    QU["queue<br/>per conversationKey"]
  end

  RO["router.ts<br/>principal → role → agentId"]

  subgraph DEFS["agent definitions · DATA · agents/&lt;id&gt;/"]
    D1["agent.yaml<br/>id · roles · tools[] · model · session policy"]
    D2["prompt.md<br/>behaviour · slots"]
    D3["knowledge/*.md<br/>facts · policies · glossary"]
  end

  subgraph RUNTIME["agent runtime · CODE · one for all"]
    RT["runtime.ts<br/>SDK loop · resume · fallback · stats"]
    PC["prompt.ts<br/>compose base + persona + knowledge"]
    KB["knowledge/store.ts<br/>FTS index · search_knowledge tool"]
    REG["tools/registry.ts<br/>name → factory · toolpacks"]
    VAL["definition.ts<br/>load · validate prompt↔tools at boot"]
  end

  subgraph PACKS["toolpacks · CODE · one per domain"]
    T1["catalog pack<br/>search · get · list · create · update · variants · stock · publish"]
    T2["leads pack"]
    T3["cart pack"]
    T4["media pack"]
    T5["agents pack<br/>ask_agent"]
  end

  subgraph ADAPTERS["adapters · CODE · implement ports"]
    SHOP["shopify/*<br/>CatalogPort"]
    OTHER["…another catalog<br/>CatalogPort"]
  end

  subgraph EGRESS["egress · reply to whoever asked"]
    RESP["responder.ts<br/>Responder.for(principal)"]
    CH["WhatsAppChannel"]
    CB["agent reply<br/>sync body | replyTo callback"]
  end

  P1 --> WH
  P2 --> A2A
  WH --> ENV
  A2A --> ENV
  ENV --> INB
  INB --> BA --> QU
  INB --> QU
  QU --> RO
  RO -->|"definition for agentId"| VAL
  VAL --> RT
  D1 --> VAL
  D2 --> PC
  D3 --> KB
  PC --> RT
  KB --> RT
  REG -->|"only definition.tools[]"| RT
  T1 --> REG
  T2 --> REG
  T3 --> REG
  T4 --> REG
  T5 --> REG
  T1 -.->|port| SHOP
  T1 -.->|port| OTHER
  T5 -.->|"POST /agents/:id/messages"| A2A
  RT -->|"reply (returned, not sent)"| RESP
  RESP --> CH
  RESP --> CB
  CH --> P1
  CB --> P2

  classDef agent fill:#f7e6df,stroke:#cd5f40,color:#1a2230;
  classDef defs fill:#ece1f7,stroke:#7d4bc0,color:#1a2230;
  classDef domain fill:#d7efec,stroke:#1f8a80,color:#1a2230;
  classDef data fill:#dbe8f6,stroke:#2d6aa8,color:#1a2230;
  classDef io fill:#f1e6c8,stroke:#a9781f,color:#1a2230;
  class RT,PC,KB,REG,VAL agent;
  class D1,D2,D3 defs;
  class T1,T2,T3,T4,T5,SHOP,OTHER domain;
  class INB data;
  class WH,A2A,ENV,BA,QU,RO,RESP,CH,CB io;
```

**Legend** — purple = data, edited per business without a deploy · red = the one runtime · green = code that knows a domain · yellow = transport and routing · dashed = port, swappable.

### 2.2 What an agent definition is

```mermaid
classDiagram
  class AgentDefinition {
    +id: string
    +roles: Role[]
    +model: ModelKnobs
    +tools: ToolName[]
    +prompt: PromptSpec
    +knowledge: KnowledgeSpec
    +session: SessionPolicy
    +reach: AgentId[]
  }
  class PromptSpec {
    +base: "grounding" | "none"
    +persona: path prompt.md
    +slots: Record~string,string~
  }
  class KnowledgeSpec {
    +inline: path[]  "always in the prompt, budgeted"
    +searchable: path[]  "FTS index behind search_knowledge"
    +maxInlineTokens: number
  }
  class SessionPolicy {
    +maxAgeDays: number
    +resetOn: ToolName[]  "today: publish transition"
    +keyedBy: "principal" | "correlation"
  }
  class ToolName {
    <<enumeration>>
    catalog.search_catalog
    catalog.get_product
    catalog.update_product
    leads.save_lead
    cart.build_cart
    knowledge.search_knowledge
    agents.ask_agent
  }
  AgentDefinition --> PromptSpec
  AgentDefinition --> KnowledgeSpec
  AgentDefinition --> SessionPolicy
  AgentDefinition --> ToolName : names only
```

| Today | Becomes | Today's anchor |
|---|---|---|
| `systemPrompt(role)` switch | `agents/vitrina-ventas/prompt.md` + `agents/vitrina-inventario/prompt.md` | `server/src/agent/agent.ts:31` |
| `customerTools` / `ownerTools` arrays | `tools: [...]` list in each `agent.yaml` | `server/src/agent/tools.ts:455` |
| `get_product` with two closures by role | Two tools: `catalog.get_product` and `catalog.get_product_any_status`; the definition picks one | `server/src/agent/tools.ts:348` |
| Example SKUs, axes, confirmation phrasing inside descriptions | `knowledge/` docs + `slots` rendered into generic descriptions | `server/src/agent/tools.ts:499` |
| `sessionAfterTurn = "reset"` set inside a tool | `session.resetOn` declared; runtime watches the tool stream it already reads | `server/src/agent/agent.ts:531` |
| `isOwner(phone)` | `router.ts`: assignment table `phone → role`, definition `roles` says which agent | `server/src/config.ts:430` |

> ℹ️ The boot validator is the piece that closes today's silent hole: every tool name the prompt mentions must be in `definition.tools`, and every name in `definition.tools` must exist in the registry. A typo fails startup instead of producing an agent that asks for a tool it does not have.

### 2.3 The tool layer: registry, packs, ports

```mermaid
flowchart LR
  DEF["agent.yaml<br/>tools: [catalog.search_catalog, cart.build_cart, leads.save_lead]"]
  REG["registry<br/>Map&lt;ToolName, ToolFactory&gt;"]
  MCP["createSdkMcpServer<br/>only the listed tools"]

  subgraph CATALOGPACK["catalog pack"]
    F1["search_catalog(ctx, port)"]
    F2["get_product(ctx, port)"]
    F3["update_product(ctx, port)"]
  end
  PORT["CatalogPort<br/>search · resolve · create · update<br/>adjustInventory(key) · publish"]
  SHOP["shopify/catalog.ts + client.ts + rank.ts + cache.ts"]

  DEF --> REG --> MCP
  REG --> F1 & F2 & F3
  F1 & F2 & F3 --> PORT
  PORT -.->|implements| SHOP

  classDef defs fill:#ece1f7,stroke:#7d4bc0,color:#1a2230;
  classDef agent fill:#f7e6df,stroke:#cd5f40,color:#1a2230;
  classDef domain fill:#d7efec,stroke:#1f8a80,color:#1a2230;
  class DEF defs;
  class REG,MCP agent;
  class F1,F2,F3,PORT,SHOP domain;
```

| Rule | Keeps |
|---|---|
| A factory receives `(ctx, ports)` and returns one SDK tool | `tools.test.ts` prefix pin becomes "the served set equals `definition.tools`" |
| `turnKey` + per-turn counter travel in `ctx` into the port | Stock idempotency, unchanged `server/src/agent/tools.ts:282` |
| Descriptions are English templates with `{{slots}}`; business literals come from the definition | Same prompt quality, no SKU baked into code |
| `shopify/` stays as it is and gains one `implements CatalogPort` file | Zero rewrite of the layer that already works |

### 2.4 Knowledge base

```mermaid
flowchart LR
  subgraph SRC["agents/&lt;id&gt;/knowledge/"]
    K1["policies.md<br/>returns · shipping · hours"]
    K2["glossary.md<br/>what 'publicar' means · option axes"]
    K3["faq.md"]
    K4["examples.md<br/>sample SKUs · confirmation phrasing"]
  end
  LOAD["knowledge/store.ts<br/>chunk · index at boot"]
  INL["inline slice<br/>≤ maxInlineTokens<br/>→ system prompt"]
  FTS[("SQLite FTS5<br/>knowledge_chunks")]
  TOOL["search_knowledge<br/>tool · returns chunks"]
  RT["runtime"]

  K1 & K2 & K3 & K4 --> LOAD
  LOAD --> INL --> RT
  LOAD --> FTS --> TOOL --> RT

  classDef defs fill:#ece1f7,stroke:#7d4bc0,color:#1a2230;
  classDef agent fill:#f7e6df,stroke:#cd5f40,color:#1a2230;
  classDef data fill:#dbe8f6,stroke:#2d6aa8,color:#1a2230;
  class K1,K2,K3,K4 defs;
  class LOAD,INL,TOOL,RT agent;
  class FTS data;
```

> ℹ️ Two tiers on purpose. Short, always-relevant facts go **inline** so a resumed transcript still carries them. Long material goes behind a **tool**, so the grounding rule holds: the agent states what a tool returned. No vector store in phase 1; FTS5 is already in the SQLite build we ship.

### 2.5 One WhatsApp message, to be

```mermaid
sequenceDiagram
  autonumber
  participant WA as WhatsApp
  participant WH as webhook.ts
  participant INB as inbox
  participant BA as batcher / queue
  participant RO as router
  participant RT as runtime
  participant TP as toolpacks
  participant RS as responder

  WA->>WH: POST /webhook (signed)
  WH->>INB: Envelope{principal: whatsapp:phone, conversationKey: phone}
  WH-->>WA: 200
  BA->>BA: debounce · claim batch
  BA->>RO: envelope
  RO->>RO: phone → role → agentId (assignment table)
  RO->>RT: definition(agentId), envelope, ctx{turnKey, role, principal}
  RT->>RT: session by (agentId, conversationKey)
  RT->>RT: prompt = base + persona + inline knowledge
  RT->>TP: only definition.tools[]
  RT-->>RS: reply (returned, never sent here)
  RS->>WA: WhatsAppChannel.sendText(phone)
```

### 2.6 One agent asking another, to be

```mermaid
sequenceDiagram
  autonumber
  participant SUP as super-agent (runtime instance A)
  participant AT as ask_agent tool
  participant A2A as POST /agents/inventario/messages
  participant INB as inbox
  participant RO as router
  participant RT as runtime (instance B)
  participant RS as responder

  SUP->>AT: ask_agent("vitrina-inventario", "¿cuántas CAM-NEG-M quedan?")
  AT->>A2A: bearer token of agent A · {text, correlationId, hop: 1}
  A2A->>A2A: verify token · A.reach includes B · hop ≤ MAX
  A2A->>INB: Envelope{principal: agent:A, agentId: B, conversationKey: correlationId}
  A2A->>RO: no debounce · run now
  RO->>RO: principal agent:A → role from registry, never from text
  RO->>RT: definition(B), envelope
  RT-->>RS: reply
  RS-->>A2A: sync body {reply, turnKey}
  A2A-->>AT: 200 {reply}
  AT-->>SUP: tool result
  Note over INB: the row still settles done/failed · audit + replay
```

| Decision | Choice | Why |
|---|---|---|
| Sync or async reply to an agent | **Sync body** by default; `replyTo` callback when the caller sets it | A tool call is already a request-response; a callback is one more thing to lose |
| Loop guard | `hop` counter in the envelope, cap 3; an agent never reaches itself | A super-agent asking an agent that asks the super-agent is otherwise a bill |
| Who says the caller's role | The **agent registry**, from the bearer token | Same rule as WhatsApp: identity from the transport, never from the message |
| Debounce | None for agent principals | Bursts are a human behaviour; an agent sends one complete message |
| Durability | Still through `inbox` | One retry story, one replay story, one place to audit |

### 2.7 Data model changes

```mermaid
erDiagram
  INBOX {
    int id PK
    text dedupe_key UK
    text agent_id "NEW · target definition"
    text principal_kind "NEW · whatsapp | agent"
    text principal_id "NEW · phone | agentId"
    text conversation_key "NEW · phone | correlationId"
    text reply_to "NEW · nullable callback"
    int hop "NEW · loop guard"
    text agent_text
    text status
    int attempts
  }
  SESSIONS {
    text agent_id PK "NEW · was phone alone"
    text conversation_key PK
    text agent_session_id
    text updated_at
  }
  ASSIGNMENTS {
    text phone PK
    text role "generalises OWNER_PHONE_NUMBERS"
  }
  AGENT_REGISTRY {
    text agent_id PK
    text token_hash
    text reach "agentIds it may call"
  }
  KNOWLEDGE_CHUNKS {
    text agent_id
    text source
    text chunk "FTS5"
  }
  INBOX ||--o{ SESSIONS : "agent_id + conversation_key"
  ASSIGNMENTS ||--o{ INBOX : "phone → role"
  AGENT_REGISTRY ||--o{ INBOX : "principal agent"
```

> ⚠️ `sessions` is keyed by `phone` today (`server/src/data/db.ts:49`) and `CREATE TABLE IF NOT EXISTS` never alters an existing table. The key change needs a real migration step, not a DDL edit.

### 2.8 Where files land

```text
server/src/
  agent/
    runtime.ts        ← agent.ts minus systemPrompt minus sendText; knows no domain
    definition.ts     ← load agents/<id>/agent.yaml · validate prompt↔tools↔registry
    prompt.ts         ← compose base + persona + inline knowledge + slots
  knowledge/
    store.ts          ← chunk, index (FTS5), budgeted inline slice
    tool.ts           ← search_knowledge
  tools/
    registry.ts       ← Map<ToolName, ToolFactory>
    ports.ts          ← CatalogPort, LeadsPort, MediaPort
    packs/catalog.ts  ← today's tools.ts, split; descriptions templated
    packs/leads.ts · packs/cart.ts · packs/media.ts · packs/agents.ts
  shopify/            ← unchanged, plus catalog-port.ts (implements CatalogPort)
  inbox/
    envelope.ts       ← Envelope, Principal
    webhook.ts        ← WhatsApp door (as today)
    a2a.ts            ← agent door
    batcher.ts · queue.ts  ← keyed by conversationKey
  egress/
    responder.ts      ← Responder.for(principal): WhatsApp | agent
  router.ts           ← principal → role → agentId
agents/
  vitrina-ventas/       agent.yaml · prompt.md · knowledge/
  vitrina-inventario/   agent.yaml · prompt.md · knowledge/
```

---

## 3. Migration — six phases, each shippable

```mermaid
flowchart LR
  P0["0 · docs<br/>mark old plan superseded"]
  P1["1 · runtime seam<br/>reply returned, not sent<br/>Envelope + Principal<br/>sessions by agentId+key"]
  P2["2 · definitions<br/>two agent.yaml + prompt.md<br/>boot validator"]
  P3["3 · tool registry<br/>packs · ports · templated descriptions"]
  P4["4 · knowledge base<br/>inline + FTS + search_knowledge"]
  P5["5 · agent door<br/>a2a.ts · registry · ask_agent · hop guard"]
  P6["6 · router table<br/>assignments replace OWNER_PHONE_NUMBERS"]
  P0 --> P1 --> P2 --> P3 --> P4 --> P5 --> P6

  classDef io fill:#f1e6c8,stroke:#a9781f,color:#1a2230;
  classDef agent fill:#f7e6df,stroke:#cd5f40,color:#1a2230;
  classDef defs fill:#ece1f7,stroke:#7d4bc0,color:#1a2230;
  classDef domain fill:#d7efec,stroke:#1f8a80,color:#1a2230;
  class P0,P1,P5,P6 io;
  class P2,P4 defs;
  class P3 domain;
```

| Phase | Behaviour change for today's users | Tests that pin it |
|---|---|---|
| 1 | None. Owner and customer map to two definitions with today's exact prompts | `agent.test.ts` persona pins move to the two `prompt.md` files; new: `runAgentTurn` returns and does not send |
| 2 | None | New: boot fails on a prompt naming a tool outside `definition.tools` |
| 3 | None | `tools.test.ts` prefix pin becomes a set-equality pin per definition; Shopify call recordings unchanged |
| 4 | Owner answers "¿qué significa publicar?" from knowledge instead of the prompt | New: inline budget respected; `search_knowledge` returns chunks only from its agent |
| 5 | New endpoint, off by default until a registry row exists | New: unknown token 401 · reach violation 403 · hop 4 refused · role never read from text |
| 6 | `OWNER_PHONE_NUMBERS` still honoured as seed rows | `config.test.ts` empty-allowlist refusal in the purge tool stays |

### 3.1 Invariants that survive every phase

| Invariant | Where it lives after |
|---|---|
| `turnKey` from the FIRST inbox row · per-turn counter | `Envelope.turnKey`, minted in the batcher as today `server/src/types.ts:88` |
| Role from the transport, never from the text | `router.ts` for phones; `a2a.ts` token for agents |
| `tools: []` removes built-ins; `allowedTools` only approves | `runtime.ts`, verbatim `server/src/agent/agent.ts:352` |
| One turn at a time per conversation | `PerPhoneQueue` renamed to per-conversation, same class `server/src/inbox/queue.ts:9` |
| A turn without words still answers | `NO_ANSWER_FALLBACK` in `runtime.ts`; the responder sends it |
| Reset session on publish | `session.resetOn` in the definition; runtime reads the tool stream it already parses `server/src/agent/agent.ts:390` |
| ECHO_MODE ahead of both gates | Unchanged in `index.ts` |
| At-least-once with capped attempts | `inbox.attempts`, unchanged; agent-door rows follow the same path |

---

## 4. What this does NOT do

| Out of scope | Reason |
|---|---|
| Split into separate processes | The seams above are in-process; promoting one to HTTP is a later, independent step |
| Vector search | FTS5 covers policies and glossaries; revisit when a knowledge folder exceeds what keyword search serves |
| A second catalog adapter | `CatalogPort` is defined so one *can* exist; writing it is another business's work |
| The super-agent's own logic | [agent-roles-routing.md](agent-roles-routing.md) owns that; this page only gives it a door and a tool |
