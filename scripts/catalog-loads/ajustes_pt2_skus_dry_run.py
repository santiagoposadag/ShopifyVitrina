# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""
Dry run: align the variant SKUs of the 37 products the `ajustes_pt2` price load
touched to the owner's format, and report what a load WOULD change. Read-only
by construction: every GraphQL document is checked and a mutation is refused.

    uv run scripts/catalog-loads/ajustes_pt2_skus_dry_run.py [--xlsx PATH] [--out PATH]

Source: revision_precios_Luminiere_pt2REVISADO.xlsx, sheet "Revisión" (the same
file `ajustes_pt2` applied prices from). Column H is the store SKU, column C is
the owner's SKU. The owner's format has NO hyphen:

    SIN AROMA  <ref><colour>      016-AM    -> 016AM
    CON AROMA  <ref>A<aroma>      062AC-CA  -> 062ACA   (the store ref's trailing
                                                          "C" is dropped)

This load writes the SKU and nothing else: no price, title, option, inventory,
tracking, create or delete. It plans from LIVE state only: a row is resolved by
its store SKU (column H) exactly, store-wide; once applied, column H no longer
exists and the row resolves by its target instead, as a no-op. That is what
makes step 5 of the house procedure (re-run, expect no change) hold.

The decision tables below are specific to this one load (October 2026). Copy
the pair of scripts for a new load rather than editing these. See README.md.

Reads SHOPIFY_* from the repo-root .env (same variables the server uses).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import openpyxl

# scripts/catalog-loads/<this file> -> repo root is three parents up.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# Inputs and outputs are store data, kept under the git-ignored tmp/.
DEFAULT_XLSX = REPO_ROOT / "tmp" / "revision_precios_Luminiere_pt2REVISADO.xlsx"
DEFAULT_PLAN = REPO_ROOT / "tmp" / "ajustes_pt2_skus_plan.json"
SHEET_NAME = "Revisión"
FIRST_DATA_ROW = 3  # rows 1-2 are a two-level header
LAST_DATA_ROW = 755

# --- Decisions (owner + store admin, 2026-10-27) --------------------------------

# The products the price load touched, and the only ones this load may touch.
EXPECTED_PRODUCTS = 37

# Column G holds an instruction instead of a title for these products. The
# price load already renamed them (handles kept), so the store title must be
# the NEW one: the old one would mean the store is not in the post-load state.
POST_LOAD_TITLES = {
    "CAMBIAR VERDE MENTA POR VERDE AGUA": "Vela Color Verde Agua",
    "CAMBIAR POR VERDE LIMON": "Vela Color Verde Limón",
}

# Rule 5: rows the owner marked as "do not create". No store variant, ignored.
SKIP_PRODUCT_CELLS = {"ELIMINAR", "(no existe)"}
OWNER_DELETE = "ELIMINAR"

# Rule 2: Amarillo rows 278-281. The owner's input landed one block off (two
# "ELIMINAR", then 038AM / 039AM against store 031D / 08). Column C is NOT used;
# the target is the store SKU in the owner's format. Each row must still point
# at the store SKU named here, else it is reported and skipped.
REALIGNED_ROWS = {
    278: ("017D-AM", "017DAM"),
    279: ("028D-AM", "028DAM"),
    280: ("031D-AM", "031DAM"),
    281: ("08-AM", "08AM"),
}

# Rules 3 and 4: products the owner's file does not cover (no column C). The
# target follows the pattern every other product of the same kind shows, which
# the dry run proves from the (H -> C) pairs before using it. The code is the
# store's own: Uvas Frescas keeps UV, Verde Oscuro keeps VO.
DERIVED_PRODUCTS = {
    "Vela Aromática Uvas Frescas": {"kind": "CON AROMA", "code": "UV", "rows": range(219, 231)},
    "Vela Color Verde Oscuro2": {"kind": "SIN AROMA", "code": "VO", "rows": range(641, 646)},
}

