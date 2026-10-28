# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""
Dry run: catalogue corrections that follow the `ajustes_pt2` loads (titles,
option values, one diameter). Read-only by construction: every GraphQL document
is checked and a mutation is refused.

    uv run scripts/catalog-loads/ajustes_pt2_catalogo_dry_run.py [--out PATH] [--no-reorder]

Decisions (store owner, 2026-10-27):

  A. Drop the trailing "2" glued to a word in "Vela Color" / "Vela Aromática"
     titles ("Vela Color Azul Oscuro2" -> "Vela Color Azul Oscuro"). Handles stay.
  B. "Vela Entorchada Colores": rename three Color values in place (same ids).
  C. "Vela Color *": refs 062 / 063 / 064 are 5 cm wide, not 4,5 cm. Move ONLY
     those three variants to a new "5 cm" Diámetro value; ref 061 (4,5 x 4 cm)
     stays at "4,5 cm". "Vela Aromática *" already say "5 cm" and are untouched.
  D. Nothing else: no price, SKU, create or delete of a product or a variant.

The plan does NOT depend on SKUs. Products are resolved by id / handle, variants
by id + option values, so the separate SKU load (`ajustes_pt2_skus`) landing in
between changes nothing here. SKUs are read for two things only: the ref
cross-check of decision C (which accepts both the old `062-XX` and the new
`062XX` format) and a REPORT of whether the SKU load has landed.

It plans from LIVE state: once applied, nothing matches any more and the re-run
plans no change (step 5 of the house procedure).

The decisions below are specific to this one load. Copy the pair of scripts for
a new load rather than editing these. See README.md.

Reads SHOPIFY_* from the repo-root .env (same variables the server uses).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata
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
DEFAULT_PLAN = REPO_ROOT / "tmp" / "ajustes_pt2_catalogo_plan.json"
DEFAULT_XLSX = REPO_ROOT / "tmp" / "revision_precios_Luminiere_pt2REVISADO.xlsx"
SHEET_NAME = "Revisión"
FIRST_DATA_ROW, LAST_DATA_ROW = 3, 755
# The SKU load that may run around this one. Read for a report and the apply's
# ordering gate, never to plan.
SKUS_PLAN = REPO_ROOT / "tmp" / "ajustes_pt2_skus_plan.json"

# --- Decisions (store owner, 2026-10-27) ----------------------------------------

# A. A "2" glued to the last word, no space before it, nothing else after it.
TRAILING_TWO = re.compile(r"^(?P<base>.*[^\d\s])2$")
TITLE_FAMILIES = ("Vela Color ", "Vela Aromática ")
# A match outside the two families is listed, never planned by the pattern. A
# human who decides it IS the same artefact names it here: product id -> title.
APPROVED_OUTSIDE_FAMILY: dict[str, str] = {}

# B.
ENTORCHADA_HANDLE = "vela-entorchada-verde-claro"
ENTORCHADA_OPTION = "Color"
ENTORCHADA_RENAMES = {"Verde Claro": "Verde Agua", "Morada": "Morado", "Azul caro": "Azul Claro"}

# C.
DIAMETER_FAMILY = "Vela Color "
# 16 colours; with the 21 aromatic products they are the 37 `ajustes_pt2` touched.
EXPECTED_DIAMETER_PRODUCTS = 16
DIAMETER, HEIGHT = "Diámetro", "Altura"
FROM_DIAMETER, TO_DIAMETER = "4,5 cm", "5 cm"
# Altura of each moved variant -> the reference its SKU must carry.
MOVED = {"8 cm": "062", "10 cm": "063", "15 cm": "064"}
KEPT = {"4 cm": "061"}  # stays at 4,5 cm
# Both SKU formats, so the SKU load landing does not change the cross-check.
OLD_COLOUR_SKU = re.compile(r"^(?P<ref>\d{2,3}D?)-[A-Z]{2}(?:-\d)?$")
NEW_COLOUR_SKU = re.compile(r"^(?P<ref>\d{2,3}D?)[A-Z]{2}$")
SKIP_PRODUCT_CELLS = {"ELIMINAR", "(no existe)"}
SHEET_MEASURE = re.compile(r"^\s*(?P<d>[\d.,]+)\s*[*xX×]\s*(?P<h>[\d.,]+)\s*cm\s*$", re.IGNORECASE)


# --- Shopify (read-only) --------------------------------------------------------


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


ALL_PRODUCTS_QUERY = """
query($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle status }
  }
}
"""

ALL_VARIANTS_QUERY = """
query($cursor: String) {
  productVariants(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id sku product { id } }
  }
}
"""

