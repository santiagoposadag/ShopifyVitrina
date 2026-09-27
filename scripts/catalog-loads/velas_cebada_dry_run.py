# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""
Dry run: map INFO_VELAS_CANDELABRO_CEBADAS.xlsx onto the live Shopify product
"Vela cebada Colores" and report what a load WOULD change. Read-only by
construction: every GraphQL document is checked and a mutation is refused.

    uv run scripts/catalog-loads/velas_cebada_dry_run.py [--xlsx PATH] [--out PATH]

The colour tables below are specific to this one load (September 2026). Copy
the pair of scripts for a new load rather than editing these: they are the
record of what was decided. See README.md next to this file.

Reads SHOPIFY_* from the repo-root .env (same variables the server uses).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from decimal import Decimal
from pathlib import Path

import openpyxl

# scripts/catalog-loads/<this file> -> repo root is three parents up.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# Inputs and outputs are store data, kept under the git-ignored tmp/.
DEFAULT_XLSX = REPO_ROOT / "tmp" / "INFO_VELAS_CANDELABRO_CEBADAS.xlsx"
DEFAULT_PLAN = REPO_ROOT / "tmp" / "velas_cebada_plan.json"
PRODUCT_HANDLE = "vela-cebada-color-morado"

# Spreadsheet colour code -> the store's own "Color" option value, matched by
# NAME only. Codes other products happen to use are not evidence. The one
# exception is VA: the store admin confirmed the sheet's "Verde Agua" IS this
# product's "Verde Menta", so those variants are reused and renamed (see
# RENAME_COLORS) rather than deleted and recreated, which would give them new
# ids and cut their history.
COLOR_MAP = {
    "AO": "Azul Oscuro",
    "AC": "Azul Claro",
    "AM": "Amarillo",
    "BG": "Beige",
    "BL": "Blanco",
    "GR": "Gris",
    "MO": "Morado",
    "MZ": "Mostaza",
    "NG": "Negro",
    "NR": "Naranja",
    "RJ": "Rojo",
    "RS": "Rosado",
    "VO": "Verde Oscuro",
    "VT": "Vinotinto",
    "VA": "Verde Menta",
}

# Colours in the sheet that the store has never had. Loading them means NEW
# variants, and their option value spelling is our proposal, not the store's.
NEW_COLOR_NAMES = {
    "CF": "Café",
    "D": "Dorado",
    "P": "Plateado",
    "PDR": "Palo de Rosa",
    "VL": "Verde Limón",
}

# Store colours the admin asked to withdraw from this product. Every variant
# carrying one is planned for deletion.
RETIRE_COLORS = {"Verde Claro"}

# Store "Color" values to rename in place: current value -> new value.
RENAME_COLORS = {"Verde Menta": "Verde Agua"}

HEIGHT_BY_REF = {"L24": "24 cm", "L40": "40 cm", "L60": "60 cm"}


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
        with urllib.request.urlopen(req) as res:
            return json.load(res)["access_token"]

    def query(self, document: str, variables: dict | None = None) -> dict:
        if "mutation" in document.lower():
            raise RuntimeError("Dry run refuses to send a mutation")
        req = urllib.request.Request(
            self.endpoint,
            data=json.dumps({"query": document, "variables": variables or {}}).encode(),
            headers={"Content-Type": "application/json", "X-Shopify-Access-Token": self.token},
        )
        with urllib.request.urlopen(req) as res:
            payload = json.load(res)
        if payload.get("errors"):
            raise RuntimeError(f"GraphQL errors: {payload['errors']}")
        return payload["data"]


PRODUCT_QUERY = """
query($q: String!) {
  products(first: 1, query: $q) {
    nodes {
      id handle title status
      options { name values }
      variants(first: 250) {
        nodes {
          id sku title price inventoryQuantity
          inventoryItem { tracked }
          selectedOptions { name value }
        }
      }
    }
  }
}
"""

