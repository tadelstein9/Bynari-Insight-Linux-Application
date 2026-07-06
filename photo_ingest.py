"""Bynari photo ingest — copy-in pipeline for the inventory library.

Decided 2026-06-12: Bynari COPIES every photo into its own library (eBay-fetched
AND the seller's own originals). This module is the copy-in path:

  * eBay images arrive renamed + WebP (e.g. .../s-l960.webp) — we rewrite the URL
    to pull the LARGEST JPEG eBay has (s-l1600 / s-l2400), skipping WebP entirely.
  * Any WebP/PNG that still slips through is converted to JPEG with Pillow, so a
    user without GIMP never has to deal with it.
  * Identity is the DB row, never the filename. The original/eBay name and source
    URL are kept as provenance; the local file gets a sane keyed name.
  * Content is hashed (sha256) for dedup + integrity; pixel dimensions are stored
    so we can tell a usable photo from a thumbnail.

Pure module: no Pywebview/UI dependency, so it unit-tests on its own. app.py can
import ingest_photo() and call it over the bridge for the inventory feature.

Schema (library.db `photos`, after migrate_library_2026-06-12.py):
  id, item_id, file_path, kind, role, shows, condition_evidence, representative,
  sort_order, source, source_url, original_name, sha256, width, height
"""
import hashlib
import io
import os
import re
import sqlite3
from urllib.parse import urlparse

import requests
from PIL import Image

UA = "Bynari/1.0"
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".webm"}
# Largest first; we stop once we land a genuinely large image. eBay tops out at
# different sizes per listing, so we probe down the ladder.
EBAY_SIZE_LADDER = (2400, 1600, 1200, 960)
_EBAY_NAME_RE = re.compile(r"(.*/)s-l\d+\.(?:jpe?g|webp|png|gif)(?:\?.*)?$", re.I)


# --------------------------------------------------------------------------- #
# Fetching + normalizing
# --------------------------------------------------------------------------- #
def _download(url):
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=30)
        if r.status_code == 200 and r.content:
            return r.content
    except requests.RequestException:
        pass
    return None


def fetch_best_ebay_image(api_url):
    """Given any eBay image URL, return (raw_bytes, chosen_url) for the largest
    JPEG available. Falls back to the URL as given if it isn't an eBay CDN name."""
    m = _EBAY_NAME_RE.match(api_url)
    if not m:
        return _download(api_url), api_url
    prefix = m.group(1)
    best = None  # (raw, url, pixels)
    for size in EBAY_SIZE_LADDER:
        cand = f"{prefix}s-l{size}.jpg"
        raw = _download(cand)
        if not raw:
            continue
        try:
            im = Image.open(io.BytesIO(raw))
            im.load()
        except Exception:
            continue
        px = im.size[0] * im.size[1]
        if best is None or px > best[2]:
            best = (raw, cand, px)
        if min(im.size) >= 1500:  # already big enough; stop probing
            break
    if best is None:
        return _download(api_url), api_url
    return best[0], best[1]


def _to_jpeg_bytes(im):
    if im.mode != "RGB":
        im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=92)
    return buf.getvalue()


def normalize_image(raw):
    """Return (jpeg_bytes, width, height). Re-encodes anything that isn't already
    JPEG (WebP, PNG, …) so the stored file is always openable without extra tools."""
    im = Image.open(io.BytesIO(raw))
    im.load()
    width, height = im.size
    if (im.format or "").upper() == "JPEG" and im.mode == "RGB":
        return raw, width, height
    return _to_jpeg_bytes(im), width, height


def _sha256(b):
    return hashlib.sha256(b).hexdigest()


# --------------------------------------------------------------------------- #
# Copy-in + DB insert
# --------------------------------------------------------------------------- #
def _keyed_name(slug, role, sort_order, ext, folder):
    """A sane, collision-free local filename keyed to the item — never the
    eBay/camera original name (which is meaningless or absent)."""
    stem = slug or "item"
    if role:
        stem += "-" + re.sub(r"[^a-z0-9]+", "-", role.lower()).strip("-")
    elif sort_order is not None:
        stem += f"-{sort_order}"
    name = f"{stem}{ext}"
    n = 2
    while os.path.exists(os.path.join(folder, name)):
        name = f"{stem}-{n}{ext}"
        n += 1
    return name


def ingest_photo(con, item_id, slug, folder, src, *,
                 role=None, source=None, sort_order=None,
                 shows=None, condition_evidence=None, representative=0):
    """Copy one photo/video into the library and record it.

    src: a local file path OR an http(s) URL (eBay). Returns
    {'status': 'added'|'duplicate', 'photo_id', 'file_path', 'width', 'height'}.
    """
    is_url = src.lower().startswith("http")
    if is_url:
        source = source or "ebay"
        original_name = os.path.basename(urlparse(src).path) or "ebay-image"
        raw, source_url = fetch_best_ebay_image(src)
        if raw is None:
            raise RuntimeError(f"could not download {src}")
    else:
        source = source or "camera"
        original_name = os.path.basename(src)
        source_url = None
        with open(src, "rb") as f:
            raw = f.read()

    ext = os.path.splitext(original_name)[1].lower()
    if ext in VIDEO_EXTS:
        kind, data, width, height, out_ext = "video", raw, None, None, ext
    else:
        kind = "photo"
        data, width, height = normalize_image(raw)
        out_ext = ".jpg"

    sha = _sha256(data)
    dup = con.execute(
        "SELECT id, file_path FROM photos WHERE item_id=? AND sha256=?",
        (item_id, sha),
    ).fetchone()
    if dup:
        return {"status": "duplicate", "photo_id": dup[0], "file_path": dup[1],
                "width": width, "height": height}

    os.makedirs(folder, exist_ok=True)
    name = _keyed_name(slug, role, sort_order, out_ext, folder)
    out_path = os.path.join(folder, name)
    with open(out_path, "wb") as f:
        f.write(data)

    cur = con.execute(
        "INSERT INTO photos (item_id, file_path, kind, role, shows, "
        "condition_evidence, representative, sort_order, source, source_url, "
        "original_name, sha256, width, height) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (item_id, out_path, kind, role, shows, condition_evidence,
         representative, sort_order, source, source_url, original_name,
         sha, width, height),
    )
    con.commit()
    return {"status": "added", "photo_id": cur.lastrowid, "file_path": out_path,
            "width": width, "height": height}


def ingest_ebay_item(con, item_id, slug, folder, image_urls, *, source="ebay"):
    """Ingest a list of eBay image URLs (hero first), in order."""
    results = []
    for i, url in enumerate(image_urls, 1):
        role = "hero" if i == 1 else None
        results.append(ingest_photo(con, item_id, slug, folder, url,
                                    role=role, source=source, sort_order=i))
    return results
