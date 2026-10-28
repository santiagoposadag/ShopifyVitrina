# Catalog loads

One-off scripts that apply a spreadsheet from the store to a live Shopify
product. They exist for BULK corrections — dozens of variants at once — which
do not belong in a WhatsApp conversation: an agent turn is capped by `maxTurns`,
and a price list is data to be reviewed as a diff, not prose to be interpreted.
Day-to-day edits of a single variant go through the owner assistant
(`update_product`).

Each load is a PAIR of scripts, kept after it ran as the record of what was
decided. For a new load, copy the pair and edit the copy.

## How a load runs

| Step | Command | Writes? |
|---|---|---|
| 1. Plan | `uv run scripts/catalog-loads/<load>_dry_run.py` | No. Every GraphQL document containing `mutation` is refused |
| 2. Review | read the printed plan / `tmp/<load>_plan.json` with the store admin | — |
| 3. Drift check | `uv run scripts/catalog-loads/<load>_apply.py` | No |
| 4. Apply | `uv run scripts/catalog-loads/<load>_apply.py --confirm` | Yes |
| 5. Confirm | re-run step 1: it must plan **no change** | No |

- **Credentials**: read from the repo-root `.env`, the same `SHOPIFY_*`
  variables the server uses (a configured token, or client id + secret to mint one).
- **Data stays out of git**: the spreadsheet, the plan and the apply log live in
  `tmp/`, which is ignored. The log holds the full pre-write snapshot of the
  product and is the only rollback source — keep it, and back it up outside the
  repo: it exists only on the machine that ran the apply.
- **Apply order** is rename → update → create → delete, stopping at the first
  `userError`. Deleting goes last so a failure earlier leaves nothing deleted.
- **Drift check**: before writing, the product is re-read and must still match
  what the plan saw. A plan applied to a store that moved on writes stale
  values over fresh ones, so any difference aborts. This is also why applying
  the same plan twice is refused.
- **Shopify has no dry-run for writes.** Business-rule rejections (`userErrors`)
  only appear on a real write; the dry run validates the current STATE (product,
  option values, SKU collisions store-wide), not the mutation.

## Loads

### `velas_cebada` — 2026-09-26

Source: `INFO_VELAS_CANDELABRO_CEBADAS.xlsx` (references L24 / L40 / L60 × colour
code, SKU `L24AO`…). Target: `vela-cebada-color-morado` "Vela cebada Colores",
options Color × Altura. Before: 48 variants, every SKU empty. After: 58
variants, every one with its SKU and the sheet's price.

| Decision (store admin) | Effect |
|---|---|
| Colours match by NAME only; SKU codes other products use are not evidence | 14 colours matched directly |
| "Verde Agua" in the sheet IS the store's "Verde Menta" | Option value renamed in place — same variant ids, history kept — not deleted and recreated |
| "Verde Limón" is a new colour | Created, 3 heights |
| "Verde Claro" is withdrawn | 3 variants deleted |
| Café, Dorado, Plateado, Palo de Rosa are new | Created; Palo de Rosa exists only at 40 cm |
| Inventory tracking stays as it is | Out of scope |

> ⚠️ `productVariantsBulkCreate` defaults to `tracked: true`. With the product's
> `inventoryPolicy: DENY` and no stock, the new variants would have been created
> **sold out**. They copy their siblings' settings instead (`tracked: false`,
> `DENY`, taxable, requires shipping).

### Price list pt2 — three loads, 2026-10-27

`ajustes_pt2` (prices), then `ajustes_pt2_skus` (SKUs), then
`ajustes_pt2_catalogo` (titles, colour names, diameters), in that order: each
one's drift check reads state the next one changes. **Roll back in reverse** —
catalogo (log 2, then log 1), then skus, then pt2 — or a rollback's drift check
sees the later load's changes and refuses.

### `ajustes_pt2` — 2026-10-27

