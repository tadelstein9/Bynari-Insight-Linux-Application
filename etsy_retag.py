#!/usr/bin/env python3
"""etsy_retag.py — push an item's full tag set onto an existing Etsy listing.

Use it to repair listings created before the tags-encoding fix (those kept only
the last tag). Reads tags from the item's etsy_meta.json and the listing_id from
its etsy_draft.json, then PATCHes the live listing via updateListing.

Usage:
  python3 etsy_retag.py --item ebay-298089439840
  python3 etsy_retag.py --item ebay-298089439840 --listing 4529445559
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error

import etsy

HERE = os.path.dirname(os.path.abspath(__file__))


def patch_listing(cfg, sid, listing_id, fields):
    token = etsy.valid_token(cfg)
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(
        f"{etsy.API_BASE}/shops/{sid}/listings/{listing_id}",
        data=body, method="PATCH",
        headers={"x-api-key": f"{cfg['keystring']}:{cfg['shared_secret']}",
                 "Authorization": f"Bearer {token}",
                 "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"Etsy API {e.code}: {e.read().decode('utf-8', 'replace')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--item", required=True, help="slug, e.g. ebay-298089439840")
    ap.add_argument("--listing", help="listing_id (else read from etsy_draft.json)")
    args = ap.parse_args()

    folder = os.path.join(HERE, "photos", args.item)
    meta = json.load(open(os.path.join(folder, "etsy_meta.json")))
    tags = meta.get("tags", [])
    if not tags:
        sys.exit("no tags in etsy_meta.json")

    listing_id = args.listing
    if not listing_id:
        draft = json.load(open(os.path.join(folder, "etsy_draft.json")))
        listing_id = draft["listing_id"]

    cfg = etsy.load_app()
    sid = etsy.whoami_quiet(cfg)["shop_id"]
    print(f"Patching listing {listing_id} with {len(tags)} tags: {', '.join(tags)}")
    res = patch_listing(cfg, sid, listing_id, {"tags": ",".join(tags)})
    print(f"  done — listing now has {len(res.get('tags', []))} tags: "
          f"{', '.join(res.get('tags', []))}")


if __name__ == "__main__":
    main()
