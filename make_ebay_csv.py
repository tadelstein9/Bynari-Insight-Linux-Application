#!/usr/bin/env python3
"""Fill eBay's Draft-listing CSV template from a Bynari listing.json.

Preserves eBay's exact #INFO header lines + column header, drops the sample row,
writes one Draft row for the item. The seller uploads the result via
Seller Hub -> Reports -> Upload (human-initiated; no API, no automation).
"""
import csv, json, argparse

ap = argparse.ArgumentParser()
ap.add_argument("--listing", required=True)
ap.add_argument("--template", required=True)
ap.add_argument("--base-url", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()

L = json.load(open(a.listing))

# Gallery order: a dial shot leads (it's what a watch buyer wants to see), then the rest.
ROLE_PRIO = {"dial": 0, "hunter-cover-closed": 1, "enamel-back": 1,
             "movement": 2, "caseback-marking": 3, "size-caliper": 4}
photos = sorted(L.get("photos", []),
                key=lambda p: (ROLE_PRIO.get(p.get("role", ""), 5), p["file"]))
base = a.base_url.rstrip("/")
photo_urls = "|".join(f"{base}/{p['file']}" for p in photos)

row = ["Draft",
       L.get("item_ref", "ladies-346"),                 # Custom label (SKU)
       L.get("category", {}).get("id", "260326"),        # Category ID
       L.get("title", ""),                               # Title
       "",                                               # UPC (vintage, none)
       L.get("price") or "",                             # Price (seller-set $50)
       "1",                                              # Quantity
       photo_urls,                                        # Item photo URL (pipe-sep)
       "3000",                                           # Condition ID = Pre-owned
       "<p>" + L.get("description", "") + "</p>",         # Description (HTML)
       "FixedPrice"]                                      # Format

# Keep eBay's template header verbatim, up to & including the "Action(" column row; drop sample.
header = []
for ln in open(a.template, encoding="utf-8").read().splitlines():
    header.append(ln)
    if ln.startswith("Action("):
        break

with open(a.out, "w", newline="", encoding="utf-8") as f:
    for ln in header:
        f.write(ln + "\n")
    csv.writer(f, lineterminator="\n").writerow(row)

print("wrote:", a.out)
print(f"photos ({len(photos)}), gallery order:")
for p in photos:
    print(f"   {p['role'] or '?':>18}  {p['file']}")
