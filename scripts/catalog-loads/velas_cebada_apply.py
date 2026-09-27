# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""
Apply tmp/velas_cebada_plan.json (produced by velas_cebada_dry_run.py) to the
live product. Writes ONLY with --confirm; without it, it re-checks the plan
against the store and stops.

    uv run scripts/catalog-loads/velas_cebada_apply.py            # drift check only
    uv run scripts/catalog-loads/velas_cebada_apply.py --confirm  # write

Order: rename -> update -> create -> delete, stopping at the first userError.
Before writing, the live product is re-read and must still look exactly like
it did when the plan was made; any drift aborts, because a plan applied to a
store that moved on writes stale values over fresh ones.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from velas_cebada_dry_run import DEFAULT_PLAN, REPO_ROOT, Shopify, load_env, option  # noqa: E402

# Holds the pre-write snapshot: it is the rollback source, keep it.
DEFAULT_LOG = REPO_ROOT / "tmp" / "velas_cebada_apply_log.json"

# New variants copy their siblings' settings. Omitting them would take Shopify's
# defaults, and tracked=true with DENY and zero stock is a variant born sold out.
NEW_VARIANT_SETTINGS = {
    "inventoryPolicy": "DENY",
    "taxable": True,
}
NEW_INVENTORY_ITEM_SETTINGS = {"tracked": False, "requiresShipping": True}

PRODUCT_QUERY = """
query($id: ID!) {
  product(id: $id) {
    id handle title
    options { id name optionValues { id name } }
    variants(first: 250) {
      nodes {
        id sku title price
        selectedOptions { name value }
      }
    }
  }
}
"""


def money(value) -> str:
    return f"{Decimal(str(value)):.2f}"


class Writer(Shopify):
    def mutate(self, document: str, variables: dict, root: str) -> dict:
        req = urllib.request.Request(
            self.endpoint,
            data=json.dumps({"query": document, "variables": variables}).encode(),
            headers={"Content-Type": "application/json", "X-Shopify-Access-Token": self.token},
        )
        with urllib.request.urlopen(req) as res:
            payload = json.load(res)
        if payload.get("errors"):
            raise RuntimeError(f"{root}: GraphQL errors: {payload['errors']}")
        result = payload["data"][root]
        if result.get("userErrors"):
            raise RuntimeError(f"{root}: userErrors: {result['userErrors']}")
        return result


def load_product(shop: Shopify, product_id: str) -> dict:
    return shop.query(PRODUCT_QUERY, {"id": product_id})["product"]


def check_drift(plan: dict, product: dict) -> list[str]:
    problems: list[str] = []
    variants = {v["id"]: v for v in product["variants"]["nodes"]}
    color = next(o for o in product["options"] if o["name"] == "Color")
    color_values = {v["name"] for v in color["optionValues"]}

    for r in plan["rename"]:
        if r["from"] not in color_values:
            problems.append(f"rename source {r['from']} missing")
        if r["to"] in color_values:
            problems.append(f"rename target {r['to']} already exists")

    for u in plan["update"]:
        v = variants.get(u["variant_id"])
        if v is None:
            problems.append(f"{u['variant_title']}: variant gone")
            continue
        old_sku, old_price = None, None
        if "sku" in u["changes"]:
            old_sku = u["changes"]["sku"][0]
            if (v["sku"] or None) != old_sku:
                problems.append(f"{v['title']}: sku is {v['sku']!r}, plan expected {old_sku!r}")
        if "price" in u["changes"]:
            old_price = u["changes"]["price"][0]
            if money(v["price"]) != money(old_price):
                problems.append(f"{v['title']}: price is {v['price']}, plan expected {old_price}")

    for d in plan["delete"]:
        if d["variant_id"] not in variants:
            problems.append(f"{d['variant_title']}: variant to delete is gone")

    existing = {(option(v, "Color"), option(v, "Altura")) for v in variants.values()}
    for c in plan["create"]:
        if tuple(c["option_values"]) in existing:
            problems.append(f"{' / '.join(c['option_values'])} already exists")
    return problems