Source: `revision_precios_Luminiere_pt2REVISADO.xlsx`, sheet "Revisión" — the
2026-10-15 price review, edited by the owner. Target: 37 products ("Vela
Aromática …", "Vela Color …"), 668 variants. Plan:
`tmp/ajustes_pt2_revisado_plan.json`. Prices and two product titles only: this
load writes **no SKU**, creates nothing and deletes nothing.

The owner did not touch the review's decision columns (M "Decisión", N "Precio a
aplicar"). Every decision was made by editing the file side (A–F) and the
product column (G), so the target price is **column F**. The store variant is
column H, resolved live by exact SKU across the whole store, and its product
and variant titles must match the sheet.

| Decision (owner + store admin) | Effect |
|---|---|
| "En ambos" rows | Price = F (555) |
| "Solo en Shopify" rows where the owner filled F (sizes 016/017D/028D/031D/08 per colour, all of Verde Claro) | Price = F (92) |
| G = "CAMBIAR VERDE MENTA POR VERDE AGUA" | Title "Vela Color Verde Menta2" → "Vela Color Verde Agua", handle kept; SKUs stay `-VA`; price = F |
| G = "CAMBIAR POR VERDE LIMON" | Title "Vela Color Verde Claro2" → "Vela Color Verde Limón", handle kept; price = F. Its `-VC` SKUs are NOT rewritten here — SKU alignment is a separate later load (`ajustes_pt2_skus`) |
| G = "ELIMINAR" (Café, Dorado, Plateado, Verde Limón as new products) and "Sándalo y Canela" 08A "(no existe)" | Nothing created (85 rows) |
| Uvas Frescas: absent from the owner's file, rows untouched | Price = N, the price every other aroma has for the same reference (12); checked against the sheet at run time |
| Verde Oscuro sizes 016/017D/028D/031D/08: rows untouched | The uniform per-reference price every other colour got (48200 / 115300 / 155000 / 230300 / 18300); the dry run verifies it IS uniform and plans nothing if not (5) |
| Amarillo rows 278–281: owner input landed one block off (refs 036–039 against store 017D/028D/031D/08-AM, two marked "ELIMINAR") | F ignored; same uniform per-reference price; no variant deleted (4) |
| No deletions, no SKU writes, no inventory or tracking change | Out of scope |

Guard: a change outside −5%..+20% that is not one of the owner-singled-out
groups (Shopify-only filled, Verde Oscuro, Amarillo) is excluded from the plan
and listed. On 2026-10-27 nothing tripped it (range +4.3%..+15.1%), and nothing
had drifted from the 2026-10-15 review.

> ⚠️ A product's TITLE is not its handle: the two renamed products keep
> `vela-color-verde-claro2` / `vela-color-verde-menta2`, sent explicitly with
> the new title so no shared link moves. The apply refuses to overwrite an
> existing `tmp/ajustes_pt2_apply_log.json`; a second run needs `--log` with a
> new path, so the first run's rollback snapshot survives.

### `ajustes_pt2_skus` — 2026-10-27

Source: the same `revision_precios_Luminiere_pt2REVISADO.xlsx`, sheet "Revisión",
rows 3–755. Target: the 37 products `ajustes_pt2` touched, all 668 variants.
Plan: `tmp/ajustes_pt2_skus_plan.json`. SKUs only (`inventoryItem.sku`, one
`productVariantsBulkUpdate` per product, `allowPartialUpdates: false`): no price,
title, option, tracking, create or delete.

The owner's format has no hyphen. SIN AROMA is `<ref><colour>` (`016-AM` →
`016AM`); CON AROMA is `<ref>A<aroma>`, where the store's ref loses its trailing
`C` (`062AC-CA` → `062ACA`).

| Decision (owner + store admin) | Effect |
|---|---|
| 1. Row has a store SKU (H) and an owner SKU (C), C ≠ "ELIMINAR" | Target = C, and column B must name the store SKU's ref (647) |
| 2. Amarillo rows 278–281: owner input one block off (C = ELIMINAR, ELIMINAR, 038AM, 039AM) | C ignored; target derived from the store SKU, which each row must still point at: `017DAM`, `028DAM`, `031DAM`, `08AM` (4) |
| 3. Uvas Frescas rows 219–230: no C | `<store ref without "C">UV` (`062AC-UV` → `062AUV`), only after every other aroma's H → C pair proves the pattern (12) |
| 4. Verde Oscuro rows 641–645: no C | `<ref>VO` (`016-VO` → `016VO`), only after every other colour's pairs, and Verde Oscuro's own 21, prove it (5) |
| 5. C = "ELIMINAR" / "(no existe)" with no store SKU | Never created; ignored (85) |
| 6. Negro `023-BL-3`, `038-BL-2` | Become `023NG`, `038NG` via C; listed in the dry run's "odd old suffixes" |

Hard checks, any of which blocks the product: targets unique; no target is ANY
SKU in the store (all 99 products) other than the variant's own; every target
fits exactly one of the two shapes (`^\d{2,3}D?[A-Z]{2}$` colour,
`^\d{2,3}A[A-Z]{2,4}$` aroma); the target's ref is the store SKU's ref; one code
per product; every variant of the 37 products covered exactly once; titles are
the post-load ones. Once applied, column H no longer exists in the store, so a
row resolves by its TARGET instead, as a no-op — which is what makes step 5
(re-run, expect no change) hold.

> ⚠️ **Aroma codes change MEANING between the two formats.** Store `CL` was
> Citronela & Limón; the owner's `CL` is **Coco & Limón** (Citronela & Limón is
> now `CTL`, and Coco & Limón was `VB-1`). Store `MZ` was Manzanilla (now
> `MLLA`) and stays Mostaza; store `VA` was Vainilla (now `VLLA`) and stays
> Verde Agua. Also `CT`→`CI`, `FF`→`FR`, Verde Limón `VC`→`VL`. Anyone reading
> an OLD SKU off a label, an order or an open lead must translate it through the
> apply log, not by its letters.

