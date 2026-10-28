# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""
Apply tmp/ajustes_pt2_skus_plan.json (produced by ajustes_pt2_skus_dry_run.py)
to the live store, or roll an earlier run back. Writes ONLY with --confirm;
without it, it re-checks the plan against the store (and the mutation document
against the schema) and stops.

    uv run scripts/catalog-loads/ajustes_pt2_skus_apply.py                      # drift check only
    uv run scripts/catalog-loads/ajustes_pt2_skus_apply.py --confirm            # write
    uv run scripts/catalog-loads/ajustes_pt2_skus_apply.py --rollback LOG       # plan the inverse
    uv run scripts/catalog-loads/ajustes_pt2_skus_apply.py --rollback LOG --confirm

What it can write, and nothing else: variant SKUs (`inventoryItem.sku`), one
productVariantsBulkUpdate per product, all-or-nothing (allowPartialUpdates:
false). No price, title, option, status, tracking, inventory, create or delete
is ever sent.

Before writing, every product in the plan is re-read and must still look
EXACTLY like the plan's snapshot (title, handle, every variant's id, title, SKU,
price and tracking); any drift aborts. Every target SKU is checked once more
against the WHOLE store, because a SKU somebody created since the dry run would
make two variants answer to one code. Each product is re-read once more right
before its own write to keep that window as short as one request.

The log is written BEFORE the first write and never overwritten. It holds the
full pre-write snapshot, the old -> new map and its inverse. A rollback is this
same write path fed the inverse map, planned from LIVE state: a product whose
variants all carry the new SKU is reverted, one whose variants all still carry
the old SKU was never written and is skipped, anything else aborts.

Stops at the first userError. The recovery path is to re-run the dry run (which
plans only what is still missing) and apply that.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ajustes_pt2_skus_dry_run import (  # noqa: E402
    DEFAULT_PLAN,
    REPO_ROOT,
    Shopify,
    load_env,
    load_product,
    money,
    scan_variants,
    sku_owners,
)

# Holds the full pre-write snapshot and the inverse map: the rollback source.
DEFAULT_LOG = REPO_ROOT / "tmp" / "ajustes_pt2_skus_apply_log.json"
DEFAULT_ROLLBACK_LOG = REPO_ROOT / "tmp" / "ajustes_pt2_skus_rollback_log.json"
DEFAULT_ROLLBACK_PLAN = REPO_ROOT / "tmp" / "ajustes_pt2_skus_rollback_plan.json"

SKU_DOC = """mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
    productVariants { id sku price inventoryItem { id tracked } }
    userErrors { field message }
  }
}"""

# Introspection is a read; it proves the document above validates against this
# store's API version before anything is sent, so a shape error cannot fail the
# load halfway through. The SKU lives on the inventory item in the bulk input
# (ProductVariantsBulkInput.inventoryItem: InventoryItemInput { sku }).
SCHEMA_QUERY = """
query {
  __schema { mutationType { fields { name args { name } } } }
  variantInput: __type(name: "ProductVariantsBulkInput") {
    inputFields { name type { name kind ofType { name kind } } }
  }
  inventoryItemInput: __type(name: "InventoryItemInput") { inputFields { name } }
  payload: __type(name: "ProductVariantsBulkUpdatePayload") { fields { name } }
  variant: __type(name: "ProductVariant") { fields { name } }
  inventoryItem: __type(name: "InventoryItem") { fields { name } }
}
"""


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
    problems = []

    def names(typ: str, key: str) -> set[str]:
        node = data.get(typ)
        if not node:
            problems.append(f"schema: type {typ} not found")
            return set()
        return {f["name"] for f in node[key] or []}

    root = [f for f in data["__schema"]["mutationType"]["fields"] if f["name"] == "productVariantsBulkUpdate"]
    args = {a["name"] for a in root[0]["args"]} if root else set()
    for needed, have, label in (
        ({"productId", "variants", "allowPartialUpdates"}, args, "productVariantsBulkUpdate args"),
        ({"id", "inventoryItem"}, names("variantInput", "inputFields"), "ProductVariantsBulkInput"),
        ({"sku"}, names("inventoryItemInput", "inputFields"), "InventoryItemInput"),
        ({"productVariants", "userErrors"}, names("payload", "fields"), "ProductVariantsBulkUpdatePayload"),
        ({"id", "sku", "price", "inventoryItem"}, names("variant", "fields"), "ProductVariant"),
        ({"id", "tracked"}, names("inventoryItem", "fields"), "InventoryItem"),
    ):
        if not needed <= have:
            problems.append(f"schema: {label} lacks {sorted(needed - have)}")
    # The bulk input's inventoryItem must BE an InventoryItemInput, or `sku`
    # above was checked on the wrong type.
    field = next((f for f in (data.get("variantInput") or {}).get("inputFields") or []
                  if f["name"] == "inventoryItem"), None)
    if field is not None:
        t = field["type"]
        type_name = t["name"] or (t.get("ofType") or {}).get("name")
        if type_name != "InventoryItemInput":
            problems.append(f"schema: ProductVariantsBulkInput.inventoryItem is {type_name}, not InventoryItemInput")
    return problems