# Store SKU shapes, one per kind. CON AROMA: <digits>AC-<aroma>[-n]; SIN AROMA:
# <digits>[D]-<colour>[-n]. The two are disjoint ("AC-" vs "-").
STORE_SKU = {
    "CON AROMA": re.compile(r"^(?P<ref>\d{2,3}A)C-(?P<code>[A-Z]{2,3}(?:-\d)?)$"),
    "SIN AROMA": re.compile(r"^(?P<ref>\d{2,3}D?)-(?P<code>[A-Z]{2}(?:-\d)?)$"),
}
# Target shapes, derived from the owner's column C (see the shape report).
TARGET_SKU = {
    "CON AROMA": re.compile(r"^(?P<ref>\d{2,3}A)(?P<code>[A-Z]{2,4})$"),
    "SIN AROMA": re.compile(r"^(?P<ref>\d{2,3}D?)(?P<code>[A-Z]{2})$"),
}
NEW_CODE = {"CON AROMA": re.compile(r"^[A-Z]{2,4}$"), "SIN AROMA": re.compile(r"^[A-Z]{2}$")}


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
        self.version = version
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
      id sku title
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


def money(value) -> str:
    return f"{Decimal(str(value)):.2f}"


def sku_owners(variants: list[dict]) -> dict[str, list[dict]]:
    """Exact SKU -> every variant carrying it, store-wide. Empty SKUs excluded."""
    by_sku: dict[str, list[dict]] = defaultdict(list)
    for v in variants:
        if v["sku"]:
            by_sku[v["sku"]].append(v)
    return by_sku


# --- Spreadsheet ----------------------------------------------------------------


def cell(v) -> str:
    return "" if v is None else str(v).strip()


def read_sheet(xlsx: Path) -> list[dict]:
    ws = openpyxl.load_workbook(xlsx, data_only=True)[SHEET_NAME]
    out = []
    rows = ws.iter_rows(min_row=FIRST_DATA_ROW, max_row=LAST_DATA_ROW, max_col=11, values_only=True)
    for n, raw in enumerate(rows, start=FIRST_DATA_ROW):
        if all(v is None for v in raw):
            continue
        a, b, c, d, _e, _f, g, h, i, _j, k = raw
        out.append(
            {
                "row": n, "tab": cell(a), "ref": cell(b), "file_sku": cell(c), "label": cell(d),
                "product": cell(g), "store_sku": cell(h), "variant": cell(i), "match": cell(k),
            }
        )
    return out


def parse_store_sku(sku: str) -> tuple[str, str, str] | None:
    """(kind, new-format ref, old code) for a store SKU, or None if it fits neither shape."""
    for kind, pattern in STORE_SKU.items():
        m = pattern.match(sku)
        if m:
            return kind, m["ref"], m["code"]
    return None


# --- Rule proofs ----------------------------------------------------------------


def prove_pattern(rows: list[dict]) -> dict:
    """Prove, from every (H -> C) pair the owner gave, that C = <new ref><code>
    with ONE code per product. Rules 3 and 4 borrow that pattern for products
    the owner did not cover, so they are planned only if it holds everywhere."""
    by_kind: dict[str, dict] = {k: {"pairs": 0, "violations": [], "codes": defaultdict(set)}
                                for k in STORE_SKU}
    for r in rows:
        if not r["store_sku"] or not r["file_sku"] or r["file_sku"] == OWNER_DELETE:
            continue
        if r["row"] in REALIGNED_ROWS:
            continue
        parsed = parse_store_sku(r["store_sku"])
        if parsed is None:
            continue  # reported per row
        kind, ref, _old = parsed
        acc = by_kind[kind]
        acc["pairs"] += 1
        c = r["file_sku"]
        if not c.startswith(ref) or not NEW_CODE[kind].match(c[len(ref):]):
            acc["violations"].append({"row": r["row"], "H": r["store_sku"], "C": c})
            continue
        acc["codes"][r["product"]].add(c[len(ref):])
    report = {}
    for kind, acc in by_kind.items():
        mixed = {p: sorted(c) for p, c in acc["codes"].items() if len(c) != 1}
        report[kind] = {
            "pairs": acc["pairs"], "violations": acc["violations"], "mixed_codes": mixed,
            "ok": acc["pairs"] > 0 and not acc["violations"] and not mixed,
        }
    # Verde Oscuro: its own 21 owner-given pairs must keep the store code VO
    # unchanged, which is what deriving the other five from it assumes.
    vo = [r for r in rows if r["product"] == "Vela Color Verde Oscuro2" and r["file_sku"]]
    vo_bad = [{"row": r["row"], "H": r["store_sku"], "C": r["file_sku"]} for r in vo
              if r["file_sku"] != r["store_sku"].replace("-", "")]
    report["verde_oscuro_keeps_code"] = {"pairs": len(vo), "violations": vo_bad,
                                         "ok": bool(vo) and not vo_bad}
    return report


# --- Plan -----------------------------------------------------------------------


