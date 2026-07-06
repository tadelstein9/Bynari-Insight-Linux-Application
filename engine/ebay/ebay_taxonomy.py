#!/usr/bin/env python3
"""ebay_taxonomy.py — ask eBay for the RIGHT category and its item specifics,
instead of hand-guessing them. Stdlib only; reuses ebay_pull for OAuth. Read-only.

This is the fix for the silent-category trap: eBay's Taxonomy API returns the
leaf category for a title and the exact aspects that category requires — BEFORE
you ever publish. Get the category from here, not from a sold comp.

  python3 ebay_taxonomy.py --suggest "UNITAS 6498 pocket watch movement"
  python3 ebay_taxonomy.py --aspects 57720
  python3 ebay_taxonomy.py --for "UNITAS 6498 pocket watch movement"   # suggest + aspects of the top hit
"""
import argparse
import json
import sys
import urllib.parse
import urllib.request
import urllib.error

import ebay_pull  # load_creds / refresh_access_token

TAXONOMY = "https://api.ebay.com/commerce/taxonomy/v1"
MARKETPLACE = "EBAY_US"


def _get(token, path, params=None):
    url = TAXONOMY + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method="GET", headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"Taxonomy API {e.code} on GET {url}\n  "
                 f"{e.read().decode('utf-8', 'replace')[:600]}")


def tree_id(token):
    """US default category tree id (returns '0' for EBAY_US)."""
    return _get(token, "/get_default_category_tree_id",
                {"marketplace_id": MARKETPLACE})["categoryTreeId"]


def suggest(token, query, tid=None):
    tid = tid or tree_id(token)
    d = _get(token, f"/category_tree/{tid}/get_category_suggestions", {"q": query})
    out = []
    for s in d.get("categorySuggestions", []):
        cat = s.get("category", {})
        anc = s.get("categoryTreeNodeAncestors", [])          # nearest parent first
        names = [a.get("categoryName") for a in reversed(anc)] + [cat.get("categoryName")]
        out.append({"id": cat.get("categoryId"),
                    "name": cat.get("categoryName"),
                    "path": " > ".join(n for n in names if n)})
    return out


def aspects(token, category_id, tid=None):
    tid = tid or tree_id(token)
    d = _get(token, f"/category_tree/{tid}/get_item_aspects_for_category",
             {"category_id": str(category_id)})
    required, optional = [], []
    for a in d.get("aspects", []):
        c = a.get("aspectConstraint", {})
        row = {"name": a.get("localizedAspectName"),
               "mode": c.get("aspectMode"),                   # FREE_TEXT | SELECTION_ONLY
               "values": [v.get("localizedValue") for v in a.get("aspectValues", [])][:6]}
        (required if c.get("aspectRequired") else optional).append(row)
    return required, optional


def _print_aspects(required, optional):
    print(f"  REQUIRED ({len(required)}):")
    for a in required:
        eg = f"   e.g. {', '.join(a['values'])}" if a["values"] else ""
        print(f"    - {a['name']}  [{a['mode']}]{eg}")
    print(f"  recommended / optional ({len(optional)}):")
    print("    " + ", ".join(a["name"] for a in optional))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--suggest", metavar="QUERY", help="rank leaf categories for a title")
    ap.add_argument("--aspects", metavar="CATEGORY_ID", help="required/optional specifics for a leaf")
    ap.add_argument("--for", dest="forq", metavar="QUERY", help="suggest, then aspects of the top hit")
    ap.add_argument("--creds", default=ebay_pull.DEFAULT_CREDS)
    args = ap.parse_args()

    creds = ebay_pull.load_creds(args.creds)
    token = ebay_pull.refresh_access_token(creds)
    tid = tree_id(token)

    q = args.suggest or args.forq
    if q:
        hits = suggest(token, q, tid)
        print(f"category suggestions (tree {tid}) for: {q!r}")
        for i, h in enumerate(hits[:8], 1):
            print(f"  {i}. {h['id']:>7}  {h['path']}")
        if args.forq and hits:
            top = hits[0]
            print(f"\naspects for top hit {top['id']} ({top['name']}):")
            _print_aspects(*aspects(token, top["id"], tid))
    elif args.aspects:
        print(f"aspects for category {args.aspects}:")
        _print_aspects(*aspects(token, args.aspects, tid))
    else:
        ap.error("use --suggest <query>, --aspects <id>, or --for <query>")


if __name__ == "__main__":
    main()
