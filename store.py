"""Local template store for Bynari Insight — SQLite on the seller's own drive.

The library lives in a folder the seller chooses (local disk or a USB-C SSD),
so the data is portable and theirs: no server, no account. Until the seller
points it at a drive, it defaults to a per-user app folder. The chosen folder
is remembered in a small config file in the per-user app folder, so we can find
an external drive again on the next launch.

This module has no Pywebview / UI dependency — it's pure SQLite, so it can be
unit-tested on its own. app.py exposes it to the JS layer over the bridge.
"""
import base64
import json
import os
import sqlite3
import time

CONFIG_DIRNAME = ".bynari-insight"
CONFIG_FILE = "config.json"
DB_FILENAME = "library.db"
IMAGES_DIRNAME = "images"


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _default_base_dir():
    return os.path.join(os.path.expanduser("~"), CONFIG_DIRNAME)


def _config_path():
    # Config always lives in the per-user app folder, even when the library
    # itself is on an external drive — that's how we relocate the drive later.
    return os.path.join(_default_base_dir(), CONFIG_FILE)


def load_storage_dir():
    """Return the folder holding the library, or the per-user default."""
    try:
        with open(_config_path(), "r", encoding="utf-8") as f:
            d = json.load(f).get("storage_dir")
            if d and os.path.isdir(d):
                return d
    except (OSError, ValueError):
        pass
    return _default_base_dir()


def save_storage_dir(path):
    os.makedirs(_default_base_dir(), exist_ok=True)
    with open(_config_path(), "w", encoding="utf-8") as f:
        json.dump({"storage_dir": path}, f)