def target_for(r: dict, proof: dict) -> tuple[str | None, str | None, str | None]:
    """(rule, target SKU, reason-if-not-planned) for one sheet row with a store SKU."""
    h = r["store_sku"]
    parsed = parse_store_sku(h)
    if parsed is None:
        return None, None, f"store SKU {h!r} fits neither known shape"
    kind, ref, _old = parsed

    if r["row"] in REALIGNED_ROWS:
        expected_h, target = REALIGNED_ROWS[r["row"]]
        if h != expected_h:
            return None, None, f"rule 2: expected store SKU {expected_h}, sheet has {h}"
        return "2-amarillo-realigned", target, None

    derived = DERIVED_PRODUCTS.get(r["product"])
    if derived and not r["file_sku"]:
        if r["row"] not in derived["rows"]:
            return None, None, f"no column C outside the decided rows {derived['rows']}"
        if kind != derived["kind"]:
            return None, None, f"{r['product']} store SKU is {kind}, decision says {derived['kind']}"
        if not proof[kind]["ok"]:
            return None, None, f"{kind} pattern did not prove out; derived rows not planned"
        if kind == "SIN AROMA" and not proof["verde_oscuro_keeps_code"]["ok"]:
            return None, None, "Verde Oscuro's own pairs do not keep VO; derived rows not planned"
        rule = "3-uvas-derived" if kind == "CON AROMA" else "4-verde-oscuro-derived"
        return rule, ref + derived["code"], None

    c = r["file_sku"]
    if not c:
        return None, None, "no owner SKU in column C and no decision covers it"
    if c == OWNER_DELETE:
        return None, None, "column C is ELIMINAR on a variant that exists; no decision covers it"
    # The owner's reference (column B) must name the same size as the store SKU.
    if r["ref"] != ref:
        return None, None, f"sheet ref {r['ref']!r} does not name store ref {ref!r} (from {h})"
    return "1-owner-sku", c, None