# `sku` is read for the ref cross-check and the record only; fingerprint()
# leaves it out, so a SKU rewrite in between is never drift for this load.
PRODUCT_QUERY = """
query($id: ID!) {
  product(id: $id) {
    id handle title status
    variantsCount { count }
    options { id name position optionValues { id name hasVariants } }
    variants(first: 250) {
      nodes {
        id title position sku price compareAtPrice
        selectedOptions { name value }
      }
    }
  }
}
"""


def paged(shop: Shopify, document: str, root: str) -> list[dict]:
    out: list[dict] = []
    cursor = None
    while True:
        page = shop.query(document, {"cursor": cursor})[root]
        out.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            return out
        cursor = page["pageInfo"]["endCursor"]


def scan_products(shop: Shopify) -> list[dict]:
    return paged(shop, ALL_PRODUCTS_QUERY, "products")


def scan_variants(shop: Shopify) -> list[dict]:
    return paged(shop, ALL_VARIANTS_QUERY, "productVariants")


def load_product(shop: Shopify, product_id: str) -> dict:
    product = shop.query(PRODUCT_QUERY, {"id": product_id})["product"]
    if product is None:
        raise RuntimeError(f"{product_id}: product not found")
    if product["variantsCount"]["count"] != len(product["variants"]["nodes"]):
        raise RuntimeError(f"{product['title']}: more variants than one page; extend the query")
    return product


def money(value) -> str | None:
    return None if value is None else f"{Decimal(str(value)):.2f}"


def norm(text: str) -> str:
    """Accent-, case- and spacing-insensitive form, for collision checks only."""
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return " ".join(stripped.casefold().split())


# --- Fingerprint: what this load writes or depends on ---------------------------


def fingerprint(product: dict) -> dict:
    """Title, handle, options with their ORDERED values and value ids, and every
    variant's title, position, options and price. NO SKU: the SKU load may land
    at any moment and must not read as drift here. Price is not written either;
    it is compared so a side effect would show up in the verify."""
    options = sorted(product["options"], key=lambda o: o["position"])
    return {
        "title": product["title"],
        "handle": product["handle"],
        "options": [
            {"id": o["id"], "name": o["name"],
             "values": [v["name"] for v in o["optionValues"]],
             "value_ids": {v["name"]: v["id"] for v in o["optionValues"]}}
            for o in options
        ],
        "variants": {
            v["id"]: {"title": v["title"], "position": v["position"],
                      "options": {s["name"]: s["value"] for s in v["selectedOptions"]},
                      "price": money(v["price"]), "compareAtPrice": money(v["compareAtPrice"])}
            for v in product["variants"]["nodes"]
        },
    }


def option_of(fp: dict, name: str) -> dict | None:
    return next((o for o in fp["options"] if o["name"] == name), None)


def option_by_id(fp: dict, option_id: str) -> dict:
    o = next((o for o in fp["options"] if o["id"] == option_id), None)
    if o is None:
        raise RuntimeError(f"option {option_id} is gone")
    return o


def variant_order(fp: dict) -> list[str]:
    return [vid for vid, _ in sorted(fp["variants"].items(), key=lambda kv: kv[1]["position"])]


def variant_title(fp: dict, options: dict[str, str]) -> str:
    return " / ".join(options[o["name"]] for o in fp["options"])