def fingerprint(product: dict) -> dict:
    """Everything this load either writes or depends on, per product. Price and
    tracking are not written, but they are compared before and after so a side
    effect of the SKU write would show up in the verify."""
    return {
        "title": product["title"],
        "handle": product["handle"],
        "variants": {
            v["id"]: {"title": v["title"], "sku": v["sku"], "price": money(v["price"]),
                      "tracked": v["inventoryItem"]["tracked"]}
            for v in product["variants"]["nodes"]
        },
    }


def diff(expected: dict, live: dict, label: str) -> list[str]:
    out = []
    for key in ("title", "handle"):
        if expected[key] != live[key]:
            out.append(f"{label}: {key} is {live[key]!r}, expected {expected[key]!r}")
    ev, lv = expected["variants"], live["variants"]
    for vid in sorted(set(ev) | set(lv)):
        if vid not in lv:
            out.append(f"{label}: variant {ev[vid]['title']} is gone")
        elif vid not in ev:
            out.append(f"{label}: new variant {lv[vid]['title']} appeared")
        elif ev[vid] != lv[vid]:
            out.append(f"{label} / {ev[vid]['title']}: is {lv[vid]}, expected {ev[vid]}")
    return out


def validate_plan(plan: dict) -> list[str]:
    problems = []
    for key in ("anomalies", "uncovered", "shape_outliers"):
        if plan.get(key):
            problems.append(f"{len(plan[key])} {key}")
    if plan.get("blocked_products"):
        problems.append(f"{len(plan['blocked_products'])} blocked products")
    for key in ("price_updates", "title_renames", "creates", "deletes"):
        if plan.get(key):
            problems.append(f"plan carries {key}; this apply writes SKUs only")
    snap = {pid: fingerprint(p) for pid, p in plan["snapshot"].items()}
    all_snapshot_skus = Counter(v["sku"] for p in snap.values() for v in p["variants"].values() if v["sku"])
    seen: set[str] = set()
    targets = Counter(u["new"] for u in plan["sku_rewrites"])
    for u in plan["sku_rewrites"]:
        v = snap.get(u["product_id"], {}).get("variants", {}).get(u["variant_id"])
        if v is None:
            problems.append(f"row {u['row']}: variant not in the plan's snapshot")
        elif v["sku"] != u["old"]:
            problems.append(f"row {u['row']}: snapshot SKU {v['sku']} ≠ planned old {u['old']}")
        if u["variant_id"] in seen:
            problems.append(f"row {u['row']}: variant planned twice")
        seen.add(u["variant_id"])
        if not u["new"] or u["new"] != u["new"].strip() or "-" in u["new"]:
            problems.append(f"row {u['row']}: malformed target {u['new']!r}")
        if targets[u["new"]] > 1:
            problems.append(f"row {u['row']}: target {u['new']} planned more than once")
        if all_snapshot_skus.get(u["new"]):
            problems.append(f"row {u['row']}: target {u['new']} is a current SKU in the snapshot")
    return problems


def collisions(jobs: list[dict], variants: list[dict]) -> list[str]:
    """A target SKU must not be carried by any variant other than its own."""
    by_sku = sku_owners(variants)
    out = []
    for j in jobs:
        others = [v for v in by_sku.get(j["to"], []) if v["id"] != j["variant_id"]]
        if others:
            out.append(f"{j['to']} is already on " + ", ".join(
                f"{v['product']['title']} / {v['title']}" for v in others))
    return out


