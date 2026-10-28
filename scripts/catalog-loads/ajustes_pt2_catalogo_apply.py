# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""
Apply tmp/ajustes_pt2_catalogo_plan.json (produced by ajustes_pt2_catalogo_dry_run.py)
to the live store, or roll an earlier run back. Writes ONLY with --confirm;
without it, it re-checks the plan against the store (and every write document
against the schema) and stops.

    uv run scripts/catalog-loads/ajustes_pt2_catalogo_apply.py                      # drift check only
    uv run scripts/catalog-loads/ajustes_pt2_catalogo_apply.py --confirm            # write
    uv run scripts/catalog-loads/ajustes_pt2_catalogo_apply.py --rollback LOG       # plan the inverse
    uv run scripts/catalog-loads/ajustes_pt2_catalogo_apply.py --rollback LOG --confirm

What it can write, and nothing else, per product in this order:
  1. title          productUpdate (id, title, handle sent UNCHANGED)
  2. value renames  productOptionUpdate optionValuesToUpdate (same value ids)
  3. value add      productOptionUpdate optionValuesToAdd, variantStrategy LEAVE_AS_IS
  4. variant moves  productVariantsBulkUpdate optionValues, allowPartialUpdates: false
  5. value order    productOptionsReorder (every option, every value, by id),
                    ONLY if the value order after step 4 is not the target
  6. positions      productVariantsBulkReorder, ONLY if any variant position
                    differs from the pre-run snapshot
A rollback may also delete the value step 3 added (optionValuesToDelete,
LEAVE_AS_IS, only once no variant uses it). No price, SKU, status, inventory,
create or delete of a product or variant is ever sent.

Shopify appends an added value at the END of the option ("... 15 cm, 5 cm"), and
then RE-FLOWS every option's value order from variant positions as soon as step 4
moves variants onto it (observed live, 2026-10-27): "5 cm" lands right after
"4,5 cm" on its own, so steps 5 and 6 are normally skipped. They remain as a
fallback: productOptionsReorder recomputes the position of EVERY variant from the
new value order, and step 6 puts each one back where it was. After step 4 the
verify expects the re-flowed order and accepts the unchanged one (logged as
"alternative"); the final verify is strict either way.

Before writing, every product in the plan is re-read and must still look EXACTLY
like the plan's snapshot (title, handle, options with ordered values and ids,
every variant's title, position, options and price). SKUs are deliberately NOT
compared: the SKU load may land at any time. Each product is re-read once more
right before its own first write, and after EVERY step, and the re-read must be
exactly the state that step promises; anything else stops the run.

Ordering gate: `ajustes_pt2_skus` checks product titles and variant titles that
this load changes, so it must land FIRST. --confirm refuses while its plan's
rewrites are not all live, unless --allow-before-skus-load.

The log is written BEFORE the first write and never overwritten. It holds the
full pre-write snapshot, the ops and the promised end state. A rollback is this
same write path planned from LIVE state toward that snapshot: each field still
at the promised value is reverted, each field already at the pre-run value is
left alone, anything else aborts the rollback before it writes.

Stops at the first userError or failed verify. The recovery path is either the
rollback (back to the pre-run state, positions included) or a fresh dry run,
which plans only what is still missing.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ajustes_pt2_catalogo_dry_run import (  # noqa: E402
    DEFAULT_PLAN,
    REPO_ROOT,
    Shopify,
    compare,
    expected_after,
    fingerprint,
    load_env,
    load_product,
    norm,
    option_by_id,
    scan_products,
    scan_variants,
    simulate,
    skus_load_status,
    variant_order,
)

DEFAULT_LOG = REPO_ROOT / "tmp" / "ajustes_pt2_catalogo_apply_log.json"
DEFAULT_ROLLBACK_LOG = REPO_ROOT / "tmp" / "ajustes_pt2_catalogo_rollback_log.json"
DEFAULT_ROLLBACK_PLAN = REPO_ROOT / "tmp" / "ajustes_pt2_catalogo_rollback_plan.json"

FORWARD_OPS = {"title", "rename_values", "add_value", "move_variants", "reorder_values", "restore_positions"}
# Ops that are skipped when the state already satisfies them.
CONDITIONAL_OPS = {"reorder_values", "restore_positions"}
# A re-read right after a write may lag (variant reorders can settle a moment
# later). Reads are safe to repeat; writes are never retried.
SETTLE_READS, SETTLE_SECONDS = 5, 2

