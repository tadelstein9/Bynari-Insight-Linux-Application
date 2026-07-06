#!/usr/bin/env python3
"""Bynari Pywebview shell.

Loads the UI via Pywebview's HTTP server so https://api.tadelstein.com
fetches aren't blocked by file://-origin CORS. Exposes a Python-side
photo picker so the file dialog opens where the user keeps photos,
not where the script lives.
"""
import base64
import json
import os
import sys
import webbrowser

# qtpy otherwise defaults to PyQt5 (which lacks the WebEngine/WebChannel modules
# here), so pywebview's Qt backend fails and falls back to GTK — which renders the
# window but silently swallows click events. Force PyQt6's QtWebEngine. Must be set
# before webview imports its Qt platform.
os.environ.setdefault("QT_API", "pyqt6")

import webview


class API:
    """JS-callable Python methods exposed at window.pywebview.api.*"""

    def __init__(self):
        # Initial pick location. After the first successful pick, we
        # remember the directory the user chose from.
        self.last_photo_dir = os.path.expanduser("~/Desktop")
        self.last_save_dir = os.path.expanduser("~/Desktop")
        self.window = None
        self.store = None  # lazy TemplateStore (SQLite on the seller's drive)

    def save_datasheet(self, content, default_name="datasheet.md"):
        """Save the assembled datasheet to a user-picked location.

        File picker offers Markdown and plain text. If the user picks a
        .txt extension, we ship `content` as-is (markdown is text-safe);
        callers that want a true plaintext rendering should pass the
        already-converted body in `content`.
        """
        result = self.window.create_file_dialog(
            webview.SAVE_DIALOG,
            directory=self.last_save_dir,
            save_filename=default_name,
            file_types=(
                "Markdown (*.md)",
                "CSV (*.csv)",
                "Text file (*.txt)",
                "All files (*.*)",
            ),
        )
        # Pywebview returns a tuple/list for some dialogs and a string for others.
        path = None
        if isinstance(result, (list, tuple)) and result:
            path = result[0]
        elif isinstance(result, str):
            path = result
        if not path:
            return {"saved": False}
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
        except OSError as e:
            return {"saved": False, "error": str(e)}
        self.last_save_dir = os.path.dirname(path)
        return {"saved": True, "path": path}

    def open_url(self, url):
        """Open an external URL in the user's default browser.

        Pywebview's default behavior for links is to load them inside the
        embedded webview, which would replace Bynari with the destination
        site. Routing through webbrowser.open() keeps the app intact.
        """
        if not isinstance(url, str):
            return {"ok": False, "error": "url must be a string"}
        if not (url.startswith("http://") or url.startswith("https://")):
            return {"ok": False, "error": "only http/https URLs allowed"}
        try:
            webbrowser.open(url, new=2)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def pick_photos(self):
        """Open a native file picker for images.

        Returns a list of {path, name, data_url} dicts; empty list if
        the user cancels. Files that fail to read are silently skipped.
        """
        paths = self.window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=True,
            directory=self.last_photo_dir,
            file_types=("Image files (*.jpg;*.jpeg;*.png;*.webp;*.gif)",),
        )
        if not paths:
            return []
        self.last_photo_dir = os.path.dirname(paths[0])

        mime_map = {
            "jpg": "jpeg", "jpeg": "jpeg",
            "png": "png", "webp": "webp", "gif": "gif",
        }
        out = []
        for p in paths:
            try:
                with open(p, "rb") as f:
                    raw = f.read()
            except OSError:
                continue
            ext = os.path.splitext(p)[1].lower().lstrip(".")
            mime = mime_map.get(ext, "jpeg")
            data_url = f"data:image/{mime};base64," + base64.b64encode(raw).decode("ascii")
            out.append({
                "path": p,
                "name": os.path.basename(p),
                "data_url": data_url,
            })
        return out

    # --- Template library (SQLite on the seller's own drive) ---
    def _get_store(self):
        if self.store is None:
            import store as store_mod
            self.store = store_mod.TemplateStore()
        return self.store

    def items_list(self):
        return self._get_store().list_items()

    def cockpit_listing(self, item_id):
        """Load one inventory item as a listing dict for the cockpit to review + publish."""
        try:
            return self._get_store().item_for_listing(int(item_id))
        except (ValueError, TypeError):
            return None

    def templates_list(self):
        return self._get_store().list_templates()

    def template_save(self, t):
        return self._get_store().save_template(t)

    def template_delete(self, tid):
        return self._get_store().delete_template(tid)

    def templates_import_text(self, text):
        return self._get_store().import_all(text)

    def get_storage_dir(self):
        return {"dir": self._get_store().base_dir}

    def setting_get(self, key, default=None):
        return self._get_store().get_setting(key, default)

    def setting_set(self, key, value):
        return self._get_store().set_setting(key, value)

    def templates_export(self):
        """Write the whole library to a user-picked JSON file."""
        content = self._get_store().export_all()
        result = self.window.create_file_dialog(
            webview.SAVE_DIALOG,
            directory=self._get_store().base_dir,
            save_filename="bynari-templates.json",
            file_types=("JSON (*.json)", "All files (*.*)"),
        )
        path = None
        if isinstance(result, (list, tuple)) and result:
            path = result[0]
        elif isinstance(result, str):
            path = result
        if not path:
            return {"saved": False}
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
        except OSError as e:
            return {"saved": False, "error": str(e)}
        return {"saved": True, "path": path}

    def export_photos(self, items):
        """Download each item's photos into a folder the seller picks.

        items: [{"label": str, "item_no": str, "urls": [str, ...]}]. Saves to
        <folder>/<safe label>/NN.ext, one subfolder per item. Returns a summary.
        """
        import re
        import urllib.request

        result = self.window.create_file_dialog(webview.FOLDER_DIALOG)
        folder = None
        if isinstance(result, (list, tuple)) and result:
            folder = result[0]
        elif isinstance(result, str):
            folder = result
        if not folder:
            return {"saved": False}

        item_count = 0
        photo_count = 0
        for it in (items or []):
            label = (it.get("label") or it.get("item_no") or "item")
            safe = re.sub(r"[^A-Za-z0-9 ._-]", "", label).strip() or "item"
            sub = os.path.join(folder, safe)
            try:
                os.makedirs(sub, exist_ok=True)
            except OSError:
                continue
            got = 0
            for i, entry in enumerate(it.get("urls") or [], 1):
                # Each entry is a URL string, or {"url", "role"} when the photo
                # carries an eBay photo role (Front, Dial, Measurement, …).
                url = entry.get("url") if isinstance(entry, dict) else entry
                role = entry.get("role") if isinstance(entry, dict) else None
                if not url:
                    continue
                try:
                    ext = os.path.splitext(url.split("?")[0])[1].lower()
                    if not ext or len(ext) > 5:
                        ext = ".jpg"
                    # Name by role when known (front.jpg, dial.jpg, …) so files
                    # drop into eBay's named photo slots; numbered otherwise.
                    stem = (re.sub(r"[^a-z0-9]+", "-", role.lower()).strip("-")
                            if role else "") or f"{i:02d}"
                    name = f"{stem}{ext}"
                    n = 2
                    while os.path.exists(os.path.join(sub, name)):
                        name = f"{stem}-{n}{ext}"
                        n += 1
                    dest = os.path.join(sub, name)
                    req = urllib.request.Request(
                        url, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=20) as resp:
                        data = resp.read()
                    with open(dest, "wb") as f:
                        f.write(data)
                    got += 1
                except Exception:
                    continue
            if got:
                item_count += 1
                photo_count += got
        return {"saved": True, "folder": folder,
                "item_count": item_count, "photo_count": photo_count}

    def import_ebay_photos(self, items):
        """Copy each listing's photos INTO the seller's library (not a dumped
        folder): create/update the item + listing rows, then run the copy-in
        pipeline — largest-JPEG fetch, webp->JPEG, dedup, keyed names.

        items: [{"item_no", "urls": [...], "title", "brand", "category_id",
        "category_path"}]. Returns a summary. The library lives wherever the
        seller pointed their storage dir (drive or cloud-synced folder).
        """
        import sqlite3
        import photo_ingest

        store = self._get_store()  # also runs the schema self-heal
        con = sqlite3.connect(store.db_path)
        con.execute("PRAGMA foreign_keys = ON")
        imported, photo_count, dup_count, fail_count = 0, 0, 0, 0
        try:
            for it in (items or []):
                urls = it.get("urls") or []
                if not urls:
                    continue
                info = store.ensure_ebay_item(it)
                if not info:
                    continue
                added = dup = 0
                for i, url in enumerate(urls, 1):
                    try:
                        res = photo_ingest.ingest_photo(
                            con, info["id"], info["slug"], info["folder"], url,
                            role=("hero" if i == 1 else None),
                            source="ebay", sort_order=i)
                        if res["status"] == "added":
                            added += 1
                        elif res["status"] == "duplicate":
                            dup += 1
                    except Exception:
                        fail_count += 1
                if added or dup:
                    imported += 1
                    photo_count += added
                    dup_count += dup
        finally:
            con.close()
        return {"saved": True, "item_count": imported,
                "photo_count": photo_count, "duplicate_count": dup_count,
                "fail_count": fail_count, "library_dir": store.base_dir}

    def choose_storage_dir(self):
        """Point the library at a folder the seller picks (e.g., a USB-C SSD)."""
        result = self.window.create_file_dialog(webview.FOLDER_DIALOG)
        path = None
        if isinstance(result, (list, tuple)) and result:
            path = result[0]
        elif isinstance(result, str):
            path = result
        if not path:
            return {"changed": False}
        import store as store_mod
        store_mod.save_storage_dir(path)
        self.store = store_mod.TemplateStore(path)
        return {"changed": True, "dir": self.store.base_dir}

    # --- eBay live listing (bring your own keys: the seller's own keyset, the seller's own trigger) ---
    def _ebay_creds(self):
        raw = self._get_store().get_setting("ebay_credentials")
        try:
            return json.loads(raw) if raw else None
        except (ValueError, TypeError):
            return None

    def _ebay_policies(self):
        raw = self._get_store().get_setting("ebay_policies")
        try:
            return json.loads(raw) if raw else {}
        except (ValueError, TypeError):
            return {}

    def ebay_check(self):
        """Confirm the seller's eBay connection: token + business policies + location.
        This is what the onboarding screen calls after they paste their keyset."""
        creds = self._ebay_creds()
        if not creds:
            return {"ok": False, "error": "Connect your eBay account first (Settings)."}
        import publish_listing
        return publish_listing.check(creds)

    def ebay_publish(self, listing, dry_run=True, go_live=False, force=False):
        """Turn a datasheet (listing.json) into a live eBay draft — or publish it, when the
        seller explicitly says go. dry_run=True runs the pre-flight and reports without sending."""
        creds = self._ebay_creds()
        if not creds:
            return {"ok": False, "error": "Connect your eBay account first (Settings)."}
        import publish_listing
        return publish_listing.publish(
            listing, creds, self._ebay_policies(),
            dry_run=bool(dry_run), go_live=bool(go_live), force=bool(force))

    # --- onboarding (bring your own keys): save keyset, list/choose default business policies ---
    def ebay_save_credentials(self, creds):
        """Store the seller's eBay keyset on their own drive. Needs the three fields the
        OAuth refresh flow requires; access_token/token_expires are optional (derived)."""
        if not isinstance(creds, dict):
            return {"ok": False, "error": "credentials must be an object"}
        need = ("client_id", "client_secret", "refresh_token")
        clean = {k: str(v).strip() for k, v in creds.items() if str(v or "").strip()}
        missing = [k for k in need if not clean.get(k)]
        if missing:
            return {"ok": False, "error": "missing required field(s): " + ", ".join(missing)}
        self._get_store().set_setting("ebay_credentials", json.dumps(clean))
        return {"ok": True}

    def ebay_list_policies(self):
        creds = self._ebay_creds()
        if not creds:
            return {"ok": False, "error": "Connect your eBay account first."}
        import publish_listing
        return publish_listing.list_policies(creds)

    def ebay_save_policies(self, policies):
        """Save the seller's chosen default fulfillment/payment/return policy + location."""
        if not isinstance(policies, dict):
            return {"ok": False, "error": "policies must be an object"}
        keep = {k: str(v).strip() for k, v in policies.items() if str(v or "").strip()}
        self._get_store().set_setting("ebay_policies", json.dumps(keep))
        return {"ok": True}

    def ebay_connection_status(self):
        """What the onboarding screen shows on load: which halves are already configured."""
        creds = self._ebay_creds() or {}
        pol = self._ebay_policies() or {}
        have_creds = all(creds.get(k) for k in ("client_id", "client_secret", "refresh_token"))
        have_pol = all(pol.get(k) for k in ("fulfillment_policy_id", "payment_policy_id",
                                            "return_policy_id", "merchant_location_key"))
        return {"credentials": bool(have_creds), "policies": bool(have_pol),
                "selected": {k: pol.get(k) for k in
                             ("fulfillment_policy_id", "payment_policy_id",
                              "return_policy_id", "merchant_location_key")}}