def execute(shop: Writer, jobs: list[dict], before: dict[str, dict], log_path: Path, header: dict) -> None:
    """Write `jobs` ({product_id, variant_id, from, to}), one all-or-nothing call
    per product, then re-read every product and compare with the promise."""
    by_product: dict[str, list[dict]] = {}
    for j in jobs:
        by_product.setdefault(j["product_id"], []).append(j)

    log: dict = {
        **header,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "store": shop.domain,
        "api_version": shop.version,
        "before": before,
        # sku_map is what this run writes; reverse_map is what undoes it, in the
        # exact shape --rollback reads.
        "sku_map": [{"product_id": j["product_id"], "product_title": j["product_title"],
                     "variant_id": j["variant_id"], "variant_title": j["variant_title"],
                     "from": j["from"], "to": j["to"]} for j in jobs],
        "reverse_map": [{"product_id": j["product_id"], "product_title": j["product_title"],
                         "variant_id": j["variant_id"], "variant_title": j["variant_title"],
                         "from": j["to"], "to": j["from"]} for j in jobs],
        "steps": [],
    }
    # Exclusive create: a log that already exists is an earlier run's rollback
    # source, and this run must not be able to destroy it.
    with open(log_path, "x", encoding="utf-8") as fh:
        fh.write(json.dumps(log, indent=2, ensure_ascii=False))

    def save() -> None:
        log_path.write_text(json.dumps(log, indent=2, ensure_ascii=False))

    def record(step: str, result: dict) -> None:
        log["steps"].append({"step": step, "at": datetime.now(timezone.utc).isoformat(), "result": result})
        save()
        print(f"  ✓ {step}")

    current = {pid: fingerprint(p) for pid, p in before.items()}

    def recheck(pid: str) -> None:
        drift = diff(current[pid], fingerprint(load_product(shop, pid)), current[pid]["title"])
        if drift:
            raise RuntimeError("drift just before writing: " + "; ".join(drift))

    shop.armed = True
    try:
        for pid, items in by_product.items():
            recheck(pid)
            result = shop.mutate(
                SKU_DOC,
                {"productId": pid,
                 "variants": [{"id": j["variant_id"], "inventoryItem": {"sku": j["to"]}} for j in items]},
                "productVariantsBulkUpdate",
            )
            returned = {v["id"]: v["sku"] for v in result["productVariants"]}
            wanted = {j["variant_id"]: j["to"] for j in items}
            for vid, sku in wanted.items():
                current[pid]["variants"][vid]["sku"] = sku
            if returned != wanted:
                # The write happened; record it before stopping so the log says so.
                record(f"skus {current[pid]['title']} ({len(items)}) — RETURNED MISMATCH", result)
                raise RuntimeError(f"productVariantsBulkUpdate {pid}: returned {returned}, wanted {wanted}")
            record(f"skus {current[pid]['title']} ({len(items)})", result)
    except Exception as err:  # any failure: record where it stopped, then stop
        log["stopped"] = f"{type(err).__name__}: {err}"
        save()
        print(f"STOPPED: {err}")
        print(f"Completed steps are logged in {log_path}. Re-run the dry run to plan what is left.")
        sys.exit(1)
    finally:
        shop.armed = False

    # Re-read every product and compare with what was promised: SKUs changed,
    # and nothing else (titles, prices, tracking) moved.
    mismatches = []
    for pid, exp in current.items():
        mismatches += diff(exp, fingerprint(load_product(shop, pid)), exp["title"])
    log["verify"] = {"mismatches": mismatches, "at": datetime.now(timezone.utc).isoformat()}
    save()
    print(f"\nVERIFY: {len(current)} products re-read")
    for m in mismatches:
        print(f"  MISMATCH {m}")
    print("OK — store matches the plan." if not mismatches else "VERIFY FAILED — see above.")
    if mismatches:
        sys.exit(1)