Rollback is the same script fed the log's inverse map:
`uv run scripts/catalog-loads/ajustes_pt2_skus_apply.py --rollback tmp/ajustes_pt2_skus_apply_log.json`
plans it from live state (dry by default; `--confirm` writes, logging to
`tmp/ajustes_pt2_skus_rollback_log.json`). A product whose variants all carry the
new SKU is reverted, one still at the old SKU is skipped, a mix aborts.

### `ajustes_pt2_catalogo` — 2026-10-27

Source: owner decisions, no spreadsheet input (the `ajustes_pt2` sheet is read
only to REPORT Altura disagreements). Target: the 16 "Vela Color *" products and
"Vela Entorchada Colores". Plan: `tmp/ajustes_pt2_catalogo_plan.json`. Titles
and option values only: no price, SKU, create or delete.

| Decision (store owner) | Effect |
|---|---|
| A. Drop the "2" glued to a title's last word (`^(.*[^\d\s])2$`) | 6 renames, all "Vela Color": Azul Oscuro, Gris, Morado, Negro, Verde Oscuro, Vinotinto. Handles kept (`…2`, `vela-color-vinotinto-2`). A match outside "Vela Color"/"Vela Aromática" is listed, never planned by the pattern; a target title another product already has (accent/case-insensitive) blocks |
| B. "Vela Entorchada Colores" Color values | Renamed in place, same ids: Verde Claro → Verde Agua, Morada → Morado, Azul caro → Azul Claro |
| C. Refs 062 / 063 / 064 are 5 cm wide | Per "Vela Color" product: add Diámetro "5 cm", move ONLY the three variants at "4,5 cm" × 8 / 10 / 15 cm (cross-checked against the SKU ref, old `062-XX` or new `062XX`) to it — 48 variants, same ids. Ref 061 (4,5 × 4 cm) keeps "4,5 cm". "Vela Aromática" already say 5 cm, untouched |
| C. Value order | "5 cm" right after "4,5 cm" — Shopify's own re-flow on the move does it; `productOptionsReorder` only as a fallback. `--no-reorder` in the dry run drops the fallback |
| D. Nothing else | Out of scope. The sheet says 062 is 5 × **7,5** cm, the store says 8 cm: reported, not changed |

> ⚠️ **Moving variants onto a value RE-FLOWS the option's value order** (found
> live on the first run, 2026-10-27). `optionValuesToAdd` appends "5 cm" last;
> the moment `productVariantsBulkUpdate` puts the three variants on it, Shopify
> re-orders EVERY option's values by the position of their first variant — so
> "5 cm" lands right after "4,5 cm" and no variant position moves. The first
> apply expected the value to stay last, failed its verify on the first product
> (Azul Oscuro) although the store was already in the intended state, and
> stopped. The verify now derives the re-flowed order (and accepts the unchanged
> one); `productOptionsReorder` + `productVariantsBulkReorder` run ONLY if the
> order or a position still differs afterwards. They are kept because the reorder
> recomputes the position of EVERY variant from value order, and Altura's order
> here is first-appearance (10, 15, 20, 5, 4, 8 …), not numeric, so it would
> reshuffle 14–17 variants per product without the position restore.

Run 1 (log `tmp/ajustes_pt2_catalogo_apply_log.json`, plan kept as
`tmp/ajustes_pt2_catalogo_plan_run1.json`) completed Azul Oscuro and stopped.
Run 2 is a fresh dry run (Azul Oscuro plans as done) applied with
`--log tmp/ajustes_pt2_catalogo_apply_log_2.json`; the spent plan is refused as
drift. To undo everything, roll back run 2's log, then run 1's.

> ⚠️ **Order against `ajustes_pt2_skus`.** That load checks the product titles
> and variant titles this one changes ("Vela Color Azul Oscuro2", "4,5 cm / 8 cm"),
> so it must land FIRST; `--confirm` refuses until every rewrite in
> `tmp/ajustes_pt2_skus_plan.json` is live (`--allow-before-skus-load` overrides).
> The reverse is safe: this load's drift fingerprint holds no SKU. On 2026-10-27
> the SKU load had already landed (668/668).

Rollback: `uv run scripts/catalog-loads/ajustes_pt2_catalogo_apply.py --rollback tmp/ajustes_pt2_catalogo_apply_log.json`
plans from live state toward the log's pre-run snapshot (dry by default;
`--confirm` writes, logging to `tmp/ajustes_pt2_catalogo_rollback_log.json`):
each field still at the promised value is reverted, one at the pre-run value is
left, anything else aborts before writing. It also deletes the "5 cm" values once
empty and restores value order and variant positions, so it is the recovery path
after a run that stopped halfway — a fresh dry run would instead adopt whatever
positions a half-finished reorder left.