def simulate(fp: dict, op: dict) -> tuple[dict, dict]:
    """The state `op` must leave behind, plus what Shopify decides on its own
    (flags): where an added value lands, where a value no variant uses lands
    after a move, and variant positions after a value reorder. Used for every
    step's verify and for the plan's expected end state."""
    out = json.loads(json.dumps(fp))
    flags: dict = {}
    kind = op["op"]
    if kind == "title":
        out["title"] = op["to"]
    elif kind == "rename_values":
        o = option_by_id(out, op["option_id"])
        for r in op["renames"]:
            o["values"] = [r["to"] if v == r["from"] else v for v in o["values"]]
            o["value_ids"][r["to"]] = o["value_ids"].pop(r["from"])
            for v in out["variants"].values():
                if v["options"].get(o["name"]) == r["from"]:
                    v["options"][o["name"]] = r["to"]
    elif kind == "add_value":
        o = option_by_id(out, op["option_id"])
        o["values"].append(op["name"])
        o["value_ids"][op["name"]] = None  # Shopify mints the id
        flags["free_values"] = [(op["option_id"], op["name"])]
    elif kind == "move_variants":
        o = option_by_id(out, op["option_id"])
        for m in op["variants"]:
            out["variants"][m["variant_id"]]["options"][o["name"]] = m["to"]
        # Observed live (2026-10-27, Vela Color Azul Oscuro): moving variants
        # onto a value re-flows EVERY option's value order from variant
        # positions — "5 cm", appended last by the add, landed right after
        # "4,5 cm" because its first variant sits right after 061. That is the
        # primary expectation. The pre-move order is accepted as the one
        # alternative: the conditional reorder that follows fixes it, and the
        # final verify is strict either way.
        flags["alternative"] = json.loads(json.dumps(out))
        flags["free_values"] = reflow_values(out)
    elif kind == "delete_value":
        o = option_by_id(out, op["option_id"])
        o["values"] = [v for v in o["values"] if v != op["name"]]
        o["value_ids"].pop(op["name"], None)
    elif kind == "reorder_values":
        for want in op["options"]:
            option_by_id(out, want["id"])["values"] = list(want["values"])
        flags["positions_free"] = True  # Shopify recomputes them from the new order
    elif kind == "restore_positions":
        for n, vid in enumerate(op["order"], start=1):
            out["variants"][vid]["position"] = n
    else:
        raise RuntimeError(f"unknown op {kind}")
    for state in (out, flags.get("alternative")):
        for v in (state or {}).get("variants", {}).values():
            v["title"] = variant_title(state, v["options"])
    return out, flags


def reflow_values(fp: dict) -> list[tuple[str, str]]:
    """Re-order each option's values the way Shopify does after a variant
    move: values in order of their first variant by position. Returns the
    values no variant uses — where Shopify puts those is not observed, so the
    verify leaves their place free (they keep their relative order, last)."""
    by_position = sorted(fp["variants"].values(), key=lambda v: v["position"])
    unused = []
    for o in fp["options"]:
        used: list[str] = []
        for v in by_position:
            value = v["options"][o["name"]]
            if value not in used:
                used.append(value)
        rest = [v for v in o["values"] if v not in used]
        o["values"] = used + rest
        unused += [(o["id"], v) for v in rest]
    return unused


def compare(expected: dict, live: dict, label: str, flags: dict | None = None) -> list[str]:
    """Differences between an expected and a live fingerprint. A value id of
    None in `expected` means "any id" (a value this load created)."""
    flags = flags or {}
    out = []
    for key in ("title", "handle"):
        if expected[key] != live[key]:
            out.append(f"{label}: {key} is {live[key]!r}, expected {expected[key]!r}")
    if [o["id"] for o in expected["options"]] != [o["id"] for o in live["options"]]:
        out.append(f"{label}: options are {[o['name'] for o in live['options']]}, "
                   f"expected {[o['name'] for o in expected['options']]}")
        return out
    free = flags.get("free_values") or []
    for eo, lo in zip(expected["options"], live["options"]):
        if eo["name"] != lo["name"]:
            out.append(f"{label}: option {eo['id']} is named {lo['name']!r}, expected {eo['name']!r}")
        ev, lv = list(eo["values"]), list(lo["values"])
        # A free value must exist; only its place in the order is not checked.
        for name in {n for oid, n in free if oid == eo["id"]}:
            if name in ev and name not in lv:
                out.append(f"{label} / {eo['name']}: value {name!r} is missing")
            ev = [v for v in ev if v != name]
            lv = [v for v in lv if v != name]
        if ev != lv:
            out.append(f"{label} / {eo['name']}: values are {lo['values']}, expected {eo['values']}")
        for name, vid in eo["value_ids"].items():
            if vid is not None and lo["value_ids"].get(name) != vid:
                out.append(f"{label} / {eo['name']} / {name}: id is {lo['value_ids'].get(name)}, expected {vid}")
    ev, lv = expected["variants"], live["variants"]
    for vid in sorted(set(ev) | set(lv)):
        if vid not in lv:
            out.append(f"{label}: variant {ev[vid]['title']} is gone")
            continue
        if vid not in ev:
            out.append(f"{label}: new variant {lv[vid]['title']} appeared")
            continue
        e, l = dict(ev[vid]), dict(lv[vid])
        if flags.get("positions_free"):
            e.pop("position"), l.pop("position")
        if e != l:
            out.append(f"{label} / {ev[vid]['title']}: is {l}, expected {e}")
    return out


# --- SKU-load status (report and ordering gate; never used to plan) ------------