SKU_QUERY = """
query($q: String!) {
  productVariants(first: 250, query: $q) {
    nodes { sku product { handle } }
  }
}
"""


# --- Spreadsheet ----------------------------------------------------------------


def read_sheet(xlsx: Path) -> list[dict]:
    ws = openpyxl.load_workbook(xlsx, data_only=True).active
    rows = list(ws.iter_rows(values_only=True))
    # The sheet has blank rows above the header, so find it by content.
    start = next(i for i, r in enumerate(rows) if r and r[0] == "Referencia")
    header = [str(h).strip() for h in rows[start]]
    out = []
    for raw in rows[start + 1:]:
        if raw[0] is None:
            continue
        row = dict(zip(header, raw))
        code = str(row.get("CodigoDetalleUno") or "").strip()
        if not code:
            continue  # the bare L24/L40/L60 row is the parent reference, not a variant
        # A blank SKU cell must stop the load: str(None) is the text "None", and
        # two such rows would write one duplicate, meaningless SKU to the store.
        sku = str(row.get("SKU") or "").strip()
        if not sku:
            sys.exit(f"Row {row['Referencia']} / {code} has no SKU; fix the sheet")
        out.append(
            {
                "ref": str(row["Referencia"]).strip(),
                "sku": sku,
                "code": code,
                "color_label": str(row["DetalleUno"]).strip(),
                "price": Decimal(str(row["PrecioVenta"])),
            }
        )
    return out


# --- Plan -----------------------------------------------------------------------


def option(variant: dict, name: str) -> str | None:
    for o in variant["selectedOptions"]:
        if o["name"] == name:
            return o["value"]
    return None


def build_plan(rows: list[dict], product: dict, foreign_skus: dict[str, str]) -> dict:
    by_key = {
        (option(v, "Color"), option(v, "Altura")): v for v in product["variants"]["nodes"]
    }
    matched_ids: set[str] = set()
    plan = {
        "rename": [],
        "update": [],
        "create": [],
        "delete": [],
        "unresolved": [],
        "untouched": [],
        "conflicts": [],
    }

    # A rename already applied (source gone, target present) is not a conflict:
    # it is the state this plan exists to reach, and rows follow the new name.
    color_option = next(o for o in product["options"] if o["name"] == "Color")
    values = set(color_option["values"])
    store_name: dict[str, str] = {}
    for old, new in RENAME_COLORS.items():
        if old in values and new not in values:
            plan["rename"].append({"option": "Color", "from": old, "to": new})
        elif old not in values and new in values:
            store_name[old] = new
        else:
            plan["conflicts"].append(
                {"sku": "-", "reason": f"rename {old} -> {new}: both or neither exist"}
            )

    for row in rows:
        height = HEIGHT_BY_REF.get(row["ref"])
        if height is None:
            plan["unresolved"].append({**row, "reason": f"unknown reference {row['ref']}"})
            continue

        owner = foreign_skus.get(row["sku"])
        if owner and owner != product["handle"]:
            plan["conflicts"].append({**row, "reason": f"SKU already used by {owner}"})
            continue

        # New colours go through the same lookup as known ones: after a load
        # they exist, and re-running the dry run must report no change rather
        # than plan duplicates.
        color = COLOR_MAP.get(row["code"]) or NEW_COLOR_NAMES.get(row["code"])
        if color is None:
            plan["unresolved"].append({**row, "reason": "colour code not mapped"})
            continue
        color = store_name.get(color, color)

        variant = by_key.get((color, height))
        if variant is None:
            plan["create"].append({**row, "option_values": [color, height]})
            continue

        matched_ids.add(variant["id"])
        current_price = Decimal(variant["price"])
        changes = {}
        if (variant["sku"] or "") != row["sku"]:
            changes["sku"] = [variant["sku"] or None, row["sku"]]
        if current_price != row["price"]:
            changes["price"] = [str(current_price), str(row["price"])]
        plan["update"].append(
            {
                **row,
                "variant_id": variant["id"],
                "variant_title": variant["title"],
                "tracked": variant["inventoryItem"]["tracked"],
                "inventory": variant["inventoryQuantity"],
                "changes": changes,
            }
        )

    for variant in product["variants"]["nodes"]:
        if variant["id"] in matched_ids:
            continue
        entry = {
            "variant_id": variant["id"],
            "variant_title": variant["title"],
            "sku": variant["sku"],
            "inventory": variant["inventoryQuantity"],
        }
        bucket = "delete" if option(variant, "Color") in RETIRE_COLORS else "untouched"
        plan[bucket].append(entry)
    return plan


