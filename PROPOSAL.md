# Vitrina — WhatsApp-Native Sales & Inventory Assistant

**Proposal v1 — 2026-07-07**

A product-agnostic platform that turns a WhatsApp number into a full sales channel: an AI assistant (Claude) answers customer questions about the catalog, captures leads, and schedules visits — while the business owner manages inventory *through WhatsApp itself*, in natural language. A landing page + catalog storefront is generated automatically from the same inventory. First vertical: real estate. Designed from day one to work for any shop.

---

## 1. The insight (from the real examples)

The example data in `propiedad_1/` and `propiedad_2/` shows how a real business actually operates on WhatsApp:

- Listings arrive as **emoji-formatted free text** ("📣 VENDO CASA PARA ESTRENAR… 📐 Área: 230 metros cuadrados… 💲 Precio: 1.150.000.000") plus a batch of photos.
- Critical data arrives **separately and conversationally** ("Código 916").
- Corrections arrive as **chat messages**, not form edits ("El código 008 no es… Ya es código 1912. Ten en cuenta eso hijo").

No small-business owner is going to fill out an admin panel. **The innovation of this product is that WhatsApp IS the admin panel.** The owner forwards a listing text + photos to the assistant; Claude parses it into a structured product, auto-tags the photos with vision, asks for whatever is missing ("What's the listing code? Is admin fee included?"), and applies corrections when the owner sends them. The customer-facing assistant and the storefront are always in sync because there is only one catalog.

This is what makes the product agnostic: the same "unstructured message → structured product" pipeline works for properties, sneakers, furniture, or car parts — only the *attribute template* changes.

## 2. Product overview

Two WhatsApp-facing experiences on one number (or two numbers, per business preference):

### A. Customer assistant (sales)
- Answers product questions from the catalog ("do you have 3-bedroom apartments near Belén under 700M?").
- Sends photos, uses **interactive buttons/lists** ("Book a viewing / More photos / Talk to a human") and **carousel templates** to show multiple listings.
- Captures leads (name, budget, intent) into a built-in CRM and can **schedule visits/appointments**.
- Escalates to a human via Kapso's team inbox when asked or when confidence is low.
- Proactive re-engagement ("a new listing matches your search") via approved WhatsApp templates.

### B. Owner assistant (inventory & ops)
- **Ingest**: owner forwards listing text + photos → Claude extracts structured fields, vision-tags photos, assigns a code, asks follow-up questions for missing required fields.
- **Correct**: "el código ya es 1912" → catalog updated, with change history.
- **Query**: "how many active listings do I have in Rionegro?" / "who asked about código 916 this week?"
- **Publish**: each product goes live on the storefront the moment it's confirmed.

### C. Landing page + e-commerce storefront (no payments)
- Auto-generated public site: landing page for the business + catalog with product detail pages (photos, attributes, price).
- Every product card's CTA is **"Chat on WhatsApp"** — a `wa.me` deep link pre-filled with the product code ("Hola! Me interesa el código 1912"), which drops the visitor straight into the AI assistant *with context*. The storefront is a funnel into the conversation, not a checkout — exactly right for high-consideration goods and for the no-payments constraint.
- Product-agnostic theming: vertical template defines which attributes are shown as filters (bedrooms/area/neighborhood for real estate; size/color for fashion).

## 3. Architecture

Validated against Kapso docs and Claude Agent SDK docs (research summaries below).

```
Customer / Owner (WhatsApp)
        │
        ▼
┌─────────────────────┐   webhook (HMAC-verified,     ┌──────────────────────────┐
│  Kapso.ai           │   ACK < 10s, idempotent)      │  Backend (Node/TS)        │
│  WhatsApp Cloud API │ ────────────────────────────► │  1. verify + dedupe       │
│  (transport only —  │                               │  2. download media (token │
│  "bring your own    │ ◄──────────────────────────── │     expires in 4 min!)    │
│  agent" mode)       │   REST send: text, images,    │  3. enqueue job, return   │
└─────────────────────┘   buttons, lists, templates   └────────────┬─────────────┘
                                                                   │ async worker
                                                                   ▼
                                                      ┌──────────────────────────┐
                                                      │  Claude Agent SDK         │
                                                      │  session per phone number │
                                                      │  (resume across hours)    │
                                                      │  roles: customer | owner  │
                                                      │  Tools:                   │
                                                      │   search_catalog          │
                                                      │   get_product / photos    │
                                                      │   upsert_product (owner)  │
                                                      │   save_lead               │
                                                      │   schedule_visit          │
                                                      │   list_leads (owner)      │
                                                      └────────────┬─────────────┘
                                                                   │
                                            ┌──────────────────────┼──────────────────┐
                                            ▼                      ▼                  ▼
                                     PostgreSQL             Object storage      Next.js storefront
                                     (catalog, leads,       (photos)            (landing + catalog,
                                     sessions, tenants)                          reads same DB)
```

