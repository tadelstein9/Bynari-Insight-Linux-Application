#!/usr/bin/env python3
"""etsy_verify.py — read back every pushed listing from Etsy and summarize it.

Walks photos/<slug>/etsy_draft.json for each item we've pushed, fetches the live
listing, and prints state / price / tag count / photo count / taxonomy so we can
confirm the drafts (and the published catalog) look right.

Usage: python3 etsy_verify.py
"""
import glob
import json
import os

import etsy

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    cfg = etsy.load_app()
    rows = []
    for path in sorted(glob.glob(os.path.join(HERE, "photos", "*", "etsy_draft.json"))):
        slug = os.path.basename(os.path.dirname(path))
        lid = json.load(open(path))["listing_id"]
        try:
            d = etsy.api_get(cfg, f"/listings/{lid}", {"includes": "Images"})
        except SystemExit:
            rows.append({"slug": slug, "id": lid, "state": "GONE/deleted",
                         "price": 0, "tags": 0, "imgs": 0, "tax": "-", "title": ""})
            continue
        price = d.get("price", {})
        amt = price.get("amount", 0) / (price.get("divisor", 100) or 100)
        rows.append({
            "slug": slug, "id": lid, "state": d.get("state"),
            "price": amt, "tags": len(d.get("tags", [])),
            "imgs": len(d.get("images") or []),
            "tax": d.get("taxonomy_id"),
            "title": (d.get("title") or "")[:48],
        })

    print(f"{'state':8} {'price':>8} {'tags':>4} {'img':>3} {'tax':>6}  {'listing_id':>11}  title")
    print("-" * 100)
    for r in rows:
        flag = "" if (r["tags"] >= 1 and r["imgs"] >= 1) else "  <-- CHECK"
        print(f"{r['state']:8} {r['price']:8.2f} {r['tags']:>4} {r['imgs']:>3} "
              f"{str(r['tax']):>6}  {r['id']:>11}  {r['title']}{flag}")
    print(f"\n{len(rows)} listings.")


if __name__ == "__main__":
    main()
