# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""
Dry run: map the owner-reviewed price sheet (revision_precios_Luminiere_pt2REVISADO.xlsx,
sheet "Revisión") onto the live store and report what a load WOULD change.
Read-only by construction: every GraphQL document is checked and a mutation is
refused.

    uv run scripts/catalog-loads/ajustes_pt2_dry_run.py [--xlsx PATH] [--out PATH]

The decision tables below are specific to this one load (October 2026). Copy
the pair of scripts for a new load rather than editing these: they are the
record of what was decided. See README.md next to this file.

The owner did NOT edit the review's decision columns (M/N/P). Every decision
was expressed by editing the FILE side (A-F) and the product column (G), so the
target price is column F, never column N — except for the groups listed below
whose rows the owner left untouched on purpose.

Reads SHOPIFY_* from the repo-root .env (same variables the server uses).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

import openpyxl

# scripts/catalog-loads/<this file> -> repo root is three parents up.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# Inputs and outputs are store data, kept under the git-ignored tmp/.
DEFAULT_XLSX = REPO_ROOT / "tmp" / "revision_precios_Luminiere_pt2REVISADO.xlsx"
DEFAULT_PLAN = REPO_ROOT / "tmp" / "ajustes_pt2_revisado_plan.json"
SHEET_NAME = "Revisión"
FIRST_DATA_ROW = 3  # rows 1-2 are a two-level header

# --- Decisions (owner + store admin, 2026-10-27) --------------------------------

# Column G holds an instruction instead of a title for these products. The key
# is the instruction, the value is (title the store had when the sheet was
# made, title it must end with). A product already carrying the target title is
# the state this load exists to reach, not a mismatch. Handles are NOT changed:
# a renamed handle breaks every link already shared.
TITLE_INSTRUCTIONS = {
    "CAMBIAR VERDE MENTA POR VERDE AGUA": ("Vela Color Verde Menta2", "Vela Color Verde Agua"),
    "CAMBIAR POR VERDE LIMON": ("Vela Color Verde Claro2", "Vela Color Verde Limón"),
}

# This load writes NO SKU. Verde Claro -> Verde Limón keeps its -VC SKUs for now;
# aligning every SKU to the owner's format is a separate later load
# (ajustes_pt2_skus). Rows are resolved by the store SKU in column H, exactly.

# Rows the owner marked as "do not create" (new colours, and an aroma that does
# not exist). Nothing is created by this load.
SKIP_PRODUCT_CELLS = {"ELIMINAR", "(no existe)"}

# The per-reference price the owner gave EVERY colour that had these sizes
# filled. Verified against the sheet at run time: if any filled colour
# disagrees, the groups below that borrow it are not planned.
UNIFORM_REF_PRICE = {
    "016": Decimal("48200"),
    "017D": Decimal("115300"),
    "028D": Decimal("155000"),
    "031D": Decimal("230300"),
    "08": Decimal("18300"),
}

# Verde Oscuro: the owner left these five rows untouched. They get the uniform
# per-reference price every other colour got.
UNIFORM_PRODUCT = "Vela Color Verde Oscuro2"

# Amarillo rows 278-281: owner input landed one block off (store 017D/028D got
# refs 036/037 with SKU "ELIMINAR"; 031D got ref 038 at 32400; 08 got ref 039 at
# 140500). Column F is NOT used for these four; the uniform price is, keyed by
# the store SKU the row must still point at. No variant is deleted.
REALIGNED_ROWS = {278: "017D-AM", 279: "028D-AM", 280: "031D-AM", 281: "08-AM"}

# Uvas Frescas: not in the owner's file at all, rows untouched. It takes the
# price of the same reference in every other aroma, which the review put in N.
SAME_REF_PRODUCT = "Vela Aromática Uvas Frescas"

# Sanity band for changes the owner did not single out. Outside it the row is
# excluded and listed for a human; rows of the groups below are exempt but are
# printed with their percentage regardless.
GUARD_MIN, GUARD_MAX = Decimal("-5"), Decimal("20")
GUARD_EXEMPT_GROUPS = {"2-shopify-only-filled", "7-verde-oscuro-uniform", "8-amarillo-realigned"}