def _resource_dir():
    """Directory holding index.html / app.js / styles.css.

    Under PyInstaller's onefile build the data files are unpacked into a
    temp dir exposed as sys._MEIPASS; in a normal run they sit next to
    this script.
    """
    if getattr(sys, "frozen", False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


def _show_fatal(message):
    """Surface a startup failure the user can act on. The app is built windowed, so an
    exception in webview.start() otherwise vanishes with no trace. We write it to stderr —
    visible when launched from a terminal, and captured by the desktop session journal."""
    sys.stderr.write(message + "\n")


def _live_reload(window, root):
    """Dev-only: reload the window whenever a front-end file changes.

    Watches every .html/.css/.js next to the app and calls location.reload()
    the moment one is saved, so edits show up without touching the window.
    Never runs in a frozen build (see main()), so it does not ship.
    """
    import glob
    import time

    def snapshot():
        snap = {}
        for ext in ("*.html", "*.css", "*.js"):
            for p in glob.glob(os.path.join(root, ext)):
                try:
                    snap[p] = os.path.getmtime(p)
                except OSError:
                    pass
        return snap

    sys.stderr.write("[live-reload] watching front-end files (dev only)\n")
    last = snapshot()
    while True:
        time.sleep(0.5)
        cur = snapshot()
        if cur != last:
            last = cur
            try:
                window.evaluate_js("location.reload()")
            except Exception:
                pass


def main():
    here = _resource_dir()
    os.chdir(here)
    api = API()
    # Backend: default to Qt (PyQt6 QtWebEngine) on Linux. On some stacks the
    # GTK/WebKit backend maps a window but silently swallows click events (and
    # spews window.native.* introspection warnings) — Qt is the reliable one.
    # BYNARI_GUI overrides (e.g. BYNARI_GUI=gtk to force GTK).
    gui = os.environ.get("BYNARI_GUI") or "qt"
    try:
        window = webview.create_window(
            "Bynari Insight",
            # BYNARI_PAGE lets you launch straight into a specific screen for review,
            # e.g. BYNARI_PAGE=onboarding.html — defaults to the normal app home.
            url=os.environ.get("BYNARI_PAGE", "index.html"),
            width=920,
            height=760,
            min_size=(720, 560),
            js_api=api,
        )
        api.window = window
        # Live reload only while developing (running app.py directly). Frozen
        # installer builds skip it entirely, so it never ships to users.
        if getattr(sys, "frozen", False):
            webview.start(gui=gui, http_server=True)
        else:
            webview.start(_live_reload, (window, here), gui=gui, http_server=True)
    except Exception as e:
        # On Linux the usual cause is a missing WebEngine backend for pywebview.
        # Tell the user how to fix it rather than dying silently.
        _show_fatal(
            "Bynari could not start its display.\n\n"
            "This usually means the Qt WebEngine backend for pywebview is missing. "
            "Install it with:\n"
            "    pip install pywebview[qt]\n\n"
            "(or set BYNARI_GUI=qt) then launch Bynari again.\n\n"
            f"Technical detail: {type(e).__name__}: {e}"
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