### Key technical decisions

| Decision | Choice | Why |
|---|---|---|
| WhatsApp layer | **Kapso, raw webhook + REST ("bring your own agent")** | Officially supported pattern; near-1:1 proxy of Meta Cloud API (low lock-in); sandbox for dev; team inbox for human handoff. Skip Kapso's own AI/workflows entirely. |
| AI brain | **Claude Agent SDK** (not `claude -p` headless) | Headless CLI is stateless and unsuitable for webhook backends. Agent SDK gives persistent sessions (customer messages hours apart resume with full context), custom tools as plain functions, 1–3s latency. |
| Model | **Haiku 4.5** for chat; Sonnet for catalog ingestion/vision | Haiku handles Q&A + tool calls at ~$11/mo per 100 conv/day; ingestion is lower volume and benefits from a stronger model. |
| Backend language | **TypeScript** (single stack) | Kapso's only SDK is TS (`@kapso/whatsapp-cloud-api`, incl. `normalizeWebhook`); Agent SDK has first-class TS support; shares types with the Next.js storefront. |
| Catalog model | Generic `products` table + **JSONB attributes** + per-tenant **vertical template** | Product-agnosticism without schema migrations per vertical. Template = required/optional attributes, filter config, ingestion prompts. |
| Storefront | **Next.js** on Vercel, ISR from catalog DB | Landing + catalog with zero manual publishing; wa.me deep links as CTA; payments deliberately out of scope. |

### Non-negotiable gotchas (from Kapso research)
1. **ACK webhooks in <10s, process async** — Claude turns take longer; Kapso retries at 10/40/90s. Idempotency on `X-Idempotency-Key` is mandatory or messages double-process.
2. **Inbound media download tokens expire in 4 minutes** — download photos to our storage at webhook receipt, before the agent job runs.
3. **24-hour window**: free-form replies only while the customer window is open. Proactive messages ("new listing matches your search") require **pre-approved templates**, billed by Meta per message. Template approval takes time — start it early.
4. **Sandbox can't send templates** — the proactive-notification feature can only be validated on a real production number.

## 4. Product-agnostic design

A **tenant** = one business. Each tenant has:

```
tenant
├── vertical_template        e.g. "real_estate", "generic_retail"
│   ├── attribute schema     required: code, price, area_m2, bedrooms…
│   ├── ingestion prompt     what to extract from forwarded messages/photos
│   ├── storefront config    filters, card layout, currency
│   └── conversation persona tone, language, escalation rules
├── products (JSONB attrs + photos + status + change history)
├── contacts / leads / visits
└── whatsapp number(s) + owner phone allowlist
```

Role detection is by phone number: messages from the owner's registered number(s) get the **owner toolset** (upsert, corrections, reports); everyone else gets the **customer toolset** (read-only catalog + lead capture). Same agent, different tools — one codebase, no forked logic.

Launching a new vertical = writing a new template (a config file + prompts), not new code. Real estate is template #1 and the pilot proves the pipeline; a generic retail template ships alongside it to keep us honest about agnosticism.

## 5. Innovative differentiators

1. **WhatsApp-as-admin-panel** — forward a listing, get a published product. No forms, ever. Corrections in natural language with full change history ("who changed the price and when" = the chat log).
2. **Vision-powered ingestion** — Claude auto-captions and tags photos (rooms, finishes, style), making the catalog searchable by things the owner never typed ("apartments with open kitchens").
3. **Storefront-to-conversation funnel** — every product page deep-links into WhatsApp with product context preloaded; web traffic converts into an ongoing, resumable conversation instead of an anonymous bounce.
4. **Memory across visits** — Agent SDK sessions per phone number mean a customer who returns three days later is remembered: budget, preferences, properties already seen. This is the "personal assistant" feel.
5. **Demand intelligence for the owner** — because every inquiry flows through the agent, the owner can ask "what are people searching for that I don't have?" — inventory signal no small business has today.