# --- Write documents --------------------------------------------------------------

TITLE_DOC = """mutation($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id }
    userErrors { field message }
  }
}"""

OPTION_DOC = """mutation($productId: ID!, $option: OptionUpdateInput!, $toAdd: [OptionValueCreateInput!], $toUpdate: [OptionValueUpdateInput!], $toDelete: [ID!], $strategy: ProductOptionUpdateVariantStrategy) {
  productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $toAdd, optionValuesToUpdate: $toUpdate, optionValuesToDelete: $toDelete, variantStrategy: $strategy) {
    product { id }
    userErrors { field message }
  }
}"""

MOVE_DOC = """mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
    productVariants { id }
    userErrors { field message }
  }
}"""

REORDER_DOC = """mutation($productId: ID!, $options: [OptionReorderInput!]!) {
  productOptionsReorder(productId: $productId, options: $options) {
    product { id }
    userErrors { field message }
  }
}"""

POSITIONS_DOC = """mutation($productId: ID!, $positions: [ProductVariantPositionInput!]!) {
  productVariantsBulkReorder(productId: $productId, positions: $positions) {
    product { id }
    userErrors { field message }
  }
}"""

# What each document relies on. check_schema() proves every line against this
# store's API version, and that each declared variable type is literally in the
# document, so the table cannot drift from the text above.
DOCS = {
    "productUpdate": {
        "doc": TITLE_DOC,
        "vars": {"product": ("product", "ProductUpdateInput!")},
        "literals": {}, "selects": {"product", "userErrors"},
    },
    "productOptionUpdate": {
        "doc": OPTION_DOC,
        "vars": {"productId": ("productId", "ID!"), "option": ("option", "OptionUpdateInput!"),
                 "optionValuesToAdd": ("toAdd", "[OptionValueCreateInput!]"),
                 "optionValuesToUpdate": ("toUpdate", "[OptionValueUpdateInput!]"),
                 "optionValuesToDelete": ("toDelete", "[ID!]"),
                 "variantStrategy": ("strategy", "ProductOptionUpdateVariantStrategy")},
        "literals": {}, "selects": {"product", "userErrors"},
    },
    "productVariantsBulkUpdate": {
        "doc": MOVE_DOC,
        "vars": {"productId": ("productId", "ID!"), "variants": ("variants", "[ProductVariantsBulkInput!]!")},
        "literals": {"allowPartialUpdates": "Boolean"}, "selects": {"productVariants", "userErrors"},
    },
    "productOptionsReorder": {
        "doc": REORDER_DOC,
        "vars": {"productId": ("productId", "ID!"), "options": ("options", "[OptionReorderInput!]!")},
        "literals": {}, "selects": {"product", "userErrors"},
    },
    "productVariantsBulkReorder": {
        "doc": POSITIONS_DOC,
        "vars": {"productId": ("productId", "ID!"), "positions": ("positions", "[ProductVariantPositionInput!]!")},
        "literals": {}, "selects": {"product", "userErrors"},
    },
}
# Input fields the documents' variables carry, and what each nested one must be.
INPUT_FIELDS = {
    "ProductUpdateInput": {"id": "ID", "title": "String", "handle": "String"},
    "OptionUpdateInput": {"id": "ID"},
    "OptionValueCreateInput": {"name": "String"},
    "OptionValueUpdateInput": {"id": "ID", "name": "String"},
    "ProductVariantsBulkInput": {"id": "ID", "optionValues": "VariantOptionValueInput"},
    "VariantOptionValueInput": {"optionId": "ID", "id": "ID"},
    "OptionReorderInput": {"id": "ID", "values": "OptionValueReorderInput"},
    "OptionValueReorderInput": {"id": "ID"},
    "ProductVariantPositionInput": {"id": "ID", "position": "Int"},
}
ENUMS = {"ProductOptionUpdateVariantStrategy": {"LEAVE_AS_IS"}}

TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }"


class Writer(Shopify):
    """Sends mutations only once armed, and arming happens only under --confirm."""

    armed = False

    def introspect(self, document: str) -> dict:
        # A read: __schema / __type only. Sent via _post because the text names
        # the mutation type, which query()'s substring guard would refuse.
        if not document.lstrip().startswith("query"):
            raise RuntimeError("introspection must be a query")
        return self._post(document, None)

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