def skus_load_status(variants: list[dict]) -> dict:
    """Whether `ajustes_pt2_skus` has landed: each of its planned rewrites is
    compared with the live SKU of the same variant id."""
    if not SKUS_PLAN.exists():
        return {"state": "unknown", "detail": f"{SKUS_PLAN} not found"}
    plan = json.loads(SKUS_PLAN.read_text())
    live = {v["id"]: v["sku"] for v in variants}
    counts = Counter()
    for u in plan.get("sku_rewrites", []):
        sku = live.get(u["variant_id"], "<gone>")
        counts["at_target" if sku == u["new"] else "at_old" if sku == u["old"] else "other"] += 1
    total = sum(counts.values())
    if total == 0:
        state = "unknown"
    elif counts["at_target"] == total:
        state = "landed"
    elif counts["at_old"] == total:
        state = "not_landed"
    else:
        state = "partial"
    return {"state": state, "rewrites_in_plan": total, **counts,
            "plan_generated_at": plan.get("generated_at")}


# --- Spreadsheet (report only: Altura of refs 062 / 063 / 064) -------------------


def cm(text: str) -> str:
    return f"{text.replace('.', ',')} cm"


def altura_report(xlsx: Path) -> dict:
    if not xlsx.exists():
        return {"sheet": str(xlsx), "error": "not found", "by_ref": {}, "discrepancies": []}
    ws = openpyxl.load_workbook(xlsx, data_only=True)[SHEET_NAME]
    store = {**{ref: (TO_DIAMETER, h) for h, ref in MOVED.items()},
             **{ref: (FROM_DIAMETER, h) for h, ref in KEPT.items()}}
    by_ref: dict[str, Counter] = defaultdict(Counter)
    skipped: Counter = Counter()
    discrepancies = []
    rows = ws.iter_rows(min_row=FIRST_DATA_ROW, max_row=LAST_DATA_ROW, max_col=7, values_only=True)
    for n, raw in enumerate(rows, start=FIRST_DATA_ROW):
        tab, ref, _c, label, measure, _f, product = raw
        ref = "" if ref is None else str(ref).strip()
        if str(tab or "").strip() != "SIN AROMA" or ref not in store:
            continue
        # Colours the owner marked as never created have no store variant.
        if str(product or "").strip() in SKIP_PRODUCT_CELLS:
            skipped[ref] += 1
            continue
        text = "" if measure is None else str(measure).strip()
        by_ref[ref][text or "∅"] += 1
        m = SHEET_MEASURE.match(text)
        want_d, want_h = store[ref]
        if not m:
            discrepancies.append({"row": n, "ref": ref, "product": product, "sheet": text or "∅",
                                  "store": f"{want_d} / {want_h}", "issue": "unreadable measure"})
            continue
        d, h = cm(m["d"]), cm(m["h"])
        issues = []
        if d != want_d:
            issues.append(f"diameter {d} vs {want_d}")
        if h != want_h:
            issues.append(f"height {h} vs {want_h}")
        if issues:
            discrepancies.append({"row": n, "ref": ref, "product": product, "sheet": text,
                                  "store": f"{want_d} / {want_h}", "issue": "; ".join(issues)})
    return {"sheet": str(xlsx), "by_ref": {r: dict(c) for r, c in sorted(by_ref.items())},
            "skipped_never_created": dict(skipped), "discrepancies": discrepancies}


# --- Plan -----------------------------------------------------------------------


def sku_ref(sku: str | None) -> str | None:
    if not sku:
        return None
    m = OLD_COLOUR_SKU.match(sku) or NEW_COLOUR_SKU.match(sku)
    return m["ref"] if m else None


def plan_titles(products: list[dict], plan: dict) -> dict[str, dict]:
    """Decision A. Returns product id -> title op."""
    ops: dict[str, dict] = {}
    for p in sorted(products, key=lambda p: p["title"]):
        if not p["title"].endswith("2"):
            continue
        m = TRAILING_TWO.match(p["title"])
        in_family = p["title"].startswith(TITLE_FAMILIES)
        entry = {"product_id": p["id"], "handle": p["handle"], "status": p["status"],
                 "from": p["title"], "to": m["base"] if m else None, "in_family": in_family}
        if not m:
            entry["result"] = "not the artefact (space or digit before the 2)"
        elif not in_family and p["id"] not in APPROVED_OUTSIDE_FAMILY:
            entry["result"] = "OUTSIDE FAMILY - listed, not planned"
        else:
            if not in_family:
                entry["to"] = APPROVED_OUTSIDE_FAMILY[p["id"]]
            entry["result"] = "planned"
            ops[p["id"]] = {"op": "title", "from": p["title"], "to": entry["to"], "handle": p["handle"]}
        plan["title_candidates"].append(entry)

    # Collision: a target title already carried by ANOTHER product, or planned
    # twice, compared accent- and case-insensitively against the post-load set.
    after = {p["id"]: ops[p["id"]]["to"] if p["id"] in ops else p["title"] for p in products}
    owners: dict[str, list[str]] = defaultdict(list)
    for pid, title in after.items():
        owners[norm(title)].append(pid)
    by_id = {p["id"]: p for p in products}
    for pid, op in list(ops.items()):
        clash = [q for q in owners[norm(op["to"])] if q != pid]
        if clash:
            reason = (f"title {op['to']!r} collides with "
                      + ", ".join(f"{by_id[q]['title']!r} ({by_id[q]['handle']})" for q in clash))
            plan["anomalies"].append({"product_id": pid, "decision": "A", "reason": reason})
            for c in plan["title_candidates"]:
                if c["product_id"] == pid:
                    c["result"] = "BLOCKED - " + reason
            del ops[pid]
    plan["title_renames"] = [{"product_id": pid, "handle": op["handle"], "from": op["from"], "to": op["to"]}
                             for pid, op in ops.items()]
    plan["title_renames_outside_family"] = [c for c in plan["title_candidates"]
                                            if not c["in_family"] and c["to"]]
    return ops


