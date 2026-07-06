#!/usr/bin/env python3
"""Bulk-fill eBay's Draft-listing CSV from many items in library.db.

The multi-item sibling of make_ebay_csv.py. Where that one fills a single row
from one listing.json, this rolls up N items from the inventory brain into one
CSV: eBay's exact #INFO header + column row, then one Draft row per item. The
seller uploads it once via Seller Hub -> Reports -> Upload (human-initiated, no
API, no automation) and gets N drafts to finish.

Each row pulls its OWN category, condition, title, price, and photos from the
item's own DB row, so a mixed pile (watches + whatever else) just works — no
hardcoded category. Photos are referenced by URL (eBay requires links, not
uploads); the local files must already be hosted under <base-url>/<slug>/...
(that's the host_photos.sh step).

By default only items that are NOT already live are drafted (an item with an
'active' listings row is skipped) so we never re-draft something on eBay. Use
--slugs to target specific items or --all to include everything.
"""
import argparse
import csv
import os
import sqlite3

# eBay listing-condition strings -> condition IDs. Vintage/used stock is 3000.
CONDITION_IDS = {
    "new": "1000", "brand new": "1000",
    "new other": "1500", "new with defects": "1750", "open box": "1500",
    "certified refurbished": "2000", "seller refurbished": "2500",
    "used": "3000", "pre-owned": "3000", "used_excellent": "3000",
    "very good": "3000", "good": "3000", "acceptable": "3000",
    "for parts or not working": "7000", "for parts": "7000",
}
DEFAULT_CONDITION_ID = "3000"  # Pre-owned

# Tertiary photo ordering when sort_order is absent: lead with the hero shot.
ROLE_PRIO = {"dial": 0, "hunter-cover-closed": 1, "enamel-back": 1, "front": 1,
             "movement": 2, "caseback-marking": 3, "back": 3, "size-caliper": 4}


def condition_id(raw):
    if not raw:
        return DEFAULT_CONDITION_ID
    s = str(raw).strip()
    if s.isdigit():            # already an eBay condition ID
        return s
    return CONDITION_IDS.get(s.lower(), DEFAULT_CONDITION_ID)


def photo_urls_for(con, item_id, slug, base):
    rows = con.execute(
        "SELECT file_path, role, sort_order, representative FROM photos "
        "WHERE item_id = ?", (item_id,)).fetchall()
    rows.sort(key=lambda p: (
        p["sort_order"] if p["sort_order"] is not None else 999,
        0 if p["representative"] else 1,
        ROLE_PRIO.get(p["role"] or "", 5),
        os.path.basename(p["file_path"] or ""),
    ))
    return "|".join(
        f"{base}/{slug}/{os.path.basename(p['file_path'])}" for p in rows
        if p["file_path"])


def select_items(con, slugs, include_all):
    if slugs:
        q = ("SELECT * FROM items WHERE slug IN (%s)"
             % ",".join("?" * len(slugs)))
        return con.execute(q, slugs).fetchall()
    if include_all:
        return con.execute("SELECT * FROM items ORDER BY id").fetchall()
    # default: skip items already live on eBay
    return con.execute(
        "SELECT * FROM items i WHERE NOT EXISTS ("
        "  SELECT 1 FROM listings l WHERE l.item_id = i.id "
        "  AND l.status = 'active') ORDER BY i.id").fetchall()


def template_header(path):
    """Keep eBay's template lines up to & including the 'Action(' column row."""
    header = []
    for ln in open(path, encoding="utf-8").read().splitlines():
        header.append(ln)
        if ln.startswith("Action("):
            break
    return header


def build_row(con, it, base):
    photos = photo_urls_for(con, it["id"], it["slug"], base)
    desc = it["description"] or ""
    return [
        "Draft",
        it["slug"],                                  # Custom label (SKU)
        it["category_id"] or "",                     # Category ID (per item)
        it["title"] or "",                           # Title
        "",                                          # UPC
        ("" if it["price"] is None else f'{it["price"]:g}'),  # Price
        "1",                                         # Quantity
        photos,                                      # Item photo URL (pipe-sep)
        condition_id(it["condition"]),               # Condition ID (per item)
        f"<p>{desc}</p>" if desc else "",            # Description (HTML)
        "FixedPrice",                                # Format
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="path to library.db")
    ap.add_argument("--template", required=True, help="eBay draft CSV template")
    ap.add_argument("--base-url", required=True,
                    help="public photo base, e.g. https://bynari-insight.com/img")
    ap.add_argument("--out", required=True)
    ap.add_argument("--slugs", nargs="*", help="only these item slugs")
    ap.add_argument("--all", action="store_true",
                    help="include items already live (normally skipped)")
    a = ap.parse_args()

    con = sqlite3.connect(a.db)
    con.row_factory = sqlite3.Row
    base = a.base_url.rstrip("/")

    items = select_items(con, a.slugs, a.all)
    header = template_header(a.template)

    rows, skipped = [], []
    for it in items:
        row = build_row(con, it, base)
        if not row[7]:          # no photos -> not listable yet, but keep visible
            skipped.append(it["slug"])
        rows.append(row)

    with open(a.out, "w", newline="", encoding="utf-8") as f:
        for ln in header:
            f.write(ln + "\n")
        w = csv.writer(f, lineterminator="\n")
        for row in rows:
            w.writerow(row)

    print(f"wrote {a.out}: {len(rows)} draft rows")
    for it in items:
        print(f"   {it['slug']:<20} cat={it['category_id'] or '?':<8} "
              f"cond={condition_id(it['condition'])}  {(it['title'] or '')[:50]}")
    if skipped:
        print(f"\n  NOTE: {len(skipped)} item(s) have no hosted photos yet "
              f"(host_photos.sh first): {', '.join(skipped)}")


if __name__ == "__main__":
    main()
