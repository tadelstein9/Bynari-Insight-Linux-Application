#!/usr/bin/env python3
"""ebay_metadata.py — ask eBay which item conditions a category actually allows,
before you publish. Stdlib only; reuses ebay_pull for OAuth. Read-only.

Kills the 25021 "condition id is invalid for the selected primary category id"
wall: getItemConditionPolicies returns the valid conditions for a leaf category,
so you learn them up front instead of at the publish error.

  python3 ebay_metadata.py --conditions 57720
"""
import argparse
import json
import sys
import urllib.parse
import urllib.request
import urllib.error

import ebay_pull  # load_creds / refresh_access_token

METADATA = "https://api.ebay.com/sell/metadata/v1"
MARKETPLACE = "EBAY_US"

# conditionId -> Inventory API condition enum (the common, stable ones the
# Sell Inventory API accepts). Unknown ids fall back to showing just the id.
COND_ENUM = {
    "1000": "NEW", "1500": "NEW_OTHER", "1750": "NEW_WITH_DEFECTS",
    "2000": "CERTIFIED_REFURBISHED", "2010": "EXCELLENT_REFURBISHED",
    "2020": "VERY_GOOD_REFURBISHED", "2030": "GOOD_REFURBISHED",
    "2500": "SELLER_REFURBISHED", "2750": "LIKE_NEW",
    "3000": "USED_EXCELLENT", "4000": "USED_VERY_GOOD",
    "5000": "USED_GOOD", "6000": "USED_ACCEPTABLE",
    "7000": "FOR_PARTS_OR_NOT_WORKING",
}


def _get(token, path, params=None):
    url = METADATA + path
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
        sys.exit(f"Metadata API {e.code} on GET {url}\n  "
                 f"{e.read().decode('utf-8', 'replace')[:600]}")


def item_conditions(token, category_id):
    """Return (condition_required, [ {id, name, enum} ]) for a leaf category."""
    d = _get(token, f"/marketplace/{MARKETPLACE}/get_item_condition_policies",
             {"filter": f"categoryIds:{{{category_id}}}"})
    pols = d.get("itemConditionPolicies", [])
    if not pols:
        return None, []
    p = pols[0]
    conds = [{"id": c.get("conditionId"),
              "name": c.get("conditionDescription"),
              "enum": COND_ENUM.get(c.get("conditionId"), "(enum: verify)")}
             for c in p.get("itemConditions", [])]
    return p.get("itemConditionRequired"), conds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--conditions", metavar="CATEGORY_ID", required=True,
                    help="valid item conditions for a leaf category")
    ap.add_argument("--creds", default=ebay_pull.DEFAULT_CREDS)
    args = ap.parse_args()

    creds = ebay_pull.load_creds(args.creds)
    token = ebay_pull.refresh_access_token(creds)
    required, conds = item_conditions(token, args.conditions)
    if not conds:
        print(f"category {args.conditions}: no condition policy returned")
        return
    print(f"category {args.conditions}: condition "
          f"{'REQUIRED' if required else 'optional'}, {len(conds)} allowed:")
    for c in conds:
        print(f"  {c['id']:>5}  {(c['name'] or ''):<30}  {c['enum']}")


if __name__ == "__main__":
    main()
