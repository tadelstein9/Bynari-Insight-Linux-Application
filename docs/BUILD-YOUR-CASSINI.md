# Build your own Cassini database

Bynari Insight fills every field eBay's search algorithm reads, per category — the
complete set of *item specifics* (aspects), their allowed values, and which are
required. That knowledge lives in a local SQLite file we call **cassini.db**.

**Bynari does not ship a populated cassini.db.** The tool is open; the harvested
database is not. But the method is — and eBay's own APIs hand you everything you
need to build your own, keyed to *your* developer account. This document is the
recipe.

You end up with a `cassini.db` on your own drive, built from eBay's live data,
that the tool reads directly. No one can take it from you.

---

## What you need

- eBay developer keys (a production keyset) and an OAuth **application** token —
  the aspect and taxonomy endpoints are application-scoped, so you do not need a
  seller's user token to read them. Get keys at developer.ebay.com.
- Python 3 and `sqlite3` (both already required by the app).

## Step 1 — create the empty database

```
sqlite3 cassini.db < schema/cassini.schema.sql
export CASSINI_DB="$PWD/cassini.db"
```

`schema/cassini.schema.sql` documents every table and the eBay endpoint that
feeds it. Five tables: `categories`, `item_specifics`, `allowed_values`,
`photo_roles`, `meta`.

## Step 2 — walk the category tree → `categories`

Use the **eBay Taxonomy API**:

1. `getDefaultCategoryTreeId?marketplace_id=EBAY_US` → the tree id for your market.
2. `getCategoryTree/{treeId}` (or `getCategorySubtree` per branch to stay under
   response limits) → the full node list.

For each node write a row: `category_id`, `category_name`, `parent_id`,
`full_path` (the ancestry joined with " > "), and `leaf_category = 1` when the
node has no children (only leaves are listable).

## Step 3 — pull each category's aspects → `item_specifics` + `allowed_values`

For every **leaf** category, call the Taxonomy/Metadata API:

```
getItemAspectsForCategory?category_tree_id={treeId}&category_id={leafId}
```

For each aspect in the response:

- write `item_specifics` — `aspect_name`, `aspect_mode`
  (`FREE_TEXT` / `SELECTION_ONLY`), `required` (1 when
  `aspectConstraint.aspectRequired` is true), and `data_type`
  (`aspectDataType`: STRING, NUMBER, DATE — and the newer advanced
  `NUMERIC_RANGE`).
- for a SELECTION aspect, write each `aspectValues[].localizedValue` into
  `allowed_values`, pointing `specific_id` back at the `item_specifics.id` you
  just inserted.

**This is exactly what `scripts/refresh_cassini_aspects.py` already does.** It is
the reference implementation of this step — dry-run by default, `--apply` to
write, idempotent per category, and it refuses to overwrite good rows on a failed
or empty fetch:

```
python scripts/refresh_cassini_aspects.py --db "$CASSINI_DB" 51020 11483 --apply
```

Run it across every leaf id from Step 2 to populate the whole database. (The
script fronts these calls through a broker by default; point it at eBay directly
with your own token, or reuse the broker pattern in `engine/broker.py`.)

> eBay retires old category endpoints periodically (GetCategories was
> decommissioned 2026-03-31, GetCategoryFeatures 2026-05-04). The Taxonomy/
> Metadata API is the current source of truth; re-run this step to keep your
> cassini.db from drifting.

## Step 4 (optional) — seed photo roles → `photo_roles`

`photo_roles` is not sourced from eBay — it encodes which shots a listing in a
given category should carry, and in what order. Seed it for the categories you
sell:

```
python scripts/seed_photo_roles.py --db "$CASSINI_DB"
```

## Step 5 — point the tool at your database

The app reads `CASSINI_DB` from the environment:

```
export CASSINI_DB=/path/to/your/cassini.db
```

That's it. Every listing the tool builds now draws its aspects, required fields,
and allowed values from *your* database, built from *your* eBay account.

---

## Why it's built this way

eBay changed its ranking in February 2026 so that structurally complete listings —
every aspect filled, the way the algorithm reads them — surface and the rest
don't. A category-aspect map is the difference between a listing that ranks and
one that disappears. eBay publishes that map through its own APIs; this recipe
just captures it locally so a tool can act on it at inventory scale, offline,
without handing your data to anyone.
