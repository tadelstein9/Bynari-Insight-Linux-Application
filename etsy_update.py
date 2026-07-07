#!/usr/bin/env python3
"""etsy_update.py — push an item's CURRENT datasheet to its EXISTING Etsy draft.

Copy (title / description / tags) goes via updateListing (PATCH). Price is NOT a
listing field on Etsy -- it lives in the listing's inventory -- so it goes via the
inventory round-trip (PUT /listings/<id>/inventory). Recovers listing_id + shop_id
from photos/<slug>/etsy_draft.json and reads new values from etsy_meta.json.

NEVER publishes: the listing stays in whatever state it is (draft). Use this to
reprice / re-copy an already-pushed draft WITHOUT creating a duplicate.

Usage:
  python3 etsy_update.py --item pwt-bul-50-001 [--dry-run]
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

import etsy

LIB = os.environ.get("BYNARI_LIB", os.path.dirname(os.path.abspath(__file__)))


def _headers(cfg, ctype):
    return {"x-api-key": f"{cfg['keystring']}:{cfg['shared_secret']}",
            "Authorization": f"Bearer {etsy.valid_token(cfg)}",
            "Content-Type": ctype}


def _send(method, url, headers, data):
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"Etsy API {e.code} on {method} {url}\n  "
                 f"{e.read().decode('utf-8', 'replace')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--item", required=True, help="slug, e.g. pwt-bul-50-001")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    folder = os.path.join(LIB, "photos", a.item)
    meta = json.load(open(os.path.join(folder, "etsy_meta.json")))
    draft = json.load(open(os.path.join(folder, "etsy_draft.json")))
    lid, sid = draft["listing_id"], draft["shop_id"]

    title = meta.get("title") or ""
    desc = meta.get("description") or ""
    tags = ",".join(meta.get("tags") or [])
    materials = ",".join(meta.get("materials") or [])
    price = float(meta["price"])
    sku = meta.get("sku")
    if not sku:
        try:
            sku = json.load(open(os.path.join(folder, "ebay_meta.json"))).get("sku", "")
        except Exception:
            sku = ""

    print(f"UPDATE listing {lid} (shop {sid}) — state stays DRAFT")
    print(f"  title : {title[:88]}")
    print(f"  tags  : {tags}")
    print(f"  price : {price:.2f}   sku: {sku or '(none)'}")
    if a.dry_run:
        print("--dry-run: nothing sent.")
        return

    cfg = etsy.load_app()

    # 1) copy -> updateListing (PATCH, form-encoded)
    body = urllib.parse.urlencode(
        {"title": title, "description": desc, "tags": tags, "materials": materials}).encode()
    _send("PATCH", f"{etsy.API_BASE}/shops/{sid}/listings/{lid}",
          _headers(cfg, "application/x-www-form-urlencoded"), body)
    print("  copy updated (title / description / tags)")

    # 2) price -> inventory round-trip: GET current, change ONLY price, PUT back.
    # Etsy rejects a hand-built offering ("All offerings need readiness state"), so
    # preserve the real structure and just strip the read-only ids Etsy won't accept.
    inv = _send("GET", f"{etsy.API_BASE}/listings/{lid}/inventory",
                _headers(cfg, "application/json"), None)
    products = inv.get("products", [])
    for p in products:
        p.pop("product_id", None)
        p.pop("is_deleted", None)
        if sku and not p.get("sku"):
            p["sku"] = sku
        for off in p.get("offerings", []):
            off.pop("offering_id", None)
            off.pop("is_deleted", None)
            off["price"] = price  # float dollars; keeps quantity/is_enabled/readiness
    body = json.dumps({
        "products": products,
        "price_on_property": inv.get("price_on_property", []),
        "quantity_on_property": inv.get("quantity_on_property", []),
        "sku_on_property": inv.get("sku_on_property", []),
    }).encode()
    _send("PUT", f"{etsy.API_BASE}/listings/{lid}/inventory",
          _headers(cfg, "application/json"), body)
    print(f"  price updated -> {price:.2f}")

    print(f"\nReview: https://www.etsy.com/your/shops/me/tools/listings/{lid}")


if __name__ == "__main__":
    main()
