#!/usr/bin/env python3
"""Seed cassini.db with per-category PHOTO ROLES (the canonical record).

Why this exists
---------------
On 2026-06-14 eBay's Sell flow began showing category-specific NAMED photo
slots (watch -> Front/Back/Dial/Clasp closed/Clasp open/Packaging/Certificate;
clothing -> Front/Back/Brand/Detail/Measurement/Size/Materials; computer
keyboards -> none). These slots are NOT exposed through eBay's public Taxonomy
API (getItemAspectsForCategory returns item specifics, not photo slots), so
Bynari must own the taxonomy itself — the same way cassini.db already owns the
per-category item-specifics schema.

This script adds a `photo_roles` table keyed by `category_id` (exactly like
`item_specifics`) and populates it per LEAF category by applying family rules
over each category's `full_path`. The rules mirror photo_roles.json, which the
desktop app reads at runtime (the app does not open cassini.db directly).

Idempotent: re-running replaces the seeded rows for the families below without
touching anything else. Read the categories table; write only photo_roles.

Usage:
    python scripts/seed_photo_roles.py [path/to/cassini.db]
Defaults to the bundled dev copy if no path is given.
"""
import os
import sqlite3
import sys

DEFAULT_DB = os.environ.get("CASSINI_DB", "cassini.db")

# Family rules. A leaf category joins a family when its full_path contains any
# `path_any` substring OR its category_name matches any `name_any` token.
# Keep in lockstep with photo_roles.json (the runtime copy).
FAMILIES = {
    "watch": {
        "path_any": ["Watches, Parts & Accessories", "Wristwatch"],
        "name_any": ["Wristwatch", "Wristwatches"],
        "roles": [
            "Front", "Back", "Right profile", "Left profile", "Dial",
            "Clasp closed", "Clasp open", "Packaging", "Certificate",
        ],
    },
    "clothing": {
        "path_any": [],
        "name_any": [
            "Jeans", "Pants", "Trousers", "Shirt", "T-Shirt", "Polo", "Blouse",
            "Dress", "Skirt", "Shorts", "Jacket", "Coat", "Sweater", "Hoodie",
            "Sweatshirt",
        ],
        "roles": [
            "Front", "Back", "Brand", "Detail", "Measurement", "Size",
            "Materials",
        ],
    },
}


def _matches(family, name, path):
    name = name or ""
    path = path or ""
    if any(p in path for p in family["path_any"]):
        return True
    return any(tok == name or tok in name for tok in family["name_any"])


def main(argv):
    db = argv[1] if len(argv) > 1 else DEFAULT_DB
    if not os.path.exists(db):
        sys.stderr.write(f"cassini.db not found: {db}\n")
        return 1
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    try:
        con.execute(
            """CREATE TABLE IF NOT EXISTS photo_roles (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id TEXT NOT NULL,
                family      TEXT,
                role_name   TEXT NOT NULL,
                sort_order  INTEGER,
                UNIQUE(category_id, role_name)
            )"""
        )
        # Clear only the families we're about to reseed (idempotent re-run).
        con.execute(
            "DELETE FROM photo_roles WHERE family IN (%s)"
            % ",".join("?" * len(FAMILIES)),
            tuple(FAMILIES.keys()),
        )
        leaves = con.execute(
            "SELECT category_id, category_name, full_path "
            "FROM categories WHERE leaf_category = 1"
        ).fetchall()
        per_family = {f: 0 for f in FAMILIES}
        rows = 0
        for leaf in leaves:
            for fname, fam in FAMILIES.items():
                if _matches(fam, leaf["category_name"], leaf["full_path"]):
                    for i, role in enumerate(fam["roles"], 1):
                        con.execute(
                            "INSERT OR REPLACE INTO photo_roles "
                            "(category_id, family, role_name, sort_order) "
                            "VALUES (?,?,?,?)",
                            (leaf["category_id"], fname, role, i),
                        )
                        rows += 1
                    per_family[fname] += 1
                    break  # one family per leaf
        con.commit()
        cats = sum(per_family.values())
        print(f"Seeded photo_roles: {rows} role rows across {cats} leaf categories.")
        for fname, n in per_family.items():
            print(f"  {fname}: {n} categories x {len(FAMILIES[fname]['roles'])} roles")
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
