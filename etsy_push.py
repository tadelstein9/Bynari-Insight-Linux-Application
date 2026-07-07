#!/usr/bin/env python3
"""etsy_push.py — turn a library.db item into an Etsy DRAFT, with its photos.

  library.db item + photos  ->  createDraftListing  ->  upload images
                            ->  etsy_draft.json written back into the folder

This NEVER publishes. createDraftListing leaves the listing in 'draft' state;
the draft sits in your Etsy account until you review it and press Publish.
That is the whole safety model — the same "seller's own trigger" rule we hold
everywhere: the tool stages, the seller ships.

Etsy needs a handful of fields the eBay-shaped library row doesn't carry
(who_made, when_made, taxonomy_id, tags, price). Those live in a small sidecar
next to the photos: etsy_meta.json. If a required field is missing, this stops
and tells you which — it will not create a half-formed draft.

Usage:
  python3 etsy_push.py --item ebay-306882768480        # by slug
  python3 etsy_push.py --item 12                        # or by id
  python3 etsy_push.py --item 12 --dry-run              # show the payload, send nothing

Required in etsy_app.json (besides keystring/secret):
  shipping_profile_id   (run: python3 etsy.py profiles)
  return_policy_id      (optional; run: python3 etsy.py policies)
"""
import argparse
import json
import mimetypes
import os
import secrets
import sqlite3
import sys
import urllib.parse
import urllib.request

import etsy  # auth + config + valid_token live here

LIB = os.environ.get("BYNARI_LIB", os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(LIB, "library.db")

# Etsy createDraftListing required fields (besides shop creds). We refuse to
# call the API until every one of these is present and non-empty.
REQUIRED = ["quantity", "title", "description", "price",
            "who_made", "when_made", "taxonomy_id"]


# --- read the item ---------------------------------------------------------
def load_item(ref):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    key = ("id", ref) if str(ref).isdigit() else ("slug", ref)
    row = con.execute(f"SELECT * FROM items WHERE {key[0]}=?", (key[1],)).fetchone()
    if not row:
        sys.exit(f"no item with {key[0]}={key[1]}")
    photos = con.execute(
        "SELECT file_path, sort_order FROM photos WHERE item_id=? AND kind='photo' "
        "ORDER BY sort_order", (row["id"],)).fetchall()
    con.close()
    return dict(row), [p["file_path"] for p in photos]


def load_meta(folder):
    path = os.path.join(folder, "etsy_meta.json")
    return json.load(open(path)) if os.path.exists(path) else {}


def build_payload(item, meta, cfg):
    """Merge: Etsy-specific sidecar wins; fall back to the library row."""
    p = {
        "quantity": meta.get("quantity", 1),
        "title": meta.get("title") or item.get("title"),
        "description": meta.get("description") or item.get("description"),
        "price": meta.get("price", item.get("price")),  # seller's call; often None
        "who_made": meta.get("who_made"),               # someone_else for vintage resale
        "when_made": meta.get("when_made"),             # e.g. 1970s
        "taxonomy_id": meta.get("taxonomy_id"),
        "is_supply": meta.get("is_supply", False),
        "type": meta.get("type", "physical"),
        "tags": meta.get("tags", []),                   # <=13, each <=20 chars
        "materials": meta.get("materials", []),
        # calculated shipping needs weight + dimensions (None values are dropped by _form)
        "item_weight": meta.get("item_weight"),
        "item_weight_unit": meta.get("item_weight_unit"),
        "item_length": meta.get("item_length"),
        "item_width": meta.get("item_width"),
        "item_height": meta.get("item_height"),
        "item_dimensions_unit": meta.get("item_dimensions_unit"),
    }
    if cfg.get("shipping_profile_id"):
        p["shipping_profile_id"] = cfg["shipping_profile_id"]
    if cfg.get("return_policy_id"):
        p["return_policy_id"] = cfg["return_policy_id"]
    if cfg.get("readiness_state_id"):
        p["readiness_state_id"] = cfg["readiness_state_id"]
    return p


# --- multipart for image upload (stdlib has no encoder) --------------------
def _multipart(fields, fname, content, ctype):
    boundary = "----bynari" + secrets.token_hex(16)
    out = []
    for k, v in fields.items():
        out.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\""
                   f"\r\n\r\n{v}\r\n".encode())
    out.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
                f"filename=\"{fname}\"\r\nContent-Type: {ctype}\r\n\r\n").encode())
    out.append(content)
    out.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(out), f"multipart/form-data; boundary={boundary}"