def render(t: dict | None) -> str:
    if t is None:
        return "?"
    if t["kind"] == "NON_NULL":
        return render(t["ofType"]) + "!"
    if t["kind"] == "LIST":
        return "[" + render(t["ofType"]) + "]"
    return t["name"]


def base_name(t: dict) -> str:
    while t.get("ofType"):
        t = t["ofType"]
    return t["name"]


def check_schema(shop: Writer) -> list[str]:
    aliases = {f"t{i}": n for i, n in enumerate(sorted(set(INPUT_FIELDS) | set(ENUMS)))}
    payloads = {f"p{i}": root for i, root in enumerate(DOCS)}
    q = ("query { __schema { mutationType { fields { name args { name type { " + TYPE_REF + " } } "
         "type { name } } } } "
         + " ".join(f'{a}: __type(name: "{n}") {{ name inputFields {{ name type {{ {TYPE_REF} }} }} '
                    f'enumValues {{ name }} }}' for a, n in aliases.items())
         + " }")
    data = shop.introspect(q)
    problems: list[str] = []
    roots = {f["name"]: f for f in data["__schema"]["mutationType"]["fields"]}

    payload_types = {}
    for root, spec in DOCS.items():
        field = roots.get(root)
        if field is None:
            problems.append(f"schema: mutation {root} not found")
            continue
        payload_types[root] = field["type"]["name"]
        args = {a["name"]: a["type"] for a in field["args"]}
        for arg, (var, declared) in spec["vars"].items():
            if arg not in args:
                problems.append(f"schema: {root} has no argument {arg}")
                continue
            if f"${var}: {declared}" not in spec["doc"] or f"{arg}: ${var}" not in spec["doc"]:
                problems.append(f"internal: {root} document does not declare/bind ${var}: {declared}")
            want = render(args[arg])
            # A variable may be stricter (non-null) than a nullable argument.
            if declared not in (want, want + "!"):
                problems.append(f"schema: {root}.{arg} is {want}, document declares {declared}")
        for arg, typ in spec["literals"].items():
            if arg not in args or base_name(args[arg]) != typ:
                problems.append(f"schema: {root}.{arg} is not {typ}")

    by_name = {data[a]["name"]: data[a] for a in aliases if data.get(a)}
    for typ, fields in INPUT_FIELDS.items():
        node = by_name.get(typ)
        if not node:
            problems.append(f"schema: type {typ} not found")
            continue
        have = {f["name"]: base_name(f["type"]) for f in node["inputFields"] or []}
        for name, inner in fields.items():
            if name not in have:
                problems.append(f"schema: {typ} lacks {name}")
            elif have[name] != inner:
                problems.append(f"schema: {typ}.{name} is {have[name]}, expected {inner}")
    for typ, values in ENUMS.items():
        node = by_name.get(typ)
        have = {v["name"] for v in (node or {}).get("enumValues") or []}
        if not values <= have:
            problems.append(f"schema: enum {typ} lacks {sorted(values - have)}")

    # Payloads: the selected fields exist, and every userErrors type has field + message.
    if payload_types:
        q2 = "query { " + " ".join(
            f'{a}: __type(name: "{payload_types[root]}") {{ name fields {{ name type {{ {TYPE_REF} }} }} }}'
            for a, root in payloads.items() if root in payload_types) + " }"
        pdata = shop.introspect(q2)
        error_types = set()
        for a, root in payloads.items():
            node = pdata.get(a)
            if not node:
                problems.append(f"schema: payload of {root} not found")
                continue
            fields = {f["name"]: f["type"] for f in node["fields"] or []}
            missing = DOCS[root]["selects"] - set(fields)
            if missing:
                problems.append(f"schema: {node['name']} lacks {sorted(missing)}")
            if "userErrors" in fields:
                error_types.add(base_name(fields["userErrors"]))
        if error_types:
            q3 = "query { " + " ".join(f'e{i}: __type(name: "{n}") {{ name fields {{ name }} }}'
                                       for i, n in enumerate(sorted(error_types))) + " }"
            for node in shop.introspect(q3).values():
                have = {f["name"] for f in (node or {}).get("fields") or []}
                if not {"field", "message"} <= have:
                    problems.append(f"schema: {node and node['name']} lacks field/message")
    return problems


# --- Ops: preconditions, satisfied-checks, documents -----------------------------


def satisfied(current: dict, op: dict) -> bool:
    if op["op"] == "reorder_values":
        return all(option_by_id(current, o["id"])["values"] == o["values"] for o in op["options"])
    if op["op"] == "restore_positions":
        return variant_order(current) == op["order"]
    return False


