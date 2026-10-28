# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""
Apply tmp/ajustes_pt2_revisado_plan.json (produced by ajustes_pt2_dry_run.py)
to the live store. Writes ONLY with --confirm; without it, it re-checks the plan
against the store (and the mutation documents against the schema) and stops.

    uv run scripts/catalog-loads/ajustes_pt2_apply.py            # drift check only
    uv run scripts/catalog-loads/ajustes_pt2_apply.py --confirm  # write

What it can write, and nothing else:
  1. product TITLE renames (handle sent unchanged, so no URL moves);
  2. variant PRICES, one productVariantsBulkUpdate per product, all-or-nothing.
No SKU, inventory, option, status, create or delete is ever sent.

Before writing, every product in the plan is re-read and must still look
EXACTLY like the plan's snapshot (title, handle, every variant's id, title, SKU
and price); any drift aborts, because a plan applied to a store that moved on
writes stale values over fresh ones. Each product is re-read once more right
before its own write to keep that window as short as one request.

Stops at the first userError. Completed steps are in the log; the recovery path
is to re-run the dry run (which plans only what is still missing) and apply that.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ajustes_pt2_dry_run import (  # noqa: E402
    DEFAULT_PLAN,
    REPO_ROOT,
    Shopify,
    load_env,
    load_product,
    money,
    scan_variants,
)

# Holds the full pre-write snapshot: it is the rollback source, keep it.
DEFAULT_LOG = REPO_ROOT / "tmp" / "ajustes_pt2_apply_log.json"

RENAME_DOC = """mutation($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id title handle }
    userErrors { field message }
  }
}"""

PRICE_DOC = """mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
    productVariants { id price }
    userErrors { field message }
  }
}"""

# Introspection is a read; it proves the two documents above validate against
# this store's API version before anything is sent, so a typo cannot fail the
# load halfway through.
SCHEMA_QUERY = """
query {
  __schema { mutationType { fields { name args { name } } } }
  productInput: __type(name: "ProductUpdateInput") { inputFields { name } }
  variantInput: __type(name: "ProductVariantsBulkInput") { inputFields { name } }
}
"""
REQUIRED_SCHEMA = {
    ("root", "productUpdate"): {"product"},
    ("root", "productVariantsBulkUpdate"): {"productId", "variants", "allowPartialUpdates"},
    ("productInput", None): {"id", "title", "handle"},
    ("variantInput", None): {"id", "price"},
}


class Writer(Shopify):
    """Sends mutations only once armed, and arming happens only under --confirm."""

    armed = False

    def introspect(self) -> dict:
        return self._post(SCHEMA_QUERY, None)

    def mutate(self, document: str, variables: dict, root: str) -> dict:
        if not self.armed:
            raise RuntimeError("Refusing to send a mutation without --confirm")
        data = self._post(document, variables)
        result = data[root]
        if result is None:
            raise RuntimeError(f"{root}: returned null")
        if result.get("userErrors"):
            raise RuntimeError(f"{root}: userErrors: {result['userErrors']}")
        return result


def check_schema(shop: Writer) -> list[str]:
    data = shop.introspect()
    data["root"] = data["__schema"]["mutationType"]
    problems = []
    for (typ, field), needed in REQUIRED_SCHEMA.items():
        if not data.get(typ):
            problems.append(f"schema: type for {typ} not found")
            continue
        if field is None:
            have = {f["name"] for f in data[typ]["inputFields"]}
        else:
            match = [f for f in data[typ]["fields"] if f["name"] == field]
            have = {a["name"] for a in match[0]["args"]} if match else set()
        if not needed <= have:
            problems.append(f"schema: {field or typ} lacks {sorted(needed - have)}")
    return problems


def fingerprint(product: dict) -> dict:
    """Everything this load either writes or depends on, per product."""
    return {
        "title": product["title"],
        "handle": product["handle"],
        "variants": {
            v["id"]: {"title": v["title"], "sku": v["sku"], "price": money(v["price"])}
            for v in product["variants"]["nodes"]
        },
    }