# --- API writes ------------------------------------------------------------
def _form(payload):
    """Etsy wants lowercase true/false, comma-joined arrays (tags/materials/style —
    NOT repeated params, or Etsy keeps only the last value), and drops None values."""
    out = {}
    for k, v in payload.items():
        if v is None:
            continue
        if isinstance(v, bool):
            out[k] = "true" if v else "false"
        elif isinstance(v, (list, tuple)):
            out[k] = ",".join(str(x) for x in v)
        else:
            out[k] = v
    return out


def create_draft(cfg, payload):
    sid = etsy.whoami_quiet(cfg)["shop_id"]
    token = etsy.valid_token(cfg)
    body = urllib.parse.urlencode(_form(payload), doseq=True).encode()
    req = urllib.request.Request(
        f"{etsy.API_BASE}/shops/{sid}/listings",
        data=body, method="POST",
        headers={"x-api-key": f"{cfg['keystring']}:{cfg['shared_secret']}",
                 "Authorization": f"Bearer {token}",
                 "Content-Type": "application/x-www-form-urlencoded"})
    return _send(req), sid


def upload_image(cfg, sid, listing_id, path, rank):
    token = etsy.valid_token(cfg)
    content = open(path, "rb").read()
    ctype = mimetypes.guess_type(path)[0] or "image/jpeg"
    data, content_type = _multipart({"rank": rank}, os.path.basename(path), content, ctype)
    req = urllib.request.Request(
        f"{etsy.API_BASE}/shops/{sid}/listings/{listing_id}/images",
        data=data, method="POST",
        headers={"x-api-key": f"{cfg['keystring']}:{cfg['shared_secret']}",
                 "Authorization": f"Bearer {token}",
                 "Content-Type": content_type})
    return _send(req)


def _send(req):
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            b = r.read()
            return json.loads(b) if b else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"Etsy API {e.code}: {e.read().decode('utf-8', 'replace')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--item", required=True, help="item id or slug")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the payload and the photos; send nothing")
    args = ap.parse_args()

    cfg = etsy.load_app()
    item, photos = load_item(args.item)
    folder = item.get("folder_path") or os.path.join(LIB, "photos", item["slug"])
    meta = load_meta(folder)
    payload = build_payload(item, meta, cfg)

    missing = [k for k in REQUIRED if not payload.get(k)]
    photos = photos[:10]  # Etsy allows up to 10 images per listing

    print("=" * 64)
    print(f"  ETSY DRAFT  —  {item['slug']}   (state stays DRAFT, never published)")
    print("=" * 64)
    print(f"Title ({len(payload['title'] or '')} chars): {payload['title']}")
    print(f"Price       : {payload['price']}  (Etsy requires this — seller's call)")
    print(f"who_made    : {payload['who_made']}")
    print(f"when_made   : {payload['when_made']}")
    print(f"taxonomy_id : {payload['taxonomy_id']}")
    print(f"tags        : {', '.join(payload['tags'])}")
    print(f"shipping    : {payload.get('shipping_profile_id', '(none set in etsy_app.json)')}")
    print(f"photos      : {len(photos)} (cap 10)")
    for ph in photos:
        mark = "OK" if os.path.exists(ph) else "MISSING"
        print(f"   [{mark}] {os.path.basename(ph)}")

    if missing:
        print("\n! Cannot create the draft — these required fields are blank:")
        print("   " + ", ".join(missing))
        print("  Fill them in", os.path.join(folder, "etsy_meta.json"),
              "\n  (taxonomy_id: run `python3 etsy.py taxonomy <keyword>`;",
              "price is yours to set.)")
        sys.exit(1)

    if args.dry_run:
        print("\n--dry-run: nothing sent. Payload above is what would be posted.")
        return

    print("\nCreating draft on your Etsy shop...")
    draft, sid = create_draft(cfg, payload)
    listing_id = draft["listing_id"]
    print(f"  draft created: listing_id={listing_id}")

    for i, ph in enumerate(photos, start=1):
        if os.path.exists(ph):
            upload_image(cfg, sid, listing_id, ph, i)
            print(f"  uploaded [{i}] {os.path.basename(ph)}")

    url = f"https://www.etsy.com/your/shops/me/tools/listings/{listing_id}"
    record = {"listing_id": listing_id, "shop_id": sid, "state": draft.get("state"),
              "edit_url": url, "title": payload["title"]}
    json.dump(record, open(os.path.join(folder, "etsy_draft.json"), "w"), indent=2)

    print("\nDone. It is a DRAFT — review and publish it yourself here:")
    print(f"  {url}")
    print(f"Recorded: {os.path.join(folder, 'etsy_draft.json')}")


if __name__ == "__main__":
    main()
