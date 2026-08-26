# SQLite — the five tables

```mermaid
erDiagram
    contacts {
        TEXT phone PK
        TEXT name
        TEXT role
        TEXT last_seen_at
    }
    sessions {
        TEXT phone PK
        TEXT agent_session_id
        TEXT updated_at
    }
    inbox {
        INTEGER id PK
        TEXT dedupe_key UK
        TEXT phone
        TEXT agent_text
        TEXT kind
        TEXT audio_path
        TEXT media_ref
        INTEGER media_sent_at
        TEXT status
        INTEGER attempts
        TEXT received_at
        TEXT processed_at
    }
    leads {
        INTEGER id PK
        TEXT phone
        TEXT product_code
        TEXT type
        TEXT name
        TEXT note
        TEXT status
        TEXT created_at
    }
    pending_media {
        INTEGER id PK
        TEXT phone
        TEXT file_path
        TEXT public_path
        TEXT caption
        TEXT received_at
        INTEGER sent_at
        TEXT attached_to
        TEXT attached_at
    }
```

Opened with `journal_mode = WAL` and `foreign_keys = ON`; the schema is created and
migrated on every boot. `server/src/data/db.ts:11`

## `inbox` — the durable queue

| Column | Notes |
|---|---|
| `dedupe_key` | `UNIQUE`. `msg:<whatsapp id>` or `evt:<sha256>`, `server/src/inbox/webhook.ts:56` |
| `kind` | `text` \| `media`. **Persisted, never re-derived** — a photo's caption is its text |
| `audio_path` | Bytes on our disk awaiting transcription — a **different** state from `media_ref`, which means not fetched at all |
| `media_ref` | A file the transport holds that we have **not fetched yet** — a Meta media id, or a bridge staging path. With `media_kind` (`photo` \| `audio`), `media_mime`, `media_name` and `media_sent_at` it is everything `resolveMedia` needs |
| `status` | `pending` \| `processing` \| `done` \| `failed` |
| `attempts` | Incremented at claim time, so the cap survives a restart |

> ⚠️ Audio rows are deliberately `kind='text'`, not `'media'`. A transcript is a spoken
> line, not a caption under a photo count — and the media window would make one voice note
> wait 45 s for a reply. `server/src/data/db.ts:72`

## `pending_media` — photos on their way to a product

| Column | Notes |
|---|---|
| `file_path` | Absolute path under `MEDIA_DIR` |
| `public_path` | `PUBLIC_BASE_URL/media/<name>` — served by `registerMediaRoutes` |
| `sent_at` | WhatsApp's send stamp. Leads the gallery ordering; arrival order only breaks ties |
| `attached_to` | The Shopify product **gid**, set only after the upload succeeded |

> ⚠️ `attached_to` is a gid rather than a local id because the product is not ours:
> nothing here can reference it, and the column's only job is to keep the housekeeping
> sweep from deleting a file that already reached the store. `server/src/data/db.ts:93`

## `sessions`, `contacts`, `leads`

| Table | Key fact |
|---|---|
| `sessions` | One row per phone. `updated_at` refreshes every turn, making expiry a sliding window |
| `contacts` | `role` records what we **last saw**, never what decides access — that is the env allowlist |
| `leads` | `type` is checked in SQL: `inquiry` \| `back_in_stock` \| `follow_up` |

> ⚠️ `purgeCustomerSessions` reads roles from `config.isOwner`, **never** from
> `contacts.role`. The allowlist is the authority; the table is an observation.
> `server/src/data/purge.ts:51`

## Migrations

`CREATE TABLE IF NOT EXISTS` never alters an existing table, so every column added after
the pilot shipped is applied by an idempotent `addColumn` step on every boot. `server/src/data/db.ts:119`

| Step | Added when |
|---|---|
| `inbox.kind` | A captioned photo turned out to be indistinguishable from chat |
| `inbox.audio_path` | Voice notes |
| `inbox.media_ref` + companions, `pending_media.sent_at` | The Cloud API cut-over: the file fetch moved onto the worker, and Meta gives no delivery-order guarantee where photo order is listing order, `server/src/data/db.ts:161` |
| `pending_media.attached_to` / `attached_at` | The Shopify cut-over — it used to point at a local products row |

> ⚠️ SQLite cannot widen an existing `CHECK` with `ALTER TABLE`. That is why audio rides
> on `kind='text'` plus a nullable column rather than forcing a table rebuild on the
> running pilot. `server/src/data/db.ts:124`

**[Shopify's side →](shopify.md)** · **[Ownership, indexes & retention →](propiedad-e-indices.md)**

<sub>Verified against `36e95b2` — 2026-08-25</sub>