def print_plan(product: dict, plan: dict) -> None:
    print(f"Product: {product['title']} ({product['handle']}, {product['status']})")
    print(f"         {product['id']}\n")

    print(f"RENAME option values: {len(plan['rename'])}")
    for r in plan["rename"]:
        print(f"  {r['option']}: {r['from']} → {r['to']}")
    print()

    print(f"UPDATE existing variants: {len(plan['update'])}")
    for u in plan["update"]:
        parts = []
        if "sku" in u["changes"]:
            old, new = u["changes"]["sku"]
            parts.append(f"sku {old or '∅'} → {new}")
        if "price" in u["changes"]:
            old, new = u["changes"]["price"]
            parts.append(f"price {old} → {new}")
        print(f"  {u['variant_title']:<22} {'; '.join(parts) or 'no change'}")

    print(f"\nCREATE new variants: {len(plan['create'])}")
    for c in plan["create"]:
        print(f"  {' / '.join(c['option_values']):<22} sku {c['sku']}  price {c['price']}")

    print(f"\nDELETE store variants (colour withdrawn): {len(plan['delete'])}")
    for d in plan["delete"]:
        print(f"  {d['variant_title']:<22} inventory {d['inventory']}")

    print(f"\nUNRESOLVED (not loaded): {len(plan['unresolved'])}")
    for r in plan["unresolved"]:
        print(f"  {r['sku']:<8} {r['color_label']:<14} {r['reason']}")

    print(f"\nCONFLICTS (SKU used elsewhere): {len(plan['conflicts'])}")
    for c in plan["conflicts"]:
        print(f"  {c['sku']:<8} {c['reason']}")

    print(f"\nUNTOUCHED store variants (not in the sheet): {len(plan['untouched'])}")
    for u in plan["untouched"]:
        print(f"  {u['variant_title']}")

    untracked = [u for u in plan["update"] if not u["tracked"]]
    if untracked:
        print(
            f"\nNOTE: {len(untracked)} matched variants have inventory tracking OFF;"
            " stock cannot be adjusted until it is enabled."
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", default=str(DEFAULT_XLSX))
    parser.add_argument("--out", default=str(DEFAULT_PLAN))
    args = parser.parse_args()

    rows = read_sheet(Path(args.xlsx))
    shop = Shopify(load_env())

    nodes = shop.query(PRODUCT_QUERY, {"q": f"handle:{PRODUCT_HANDLE}"})["products"]["nodes"]
    if not nodes:
        sys.exit(f"Product {PRODUCT_HANDLE} not found")
    product = nodes[0]

    # A SKU is only an identifier if it is unique store-wide: check every
    # sheet SKU against the whole catalogue, not just this product.
    foreign_skus: dict[str, str] = {}
    for ref in HEIGHT_BY_REF:
        data = shop.query(SKU_QUERY, {"q": f"sku:{ref}*"})
        for v in data["productVariants"]["nodes"]:
            if v["sku"]:
                foreign_skus[v["sku"]] = v["product"]["handle"]

    plan = build_plan(rows, product, foreign_skus)
    print_plan(product, plan)

    Path(args.out).write_text(
        json.dumps({"product_id": product["id"], "handle": product["handle"], **plan},
                   indent=2, ensure_ascii=False, default=str)
    )
    print(f"\nPlan written to {args.out}")


if __name__ == "__main__":
    main()