def precondition(current: dict, op: dict) -> list[str]:
    kind, out = op["op"], []
    if kind == "title":
        if current["title"] != op["from"]:
            out.append(f"title is {current['title']!r}, expected {op['from']!r}")
        if current["handle"] != op["handle"]:
            out.append(f"handle is {current['handle']!r}, expected {op['handle']!r}")
    elif kind == "rename_values":
        o = option_by_id(current, op["option_id"])
        for r in op["renames"]:
            if o["value_ids"].get(r["from"]) != r["value_id"]:
                out.append(f"{o['name']}: {r['from']!r} is not value {r['value_id']}")
            clash = [v for v in o["values"] if norm(v) == norm(r["to"]) and v != r["from"]]
            if clash:
                out.append(f"{o['name']}: {r['to']!r} would collide with {clash}")
    elif kind == "add_value":
        o = option_by_id(current, op["option_id"])
        if any(norm(v) == norm(op["name"]) for v in o["values"]):
            out.append(f"{o['name']}: {op['name']!r} already exists")
    elif kind == "move_variants":
        o = option_by_id(current, op["option_id"])
        occupied = {tuple(sorted(v["options"].items())) for v in current["variants"].values()}
        for m in op["variants"]:
            v = current["variants"].get(m["variant_id"])
            if v is None:
                out.append(f"variant {m['variant_id']} is gone")
                continue
            if v["options"].get(o["name"]) != m["from"]:
                out.append(f"{v['title']}: {o['name']} is {v['options'].get(o['name'])!r}, expected {m['from']!r}")
            if o["value_ids"].get(m["to"]) is None:
                out.append(f"{o['name']}: value {m['to']!r} does not exist")
            target = tuple(sorted({**v["options"], o["name"]: m["to"]}.items()))
            if target in occupied:
                out.append(f"{v['title']}: combination {dict(target)} already exists")
    elif kind == "delete_value":
        o = option_by_id(current, op["option_id"])
        if o["value_ids"].get(op["name"]) != op["value_id"]:
            out.append(f"{o['name']}: {op['name']!r} is not value {op['value_id']}")
        users = [v["title"] for v in current["variants"].values() if v["options"].get(o["name"]) == op["name"]]
        if users:
            out.append(f"{o['name']}: {op['name']!r} is still used by {users}")
    elif kind == "reorder_values":
        if [o["id"] for o in op["options"]] != [o["id"] for o in current["options"]]:
            out.append("reorder must list every option in its current order")
        for want in op["options"]:
            have = option_by_id(current, want["id"])["values"]
            if sorted(have) != sorted(want["values"]):
                out.append(f"{want['name']}: values are {have}, reorder names {want['values']}")
    elif kind == "restore_positions":
        if sorted(op["order"]) != sorted(current["variants"]):
            out.append("positions must name every variant exactly once")
    return out


def document(product_id: str, current: dict, op: dict) -> tuple[str, dict, str]:
    kind = op["op"]
    if kind == "title":
        return TITLE_DOC, {"product": {"id": product_id, "title": op["to"], "handle": op["handle"]}}, "productUpdate"
    if kind in ("rename_values", "add_value", "delete_value"):
        variables = {"productId": product_id, "option": {"id": op["option_id"]}, "strategy": "LEAVE_AS_IS"}
        if kind == "rename_values":
            variables["toUpdate"] = [{"id": r["value_id"], "name": r["to"]} for r in op["renames"]]
        elif kind == "add_value":
            variables["toAdd"] = [{"name": op["name"]}]
        else:
            variables["toDelete"] = [op["value_id"]]
        return OPTION_DOC, variables, "productOptionUpdate"
    if kind == "move_variants":
        moved = option_by_id(current, op["option_id"])
        variants = []
        for m in op["variants"]:
            v = current["variants"][m["variant_id"]]
            # Every option by value id: the moved one to its target, the rest
            # exactly as they are, so nothing is left to inference.
            values = []
            for o in current["options"]:
                name = m["to"] if o["id"] == moved["id"] else v["options"][o["name"]]
                values.append({"optionId": o["id"], "id": o["value_ids"][name]})
            variants.append({"id": m["variant_id"], "optionValues": values})
        return MOVE_DOC, {"productId": product_id, "variants": variants}, "productVariantsBulkUpdate"
    if kind == "reorder_values":
        options = [{"id": want["id"],
                    "values": [{"id": option_by_id(current, want["id"])["value_ids"][n]} for n in want["values"]]}
                   for want in op["options"]]
        return REORDER_DOC, {"productId": product_id, "options": options}, "productOptionsReorder"
    if kind == "restore_positions":
        positions = [{"id": vid, "position": n} for n, vid in enumerate(op["order"], start=1)]
        return POSITIONS_DOC, {"productId": product_id, "positions": positions}, "productVariantsBulkReorder"
    raise RuntimeError(f"unknown op {kind}")


