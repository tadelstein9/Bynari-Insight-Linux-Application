#!/usr/bin/env python3
"""Emit eBay MIP product-combined.csv for one item from a Bynari listing.json.

Uses the real product-combined.csv sample's header verbatim (column order/names match
eBay exactly), drops the leading "Remove this column", and fills one data row.
Item specifics -> Attribute Name/Value pairs (Brand has its own column);
photos -> Picture URL 1..12; condition -> eBay enum string.
"""
import csv, json, argparse

ap = argparse.ArgumentParser()
ap.add_argument("--listing", required=True)
ap.add_argument("--sample", required=True)   # eBay's product-combined.csv (for the header)
ap.add_argument("--base-url", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--location-id", default="")
ap.add_argument("--shipping-policy", default="<<YOUR_SHIPPING_POLICY_NAME>>")
ap.add_argument("--payment-policy", default="<<YOUR_PAYMENT_POLICY_NAME>>")
ap.add_argument("--return-policy", default="<<YOUR_RETURN_POLICY_NAME>>")
a = ap.parse_args()

L = json.load(open(a.listing))
spec = dict(L.get("specifics", {}))
brand = spec.pop("Brand", "")            # Brand rides its own column, not an Attribute pair

ROLE_PRIO = {"dial": 0, "hunter-cover-closed": 1, "enamel-back": 1,
             "movement": 2, "caseback-marking": 3, "size-caliper": 4}
photos = sorted(L.get("photos", []),
                key=lambda p: (ROLE_PRIO.get(p.get("role", ""), 5), p["file"]))
base = a.base_url.rstrip("/")
photo_urls = [f"{base}/{p['file']}" for p in photos][:12]

# eBay conditionId 3000 (Pre-owned, watches) -> MIP enum. CONFIRM via category-metadata.
COND_ENUM = {"1000": "NEW", "1500": "NEW_OTHER", "2750": "LIKE_NEW",
             "3000": "USED_EXCELLENT", "7000": "FOR_PARTS_OR_NOT_WORKING"}
cond = COND_ENUM.get("3000", "USED_EXCELLENT")

vals = {
    "SKU": L.get("item_ref", "ladies-346"),
    "Localized For": "en_US",
    "Title": L.get("title", ""),
    "Product Description": "<p>" + L.get("description", "") + "</p>",
    "Brand": brand,
    "UPC": "",
    "Condition": cond,
    "Total Ship To Home Quantity": "1",
    "Channel ID": "EBAY_US",
    "Warehouse Location ID": a.location_id,
    "Category": L.get("category", {}).get("id", "260326"),
    "List Price": L.get("price") or "",
    "Format": "FixedPrice",
    "ListingDuration": "GTC",
    # business-policy NAMES are seller-specific (must match the seller's eBay policies exactly):
    "Shipping Policy": a.shipping_policy,
    "Payment Policy": a.payment_policy,
    "Return Policy": a.return_policy,
}
for i, url in enumerate(photo_urls, 1):
    vals[f"Picture URL {i}"] = url
for i, (k, v) in enumerate(spec.items(), 1):
    vals[f"Attribute Name {i}"] = k
    vals[f"Attribute Value {i}"] = v

# Use eBay's exact header; drop the instructional first column.
with open(a.sample, newline="", encoding="utf-8") as f:
    header = next(csv.reader(f))
out_cols = [c for c in header if c.strip() != "Remove this column"]
row = [vals.get(c, vals.get(c.strip(), "")) for c in out_cols]

with open(a.out, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(out_cols)
    w.writerow(row)

print("wrote:", a.out, f"({len(out_cols)} columns)")
print("\nfilled fields:")
for c in out_cols:
    v = vals.get(c) or vals.get(c.strip())
    if v:
        print(f"  {c:>28} : {v[:70]}")
