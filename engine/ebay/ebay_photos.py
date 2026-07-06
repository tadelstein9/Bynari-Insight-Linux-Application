#!/usr/bin/env python3
"""ebay_photos.py — upload LOCAL photos to eBay's picture servers (EPS) and get
back hosted URLs, so net-new items can be listed via the Sell API (which wants
image URLs, not file bytes). This is the piece we were missing.

Cloned LOGIC (not the app) from the hahm-ebay-lister study: the REST Inventory
API can't take binaries, so photos go through the OLD Trading API call
`UploadSiteHostedPictures` (multipart XML + image) using the same OAuth token /
IAF header pattern as ebay_pull.py. Returns EPS FullURLs. Local-first, bring your own keys,
runs as the token owner (your keyset).

Usage:
  python3 ebay_photos.py --files a.jpg b.jpg          # upload, print EPS URLs
  python3 ebay_photos.py --item watch-cali-pt5000-01  # upload photos/<slug>/*.jpg,
                                                       # write URLs into ebay_meta.json
"""
import argparse
import glob
import json
import os
import secrets
import sys
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

import ebay_pull  # load_creds / refresh_access_token / TRADING_URL / COMPAT / NS

HERE = os.path.dirname(os.path.abspath(__file__))
IMG_EXT = (".jpg", ".jpeg", ".png")


def _multipart_eps(xml_bytes, fname, img_bytes):
    """Two-part multipart: the XML request first, then the image binary."""
    boundary = "----bynariEPS" + secrets.token_hex(16)
    b = boundary.encode()
    out = [
        b"--" + b + b"\r\n",
        b'Content-Disposition: form-data; name="XML Payload"\r\n',
        b"Content-Type: text/xml;charset=utf-8\r\n\r\n",
        xml_bytes, b"\r\n",
        b"--" + b + b"\r\n",
        f'Content-Disposition: form-data; name="image"; filename="{fname}"\r\n'.encode(),
        b"Content-Type: image/jpeg\r\n\r\n",
        img_bytes, b"\r\n",
        b"--" + b + b"--\r\n",
    ]
    return b"".join(out), f"multipart/form-data; boundary={boundary}"


def upload_one(token, path):
    name = os.path.splitext(os.path.basename(path))[0][:30]
    xml = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
        f'<PictureName>{name}</PictureName>'
        '<PictureSet>Supersize</PictureSet>'
        '</UploadSiteHostedPicturesRequest>'
    ).encode()
    body, ctype = _multipart_eps(xml, os.path.basename(path), open(path, "rb").read())
    headers = {
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": ebay_pull.COMPAT,
        "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures",
        "X-EBAY-API-IAF-TOKEN": token,
        "Content-Type": ctype,
    }
    req = urllib.request.Request(ebay_pull.TRADING_URL, data=body, method="POST",
                                 headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
    root = ET.fromstring(raw)
    ns = ebay_pull.NS
    ack = (root.findtext(".//e:Ack", default="", namespaces=ns)
           or root.findtext("Ack", default=""))
    full = root.findtext(".//e:FullURL", namespaces=ns)
    if not full:
        # surface eBay's error text instead of failing silently
        errs = [el.findtext("e:LongMessage", default="", namespaces=ns) or
                el.findtext("e:ShortMessage", default="", namespaces=ns)
                for el in root.findall(".//e:Errors", namespaces=ns)]
        raise SystemExit(f"upload FAILED for {os.path.basename(path)} [Ack={ack}]:\n  "
                         + ("\n  ".join(e for e in errs if e) or raw[:600]))
    return full


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--files", nargs="*", help="image paths to upload")
    ap.add_argument("--item", help="slug: upload photos/<slug>/*.jpg, save URLs to ebay_meta.json")
    ap.add_argument("--creds", default=ebay_pull.DEFAULT_CREDS)
    args = ap.parse_args()

    if args.item:
        folder = os.path.join(HERE, "photos", args.item)
        files = sorted(p for p in glob.glob(os.path.join(folder, "*"))
                       if p.lower().endswith(IMG_EXT))
    else:
        files = args.files or []
    if not files:
        sys.exit("no images to upload (use --files or --item)")

    creds = ebay_pull.load_creds(args.creds)
    print(f"Refreshing token from {os.path.basename(args.creds)} …")
    token = ebay_pull.refresh_access_token(creds)
    print("  token OK\n")

    urls = []
    for p in files:
        print(f"uploading {os.path.basename(p)} ({os.path.getsize(p)//1024}K) …")
        u = upload_one(token, p)
        print(f"  -> {u}")
        urls.append(u)

    if args.item:
        mp = os.path.join(HERE, "photos", args.item, "ebay_meta.json")
        meta = json.load(open(mp)) if os.path.exists(mp) else {}
        meta["image_urls"] = urls
        json.dump(meta, open(mp, "w"), indent=2)
        print(f"\nWrote {len(urls)} image_urls into {mp}")
    else:
        print(f"\n{len(urls)} EPS URLs:")
        for u in urls:
            print(f"  {u}")


if __name__ == "__main__":
    main()