def plan_entorchada(product: dict | None, plan: dict) -> dict | None:
    """Decision B. Returns the rename op, or None."""
    if product is None:
        plan["anomalies"].append({"product_id": None, "decision": "B",
                                  "reason": f"no product with handle {ENTORCHADA_HANDLE}"})
        return None
    fp = fingerprint(product)
    option = option_of(fp, ENTORCHADA_OPTION)
    if option is None:
        plan["anomalies"].append({"product_id": product["id"], "decision": "B",
                                  "reason": f"no option {ENTORCHADA_OPTION!r}"})
        return None
    renames, report = [], []
    for old, new in ENTORCHADA_RENAMES.items():
        has_old = old in option["values"]
        # Any OTHER value that reads like the target blocks it.
        clash = [v for v in option["values"] if norm(v) == norm(new) and v != old]
        if has_old and clash:
            reason = f"{old!r} -> {new!r}: {clash} already in {ENTORCHADA_OPTION}"
            plan["anomalies"].append({"product_id": product["id"], "decision": "B", "reason": reason})
            report.append({"from": old, "to": new, "result": "BLOCKED"})
        elif has_old:
            renames.append({"value_id": option["value_ids"][old], "from": old, "to": new})
            report.append({"from": old, "to": new, "result": "planned"})
        elif new in option["values"]:
            report.append({"from": old, "to": new, "result": "no-op (already renamed)"})
        else:
            plan["anomalies"].append({"product_id": product["id"], "decision": "B",
                                      "reason": f"neither {old!r} nor {new!r} in {option['values']}"})
            report.append({"from": old, "to": new, "result": "BLOCKED"})
    # The renamed set itself must stay distinct.
    final = [next((r["to"] for r in renames if r["from"] == v), v) for v in option["values"]]
    dupes = [v for v, n in Counter(norm(v) for v in final).items() if n > 1]
    if dupes:
        plan["anomalies"].append({"product_id": product["id"], "decision": "B",
                                  "reason": f"values would collide after renaming: {dupes}"})
    plan["entorchada"] = {"product_id": product["id"], "title": product["title"],
                          "handle": product["handle"], "option_id": option["id"],
                          "values_before": option["values"], "values_after": final, "renames": report}
    if not renames:
        return None
    return {"op": "rename_values", "option_id": option["id"], "renames": renames}