def describe(op: dict) -> str:
    kind = op["op"]
    if kind == "title":
        return f"title {op['from']!r} -> {op['to']!r}"
    if kind == "rename_values":
        return "rename " + ", ".join(f"{r['from']!r}->{r['to']!r}" for r in op["renames"])
    if kind == "add_value":
        return f"add value {op['name']!r}"
    if kind == "delete_value":
        return f"delete value {op['name']!r}"
    if kind == "move_variants":
        return f"move {len(op['variants'])} variants " + ", ".join(
            f"{m['from']}->{m['to']}" for m in op["variants"][:1])
    if kind == "reorder_values":
        return "reorder values " + "; ".join(f"{o['name']}={o['values']}" for o in op["options"][:1])
    return "restore variant positions"


# --- Execution ----------------------------------------------------------------


def settled_read(shop: Writer, pid: str, expected: dict, label: str, flags: dict) -> tuple[dict, list[str], str]:
    """Re-read until the state is the expected one (or an accepted alternative).
    Returns the live fingerprint, the problems against the PRIMARY expectation
    (empty on success) and which expectation matched."""
    alternative = flags.get("alternative")
    for attempt in range(SETTLE_READS):
        live = fingerprint(load_product(shop, pid))
        problems = compare(expected, live, label, flags)
        if not problems:
            return live, [], "expected"
        if alternative is not None and not compare(alternative, live, label, {"positions_free": flags.get("positions_free")}):
            return live, [], "alternative (no value re-flow)"
        if attempt == SETTLE_READS - 1:
            return live, problems, "none"
        time.sleep(SETTLE_SECONDS)
    raise AssertionError("unreachable")


def final_flags(job: dict) -> dict:
    """Without a value reorder, where Shopify put an added value is its call."""
    kinds = [o["op"] for o in job["ops"]]
    if "add_value" in kinds and "reorder_values" not in kinds:
        add = next(o for o in job["ops"] if o["op"] == "add_value")
        return {"free_values": [(add["option_id"], add["name"])]}
    return {}


def execute(shop: Writer, jobs: dict[str, dict], before: dict[str, dict], log_path: Path, header: dict) -> None:
    """jobs: product id -> {title, start (fingerprint), ops, expected_after}."""
    log: dict = {
        **header,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "store": shop.domain,
        "api_version": shop.version,
        # Full pre-write products (SKUs included, for the human record only).
        "before": before,
        # What --rollback reads: where each product started, what it was promised.
        "before_fp": {pid: j["start"] for pid, j in jobs.items()},
        "expected_after": {pid: j["expected_after"] for pid, j in jobs.items()},
        "ops": {pid: j["ops"] for pid, j in jobs.items()},
        "steps": [],
    }
    # Exclusive create: a log that already exists is an earlier run's rollback
    # source, and this run must not be able to destroy it.
    with open(log_path, "x", encoding="utf-8") as fh:
        fh.write(json.dumps(log, indent=2, ensure_ascii=False))

    def save() -> None:
        log_path.write_text(json.dumps(log, indent=2, ensure_ascii=False))

    def record(pid: str, step: str, entry: dict) -> None:
        log["steps"].append({"product_id": pid, "step": step, "at": datetime.now(timezone.utc).isoformat(), **entry})
        save()

    shop.armed = True
    try:
        for pid, job in jobs.items():
            label = job["title"]
            print(f"\n{label}")
            current = fingerprint(load_product(shop, pid))
            drift = compare(job["start"], current, label)
            if drift:
                raise RuntimeError("drift just before writing: " + "; ".join(drift))
            for i, op in enumerate(job["ops"]):
                step = describe(op)
                if op["op"] in CONDITIONAL_OPS and satisfied(current, op):
                    record(pid, step, {"skipped": "already satisfied"})
                    print(f"  - {step}: already satisfied")
                    continue
                pre = precondition(current, op)
                if pre:
                    raise RuntimeError(f"{label}: precondition of '{step}' failed: " + "; ".join(pre))
                doc, variables, root = document(pid, current, op)
                result = shop.mutate(doc, variables, root)
                expected, flags = simulate(current, op)
                if op["op"] == "move_variants" and any(o["op"] == "restore_positions" for o in job["ops"][i + 1:]):
                    flags["positions_free"] = True  # whatever the move does to positions, a restore follows
                live, problems, matched = settled_read(shop, pid, expected, label, flags)
                # The write happened; record it (and the state it left) before
                # deciding whether to stop.
                record(pid, step, {"variables": variables, "result": result, "after": live,
                                   "matched": matched, "problems": problems})
                if problems:
                    raise RuntimeError(f"{label}: '{step}' left an unexpected state: " + "; ".join(problems))
                print(f"  ✓ {step}" + ("" if matched == "expected" else f"  [{matched}]"))
                current = live
    except Exception as err:  # any failure: record where it stopped, then stop
        log["stopped"] = f"{type(err).__name__}: {err}"
        save()
        print(f"STOPPED: {err}")
        print(f"Completed steps are logged in {log_path}. Roll back with --rollback {log_path}, "
              f"or re-run the dry run to plan what is left.")
        sys.exit(1)
    finally:
        shop.armed = False

    # Re-read every product and compare with what was promised.
    mismatches = []
    for pid, job in jobs.items():
        _, problems, _ = settled_read(shop, pid, job["expected_after"], job["title"], final_flags(job))
        mismatches += problems
    log["verify"] = {"mismatches": mismatches, "at": datetime.now(timezone.utc).isoformat()}
    save()
    print(f"\nVERIFY: {len(jobs)} products re-read")
    for m in mismatches:
        print(f"  MISMATCH {m}")
    print("OK — store matches the plan." if not mismatches else "VERIFY FAILED — see above.")
    if mismatches:
        sys.exit(1)