def build_plan(rows: list[dict], variants: list[dict], snapshot_of) -> dict:
    by_sku = sku_owners(variants)
    proof = prove_pattern(rows)
    plan: dict = {
        "pattern_proof": proof,
        "products": {},
        "sku_rewrites": [],
        "noops": [],
        "skipped_by_decision": [],
        "anomalies": [],
        "blocked_products": {},
        "uncovered": [],
        "shape_outliers": [],
    }
    anomalies = plan["anomalies"]

    resolved: list[dict] = []  # one entry per sheet row that reached a store variant
    covered: dict[str, int] = {}  # variant id -> sheet row
    products: dict[str, dict] = {}

    for r in rows:
        if not r["store_sku"]:
            if r["product"] in SKIP_PRODUCT_CELLS and r["match"] == "Solo en el archivo":
                plan["skipped_by_decision"].append(
                    {"row": r["row"], "label": r["label"], "file_sku": r["file_sku"], "product": r["product"]}
                )
            else:
                anomalies.append({"row": r["row"], "product_id": None, "sku": "-",
                                  "reason": f"row has no store SKU and is not a skip decision ({r['product']!r})"})
            continue

        rule, target, reason = target_for(r, proof)
        if reason:
            anomalies.append({"row": r["row"], "product_id": None, "sku": r["store_sku"], "reason": reason})
            continue

        # Resolve by EXACT store SKU store-wide; once applied, by the target.
        h = r["store_sku"]
        by_h, by_t = by_sku.get(h, []), by_sku.get(target, [])
        if by_h and by_t:
            anomalies.append({"row": r["row"], "product_id": None, "sku": h,
                              "reason": f"both {h} and its target {target} exist in the store "
                                        f"({len(by_h)} + {len(by_t)} variants)"})
            continue
        owners = by_h or by_t
        if not owners:
            anomalies.append({"row": r["row"], "product_id": None, "sku": h,
                              "reason": f"neither {h} nor {target} found in the store"})
            continue
        if len(owners) > 1:
            anomalies.append(
                {"row": r["row"], "product_id": None, "sku": owners[0]["sku"],
                 "reason": f"SKU on {len(owners)} variants: "
                           + ", ".join(f"{v['product']['title']} / {v['title']}" for v in owners)}
            )
            continue
        v = owners[0]
        p = v["product"]
        expected_title = POST_LOAD_TITLES.get(r["product"], r["product"])
        if p["title"] != expected_title:
            anomalies.append({"row": r["row"], "product_id": p["id"], "sku": v["sku"],
                              "reason": f"product is {p['title']!r}, post-load title is {expected_title!r}"})
            continue
        if v["title"] != r["variant"]:
            anomalies.append({"row": r["row"], "product_id": p["id"], "sku": v["sku"],
                              "reason": f"variant is {v['title']!r}, sheet says {r['variant']!r}"})
            continue
        if v["id"] in covered:
            anomalies.append({"row": r["row"], "product_id": p["id"], "sku": v["sku"],
                              "reason": f"variant already covered by row {covered[v['id']]}"})
            continue
        covered[v["id"]] = r["row"]
        if p["id"] not in products:
            products[p["id"]] = snapshot_of(p["id"])
        kind, ref, old_code = parse_store_sku(h)  # validated in target_for
        resolved.append({
            "row": r["row"], "rule": rule, "kind": kind, "ref": ref, "old_code": old_code,
            "product_id": p["id"], "product_title": p["title"], "handle": p["handle"],
            "variant_id": v["id"], "variant_title": v["title"],
            "sheet_sku": h, "live": v["sku"], "new": target,
        })

    def block(pid: str | None, row, sku: str, reason: str) -> None:
        anomalies.append({"row": row, "product_id": pid, "sku": sku, "reason": reason})

    # Hard check: every target is unique among targets.
    target_count = Counter(e["new"] for e in resolved)
    for e in resolved:
        if target_count[e["new"]] > 1:
            block(e["product_id"], e["row"], e["new"], f"target {e['new']} planned {target_count[e['new']]} times")

    # Hard check: no target equals any SKU in the store other than the
    # variant's own current one (all products, not only these 37).
    for e in resolved:
        others = [v for v in by_sku.get(e["new"], []) if v["id"] != e["variant_id"]]
        if others:
            block(e["product_id"], e["row"], e["new"],
                  "target already used by " + ", ".join(f"{v['product']['title']} / {v['title']}" for v in others))

    # Hard checks: shape, reference, one code per product.
    codes_by_product: dict[str, set] = defaultdict(set)
    for e in resolved:
        m = TARGET_SKU[e["kind"]].match(e["new"])
        # The two formats must stay disjoint: a target readable as BOTH a colour
        # and an aroma SKU would be ambiguous to anyone reading it back.
        fits = [k for k, pattern in TARGET_SKU.items() if pattern.match(e["new"])]
        if len(fits) > 1:
            plan["shape_outliers"].append({"row": e["row"], "sku": e["new"], "kind": "+".join(fits)})
            block(e["product_id"], e["row"], e["new"], f"target fits both shapes {fits}")
            continue
        if not m:
            plan["shape_outliers"].append({"row": e["row"], "sku": e["new"], "kind": e["kind"]})
            block(e["product_id"], e["row"], e["new"], f"target does not fit the {e['kind']} shape")
            continue
        if m["ref"] != e["ref"]:
            block(e["product_id"], e["row"], e["new"],
                  f"target ref {m['ref']} ≠ store ref {e['ref']} (from {e['sheet_sku']})")
            continue
        e["new_code"] = m["code"]
        codes_by_product[e["product_id"]].add(m["code"])
    for pid, codes in codes_by_product.items():
        if len(codes) != 1:
            block(pid, None, "-", f"targets of one product carry {len(codes)} codes: {sorted(codes)}")

    if len(products) != EXPECTED_PRODUCTS:
        block(None, None, "-", f"{len(products)} products resolved, expected {EXPECTED_PRODUCTS}")

    # Coverage: every variant of every touched product exactly once.
    for pid, prod in products.items():
        for v in prod["variants"]["nodes"]:
            if v["id"] not in covered:
                plan["uncovered"].append({"product_id": pid, "product_title": prod["title"],
                                          "variant_id": v["id"], "variant_title": v["title"], "sku": v["sku"]})
                block(pid, None, v["sku"] or "∅", f"variant {v['title']} has no sheet row")

    # The products that a hard check named get NOTHING planned.
    blocked = defaultdict(list)
    for a in anomalies:
        if a["product_id"]:
            blocked[a["product_id"]].append(a["reason"])
    plan["blocked_products"] = {pid: reasons for pid, reasons in blocked.items()}

    snap_skus = {v["id"]: v["sku"] for prod in products.values() for v in prod["variants"]["nodes"]}
    for e in resolved:
        if e["product_id"] in blocked:
            continue
        # The product snapshot is the authority on the live SKU (read after the scan).
        e["old"] = snap_skus.get(e["variant_id"])
        entry = {k: e[k] for k in ("row", "rule", "product_id", "product_title", "variant_id",
                                   "variant_title", "old", "new")}
        entry["old_code"], entry["new_code"] = e["old_code"], e.get("new_code")
        if e["old"] == e["new"]:
            plan["noops"].append(entry)
        elif e["old"] != e["live"]:
            block(e["product_id"], e["row"], e["old"] or "∅",
                  f"SKU moved between the store scan ({e['live']}) and the product read ({e['old']})")
        else:
            plan["sku_rewrites"].append(entry)
    # A block raised in the loop above must also pull that product's rewrites.
    late = {a["product_id"] for a in anomalies if a["product_id"]} - set(blocked)
    if late:
        plan["sku_rewrites"] = [u for u in plan["sku_rewrites"] if u["product_id"] not in late]
        plan["noops"] = [u for u in plan["noops"] if u["product_id"] not in late]
        for a in anomalies:
            if a["product_id"] in late:
                plan["blocked_products"].setdefault(a["product_id"], []).append(a["reason"])

    # Per-product code table (old code -> new code), for a human to eyeball.
    by_product: dict[str, list[dict]] = defaultdict(list)
    for e in resolved:
        by_product[e["product_id"]].append(e)
    for pid, prod in products.items():
        entries = by_product.get(pid, [])
        old_codes = Counter(e["old_code"] for e in entries)
        majority = old_codes.most_common(1)[0][0] if old_codes else None
        plan["products"][pid] = {
            "title": prod["title"], "handle": prod["handle"], "status": prod["status"],
            "kind": entries[0]["kind"] if entries else None,
            "variants": len(prod["variants"]["nodes"]),
            "old_codes": dict(old_codes), "new_codes": sorted(codes_by_product.get(pid, set())),
            "rules": dict(Counter(e["rule"] for e in entries)),
            "odd_old_codes": [{"row": e["row"], "variant_title": e["variant_title"], "old": e["sheet_sku"],
                               "new": e["new"]} for e in entries if e["old_code"] != majority],
            "blocked": pid in plan["blocked_products"],
        }

    # Codes that change meaning: a code that named one set of products before
    # and names a different set after. Checked across BOTH kinds, because a
    # person reads "MZ" the same way whether a ref or a ref+A precedes it.
    old_owner: dict[str, set] = defaultdict(set)
    new_owner: dict[str, set] = defaultdict(set)
    for info in plan["products"].values():
        for code in info["old_codes"]:
            old_owner[code].add(f"{info['title']} [{info['kind']}]")
        for code in info["new_codes"]:
            new_owner[code].add(f"{info['title']} [{info['kind']}]")
    plan["code_meaning_changes"] = [
        {"code": code, "old_meaning": sorted(old_owner[code]), "new_meaning": sorted(new_owner[code])}
        for code in sorted(set(old_owner) & set(new_owner)) if old_owner[code] != new_owner[code]
    ]
    plan["snapshot"] = products
    return plan