def plan_diameter(product: dict, plan: dict, reorder: bool) -> list[dict]:
    """Decision C for one "Vela Color" product. Returns its ops."""
    pid = product["id"]
    fp = fingerprint(product)

    def anomaly(reason: str) -> list[dict]:
        plan["anomalies"].append({"product_id": pid, "decision": "C", "reason": reason})
        return []

    diam, height = option_of(fp, DIAMETER), option_of(fp, HEIGHT)
    if diam is None or height is None or len(fp["options"]) != 2:
        return anomaly(f"options are {[o['name'] for o in fp['options']]}, expected [{DIAMETER}, {HEIGHT}]")

    variants = product["variants"]["nodes"]
    opts = {v["id"]: fp["variants"][v["id"]]["options"] for v in variants}
    at = defaultdict(list)  # (diameter, height) -> variant ids
    for vid, o in opts.items():
        at[(o[DIAMETER], o[HEIGHT])].append(vid)
    for combo, vids in at.items():
        if len(vids) > 1:
            return anomaly(f"{len(vids)} variants share {combo}")

    # Identify by option values, then cross-check against the SKU reference.
    by_option = {vid: MOVED[o[HEIGHT]] for vid, o in opts.items()
                 if o[DIAMETER] == FROM_DIAMETER and o[HEIGHT] in MOVED}
    done = {vid: MOVED[o[HEIGHT]] for vid, o in opts.items()
            if o[DIAMETER] == TO_DIAMETER and o[HEIGHT] in MOVED}
    by_sku = {v["id"]: sku_ref(v["sku"]) for v in variants if sku_ref(v["sku"]) in MOVED.values()}
    problems = []
    for vid, ref in {**by_option, **done}.items():
        got = sku_ref(next(v["sku"] for v in variants if v["id"] == vid))
        if got != ref:
            problems.append(f"{fp['variants'][vid]['title']}: SKU ref is {got!r}, expected {ref}")
    for vid, ref in by_sku.items():
        if vid not in by_option and vid not in done:
            problems.append(f"{fp['variants'][vid]['title']}: SKU ref {ref} sits at "
                            f"{opts[vid][DIAMETER]} / {opts[vid][HEIGHT]}")
    kept = [vid for vid, o in opts.items() if o[DIAMETER] == FROM_DIAMETER and o[HEIGHT] in KEPT]
    for vid in kept:
        got = sku_ref(next(v["sku"] for v in variants if v["id"] == vid))
        if got != KEPT[opts[vid][HEIGHT]]:
            problems.append(f"{fp['variants'][vid]['title']}: SKU ref is {got!r}, expected "
                            f"{KEPT[opts[vid][HEIGHT]]} (stays at {FROM_DIAMETER})")
    if problems:
        return anomaly("option values and SKU refs disagree: " + "; ".join(problems))
    if by_option and done:
        return anomaly(f"partly moved: {len(by_option)} still at {FROM_DIAMETER}, {len(done)} at {TO_DIAMETER}")
    if by_option and len(by_option) != len(MOVED):
        return anomaly(f"{len(by_option)} of {len(MOVED)} refs at {FROM_DIAMETER} / {sorted(MOVED)}")
    if not kept:
        plan["notes"].append(f"{product['title']}: no {FROM_DIAMETER} / 4 cm variant; "
                             f"{FROM_DIAMETER} would be left unused")
    for h in MOVED:
        if (TO_DIAMETER, h) in at and by_option:
            return anomaly(f"{TO_DIAMETER} / {h} already exists")

    ops: list[dict] = []
    if by_option:
        if TO_DIAMETER not in diam["values"]:
            ops.append({"op": "add_value", "option_id": diam["id"], "name": TO_DIAMETER})
        moves = []
        for vid in sorted(by_option, key=lambda v: fp["variants"][v]["position"]):
            o = opts[vid]
            moves.append({"variant_id": vid, "ref": by_option[vid], "variant_title": fp["variants"][vid]["title"],
                          "from": FROM_DIAMETER, "to": TO_DIAMETER, "height": o[HEIGHT],
                          "height_value_id": height["value_ids"][o[HEIGHT]]})
        ops.append({"op": "move_variants", "option_id": diam["id"], "height_option_id": height["id"],
                    "variants": moves})
        plan["diameter_moves"].append({"product_id": pid, "title": product["title"],
                                       "moves": [{k: m[k] for k in ("ref", "variant_title", "from", "to")}
                                                 for m in moves]})
    elif done:
        plan["noops"].append(f"{product['title']}: {len(done)} refs already at {TO_DIAMETER}")

    if reorder and (by_option or done):
        # "5 cm" right after "4,5 cm"; every other value keeps its place, and
        # Altura is sent unchanged (productOptionsReorder takes all options).
        current = [v for v in diam["values"] if v != TO_DIAMETER]
        if FROM_DIAMETER not in current:
            return anomaly(f"{FROM_DIAMETER} missing from {DIAMETER}; cannot place {TO_DIAMETER}")
        i = current.index(FROM_DIAMETER) + 1
        target = current[:i] + [TO_DIAMETER] + current[i:]
        if diam["values"] != target:
            ops.append({"op": "reorder_values", "options": [
                {"id": diam["id"], "name": DIAMETER, "values": target},
                {"id": height["id"], "name": HEIGHT, "values": list(height["values"])},
            ]})
            # Both run ONLY if needed (the apply checks live state first): the
            # move's own re-flow normally lands on this order already. If the
            # reorder does run, it recomputes every variant's position, so the
            # restore puts them back.
            ops.append({"op": "restore_positions", "order": variant_order(fp)})
            plan["reorders"].append({"product_id": pid, "title": product["title"],
                                     "from": diam["values"], "to": target,
                                     "reflow_reaches_target": reflow_reaches_target(fp, ops),
                                     "positions_shifted_if_reorder_runs": predicted_shift(fp, ops)})
    return ops