def expected_final(plan: dict) -> dict[tuple[str, str], tuple[str, str]]:
    renames = {r["from"]: r["to"] for r in plan["rename"]}
    expected = {}
    for u in plan["update"]:
        color, height = u["variant_title"].split(" / ")
        expected[(renames.get(color, color), height)] = (u["sku"], money(u["price"]))
    for c in plan["create"]:
        expected[tuple(c["option_values"])] = (c["sku"], money(c["price"]))
    return expected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--confirm", action="store_true", help="Actually write to the store")
    parser.add_argument("--plan", default=str(DEFAULT_PLAN))
    parser.add_argument("--log", default=str(DEFAULT_LOG))
    args = parser.parse_args()
    global LOG
    LOG = Path(args.log)

    plan = json.loads(Path(args.plan).read_text())
    if plan["unresolved"] or plan["conflicts"] or plan["untouched"]:
        sys.exit("Plan has unresolved/conflicting/untouched entries; fix them in the dry run first")

    shop = Writer(load_env())
    product_id = plan["product_id"]
    before = load_product(shop, product_id)

    problems = check_drift(plan, before)
    if problems:
        print("DRIFT — the store no longer matches the plan. Nothing written.")
        for p in problems:
            print(f"  {p}")
        sys.exit(1)
    print(
        f"Plan still matches {before['handle']}: rename {len(plan['rename'])}, "
        f"update {len(plan['update'])}, create {len(plan['create'])}, delete {len(plan['delete'])}"
    )
    if not args.confirm:
        print("Drift check only. Re-run with --confirm to write.")
        return

    # The full pre-write snapshot is the rollback source: old SKUs, prices and
    # the ids of everything about to be renamed or deleted.
    log: dict = {"product_id": product_id, "before": before, "steps": []}
    LOG.write_text(json.dumps(log, indent=2, ensure_ascii=False))

    def record(step: str, result: dict) -> None:
        log["steps"].append({"step": step, "result": result})
        LOG.write_text(json.dumps(log, indent=2, ensure_ascii=False))
        print(f"  ✓ {step}")

    try:
        # 1. Rename option values in place (same variant ids, history kept).
        color = next(o for o in before["options"] if o["name"] == "Color")
        value_ids = {v["name"]: v["id"] for v in color["optionValues"]}
        if plan["rename"]:
            result = shop.mutate(
                """mutation($productId: ID!, $option: OptionUpdateInput!, $values: [OptionValueUpdateInput!]) {
                     productOptionUpdate(productId: $productId, option: $option, optionValuesToUpdate: $values) {
                       product { id }
                       userErrors { field message code }
                     }
                   }""",
                {
                    "productId": product_id,
                    "option": {"id": color["id"]},
                    "values": [{"id": value_ids[r["from"]], "name": r["to"]} for r in plan["rename"]],
                },
                "productOptionUpdate",
            )
            record("rename", result)

        # 2. SKU + price on existing variants. Unchanged ones stay in the plan for
        # the final verification but are not re-sent.
        changed = [u for u in plan["update"] if u["changes"]]
        if changed:
            result = shop.mutate(
                """mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                     productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                       productVariants { id sku price }
                       userErrors { field message }
                     }
                   }""",
                {
                    "productId": product_id,
                    "variants": [
                        {"id": u["variant_id"], "price": money(u["price"]), "inventoryItem": {"sku": u["sku"]}}
                        for u in changed
                    ],
                },
                "productVariantsBulkUpdate",
            )
            record("update", result)

        # 3. New variants, configured like their siblings.
        if plan["create"]:
            result = shop.mutate(
                """mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                     productVariantsBulkCreate(productId: $productId, variants: $variants) {
                       productVariants { id sku price title }
                       userErrors { field message }
                     }
                   }""",
                {
                    "productId": product_id,
                    "variants": [
                        {
                            "price": money(c["price"]),
                            "optionValues": [
                                {"optionName": "Color", "name": c["option_values"][0]},
                                {"optionName": "Altura", "name": c["option_values"][1]},
                            ],
                            "inventoryItem": {"sku": c["sku"], **NEW_INVENTORY_ITEM_SETTINGS},
                            **NEW_VARIANT_SETTINGS,
                        }
                        for c in plan["create"]
                    ],
                },
                "productVariantsBulkCreate",
            )
            record("create", result)

        # 4. Withdrawn colour. Last, so a failure above leaves nothing deleted.
        if plan["delete"]:
            result = shop.mutate(
                """mutation($productId: ID!, $ids: [ID!]!) {
                     productVariantsBulkDelete(productId: $productId, variantsIds: $ids) {
                       product { id }
                       userErrors { field message }
                     }
                   }""",
                {"productId": product_id, "ids": [d["variant_id"] for d in plan["delete"]]},
                "productVariantsBulkDelete",
            )
            record("delete", result)
    except RuntimeError as err:
        print(f"STOPPED: {err}")
        print(f"Completed steps are logged in {LOG}")
        sys.exit(1)

    # 5. Re-read and compare against what the plan promised.
    after = load_product(shop, product_id)
    expected = expected_final(plan)
    actual = {
        (option(v, "Color"), option(v, "Altura")): (v["sku"], money(v["price"]))
        for v in after["variants"]["nodes"]
    }
    missing = {k: v for k, v in expected.items() if actual.get(k) != v}
    extra = sorted(set(actual) - set(expected))
    color_after = next(o for o in after["options"] if o["name"] == "Color")

    print(f"\nVERIFY: {len(actual)} variants in store, {len(expected)} expected")
    for k, v in missing.items():
        print(f"  MISMATCH {' / '.join(k)}: expected {v}, got {actual.get(k)}")
    for k in extra:
        print(f"  UNEXPECTED {' / '.join(k)}: {actual[k]}")
    print(f"  Color values: {', '.join(v['name'] for v in color_after['optionValues'])}")
    log["verify"] = {"missing": {" / ".join(k): v for k, v in missing.items()}, "extra": [" / ".join(k) for k in extra]}
    LOG.write_text(json.dumps(log, indent=2, ensure_ascii=False))
    print("OK — store matches the plan." if not missing and not extra else "VERIFY FAILED — see above.")


if __name__ == "__main__":
    main()
