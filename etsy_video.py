#!/usr/bin/env python3
"""etsy_video.py — upload ONE video to an Etsy listing (active or draft).

Etsy allows a single video per listing, ~5-15s, <=100MB. Recovers the listing_id
from the item's etsy_draft.json unless given. Reuses etsy.py auth.

Usage:
  python3 etsy_video.py --item ebay-298361644027
  python3 etsy_video.py --item ebay-298399874092 --file path.mp4 --listing 4529459525
"""
import argparse
import json
import os
import secrets
import sys
import urllib.request
import urllib.error

import etsy

HERE = os.path.dirname(os.path.abspath(__file__))


def _multipart(fields, file_field, fname, content, ctype):
    boundary = "----bynari" + secrets.token_hex(16)
    out = []
    for k, v in fields.items():
        out.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\""
                   f"\r\n\r\n{v}\r\n".encode())
    out.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; "
                f"filename=\"{fname}\"\r\nContent-Type: {ctype}\r\n\r\n").encode())
    out.append(content)
    out.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(out), f"multipart/form-data; boundary={boundary}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--item", required=True, help="slug, e.g. ebay-298361644027")
    ap.add_argument("--file", help="video path (default photos/<slug>/<slug>-video.mp4)")
    ap.add_argument("--listing", help="listing_id (else from etsy_draft.json)")
    args = ap.parse_args()

    folder = os.path.join(HERE, "photos", args.item)
    path = args.file or os.path.join(folder, f"{args.item}-video.mp4")
    if not os.path.exists(path):
        sys.exit(f"no video at {path}")

    listing_id = args.listing
    if not listing_id:
        listing_id = json.load(open(os.path.join(folder, "etsy_draft.json")))["listing_id"]

    cfg = etsy.load_app()
    sid = etsy.whoami_quiet(cfg)["shop_id"]
    token = etsy.valid_token(cfg)

    content = open(path, "rb").read()
    data, ctype = _multipart({"name": os.path.basename(path)}, "video",
                             os.path.basename(path), content, "video/mp4")
    req = urllib.request.Request(
        f"{etsy.API_BASE}/shops/{sid}/listings/{listing_id}/videos",
        data=data, method="POST",
        headers={"x-api-key": f"{cfg['keystring']}:{cfg['shared_secret']}",
                 "Authorization": f"Bearer {token}",
                 "Content-Type": ctype})
    print(f"Uploading {os.path.basename(path)} ({len(content)} bytes) to listing {listing_id} …")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            res = json.loads(r.read())
        print(f"  done — video_id={res.get('video_id')} state={res.get('video_state')}")
    except urllib.error.HTTPError as e:
        sys.exit(f"Etsy API {e.code}: {e.read().decode('utf-8', 'replace')}")


if __name__ == "__main__":
    main()