# --- Forward plan ----------------------------------------------------------------


def validate_plan(plan: dict) -> list[str]:
    problems = []
    if plan.get("anomalies"):
        problems.append(f"{len(plan['anomalies'])} anomalies")
    if plan.get("blocked_products"):
        problems.append(f"{len(plan['blocked_products'])} blocked products")
    for pid, entry in plan["products"].items():
        snap = plan["snapshot"].get(pid)
        if snap is None:
            problems.append(f"{pid}: no snapshot")
            continue
        for op in entry["ops"]:
            if op["op"] not in FORWARD_OPS:
                problems.append(f"{entry['title']}: op {op['op']} is not allowed in a forward run")
            if op["op"] == "title" and op["handle"] != snap["handle"]:
                problems.append(f"{entry['title']}: title op would change the handle")
        # The promised end state must follow from the snapshot and the ops.
        recomputed = expected_after(fingerprint(snap), entry["ops"])
        if recomputed != entry["expected_after"]:
            problems.append(f"{entry['title']}: expected_after does not follow from snapshot + ops")
    return problems


def title_collisions(plan: dict, products: list[dict]) -> list[str]:
    """Re-checked store-wide at apply time: a product created or renamed since
    the dry run may now carry a target title."""
    targets = {op["to"]: pid for pid, e in plan["products"].items() for op in e["ops"] if op["op"] == "title"}
    renamed = {pid: to for to, pid in targets.items()}
    out = []
    for to, pid in targets.items():
        for p in products:
            if p["id"] != pid and norm(renamed.get(p["id"], p["title"])) == norm(to):
                out.append(f"title {to!r} collides with {p['title']!r} ({p['handle']})")
    return out


# --- Rollback ------------------------------------------------------------------