def reflow_reaches_target(fp: dict, ops: list[dict]) -> bool:
    """Whether the state after the move (re-flow included) already has the
    reorder's target order, i.e. the apply is expected to skip the reorder."""
    state = fp
    for op in ops:
        if op["op"] == "reorder_values":
            return all(option_by_id(state, o["id"])["values"] == o["values"] for o in op["options"])
        state, _ = simulate(state, op)
    return True


def predicted_shift(fp: dict, ops: list[dict]) -> int:
    """How many variants productOptionsReorder would move (documented rule:
    variants sorted by option-value order), i.e. what restore_positions undoes."""
    state = fp
    for op in ops:
        if op["op"] == "reorder_values":
            break
        state, _ = simulate(state, op)
    reorder = next(op for op in ops if op["op"] == "reorder_values")
    rank = {o["name"]: {v: i for i, v in enumerate(o["values"])} for o in reorder["options"]}
    names = [o["name"] for o in reorder["options"]]
    sorted_ids = sorted(state["variants"], key=lambda vid: tuple(
        rank[n].get(state["variants"][vid]["options"][n], 999) for n in names))
    return sum(1 for a, b in zip(variant_order(state), sorted_ids) if a != b)


def expected_after(fp: dict, ops: list[dict]) -> dict:
    state = fp
    for op in ops:
        state, _ = simulate(state, op)
    return state


def build_plan(shop: Shopify, reorder: bool) -> dict:
    products = scan_products(shop)
    variants = scan_variants(shop)
    plan: dict = {
        "reorder_diameter_values": reorder,
        "title_candidates": [], "title_renames": [], "title_renames_outside_family": [],
        "entorchada": None, "diameter_moves": [], "reorders": [], "noops": [], "notes": [],
        "anomalies": [], "blocked_products": {}, "products": {}, "snapshot": {},
    }
    ops_by_product: dict[str, list[dict]] = defaultdict(list)
    full: dict[str, dict] = {}

    def read(pid: str) -> dict:
        if pid not in full:
            full[pid] = load_product(shop, pid)
        return full[pid]

    for pid, op in plan_titles(products, plan).items():
        ops_by_product[pid].append(op)

    entorchada = [p for p in products if p["handle"] == ENTORCHADA_HANDLE]
    op = plan_entorchada(read(entorchada[0]["id"]) if entorchada else None, plan)
    if op:
        ops_by_product[entorchada[0]["id"]].append(op)

    family = [p for p in products if p["title"].startswith(DIAMETER_FAMILY)]
    if len(family) != EXPECTED_DIAMETER_PRODUCTS:
        plan["anomalies"].append({"product_id": None, "decision": "C",
                                  "reason": f"{len(family)} '{DIAMETER_FAMILY}*' products, "
                                            f"expected {EXPECTED_DIAMETER_PRODUCTS}"})
    for p in sorted(family, key=lambda p: p["title"]):
        ops_by_product[p["id"]].extend(plan_diameter(read(p["id"]), plan, reorder))

    # A product a check named gets NOTHING planned (and the apply refuses any
    # plan that carries an anomaly at all).
    for a in plan["anomalies"]:
        if a["product_id"]:
            plan["blocked_products"].setdefault(a["product_id"], []).append(f"{a['decision']}: {a['reason']}")

    for pid, ops in ops_by_product.items():
        if not ops or pid in plan["blocked_products"]:
            continue
        product = read(pid)
        # Apply order inside a product: title, value renames, value add, moves,
        # then the ordering steps.
        rank = ["title", "rename_values", "add_value", "move_variants", "reorder_values", "restore_positions"]
        ops = sorted(ops, key=lambda o: rank.index(o["op"]))
        fp = fingerprint(product)
        plan["products"][pid] = {"title": product["title"], "handle": product["handle"],
                                 "ops": ops, "expected_after": expected_after(fp, ops)}
        plan["snapshot"][pid] = product

    plan["skus_load"] = skus_load_status(variants)
    plan["store_products"], plan["store_variants"] = len(products), len(variants)
    return plan


# --- Report ---------------------------------------------------------------------