def plan_rollback(shop: Writer, source: dict) -> tuple[list[dict], dict[str, dict], list[str], list[str]]:
    """Inverse jobs from a log's reverse_map, decided per product from LIVE state."""
    by_product: dict[str, list[dict]] = {}
    for m in source["reverse_map"]:
        by_product.setdefault(m["product_id"], []).append(m)
    jobs, before, problems, skipped = [], {}, [], []
    for pid, entries in by_product.items():
        product = load_product(shop, pid)
        live = {v["id"]: v["sku"] for v in product["variants"]["nodes"]}
        state = []
        for m in entries:
            if m["variant_id"] not in live:
                problems.append(f"{m['product_title']} / {m['variant_title']}: variant is gone")
            elif live[m["variant_id"]] == m["from"]:
                state.append("revert")
            elif live[m["variant_id"]] == m["to"]:
                state.append("already")
            else:
                problems.append(f"{m['product_title']} / {m['variant_title']}: SKU is "
                                f"{live[m['variant_id']]!r}, neither {m['from']!r} nor {m['to']!r}")
                state.append("drift")
        kinds = set(state)
        if kinds == {"already"}:
            skipped.append(f"{product['title']}: already at the pre-run SKUs (never written)")
            continue
        if kinds != {"revert"}:
            # A product is written all-or-nothing, so a mix means somebody else
            # edited it since; reverting part of it would be a guess.
            problems.append(f"{product['title']}: mixed state {dict(Counter(state))}; not reverted")
            continue
        before[pid] = product
        for m in entries:
            jobs.append({"product_id": pid, "product_title": product["title"], "variant_id": m["variant_id"],
                         "variant_title": m["variant_title"], "from": m["from"], "to": m["to"]})
    return jobs, before, problems, skipped


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--confirm", action="store_true", help="Actually write to the store")
    parser.add_argument("--plan", default=str(DEFAULT_PLAN))
    parser.add_argument("--rollback", metavar="LOG", help="Plan (and with --confirm, write) the inverse of LOG")
    parser.add_argument("--log", help="Where this run's log goes (never overwritten)")
    args = parser.parse_args()
    log_path = Path(args.log or (DEFAULT_ROLLBACK_LOG if args.rollback else DEFAULT_LOG))

    shop = Writer(load_env())

    if args.rollback:
        source = json.loads(Path(args.rollback).read_text())
        if shop.domain != source["store"]:
            sys.exit(f"Log was written against {source['store']}, this .env points at {shop.domain}")
        if "reverse_map" not in source:
            sys.exit(f"{args.rollback} has no reverse_map; it is not a log from this script")
        problems = check_schema(shop)
        jobs, before, drift, skipped = plan_rollback(shop, source)
        problems += drift
        problems += collisions(jobs, scan_variants(shop))
        header = {"mode": "rollback", "rollback_of": str(args.rollback)}
        DEFAULT_ROLLBACK_PLAN.write_text(json.dumps(
            {"generated_at": datetime.now(timezone.utc).isoformat(), "store": shop.domain, **header,
             "jobs": jobs, "skipped": skipped, "problems": problems}, indent=2, ensure_ascii=False))
        print(f"ROLLBACK of {args.rollback}: {len(jobs)} SKUs across {len({j['product_id'] for j in jobs})} "
              f"products; {len(skipped)} products skipped. Plan: {DEFAULT_ROLLBACK_PLAN}")
        for s in skipped:
            print(f"  skip {s}")
        for j in jobs[:15]:
            print(f"  {j['product_title'][:30]:<30} {j['variant_title']:<16} {j['from']:<10} → {j['to']}")
        if len(jobs) > 15:
            print(f"  … {len(jobs) - 15} more (see the plan file)")
    else:
        plan = json.loads(Path(args.plan).read_text())
        problems = validate_plan(plan)
        if problems:
            sys.exit("Plan is not appliable; fix it in the dry run first:\n  " + "\n  ".join(problems))
        if shop.domain != plan["store"]:
            sys.exit(f"Plan was made against {plan['store']}, this .env points at {shop.domain}")
        problems = check_schema(shop)
        snapshot = {pid: fingerprint(p) for pid, p in plan["snapshot"].items()}
        before = {}
        for pid in snapshot:
            before[pid] = load_product(shop, pid)
            problems += diff(snapshot[pid], fingerprint(before[pid]), before[pid]["title"])
        jobs = [{"product_id": u["product_id"], "product_title": u["product_title"],
                 "variant_id": u["variant_id"], "variant_title": u["variant_title"],
                 "from": u["old"], "to": u["new"]} for u in plan["sku_rewrites"]]
        problems += collisions(jobs, scan_variants(shop))
        header = {"mode": "apply", "plan": str(args.plan), "plan_generated_at": plan["generated_at"]}
        print(f"Plan ({plan['generated_at']}) against {plan['store']}: {len(jobs)} SKU rewrites across "
              f"{len({j['product_id'] for j in jobs})} products; {len(plan['noops'])} no-ops.")

    if problems:
        print("DRIFT — the store no longer matches the plan. Nothing written.")
        for p in problems:
            print(f"  {p}")
        sys.exit(1)
    if not jobs:
        print("Nothing to write.")
        return
    print(f"Still matches the store; schema OK for API {shop.version}; no target SKU is taken store-wide.")
    if not args.confirm:
        if log_path.exists():
            print(f"NOTE: {log_path} exists; --confirm will refuse unless --log names a new path.")
        print("Drift check only. Re-run with --confirm to write.")
        return
    if log_path.exists():
        sys.exit(f"{log_path} exists (an earlier run's rollback source). Pass --log with a new path.")
    # Only the products that get written are logged as `before`.
    written = {j["product_id"] for j in jobs}
    execute(shop, jobs, {pid: p for pid, p in before.items() if pid in written}, log_path, header)


if __name__ == "__main__":
    main()
