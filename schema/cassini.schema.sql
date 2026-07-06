-- cassini.schema.sql
-- The schema for a "Cassini" database: a local snapshot of eBay's category tree
-- and the item-specifics (aspects) each category expects, so a listing tool can
-- fill every field the search algorithm reads.
--
-- This file ships EMPTY on purpose. Bynari does not distribute a populated
-- cassini.db — you build your own by walking eBay's public APIs with your own
-- developer keys (BYOK). See docs/BUILD-YOUR-CASSINI.md for the step-by-step.
--
-- Create an empty database:
--     sqlite3 cassini.db < schema/cassini.schema.sql
--
-- Then point the tool at it:  export CASSINI_DB=/path/to/cassini.db

-- The category tree.  Source: eBay Taxonomy API — getDefaultCategoryTreeId +
-- getCategoryTree / getCategorySubtree.  leaf_category=1 marks a listable leaf.
CREATE TABLE categories (
    category_id   TEXT PRIMARY KEY,
    category_name TEXT NOT NULL,
    parent_id     TEXT,
    full_path     TEXT,               -- e.g. "Jewelry & Watches > Watches > Wristwatches"
    leaf_category INTEGER DEFAULT 0
);

-- The aspects (item specifics) each category expects.  Source: eBay Taxonomy/
-- Metadata API — getItemAspectsForCategory.  aspect_mode = FREE_TEXT | SELECTION_ONLY;
-- required = 1 when eBay flags it REQUIRED; data_type carries the aspect data type
-- (STRING, NUMBER, DATE, and the newer NUMERIC_RANGE advanced type).
CREATE TABLE item_specifics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id TEXT NOT NULL,
    aspect_name TEXT NOT NULL,
    aspect_mode TEXT,
    required    INTEGER DEFAULT 0,
    data_type   TEXT
);

-- The allowed values for a SELECTION aspect (its dropdown options).  Source: the
-- same getItemAspectsForCategory response (aspectValues[].localizedValue).
CREATE TABLE allowed_values (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    specific_id INTEGER NOT NULL,     -- -> item_specifics.id
    value       TEXT NOT NULL
);

-- Per-category photo roles (which shots a listing in this category should carry,
-- and in what order).  Populated by seed_photo_roles.py; not sourced from eBay.
CREATE TABLE photo_roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id TEXT NOT NULL,
    family      TEXT,
    role_name   TEXT NOT NULL,
    sort_order  INTEGER,
    UNIQUE(category_id, role_name)
);

-- Freeform metadata: when the tree was built, which category-tree version, etc.
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
