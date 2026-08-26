# 03 · Data

```mermaid
graph TB
    subgraph OURS["SQLite — ours · 5 tables"]
        IN["inbox"]
        SE["sessions"]
        CO["contacts"]
        LE["leads"]
        PM["pending_media"]
    end

    subgraph THEIRS["Shopify — source of truth"]
        PR["Product"]
        VA["ProductVariant"]
        II["InventoryItem / Level"]
        LO["Location"]
        ME["Media"]
    end

    PM -.->|"attached_to = product gid"| PR
    LE -.->|"product_code = SKU or handle,<br/>free text, NOT a key"| PR
```

> ⚠️ There is **no products table**. Prices, stock, photos and statuses live in Shopify
> and nowhere else. Anything here that names a product does so by a value that survives
> the product being renamed or deleted. `server/src/data/db.ts:20`

| Page | Contents |
|---|---|
| [`sqlite.md`](sqlite.md) | The five tables, column by column, and the migration rule |
| [`shopify.md`](shopify.md) | The Shopify fields we read and write, and our flattened types |
| [`propiedad-e-indices.md`](propiedad-e-indices.md) | Who writes what, indexes, retention, and where PII lives |

## The inventory

| Store | What it holds | Durability |
|---|---|---|
| `vitrina.db` (SQLite, WAL) | inbox, sessions, contacts, leads, pending_media | `vitrina-data` volume |
| Agent SDK transcripts | Conversation history, one `.jsonl` per session | `vitrina-sessions` volume |
| `whatsmeow.db` + `outbox.db` | Pairing and the delivery queue | `vitrina-whatsapp` volume |
| Shopify | The entire catalog | Shopify's problem |

## Two identifiers that are not the same thing

```mermaid
graph LR
    PH["phone<br/>bare E.164 digits"] --> CO2["contacts.phone (PK)"]
    PH --> SE2["sessions.phone (PK)"]
    PH --> IN2["inbox.phone"]
    PH --> PM2["pending_media.phone"]
    PH --> LE2["leads.phone"]
    GID["gid://shopify/Product/…"] --> AT["pending_media.attached_to"]
```

| Identifier | Normalised by | Trap |
|---|---|---|
| `phone` | `normalizePhone` — digits only | A LID normalises to digits too, and is **not** a phone |
| Product `gid` | Shopify | Never stored anywhere a foreign key could point at it |
| SKU | Owner-typed | Nullable in Shopify; a variant without one is reachable only via its product |
| `handle` | Shopify slug, unique per store | The product-level identifier, and the delete confirmation |

> ℹ️ Nothing in SQLite is joined to anything in Shopify. That is the decoupling: a store
> wiped and rebuilt leaves the inbox, the leads and the sessions intact and meaningful.

<sub>Verified against `6f9211b` — 2026-08-24</sub>
