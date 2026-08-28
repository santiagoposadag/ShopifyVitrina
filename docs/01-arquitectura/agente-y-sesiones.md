# The agent and its sessions

```mermaid
sequenceDiagram
    participant Q as queue
    participant RA as runAgentTurn
    participant DB as sessions table
    participant SDK as Agent SDK (subprocess)
    participant TS as MCP tool server

    Q->>RA: ctx {phone, role, turnKey}
    RA->>DB: getSessionId(phone, maxAgeDays)
    RA->>SDK: query(prompt, systemPrompt(role), tools, resume?)
    SDK->>TS: mcp__vitrina__* only
    TS-->>SDK: tool results
    SDK-->>RA: reply + session_id + usage
    alt a tool set sessionAfterTurn = "reset"
        RA->>DB: clearSessionId
    else
        RA->>DB: setSessionId(new id)
    end
```

## The role boundary, enforced twice

| Layer | Mechanism | Anchor | Pinned by |
|---|---|---|---|
| Tools | Customers get 3 tools; owner tools are appended only for the owner | `server/src/agent/tools.ts:273` | `test/tools.test.ts` |
| Persona | The customer branch refuses inventory talk and ignores "I am the owner" | `server/src/agent/agent.ts:102` | `test/agent.test.ts` |

| Role | Tools |
|---|---|
| Customer | `search_catalog`, `get_product`, `save_lead` |
| Owner | those three **plus** `list_products`, `create_product`, `update_product`, `delete_product`, `get_inventory`, `adjust_inventory`, `attach_pending_photos`, `list_locations`, `list_leads` |

> ⚠️ `get_product` is **one tool name with two closures**, chosen by `ctx.role`. The
> customer's returns "no product found" for a non-`ACTIVE` product: confirming that a
> hidden product exists is itself a leak. `server/src/agent/tools.ts:244`

> ℹ️ Giving the customer's tool a `status` parameter instead would move that boundary
> out of the tool set — where it is structural — into a value the model decides.

## The built-ins are REMOVED, not denied

| Option | What it actually does |
|---|---|
| `tools: []` | **Removes** every built-in from the model's context. The only real restriction |
| `allowedTools` | Auto-approves ours. Does NOT restrict — the SDK says use `tools` for that |
| `canUseTool` | Denies at EXECUTION, when a turn is already spent. Defence in depth, and the tool log |

`server/src/agent/agent.ts:301`

> ⚠️ Denying from `canUseTool` alone is too late. The model still SEES `Bash`, picks it,
> and burns a turn discovering it is refused — then picks it again. Observed against a real
> store: **twelve turns, every one a denied `Bash` call, no answer, 52 seconds.**

> ℹ️ `allowedTools` still carries our own tools, or each would wait on a prompt that
> nothing in this process can answer.

## Session lifetime

```mermaid
stateDiagram-v2
    [*] --> Fresh: no row, or older than SESSION_MAX_AGE_DAYS
    Fresh --> Live: setSessionId after a successful turn
    Live --> Live: every turn refreshes updated_at
    Live --> Fresh: publish transition (sessionAfterTurn = reset)
    Live --> Fresh: resume failed → clearSessionId, retry once
    Fresh --> [*]
```

| Fact | Detail |
|---|---|
| Where the id lives | SQLite `sessions.phone` (primary key), on the `vitrina-data` volume |
| Where the transcript lives | The SDK's home dir, on the `vitrina-sessions` volume |
| Expiry | `SESSION_MAX_AGE_DAYS` of **silence** — a sliding window |
| Context growth | Bounded by the SDK's own auto-compaction. Do **not** build a compaction layer |

> ⚠️ The two stores can diverge. A container whose home is ephemeral resumes an id whose
> transcript is gone, and the subprocess exits 1. `runAgentTurn` retries once with a
> fresh session — but **only when a resume was in play**. `server/src/agent/agent.ts:413`

> ℹ️ The retry is gated on `resumeId`, not on the error text: the SDK reports every
> failure as a generic "exited with code 1", so matching the wording buys no precision
> and would silently stop working if it changed.

## Session reset on publish

`ctx.sessionAfterTurn = "reset"` is set by `create_product` and `update_product` when a
product actually transitions to `ACTIVE`, and applied **after** the turn.
`server/src/agent/tools.ts:26`, `server/src/agent/agent.ts:432`

> ⚠️ A mid-turn `clearSessionId` would be clobbered by the post-turn persist. The mutable
> `TurnContext` is the **only** in-process channel from a tool back to `runAgentTurn`.

Because history may be cleared before the next message, the owner prompt requires every
confirmation to name the product's handle or SKU — the message is the owner's only
durable reference. `server/src/agent/agent.ts:67`

## Provider is a set of environment variables

`buildAgentEnv` writes every knob it owns, **including to `undefined`**, then deletes the
undefined keys. `server/src/agent/agent.ts:138`

> ⚠️ A conditional spread would leave whatever the shell already had sitting in the
> environment, and the CLI reads that — so a deployment whose config says thinking is OFF
> would quietly run and bill for it because a stray variable outvoted the config.

**[← Shopify layer](capa-shopify.md)** · **[WhatsApp transport →](bridge-whatsapp.md)**

<sub>Verified against `cda9ea9` — 2026-08-28</sub>