def plan_rollback(shop: Writer, source: dict) -> tuple[dict[str, dict], dict[str, dict], list[str], list[str]]:
    """Ops that take every product from LIVE state back to the log's before_fp.
    A field still at the promised value is reverted, one at the pre-run value is
    left alone, anything else is a problem and nothing is written."""
    jobs, before, problems, skipped = {}, {}, [], []
    for pid, start in source["before_fp"].items():
        promised = source["expected_after"][pid]
        product = load_product(shop, pid)
        live = fingerprint(product)
        label = live["title"]
        ops: list[dict] = []
        p: list[str] = []

        if live["handle"] != start["handle"]:
            p.append(f"handle is {live['handle']!r}, was {start['handle']!r}")
        if live["title"] == promised["title"] and live["title"] != start["title"]:
            ops.append({"op": "title", "from": live["title"], "to": start["title"], "handle": live["handle"]})
        elif live["title"] != start["title"]:
            p.append(f"title is {live['title']!r}, neither {start['title']!r} nor {promised['title']!r}")
        if [o["id"] for o in live["options"]] != [o["id"] for o in start["options"]]:
            problems.append(f"{label}: options changed since the run; not reverted")
            continue
        if set(live["variants"]) != set(start["variants"]):
            problems.append(f"{label}: variants added or removed since the run; not reverted")
            continue

        deletes = []
        for so, po, lo in zip(start["options"], promised["options"], live["options"]):
            s_by_id = {vid: n for n, vid in so["value_ids"].items()}
            p_by_id = {vid: n for n, vid in po["value_ids"].items() if vid}
            l_by_id = {vid: n for n, vid in lo["value_ids"].items()}
            renames = []
            for vid, s_name in s_by_id.items():
                if vid not in l_by_id:
                    p.append(f"{so['name']}: value {s_name!r} is gone")
                elif l_by_id[vid] != s_name:
                    if l_by_id[vid] == p_by_id.get(vid):
                        renames.append({"value_id": vid, "from": l_by_id[vid], "to": s_name})
                    else:
                        p.append(f"{so['name']}: value {vid} is {l_by_id[vid]!r}, neither {s_name!r} "
                                 f"nor {p_by_id.get(vid)!r}")
            if renames:
                ops.append({"op": "rename_values", "option_id": so["id"], "renames": renames})
            for vid, name in l_by_id.items():
                if vid in s_by_id:
                    continue
                if name in po["values"]:  # created by this load
                    deletes.append({"op": "delete_value", "option_id": so["id"], "value_id": vid, "name": name})
                else:
                    p.append(f"{so['name']}: value {name!r} was not created by this load")
            # Variants moved within this option: back to their start value.
            s_names = {n: vid for n, vid in so["value_ids"].items()}
            moves = []
            for vid, sv in start["variants"].items():
                lv = live["variants"][vid]
                s_val, l_val = sv["options"][so["name"]], lv["options"][lo["name"]]
                l_id = lo["value_ids"].get(l_val)
                if l_id == s_names[s_val]:
                    continue  # same value (maybe renamed; the rename op covers it)
                if l_val == promised["variants"][vid]["options"][po["name"]]:
                    moves.append({"variant_id": vid, "variant_title": lv["title"], "from": l_val, "to": s_val})
                else:
                    p.append(f"{lv['title']}: {so['name']} is {l_val!r}, neither {s_val!r} "
                             f"nor {promised['variants'][vid]['options'][po['name']]!r}")
            if moves:
                ops.append({"op": "move_variants", "option_id": so["id"], "variants": moves})
        ops += deletes
        ops.append({"op": "reorder_values",
                    "options": [{"id": o["id"], "name": o["name"], "values": list(o["values"])}
                                for o in start["options"]]})
        ops.append({"op": "restore_positions", "order": variant_order(start)})
        # Apply order: title, renames, moves, deletes, then ordering.
        rank = ["title", "rename_values", "move_variants", "delete_value", "reorder_values", "restore_positions"]
        ops.sort(key=lambda o: rank.index(o["op"]))

        if p:
            problems += [f"{label}: {x}" for x in p]
            continue
        # The target is the pre-run state, except fields this load never wrote
        # (price), which keep their live value.
        target = json.loads(json.dumps(start))
        for vid, v in target["variants"].items():
            v["price"] = live["variants"][vid]["price"]
            v["compareAtPrice"] = live["variants"][vid]["compareAtPrice"]
        reached = expected_after(live, ops)
        gap = compare(target, reached, label)
        if gap:
            problems += [f"rollback cannot reach the pre-run state: {g}" for g in gap]
            continue
        writes = [o for o in ops if not (o["op"] in CONDITIONAL_OPS and conditional_noop(live, ops, o))]
        if not writes:
            skipped.append(f"{label}: already at the pre-run state")
            continue
        jobs[pid] = {"title": label, "start": live, "ops": ops, "expected_after": target}
        before[pid] = product
    return jobs, before, problems, skipped


def conditional_noop(live: dict, ops: list[dict], op: dict) -> bool:
    """Whether a conditional op would already be satisfied once the ops before
    it ran (simulated), i.e. it would not write."""
    state = live
    for o in ops:
        if o is op:
            return satisfied(state, op)
        state, _ = simulate(state, o)
    return False