## 6. Phased roadmap

**Phase 0 — Spike (days)**
Kapso sandbox + minimal webhook + Agent SDK echo agent with one tool (`search_catalog` over the two example properties, hand-loaded). Proves the loop end-to-end.

**Phase 1 — Real estate pilot MVP (weeks 1–4)**
- Webhook service (verify, dedupe, media download, queue) + Postgres schema (tenant/product/lead/session).
- Customer agent: catalog Q&A, photo sending, buttons, lead capture, visit scheduling.
- Owner agent: ingestion from forwarded messages + photos, corrections, basic queries.
- Storefront v1: landing + catalog + product pages + wa.me CTA.
- Deploy on one real WhatsApp Business number for the pilot agency; start template approvals.

**Phase 2 — Hardening & proactive (weeks 5–8)**
Human handoff to Kapso inbox, template-based notifications (saved searches → "new listing" alerts), owner reports, change history, admin fallback web view (read-only).

**Phase 3 — Agnostic + multi-tenant (weeks 9+)**
Second vertical template (generic retail), tenant onboarding flow ("connect your number, describe your shop, forward your first products"), pricing/subscription, per-tenant storefront theming.

## 7. Running costs (pilot, one tenant)

| Item | Cost/mo |
|---|---|
| Kapso Free tier (2,000 msgs/mo) | $0 |
| Claude API (Haiku, ~100 conv/day) | ~$11–35 |
| Meta template messages (proactive only) | usage-based, ~$0.01–0.07/msg |
| Hosting (Fly.io/Cloud Run + Vercel + Postgres) | ~$10–25 |
| **Total** | **~$25–60/mo** |

Scales linearly and stays healthy: even at Pro tier Kapso ($ for 100k msgs) plus Sonnet-level models, per-tenant cost stays far below what a human sales assistant costs — which is the pricing anchor for the SaaS.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Meta business verification / template approval delays | Start verification in week 1; sandbox unblocks all dev except templates |
| Hallucinated product facts | Agent answers **only** via `search_catalog`/`get_product` tools; prompt forbids answering from memory; prices/codes always quoted from tool output |
| Owner sends ambiguous/conflicting data | Ingestion agent asks follow-up questions; required-field gate before publishing; change history for audit |
| 10s webhook timeout under load | Queue-first architecture from day 0 (ACK immediately, worker processes) |
| Kapso lock-in | Kapso's API mirrors Meta Cloud API 1:1 — migration path to raw Meta is preserved by design |

## 9. Open questions for the founder

1. Pilot agency: one WhatsApp number for both customers and owner, or separate numbers?
2. Storefront branding: white-label per tenant from day 1, or single-brand for the pilot?
3. Visit scheduling: integrate the agency's calendar (Google Calendar) in Phase 1, or capture requests as leads first?
4. Languages: Spanish-only pilot, or Spanish + English from the start?

---

## Appendix — research sources

- **Kapso**: bring-your-own-agent via raw webhook + REST confirmed as supported pattern (OpenClaw/Hermes plugins are reference implementations). Webhook: HMAC-SHA256 signature, 10s ACK, retries 10/40/90s, idempotency keys, `kapso` vs `meta` payload formats. Send API: `POST https://api.kapso.ai/meta/whatsapp/v24.0/{phoneNumberId}/messages`, `X-API-Key` auth; text, media, buttons, lists, carousel templates. Media download tokens expire in 4 min. Sandbox: shared number, text+interactive only. Pricing: Free 2k msgs/mo → Pro 100k. Docs: https://docs.kapso.ai/docs/introduction, https://docs.kapso.ai/llms.txt
- **Claude**: Agent SDK recommended over `claude -p` (stateless, 2–5s startup, unsuitable for webhooks). Sessions resumable by ID → per-phone conversation continuity across hours/days. Tools as plain functions. Haiku 4.5 ≈ $11/mo at 100 conv/day × 5 turns. Docs: https://code.claude.com/docs/en/agent-sdk/sessions