def diff(expected: dict, live: dict, label: str) -> list[str]:
    out = []
    for key in ("title", "handle"):
        if expected[key] != live[key]:
            out.append(f"{label}: {key} is {live[key]!r}, plan saw {expected[key]!r}")
    ev, lv = expected["variants"], live["variants"]
    for vid in sorted(set(ev) | set(lv)):
        if vid not in lv:
            out.append(f"{label}: variant {ev[vid]['title']} is gone")
        elif vid not in ev:
            out.append(f"{label}: new variant {lv[vid]['title']} appeared")
        elif ev[vid] != lv[vid]:
            out.append(f"{label} / {ev[vid]['title']}: is {lv[vid]}, plan saw {ev[vid]}")
    return out


def validate_plan(plan: dict) -> list[str]:
    problems = []
    if plan["anomalies"]:
        problems.append(f"{len(plan['anomalies'])} anomalies")
    if plan["untouched"]:
        problems.append(f"{len(plan['untouched'])} untouched variants in touched products")
    for key in ("sku_rewrites", "creates", "deletes"):
        if plan.get(key):
            problems.append(f"plan carries {key}; this apply does not write them")
    snap = {pid: fingerprint(p) for pid, p in plan["snapshot"].items()}
    seen = set()
    for u in plan["price_updates"]:
        v = snap.get(u["product_id"], {}).get("variants", {}).get(u["variant_id"])
        if v is None:
            problems.append(f"row {u['row']}: variant not in the plan's snapshot")
        elif v["price"] != u["old"]:
            problems.append(f"row {u['row']}: snapshot price {v['price']} ≠ planned old {u['old']}")
        if u["variant_id"] in seen:
            problems.append(f"row {u['row']}: variant planned twice")
        seen.add(u["variant_id"])
        if Decimal(u["new"]) <= 0:
            problems.append(f"row {u['row']}: non-positive price {u['new']}")
    for t in plan["title_renames"]:
        if snap.get(t["product_id"], {}).get("title") != t["from"]:
            problems.append(f"rename {t['from']}: not the snapshot's title")
    return problems


