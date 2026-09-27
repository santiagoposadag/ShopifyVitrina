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
  product and is the only rollback source — keep it.
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