class TemplateStore:
    """SQLite-backed template library at <base_dir>/library.db."""

    def __init__(self, base_dir=None):
        self.base_dir = base_dir or load_storage_dir()
        os.makedirs(self.base_dir, exist_ok=True)
        os.makedirs(os.path.join(self.base_dir, IMAGES_DIRNAME), exist_ok=True)
        self.db_path = os.path.join(self.base_dir, DB_FILENAME)
        self._init_db()

    def _conn(self):
        c = sqlite3.connect(self.db_path)
        c.row_factory = sqlite3.Row
        return c

    def _init_db(self):
        with self._conn() as c:
            c.execute(
                """CREATE TABLE IF NOT EXISTS templates (
                    id          TEXT PRIMARY KEY,
                    name        TEXT,
                    category_id TEXT,
                    updated_at  TEXT,
                    doc         TEXT NOT NULL
                )"""
            )
            # Reconcile an older relational `templates` table (from
            # build_library_row1.py) that has no `doc` column — the app stores
            # each template as a JSON doc. Without this, every template_save /
            # templates_list against such a library silently fails. An empty old
            # table is dropped and recreated; a populated one is left untouched
            # for manual migration so no data is lost.
            tcols = {r["name"] for r in c.execute("PRAGMA table_info(templates)")}
            if "doc" not in tcols and c.execute(
                    "SELECT COUNT(*) FROM templates").fetchone()[0] == 0:
                c.execute("DROP TABLE templates")
                c.execute(
                    """CREATE TABLE templates (
                        id          TEXT PRIMARY KEY,
                        name        TEXT,
                        category_id TEXT,
                        updated_at  TEXT,
                        doc         TEXT NOT NULL
                    )"""
                )
            # Inventory brain — items / photos / listings. Created idempotently so
            # a fresh install gets a working library; on the seller's existing
            # library.db (built by build_library_row1.py) these already exist and
            # the IF NOT EXISTS is a no-op. Schema mirrors that build script.
            c.execute(
                """CREATE TABLE IF NOT EXISTS items (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug          TEXT UNIQUE NOT NULL,
                    what          TEXT,
                    brand         TEXT,
                    category_id   INTEGER,
                    category_path TEXT,
                    caliber       TEXT,
                    sell_as       TEXT,
                    state         TEXT,
                    title         TEXT,
                    condition     TEXT,
                    description   TEXT,
                    price         REAL,
                    folder_path   TEXT,
                    template_id   INTEGER REFERENCES templates(id),
                    created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at    TEXT DEFAULT CURRENT_TIMESTAMP
                )"""
            )
            c.execute(
                """CREATE TABLE IF NOT EXISTS photos (
                    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                    item_id            INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                    file_path          TEXT NOT NULL,
                    kind               TEXT,
                    role               TEXT,
                    shows              TEXT,
                    condition_evidence TEXT,
                    representative     INTEGER DEFAULT 0,
                    sort_order         INTEGER,
                    source             TEXT,
                    source_url         TEXT,
                    original_name      TEXT,
                    sha256             TEXT,
                    width              INTEGER,
                    height             INTEGER
                )"""
            )
            # Self-heal a photos table created by an older store.py (or the
            # pre-v2 build script) — add the copy-in provenance/quality columns
            # if missing. Mirrors migrate_library_2026-06-12.py; idempotent.
            have = {row["name"] for row in c.execute("PRAGMA table_info(photos)")}
            for col, decl in (
                ("source", "TEXT"), ("source_url", "TEXT"),
                ("original_name", "TEXT"), ("sha256", "TEXT"),
                ("width", "INTEGER"), ("height", "INTEGER"),
            ):
                if col not in have:
                    c.execute(f"ALTER TABLE photos ADD COLUMN {col} {decl}")
            c.execute(
                """CREATE TABLE IF NOT EXISTS listings (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                    ebay_item_no TEXT,
                    status       TEXT,
                    listed_at    TEXT,
                    ended_at     TEXT,
                    created_at   TEXT DEFAULT CURRENT_TIMESTAMP
                )"""
            )
            # Small key/value store for UI flags that must survive a relaunch
            # (e.g. "the inventory intro was already seen"). Lives on the
            # seller's drive because pywebview's http_server picks a fresh port
            # each launch, so the page origin — and any localStorage — changes,
            # making localStorage unreliable for cross-launch persistence.
            c.execute(
                """CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT
                )"""
            )

    # --- Small persistent settings (UI flags that outlive a launch) ---
    def get_setting(self, key, default=None):
        with self._conn() as c:
            row = c.execute(
                "SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_setting(self, key, value):
        with self._conn() as c:
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, None if value is None else str(value)))
        return {"ok": True}

    def list_templates(self):
        with self._conn() as c:
            rows = c.execute(
                "SELECT doc FROM templates ORDER BY updated_at DESC"
            ).fetchall()
        return [json.loads(r["doc"]) for r in rows]

    def save_template(self, t):
        if not isinstance(t, dict) or not t.get("id"):
            return None
        t = dict(t)
        t["updated_at"] = _now()
        if not t.get("created_at"):
            t["created_at"] = t["updated_at"]
        with self._conn() as c:
            c.execute(
                "INSERT OR REPLACE INTO templates "
                "(id, name, category_id, updated_at, doc) VALUES (?, ?, ?, ?, ?)",
                (t["id"], t.get("name", ""), t.get("categoryId", ""),
                 t["updated_at"], json.dumps(t)),
            )
        return t

    def delete_template(self, tid):
        with self._conn() as c:
            c.execute("DELETE FROM templates WHERE id = ?", (tid,))
        return {"deleted": True}

    # --- Inventory (items / photos / listings) ---
    def ensure_ebay_item(self, meta):
        """Create or update an item row for an imported eBay listing, plus its
        listings row. Returns {'id', 'slug', 'folder'} for the photo pipeline.

        Keyed on a stable slug `ebay-<item_no>` so re-importing the same listing
        updates rather than duplicates. Photos land in <library>/photos/<slug>/.
        Pure SQLite — the photo copy-in (Pillow/requests) is the caller's job.
        """
        item_no = str(meta.get("item_no") or "").strip()
        slug = meta.get("slug") or (f"ebay-{item_no}" if item_no else None)
        if not slug:
            return None
        folder = os.path.join(self.base_dir, "photos", slug)
        with self._conn() as c:
            c.execute(
                "INSERT INTO items (slug, what, brand, category_id, category_path, "
                "title, state, folder_path) VALUES (?,?,?,?,?,?,?,?) "
                "ON CONFLICT(slug) DO UPDATE SET "
                "title=excluded.title, brand=excluded.brand, "
                "category_id=excluded.category_id, category_path=excluded.category_path, "
                "folder_path=excluded.folder_path, updated_at=CURRENT_TIMESTAMP",
                (slug, meta.get("what"), meta.get("brand"), meta.get("category_id"),
                 meta.get("category_path"), meta.get("title"), "listed", folder),
            )
            item_id = c.execute(
                "SELECT id FROM items WHERE slug = ?", (slug,)).fetchone()["id"]
            if item_no and not c.execute(
                "SELECT 1 FROM listings WHERE item_id = ? AND ebay_item_no = ?",
                (item_id, item_no),
            ).fetchone():
                c.execute(
                    "INSERT INTO listings (item_id, ebay_item_no, status) "
                    "VALUES (?, ?, 'active')", (item_id, item_no))
        return {"id": item_id, "slug": slug, "folder": folder}

    _IMG_MIME = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png",
                 "webp": "webp", "gif": "gif"}
    _HERO_MAX_BYTES = 4 * 1024 * 1024  # don't inline huge originals into the UI

    def _hero_data_url(self, item_id):
        """Return a data: URL for the item's representative still photo, or None.

        Photos are referenced in place (originals never moved); we read and
        base64-encode the representative hero so the Inventory grid can show a
        real thumbnail. Videos and oversized/missing files are skipped.
        """
        with self._conn() as c:
            row = c.execute(
                """SELECT file_path FROM photos
                   WHERE item_id = ? AND (kind IS NULL OR kind = 'photo')
                   ORDER BY (role = 'hero') DESC, representative DESC, sort_order
                   LIMIT 1""",
                (item_id,),
            ).fetchone()
        if not row:
            return None
        path = row["file_path"]
        ext = os.path.splitext(path or "")[1].lower().lstrip(".")
        mime = self._IMG_MIME.get(ext)
        if not mime:
            return None
        try:
            if os.path.getsize(path) > self._HERO_MAX_BYTES:
                return None
            with open(path, "rb") as f:
                raw = f.read()
        except OSError:
            return None
        return f"data:image/{mime};base64," + base64.b64encode(raw).decode("ascii")

    def list_items(self):
        """Every inventory item, newest first, with its current eBay listing
        (item number + status) and a hero thumbnail when one exists."""
        with self._conn() as c:
            rows = c.execute(
                "SELECT * FROM items ORDER BY updated_at DESC, id DESC"
            ).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                lst = c.execute(
                    """SELECT ebay_item_no, status FROM listings
                       WHERE item_id = ? ORDER BY id DESC LIMIT 1""",
                    (r["id"],),
                ).fetchone()
                d["ebay_item_no"] = lst["ebay_item_no"] if lst else None
                d["listing_status"] = lst["status"] if lst else None
                d["photo_count"] = c.execute(
                    "SELECT COUNT(*) n FROM photos WHERE item_id = ?", (r["id"],)
                ).fetchone()["n"]
                out.append(d)
        # Hero thumbnail outside the connection loop (file I/O, not SQL).
        for d in out:
            d["hero"] = self._hero_data_url(d["id"])
        return out

    def item_for_listing(self, item_id):
        """Assemble one inventory item into a listing dict the eBay bridge can publish:
        the item fields, its specifics (if the item_specifics table exists), and its local
        photo paths in display order (originals, referenced in place — used for EPS upload)."""
        with self._conn() as c:
            row = c.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
            if not row:
                return None
            item = dict(row)
            specifics = {}
            try:  # item_specifics exists on a built library, not on a fresh one
                for s in c.execute(
                        "SELECT name, value FROM item_specifics WHERE item_id = ? ORDER BY id",
                        (item_id,)):
                    if s["value"]:
                        specifics[s["name"]] = s["value"]
            except sqlite3.OperationalError:
                pass
            paths = [r["file_path"] for r in c.execute(
                "SELECT file_path FROM photos WHERE item_id = ? "
                "AND (kind IS NULL OR kind = 'photo') "
                "ORDER BY (role = 'hero') DESC, representative DESC, sort_order, id",
                (item_id,)) if r["file_path"]]
        return {
            "sku": (item.get("slug") or "").upper(),
            "item_ref": item.get("slug"),
            "title": item.get("title") or "",
            "description": item.get("description") or "",
            "price": item.get("price"),
            "condition": item.get("condition") or "",
            "category": {"id": item.get("category_id"), "path": item.get("category_path")},
            "specifics": specifics,
            "photo_paths": paths,
            "photo_count": len(paths),
        }

    def export_all(self):
        return json.dumps(
            {"kind": "bynari-template-library", "version": 1,
             "templates": self.list_templates()},
            indent=2,
        )

    def import_all(self, text):
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            return {"imported": 0, "error": "invalid JSON"}
        incoming = data if isinstance(data, list) else data.get("templates", [])
        n = 0
        for t in incoming:
            if isinstance(t, dict) and t.get("id"):
                self.save_template(t)
                n += 1
        return {"imported": n}