def expected_final(plan: dict) -> dict[str, dict]:
    final = {pid: fingerprint(p) for pid, p in plan["snapshot"].items()}
    for t in plan["title_renames"]:
        final[t["product_id"]]["title"] = t["to"]
    for u in plan["price_updates"]:
        final[u["product_id"]]["variants"][u["variant_id"]]["price"] = u["new"]
    return final


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--confirm", action="store_true", help="Actually write to the store")
    parser.add_argument("--plan", default=str(DEFAULT_PLAN))
    parser.add_argument("--log", default=str(DEFAULT_LOG))
    args = parser.parse_args()
    log_path = Path(args.log)

    plan = json.loads(Path(args.plan).read_text())
    problems = validate_plan(plan)
    if problems:
        sys.exit("Plan is not appliable; fix it in the dry run first:\n  " + "\n  ".join(problems))

    shop = Writer(load_env())
    if shop.domain != plan["store"]:
        sys.exit(f"Plan was made against {plan['store']}, this .env points at {shop.domain}")

    problems = check_schema(shop)
    snapshot = {pid: fingerprint(p) for pid, p in plan["snapshot"].items()}
    before: dict[str, dict] = {}
    for pid in snapshot:
        before[pid] = load_product(shop, pid)
        problems += diff(snapshot[pid], fingerprint(before[pid]), before[pid]["title"])

    # A target title must still be free store-wide.
    variants = scan_variants(shop)
    for t in plan["title_renames"]:
        taken = {v["product"]["id"] for v in variants
                 if v["product"]["title"] == t["to"] and v["product"]["id"] != t["product_id"]}
        if taken:
            problems.append(f"title {t['to']!r} now used by {sorted(taken)}")

    if problems:
        print("DRIFT — the store no longer matches the plan. Nothing written.")
        for p in problems:
            print(f"  {p}")
        sys.exit(1)

    by_product: dict[str, list[dict]] = {}
    for u in plan["price_updates"]:
        by_product.setdefault(u["product_id"], []).append(u)
    print(
        f"Plan ({plan['generated_at']}) still matches {plan['store']}: "
        f"{len(plan['title_renames'])} title renames, {len(plan['price_updates'])} price updates "
        f"across {len(by_product)} products; {len(plan['noops'])} no-ops, "
        f"{len(plan['excluded_by_guard'])} excluded by the guard (not written)."
    )
    if not args.confirm:
        print("Drift check only. Re-run with --confirm to write.")
        return

    # Never overwrite an earlier log: after a partial run it is the only record
    # of the store before that run.
    if log_path.exists():
        sys.exit(f"{log_path} exists (an earlier run's rollback source). Pass --log with a new path.")

    log: dict = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "plan": str(args.plan),
        "plan_generated_at": plan["generated_at"],
        "store": plan["store"],
        "before": before,
        "steps": [],
    }
    log_path.write_text(json.dumps(log, indent=2, ensure_ascii=False))

    def record(step: str, result: dict) -> None:
        log["steps"].append({"step": step, "at": datetime.now(timezone.utc).isoformat(), "result": result})
        log_path.write_text(json.dumps(log, indent=2, ensure_ascii=False))
        print(f"  ✓ {step}")

    def recheck(pid: str, expected: dict) -> None:
        drift = diff(expected, fingerprint(load_product(shop, pid)), expected["title"])
        if drift:
            raise RuntimeError("drift just before writing: " + "; ".join(drift))

    shop.armed = True
    current = {pid: fingerprint(p) for pid, p in before.items()}
    try:
        # 1. Titles. The handle is sent as it is, so no link changes.
        for t in plan["title_renames"]:
            pid = t["product_id"]
            recheck(pid, current[pid])
            result = shop.mutate(
                RENAME_DOC,
                {"product": {"id": pid, "title": t["to"], "handle": current[pid]["handle"]}},
                "productUpdate",
            )
            got = result["product"]
            if got["title"] != t["to"] or got["handle"] != current[pid]["handle"]:
                raise RuntimeError(f"productUpdate {pid}: returned {got}")
            current[pid]["title"] = t["to"]
            record(f"title {t['from']} → {t['to']}", result)

        # 2. Prices, one all-or-nothing call per product. Only price is sent.
        for pid, updates in by_product.items():
            recheck(pid, current[pid])
            result = shop.mutate(
                PRICE_DOC,
                {"productId": pid,
                 "variants": [{"id": u["variant_id"], "price": u["new"]} for u in updates]},
                "productVariantsBulkUpdate",
            )
            returned = {v["id"]: money(v["price"]) for v in result["productVariants"]}
            wanted = {u["variant_id"]: u["new"] for u in updates}
            if returned != wanted:
                raise RuntimeError(f"productVariantsBulkUpdate {pid}: returned {returned}, wanted {wanted}")
            for vid, price in wanted.items():
                current[pid]["variants"][vid]["price"] = price
            record(f"prices {current[pid]['title']} ({len(updates)})", result)
    except Exception as err:  # any failure: record where it stopped, then stop
        log["stopped"] = f"{type(err).__name__}: {err}"
        log_path.write_text(json.dumps(log, indent=2, ensure_ascii=False))
        print(f"STOPPED: {err}")
        print(f"Completed steps are logged in {log_path}. Re-run the dry run to plan what is left.")
        sys.exit(1)

    # 3. Re-read every product and compare with what the plan promised.
    expected = expected_final(plan)
    mismatches = []
    for pid, exp in expected.items():
        mismatches += diff(exp, fingerprint(load_product(shop, pid)), exp["title"])
    log["verify"] = {"mismatches": mismatches, "at": datetime.now(timezone.utc).isoformat()}
    log_path.write_text(json.dumps(log, indent=2, ensure_ascii=False))
    print(f"\nVERIFY: {len(expected)} products re-read")
    for m in mismatches:
        print(f"  MISMATCH {m}")
    print("OK — store matches the plan." if not mismatches else "VERIFY FAILED — see above.")
    if mismatches:
        sys.exit(1)


if __name__ == "__main__":
    main()