def print_plan(plan: dict, alt: dict) -> None:
    print(f"Store: {plan['store_products']} products, {plan['store_variants']} variants\n")

    print(f"A. TITLE CANDIDATES (every title ending in '2'): {len(plan['title_candidates'])}")
    for c in plan["title_candidates"]:
        fam = "" if c["in_family"] else "  [outside family]"
        print(f"  {c['from']!r:<34} -> {c['to']!r:<32} {c['result']}{fam}")
        print(f"      handle {c['handle']} (kept), {c['status']}")
    print(f"  planned: {len(plan['title_renames'])}; outside family listed: "
          f"{len(plan['title_renames_outside_family'])}\n")

    e = plan["entorchada"]
    print("B. VELA ENTORCHADA (option value renames, same ids):")
    if e:
        print(f"  {e['title']} ({e['handle']}) {ENTORCHADA_OPTION}: {e['values_before']} -> {e['values_after']}")
        for r in e["renames"]:
            print(f"    {r['from']!r} -> {r['to']!r}: {r['result']}")
    print()

    print(f"C. DIAMETER MOVES ({FROM_DIAMETER} -> {TO_DIAMETER}, refs {sorted(MOVED.values())}): "
          f"{sum(len(d['moves']) for d in plan['diameter_moves'])} variants in "
          f"{len(plan['diameter_moves'])} products")
    for d in plan["diameter_moves"]:
        moves = ", ".join(f"{m['ref']} {m['variant_title']}" for m in d["moves"])
        print(f"  {d['title'][:30]:<30} {moves}")
    print(f"  value order (reorder={'on' if plan['reorder_diameter_values'] else 'OFF'}):")
    for r in plan["reorders"][:1]:
        print(f"    e.g. {r['title']}: {r['from']} + ['{TO_DIAMETER}'] -> {r['to']}")
    reached = sum(1 for r in plan["reorders"] if r["reflow_reaches_target"])
    print(f"    the move's re-flow is expected to reach this order in {reached}/{len(plan['reorders'])} "
          f"products: reorder + restore_positions then SKIP (they run only if live state needs them)")
    for r in plan["reorders"]:
        if not r["reflow_reaches_target"]:
            print(f"    ⚠ {r['title']}: re-flow would NOT reach the target; reorder would shift "
                  f"{r['positions_shifted_if_reorder_runs']} variants and the restore would put them back")
    for n in plan["noops"]:
        print(f"  no-op {n}")
    for n in plan["notes"]:
        print(f"  note  {n}")
    print()

    print(f"ALTURA vs owner's sheet col E (report only, nothing changed): {alt.get('sheet')}")
    if alt.get("error"):
        print(f"  sheet {alt['error']}")
    for ref, values in alt["by_ref"].items():
        print(f"  ref {ref}: sheet says {values}")
    if alt.get("skipped_never_created"):
        print(f"  rows skipped (colour never created): {alt['skipped_never_created']}")
    by = Counter((d["ref"], d["sheet"], d["store"], d["issue"]) for d in alt["discrepancies"])
    for (ref, sheet, store, issue), n in sorted(by.items()):
        print(f"  DISCREPANCY ref {ref}: sheet {sheet!r} vs store {store} ({issue}) x{n} rows")
    print()

    s = plan["skus_load"]
    print(f"SKU LOAD (ajustes_pt2_skus) status: {s['state'].upper()} {json.dumps({k: v for k, v in s.items() if k != 'state'})}")
    print()

    total_ops = Counter(op["op"] for p in plan["products"].values() for op in p["ops"])
    print(f"WRITES PLANNED: {len(plan['products'])} products, ops {dict(total_ops)}")
    print(f"ANOMALIES (blocking): {len(plan['anomalies'])}")
    for a in plan["anomalies"]:
        print(f"  [{a['decision']}] {a['product_id']}: {a['reason']}")
    print(f"BLOCKED products (nothing planned): {len(plan['blocked_products'])}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(DEFAULT_PLAN))
    parser.add_argument("--xlsx", default=str(DEFAULT_XLSX))
    parser.add_argument("--no-reorder", action="store_true",
                        help=f"Leave '{TO_DIAMETER}' where Shopify appends it instead of after '{FROM_DIAMETER}'")
    args = parser.parse_args()

    shop = Shopify(load_env())
    plan = build_plan(shop, reorder=not args.no_reorder)
    alt = altura_report(Path(args.xlsx))
    print_plan(plan, alt)

    Path(args.out).write_text(
        json.dumps(
            {"generated_at": datetime.now(timezone.utc).isoformat(), "store": shop.domain,
             "api_version": shop.version, "altura_report": alt, **plan},
            indent=2, ensure_ascii=False, default=str,
        )
    )
    print(f"\nPlan written to {args.out}")


if __name__ == "__main__":
    main()
