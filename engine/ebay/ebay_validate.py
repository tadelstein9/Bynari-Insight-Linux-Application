#!/usr/bin/env python3
"""ebay_validate.py — pre-flight a listing against eBay's own rules BEFORE publish.

Combines A1 (Taxonomy: required aspects) and A2 (Metadata: valid conditions) into
one LOCAL gate. Fails loud and local, so you never learn a category's rules at the
publish error. Read-only.

  python3 ebay_validate.py --meta path/to/ebay_meta.json
  python3 ebay_validate.py --item <slug>          # reads photos/<slug>/ebay_meta.json
"""
import argparse
import json
import os
import sys

import ebay_pull
import ebay_taxonomy
import ebay_metadata

HERE = os.path.dirname(os.path.abspath(__file__))


def validate(token, meta, tid=None):
    """Return a list of problems (empty list == the listing passes pre-flight)."""
    tid = tid or ebay_taxonomy.tree_id(token)
    problems = []
    cat = str(meta.get("category_id") or "").strip()
    if not cat:
        return ["no category_id set"]
    cond = meta.get("condition")
    have = {k.strip().lower(): v for k, v in (meta.get("aspects") or {}).items() if v}

    # A1 -- every REQUIRED aspect for this category must be present
    try:
        required, _ = ebay_taxonomy.aspects(token, cat, tid)
    except SystemExit as e:                       # API rejected the category
        return [f"category {cat} is not a valid leaf ({e})"]
    for a in required:
        if a["name"].strip().lower() not in have:
            problems.append(f"missing required aspect: {a['name']}")

    # A2 -- the condition must be one the category allows
    try:
        cond_required, conds = ebay_metadata.item_conditions(token, cat)
    except SystemExit as e:
        cond_required, conds = False, []
        problems.append(f"could not read condition policy ({e})")
    allowed = {c["enum"] for c in conds}
    if cond_required and not cond:
        problems.append("condition is required but not set")
    if cond and allowed and cond not in allowed:
        ok = ", ".join(sorted(e for e in allowed if not e.startswith("(")))
        problems.append(f"condition {cond} is invalid for category {cat}  (allowed: {ok})")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", help="path to an ebay_meta.json")
    ap.add_argument("--item", help="slug -> photos/<slug>/ebay_meta.json")
    ap.add_argument("--creds", default=ebay_pull.DEFAULT_CREDS)
    args = ap.parse_args()

    if args.item:
        path = os.path.join(HERE, "photos", args.item, "ebay_meta.json")
    elif args.meta:
        path = args.meta
    else:
        ap.error("use --meta <path> or --item <slug>")
    meta = json.load(open(path))

    token = ebay_pull.refresh_access_token(ebay_pull.load_creds(args.creds))
    problems = validate(token, meta)

    label = (f"{meta.get('sku') or os.path.basename(path)}  "
             f"cat={meta.get('category_id')}  cond={meta.get('condition')}")
    if problems:
        print(f"FAIL  {label}")
        for p in problems:
            print(f"   x {p}")
        sys.exit(1)
    print(f"PASS  {label}  -- category, condition, and required aspects all valid")


if __name__ == "__main__":
    main()