# --- Main ------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--confirm", action="store_true", help="Actually write to the store")
    parser.add_argument("--plan", default=str(DEFAULT_PLAN))
    parser.add_argument("--rollback", metavar="LOG", help="Plan (and with --confirm, write) the inverse of LOG")
    parser.add_argument("--log", help="Where this run's log goes (never overwritten)")
    parser.add_argument("--allow-before-skus-load", action="store_true",
                        help="Write even though ajustes_pt2_skus has not landed (it will then block)")
    args = parser.parse_args()
    log_path = Path(args.log or (DEFAULT_ROLLBACK_LOG if args.rollback else DEFAULT_LOG))

    shop = Writer(load_env())

    if args.rollback:
        source = json.loads(Path(args.rollback).read_text())
        if shop.domain != source["store"]:
            sys.exit(f"Log was written against {source['store']}, this .env points at {shop.domain}")
        if "before_fp" not in source or "expected_after" not in source:
            sys.exit(f"{args.rollback} has no before_fp / expected_after; it is not a log from this script")
        problems = check_schema(shop)
        jobs, before, drift, skipped = plan_rollback(shop, source)
        problems += drift
        header = {"mode": "rollback", "rollback_of": str(args.rollback)}
        DEFAULT_ROLLBACK_PLAN.write_text(json.dumps(
            {"generated_at": datetime.now(timezone.utc).isoformat(), "store": shop.domain, **header,
             "jobs": jobs, "skipped": skipped, "problems": problems}, indent=2, ensure_ascii=False))
        print(f"ROLLBACK of {args.rollback}: {len(jobs)} products; {len(skipped)} skipped. "
              f"Plan: {DEFAULT_ROLLBACK_PLAN}")
        for s in skipped:
            print(f"  skip {s}")
        for job in jobs.values():
            print(f"  {job['title']}: " + "; ".join(describe(o) for o in job["ops"]))
    else:
        plan = json.loads(Path(args.plan).read_text())
        problems = validate_plan(plan)
        if problems:
            sys.exit("Plan is not appliable; fix it in the dry run first:\n  " + "\n  ".join(problems))
        if shop.domain != plan["store"]:
            sys.exit(f"Plan was made against {plan['store']}, this .env points at {shop.domain}")
        problems = check_schema(shop)
        jobs, before = {}, {}
        for pid, entry in plan["products"].items():
            start = fingerprint(plan["snapshot"][pid])
            before[pid] = load_product(shop, pid)
            problems += compare(start, fingerprint(before[pid]), before[pid]["title"])
            jobs[pid] = {"title": entry["title"], "start": start, "ops": entry["ops"],
                         "expected_after": entry["expected_after"]}
        problems += title_collisions(plan, scan_products(shop))
        header = {"mode": "apply", "plan": str(args.plan), "plan_generated_at": plan["generated_at"]}
        n_ops = sum(len(j["ops"]) for j in jobs.values())
        print(f"Plan ({plan['generated_at']}) against {plan['store']}: {len(jobs)} products, {n_ops} ops "
              f"(conditional ones run only if needed).")

    if problems:
        print("DRIFT — the store no longer matches the plan. Nothing written.")
        for p in problems:
            print(f"  {p}")
        sys.exit(1)
    if not jobs:
        print("Nothing to write.")
        return
    print(f"Still matches the store; schema OK for API {shop.version}; no target title is taken.")

    if not args.rollback:
        status = skus_load_status(scan_variants(shop))
        print(f"SKU load (ajustes_pt2_skus): {status['state'].upper()} "
              f"{json.dumps({k: v for k, v in status.items() if k != 'state'})}")
        if status["state"] != "landed" and not args.allow_before_skus_load:
            msg = ("ajustes_pt2_skus has not fully landed. It checks the product titles and variant titles "
                   "this load changes, so applying this first blocks it. Apply it first, or pass "
                   "--allow-before-skus-load.")
            if args.confirm:
                sys.exit(msg)
            print(f"NOTE: {msg}")

    if not args.confirm:
        if log_path.exists():
            print(f"NOTE: {log_path} exists; --confirm will refuse unless --log names a new path.")
        print("Drift check only. Re-run with --confirm to write.")
        return
    if log_path.exists():
        sys.exit(f"{log_path} exists (an earlier run's rollback source). Pass --log with a new path.")
    execute(shop, jobs, before, log_path, header)


if __name__ == "__main__":
    main()