# --- Report ---------------------------------------------------------------------


def print_plan(plan: dict, rows_total: int, variants_total: int, products_total: int) -> None:
    print(f"Sheet rows read: {rows_total}   Store: {products_total} products, {variants_total} variants")
    print(f"Products resolved: {len(plan['products'])} (expected {EXPECTED_PRODUCTS})\n")

    print("PATTERN PROOF (owner pairs H -> C, C = <new ref><code>, one code per product):")
    for kind in STORE_SKU:
        pr = plan["pattern_proof"][kind]
        print(f"  {kind}: {'OK' if pr['ok'] else 'FAILED'}  pairs={pr['pairs']} "
              f"violations={len(pr['violations'])} mixed={pr['mixed_codes'] or '-'}")
        for v in pr["violations"]:
            print(f"    row {v['row']}: {v['H']} -> {v['C']}")
    vo = plan["pattern_proof"]["verde_oscuro_keeps_code"]
    print(f"  Verde Oscuro owner pairs keep VO: {'OK' if vo['ok'] else 'FAILED'} pairs={vo['pairs']} "
          f"violations={vo['violations'] or '-'}\n")

    print("CODE TABLE per product (old store code -> new code):")
    for kind in STORE_SKU:
        print(f"  {kind}")
        for info in sorted((i for i in plan["products"].values() if i["kind"] == kind),
                           key=lambda i: i["title"]):
            old = ", ".join(f"{c}×{n}" for c, n in sorted(info["old_codes"].items()))
            new = ", ".join(info["new_codes"]) or "?"
            same = all(c == info["new_codes"][0] for c in info["old_codes"]) if len(info["new_codes"]) == 1 else False
            flag = "" if same else "   ← code changes"
            if info["blocked"]:
                flag += "   BLOCKED"
            print(f"    {info['title'][:38]:<38} {old:<22} → {new:<5}{flag}")
    if plan["code_meaning_changes"]:
        print("\n  ⚠ codes that change MEANING (old code of one product = new code of another):")
        for c in plan["code_meaning_changes"]:
            print(f"    {c['code']}: was {c['old_meaning']}\n      becomes {c['new_meaning']}")

    odd = [(i["title"], o) for i in plan["products"].values() for o in i["odd_old_codes"]]
    print(f"\nODD OLD SUFFIXES (not the product's usual code) — listed for review: {len(odd)}")
    for title, o in odd:
        print(f"  row {o['row']:>3} {title[:28]:<28} {o['variant_title']:<16} {o['old']:<10} → {o['new']}")

    rw = plan["sku_rewrites"]
    by_rule = Counter(u["rule"] for u in rw)
    print(f"\nSKU REWRITES: {len(rw)}  by rule {dict(sorted(by_rule.items()))}")
    by_product = Counter(u["product_title"] for u in rw)
    for title, n in sorted(by_product.items()):
        print(f"  {title[:40]:<40} {n:>3}")
    derived = [u for u in rw + plan["noops"] if u["rule"] != "1-owner-sku"]
    print(f"\n  Derived / realigned rows — eyeball these ({len(derived)}):")
    for u in sorted(derived, key=lambda u: u["row"]):
        print(f"    row {u['row']:>3} {u['rule']:<22} {u['product_title'][:28]:<28} "
              f"{u['variant_title']:<16} {u['old']:<10} → {u['new']}")
    print("\n  Sample of rule-1 rewrites (first per product):")
    seen = set()
    for u in rw:
        if u["rule"] == "1-owner-sku" and u["product_id"] not in seen:
            seen.add(u["product_id"])
            print(f"    row {u['row']:>3} {u['product_title'][:28]:<28} {u['variant_title']:<16} "
                  f"{u['old']:<10} → {u['new']}")

    print(f"\nNO-OPS (live SKU already the target): {len(plan['noops'])}")
    for u in plan["noops"][:20]:
        print(f"  row {u['row']:>3} {u['product_title'][:30]:<30} {u['new']}")
    if len(plan["noops"]) > 20:
        print(f"  … {len(plan['noops']) - 20} more")

    print(f"\nSHAPE OUTLIERS: {len(plan['shape_outliers'])}")
    for o in plan["shape_outliers"]:
        print(f"  row {o['row']} {o['sku']} ({o['kind']})")

    skipped = Counter(s["product"] for s in plan["skipped_by_decision"])
    print(f"\nSKIPPED by decision (never created, rule 5): {len(plan['skipped_by_decision'])} {dict(skipped)}")

    print(f"\nUNCOVERED variants of touched products: {len(plan['uncovered'])}")
    for u in plan["uncovered"]:
        print(f"  {u['product_title'][:30]:<30} {u['variant_title']:<16} {u['sku'] or '∅'}")

    print(f"\nANOMALIES (blocking): {len(plan['anomalies'])}")
    for a in plan["anomalies"]:
        print(f"  row {a['row']}  {a['sku']:<10} {a['reason']}")
    print(f"BLOCKED products (nothing planned): {len(plan['blocked_products'])}")
    for pid, reasons in plan["blocked_products"].items():
        print(f"  {plan['products'].get(pid, {}).get('title', pid)}: {len(reasons)} reason(s)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", default=str(DEFAULT_XLSX))
    parser.add_argument("--out", default=str(DEFAULT_PLAN))
    args = parser.parse_args()

    rows = read_sheet(Path(args.xlsx))
    shop = Shopify(load_env())
    variants = scan_variants(shop)
    products_total = len({v["product"]["id"] for v in variants})

    plan = build_plan(rows, variants, lambda pid: load_product(shop, pid))
    print_plan(plan, len(rows), len(variants), products_total)

    Path(args.out).write_text(
        json.dumps(
            {"generated_at": datetime.now(timezone.utc).isoformat(), "store": shop.domain,
             "api_version": shop.version, "sheet": str(args.xlsx),
             "store_variants": len(variants), "store_products": products_total, **plan},
            indent=2, ensure_ascii=False, default=str,
        )
    )
    print(f"\nPlan written to {args.out}")


if __name__ == "__main__":
    main()