# --- Shopify (read-only) ------------------------------------------------------


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    path = REPO_ROOT / ".env"
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    env.update({k: v for k, v in os.environ.items() if k.startswith("SHOPIFY_")})
    return env


def _throttled(payload: dict) -> bool:
    return any(
        (e.get("extensions") or {}).get("code") == "THROTTLED" for e in payload.get("errors") or []
    )


class Shopify:
    def __init__(self, env: dict[str, str]):
        domain = env.get("SHOPIFY_STORE_DOMAIN", "")
        if not domain:
            sys.exit("SHOPIFY_STORE_DOMAIN is not set")
        version = env.get("SHOPIFY_API_VERSION") or "2026-01"
        self.domain = domain
        self.endpoint = f"https://{domain}/admin/api/{version}/graphql.json"
        self.token = env.get("SHOPIFY_ADMIN_TOKEN") or self._mint(env)

    def _mint(self, env: dict[str, str]) -> str:
        client_id = env.get("SHOPIFY_CLIENT_ID", "")
        secret = env.get("SHOPIFY_CLIENT_SECRET", "")
        if not client_id or not secret:
            sys.exit("Set SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET")
        body = urllib.parse.urlencode(
            {"grant_type": "client_credentials", "client_id": client_id, "client_secret": secret}
        ).encode()
        req = urllib.request.Request(
            f"https://{self.domain}/admin/oauth/access_token",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.load(res)["access_token"]

    def _post(self, document: str, variables: dict | None) -> dict:
        # THROTTLED is rejected before execution (the cost is computed first),
        # so retrying it can never run a document twice. Nothing else retries.
        for attempt in range(6):
            req = urllib.request.Request(
                self.endpoint,
                data=json.dumps({"query": document, "variables": variables or {}}).encode(),
                headers={"Content-Type": "application/json", "X-Shopify-Access-Token": self.token},
            )
            with urllib.request.urlopen(req, timeout=60) as res:
                payload = json.load(res)
            if _throttled(payload):
                time.sleep(2 ** attempt)
                continue
            if payload.get("errors"):
                raise RuntimeError(f"GraphQL errors: {payload['errors']}")
            return payload["data"]
        raise RuntimeError("Still THROTTLED after 6 attempts")

    def query(self, document: str, variables: dict | None = None) -> dict:
        if "mutation" in document.lower():
            raise RuntimeError("Dry run refuses to send a mutation")
        return self._post(document, variables)


# Every variant in the store. A SKU is only an identifier if it is unique
# store-wide, and Shopify's `sku:` search is not exact, so the whole catalogue
# is read and matched exactly here.
ALL_VARIANTS_QUERY = """
query($cursor: String) {
  productVariants(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id sku title price
      product { id title handle status }
    }
  }
}
"""

PRODUCT_QUERY = """
query($id: ID!) {
  product(id: $id) {
    id handle title status
    variantsCount { count }
    options { id name optionValues { id name } }
    variants(first: 250) {
      nodes {
        id sku title price compareAtPrice
        selectedOptions { name value }
        inventoryItem { id tracked }
      }
    }
  }
}
"""


def scan_variants(shop: Shopify) -> list[dict]:
    out: list[dict] = []
    cursor = None
    while True:
        page = shop.query(ALL_VARIANTS_QUERY, {"cursor": cursor})["productVariants"]
        out.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            return out
        cursor = page["pageInfo"]["endCursor"]


def load_product(shop: Shopify, product_id: str) -> dict:
    product = shop.query(PRODUCT_QUERY, {"id": product_id})["product"]
    if product is None:
        raise RuntimeError(f"{product_id}: product not found")
    if product["variantsCount"]["count"] != len(product["variants"]["nodes"]):
        raise RuntimeError(f"{product['title']}: more variants than one page; extend the query")
    return product


# --- Money ----------------------------------------------------------------------


def to_price(value) -> Decimal | None:
    """A sheet cell as an exact amount. str() first: a float never becomes money."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        amount = Decimal(str(value).strip())
    except InvalidOperation:
        raise ValueError(f"not a price: {value!r}")
    if amount <= 0 or amount != amount.to_integral_value():
        raise ValueError(f"not a whole positive price: {value!r}")
    return amount


def money(value) -> str:
    return f"{Decimal(str(value)):.2f}"


def pct(old: Decimal, new: Decimal) -> Decimal:
    return ((new / old - 1) * 100).quantize(Decimal("0.1"))


# --- Spreadsheet ----------------------------------------------------------------


def cell(v) -> str:
    return "" if v is None else str(v).strip()


def read_sheet(xlsx: Path) -> list[dict]:
    ws = openpyxl.load_workbook(xlsx, data_only=True)[SHEET_NAME]
    out = []
    for n, raw in enumerate(ws.iter_rows(min_row=FIRST_DATA_ROW, max_col=16, values_only=True),
                            start=FIRST_DATA_ROW):
        if all(v is None for v in raw):
            continue
        a, b, c, d, e, f, g, h, i, j, k, _l, m, nn, o, p = raw
        out.append(
            {
                "row": n,
                "tab": cell(a), "ref": cell(b), "file_sku": cell(c), "label": cell(d),
                "size": cell(e), "price_f": f, "product": cell(g), "store_sku": cell(h),
                "variant": cell(i), "price_j": j, "match": cell(k), "decision": cell(m),
                "price_n": nn,
            }
        )
    return out


def store_ref(sku: str) -> str:
    return sku.split("-", 1)[0]


def ref_agrees(sheet_ref: str, sku: str) -> bool:
    """Does the owner's reference name the same size as the store SKU?

    Colour SKUs are <ref>-<colour> ("016-AM" for ref 016); aroma SKUs append a
    "C" ("062AC-CA" for ref 062A). Anything else means the owner's line landed
    on a different variant than the one the row points at.
    """
    head = store_ref(sku)
    return head == sheet_ref or head == sheet_ref + "C"


def verify_uniform(rows: list[dict]) -> tuple[bool, dict]:
    """Every colour that had one of the uniform refs filled must carry its price."""
    seen: dict[str, Counter] = defaultdict(Counter)
    offenders = []
    for r in rows:
        if r["match"] != "Solo en Shopify" or r["row"] in REALIGNED_ROWS:
            continue
        if r["ref"] not in UNIFORM_REF_PRICE or r["price_f"] is None:
            continue
        price = to_price(r["price_f"])
        seen[r["ref"]][str(price)] += 1
        if price != UNIFORM_REF_PRICE[r["ref"]]:
            offenders.append({"row": r["row"], "ref": r["ref"], "price": str(price),
                              "expected": str(UNIFORM_REF_PRICE[r["ref"]])})
    return not offenders, {"observed": {k: dict(v) for k, v in seen.items()}, "offenders": offenders}


def verify_same_ref(rows: list[dict]) -> list[dict]:
    """Uvas Frescas' column N must be the price every other aroma got for that ref."""
    by_ref: dict[str, set] = defaultdict(set)
    for r in rows:
        if r["tab"] == "CON AROMA" and r["match"] == "En ambos" and r["price_f"] is not None:
            by_ref[store_ref(r["store_sku"])].add(to_price(r["price_f"]))
    problems = []
    for r in rows:
        if r["product"] != SAME_REF_PRODUCT:
            continue
        prices = by_ref.get(store_ref(r["store_sku"]), set())
        n = to_price(r["price_n"])
        if prices != {n}:
            problems.append({"row": r["row"], "sku": r["store_sku"], "N": str(n),
                             "other_aromas": sorted(str(x) for x in prices)})
    return problems


# --- Plan -----------------------------------------------------------------------


def classify(r: dict, uniform_ok: bool) -> tuple[str | None, Decimal | None, str | None]:
    """(group, target price, reason-if-not-planned) for one sheet row."""
    if r["match"] == "Solo en el archivo":
        if r["product"] in SKIP_PRODUCT_CELLS:
            return "5-skip-not-created", None, None
        return None, None, f"file-only row with product {r['product']!r}: nothing decided"

    if r["row"] in REALIGNED_ROWS:
        if r["store_sku"] != REALIGNED_ROWS[r["row"]]:
            return None, None, f"expected store SKU {REALIGNED_ROWS[r['row']]}, sheet has {r['store_sku']}"
        if not uniform_ok:
            return None, None, "uniform per-ref prices did not verify; not planned"
        return "8-amarillo-realigned", UNIFORM_REF_PRICE[store_ref(r["store_sku"])], None

    if r["product"] == UNIFORM_PRODUCT and r["match"] == "Solo en Shopify" and r["price_f"] is None:
        ref = store_ref(r["store_sku"])
        if ref not in UNIFORM_REF_PRICE:
            return None, None, f"Verde Oscuro ref {ref} has no uniform price"
        if not uniform_ok:
            return None, None, "uniform per-ref prices did not verify; not planned"
        return "7-verde-oscuro-uniform", UNIFORM_REF_PRICE[ref], None

    if r["product"] == SAME_REF_PRODUCT and r["match"] == "Solo en Shopify" and r["price_f"] is None:
        return "6-uvas-same-ref", to_price(r["price_n"]), None

    target = to_price(r["price_f"])
    if target is None:
        return None, None, f"{r['match']} row with no price in column F: nothing decided"
    if not ref_agrees(r["ref"], r["store_sku"]):
        return None, None, f"sheet ref {r['ref']} does not name store SKU {r['store_sku']}"
    if r["match"] == "En ambos":
        return "1-in-both", target, None
    if r["match"] == "Solo en Shopify":
        return "2-shopify-only-filled", target, None
    return None, None, f"unknown match value {r['match']!r}"


def build_plan(rows: list[dict], variants: list[dict], snapshot_of) -> dict:
    by_sku: dict[str, list[dict]] = defaultdict(list)
    for v in variants:
        if v["sku"]:
            by_sku[v["sku"]].append(v)

    uniform_ok, uniform_report = verify_uniform(rows)
    plan: dict = {
        "uniform_ref_price": {k: str(v) for k, v in UNIFORM_REF_PRICE.items()},
        "uniform_check": {"ok": uniform_ok, **uniform_report},
        "same_ref_check": verify_same_ref(rows),
        "products": {},
        "title_renames": [],
        "price_updates": [],
        "noops": [],
        "excluded_by_guard": [],
        "skipped_by_decision": [],
        "anomalies": [],
        "untouched": [],
        "notes": [],
    }
    if plan["same_ref_check"]:
        for p in plan["same_ref_check"]:
            plan["anomalies"].append({"row": p["row"], "sku": p["sku"],
                                      "reason": f"N={p['N']} but other aromas got {p['other_aromas']}"})

    covered: dict[str, int] = {}  # variant id -> sheet row
    products: dict[str, dict] = {}

    def product(pid: str) -> dict:
        if pid not in products:
            products[pid] = snapshot_of(pid)
        return products[pid]

    for r in rows:
        group, target, reason = classify(r, uniform_ok)
        if group == "5-skip-not-created":
            plan["skipped_by_decision"].append(
                {"row": r["row"], "label": r["label"], "file_sku": r["file_sku"], "product": r["product"]}
            )
            continue
        if reason:
            plan["anomalies"].append({"row": r["row"], "sku": r["store_sku"], "reason": reason})
            continue

        # Resolve the store variant by EXACT SKU across the whole store.
        expected_title, rename_to = r["product"], None
        if r["product"] in TITLE_INSTRUCTIONS:
            expected_title, rename_to = TITLE_INSTRUCTIONS[r["product"]]
        sku = r["store_sku"]
        owners = by_sku.get(sku, [])
        if not owners:
            plan["anomalies"].append({"row": r["row"], "sku": sku, "reason": "SKU not found in the store"})
            continue
        if len(owners) > 1:
            plan["anomalies"].append(
                {"row": r["row"], "sku": sku,
                 "reason": "SKU on " + str(len(owners)) + " variants: "
                           + ", ".join(f"{v['product']['title']} / {v['title']}" for v in owners)}
            )
            continue
        v = owners[0]
        p = v["product"]

        acceptable = {expected_title} | ({rename_to} if rename_to else set())
        if p["title"] not in acceptable:
            plan["anomalies"].append(
                {"row": r["row"], "sku": sku,
                 "reason": f"product is {p['title']!r}, sheet expects {expected_title!r}"}
            )
            continue
        if v["title"] != r["variant"]:
            plan["anomalies"].append(
                {"row": r["row"], "sku": sku,
                 "reason": f"variant is {v['title']!r}, sheet says {r['variant']!r}"}
            )
            continue
        if v["id"] in covered:
            plan["anomalies"].append(
                {"row": r["row"], "sku": sku, "reason": f"variant already covered by row {covered[v['id']]}"}
            )
            continue
        covered[v["id"]] = r["row"]
        product(p["id"])

        if rename_to and p["title"] == expected_title:
            if not any(t["product_id"] == p["id"] for t in plan["title_renames"]):
                plan["title_renames"].append(
                    {"product_id": p["id"], "handle": p["handle"], "from": p["title"], "to": rename_to}
                )
        live = Decimal(v["price"])
        sheet_j = to_price(r["price_j"])
        entry = {
            "row": r["row"], "group": group, "product_id": p["id"], "product_title": p["title"],
            "handle": p["handle"], "status": p["status"], "variant_id": v["id"],
            "variant_title": v["title"], "sku": sku,
            "old": money(live), "new": money(target), "pct": float(pct(live, target)),
            "sheet_J": money(sheet_j) if sheet_j is not None else None,
            "drift_since_review": sheet_j is not None and sheet_j != live,
        }
        if live == target:
            plan["noops"].append(entry)
            continue
        p_change = pct(live, target)
        if group not in GUARD_EXEMPT_GROUPS and not (GUARD_MIN <= p_change <= GUARD_MAX):
            plan["excluded_by_guard"].append(entry)
            continue
        plan["price_updates"].append(entry)

    # A renamed title must not already belong to another product.
    for t in plan["title_renames"]:
        others = {v["product"]["id"] for v in variants
                  if v["product"]["title"] == t["to"] and v["product"]["id"] != t["product_id"]}
        if others:
            plan["anomalies"].append(
                {"row": None, "sku": "-", "reason": f"title {t['to']!r} already used by {sorted(others)}"}
            )

    for pid, prod in products.items():
        plan["products"][pid] = {
            "title": prod["title"], "handle": prod["handle"], "status": prod["status"],
            "variants": len(prod["variants"]["nodes"]),
            "options": {o["name"]: [x["name"] for x in o["optionValues"]] for o in prod["options"]},
        }
        for v in prod["variants"]["nodes"]:
            if v["id"] not in covered:
                plan["untouched"].append(
                    {"product_title": prod["title"], "variant_id": v["id"], "variant_title": v["title"],
                     "sku": v["sku"], "price": money(v["price"])}
                )
            if v["compareAtPrice"] and v["id"] in {u["variant_id"] for u in plan["price_updates"]}:
                plan["notes"].append(
                    f"{prod['title']} / {v['title']}: has compareAtPrice {v['compareAtPrice']} (not changed)"
                )
        for o in prod["options"]:
            for val in o["optionValues"]:
                if any(word in val["name"] for word in ("Menta", "Claro")):
                    plan["notes"].append(
                        f"{prod['title']}: option {o['name']} value {val['name']!r} still names the old colour (out of scope)"
                    )
    plan["snapshot"] = products
    return plan


# --- Report ---------------------------------------------------------------------


def print_plan(plan: dict, rows_total: int) -> None:
    pu = plan["price_updates"]
    by_group = Counter(u["group"] for u in pu)
    print(f"Sheet rows read: {rows_total}")
    print(f"Products touched: {len(plan['products'])}\n")

    uc = plan["uniform_check"]
    print(f"UNIFORM per-ref check: {'OK' if uc['ok'] else 'FAILED'}  observed={uc['observed']}")
    for o in uc["offenders"]:
        print(f"  row {o['row']}: ref {o['ref']} at {o['price']}, expected {o['expected']}")
    print(f"SAME-REF check (Uvas Frescas N vs other aromas): "
          f"{'OK' if not plan['same_ref_check'] else plan['same_ref_check']}\n")

    print(f"TITLE RENAMES (handle kept): {len(plan['title_renames'])}")
    for t in plan["title_renames"]:
        print(f"  {t['from']} → {t['to']}   handle {t['handle']}")
    print("SKU REWRITES: none in this load (moved to ajustes_pt2_skus)")

    print(f"\nPRICE UPDATES: {len(pu)}  by group {dict(sorted(by_group.items()))}")
    exempt = [u for u in pu if u["group"] in GUARD_EXEMPT_GROUPS]
    print(f"\n  Exempt from the guard — eyeball these ({len(exempt)}):")
    for u in exempt:
        flag = "  ← outside band" if not (GUARD_MIN <= Decimal(str(u["pct"])) <= GUARD_MAX) else ""
        print(f"    row {u['row']:>3} {u['group']:<24} {u['product_title'][:28]:<28} {u['sku']:<9} "
              f"{u['old']:>10} → {u['new']:>10}  {u['pct']:+.1f}%{flag}")
    uvas = [u for u in pu if u["group"] == "6-uvas-same-ref"]
    print(f"\n  Uvas Frescas, same-ref price ({len(uvas)}):")
    for u in uvas:
        print(f"    row {u['row']:>3} {u['sku']:<9} {u['old']:>10} → {u['new']:>10}  {u['pct']:+.1f}%")
    pcts = [Decimal(str(u["pct"])) for u in pu if u["group"] == "1-in-both"]
    if pcts:
        print(f"\n  In-both rows: {len(pcts)}, pct range {min(pcts)}%..{max(pcts)}%")

    print(f"\nNO-OPS (live price already the target): {len(plan['noops'])}")
    for u in plan["noops"]:
        print(f"  row {u['row']:>3} {u['product_title'][:30]:<30} {u['sku']:<9} {u['old']}")

    drift = [u for u in pu + plan["noops"] + plan["excluded_by_guard"] if u["drift_since_review"]]
    print(f"\nDRIFT since the 2026-10-15 review (live price ≠ column J): {len(drift)}")
    for u in drift:
        print(f"  row {u['row']:>3} {u['product_title'][:30]:<30} {u['sku']:<9} J={u['sheet_J']} live={u['old']}")

    print(f"\nEXCLUDED by the {GUARD_MIN}%..+{GUARD_MAX}% guard: {len(plan['excluded_by_guard'])}")
    for u in plan["excluded_by_guard"]:
        print(f"  row {u['row']:>3} {u['product_title'][:30]:<30} {u['sku']:<9} {u['old']} → {u['new']} {u['pct']:+.1f}%")

    skipped = Counter(s["product"] for s in plan["skipped_by_decision"])
    print(f"\nSKIPPED by decision (not created): {len(plan['skipped_by_decision'])} {dict(skipped)}")

    print(f"\nANOMALIES (blocking): {len(plan['anomalies'])}")
    for a in plan["anomalies"]:
        print(f"  row {a['row']}  {a['sku']:<9} {a['reason']}")

    print(f"\nUNTOUCHED variants of touched products (no sheet row): {len(plan['untouched'])}")
    for u in plan["untouched"]:
        print(f"  {u['product_title'][:30]:<30} {u['variant_title']:<16} {u['sku'] or '∅':<10} {u['price']}")

    if plan["notes"]:
        print(f"\nNOTES: {len(plan['notes'])}")
        for n in plan["notes"]:
            print(f"  {n}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", default=str(DEFAULT_XLSX))
    parser.add_argument("--out", default=str(DEFAULT_PLAN))
    args = parser.parse_args()

    rows = read_sheet(Path(args.xlsx))
    shop = Shopify(load_env())
    variants = scan_variants(shop)
    print(f"Store variants scanned: {len(variants)}")

    plan = build_plan(rows, variants, lambda pid: load_product(shop, pid))
    print_plan(plan, len(rows))

    Path(args.out).write_text(
        json.dumps(
            {"generated_at": datetime.now(timezone.utc).isoformat(), "store": shop.domain,
             "sheet": str(args.xlsx), **plan},
            indent=2, ensure_ascii=False, default=str,
        )
    )
    print(f"\nPlan written to {args.out}")


if __name__ == "__main__":
    main()
