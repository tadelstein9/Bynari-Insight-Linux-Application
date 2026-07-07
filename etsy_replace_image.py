#!/usr/bin/env python3
"""Replace ONE image on an existing Etsy listing in place (e.g. a re-edited hero),
without disturbing the other photos or their order. Uses Etsy's overwrite on the
existing listing_image_id.

  python3 etsy_replace_image.py <listing_id> <image_path> [rank]
      rank omitted -> replaces the current rank-1 (hero) image
"""
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request

import etsy        # auth + config
import etsy_push   # _multipart

LIB = os.environ.get("BYNARI_LIB", os.path.dirname(os.path.abspath(__file__)))


def _headers(cfg, token, extra=None):
    h = {"x-api-key": f"{cfg['keystring']}:{cfg['shared_secret']}",
         "Authorization": f"Bearer {token}"}
    if extra:
        h.update(extra)
    return h


def main():
    listing_id = sys.argv[1]
    img_path = sys.argv[2]
    want_rank = int(sys.argv[3]) if len(sys.argv) > 3 else None

    cfg = etsy.load_app()
    sid = etsy.whoami_quiet(cfg)["shop_id"]
    token = etsy.valid_token(cfg)
    get_url = f"{etsy.API_BASE}/listings/{listing_id}/images"          # listing-level
    base = f"{etsy.API_BASE}/shops/{sid}/listings/{listing_id}/images"  # shop-level (write)

    # 1) read the current images, pick the target
    req = urllib.request.Request(get_url, headers=_headers(cfg, token))
    with urllib.request.urlopen(req, timeout=60) as r:
        results = json.loads(r.read()).get("results", [])
    if not results:
        sys.exit("listing has no images")
    results.sort(key=lambda i: i.get("rank", 999))
    target = (next((i for i in results if i.get("rank") == want_rank), None)
              if want_rank else results[0])
    if not target:
        sys.exit(f"no image at rank {want_rank}")
    rank = target.get("rank", 1)
    print(f"{len(results)} images on listing {listing_id}; "
          f"replacing rank {rank} (listing_image_id={target['listing_image_id']})")

    # 2) overwrite that image in place
    content = open(img_path, "rb").read()
    ctype = mimetypes.guess_type(img_path)[0] or "image/jpeg"
    fields = {"listing_image_id": str(target["listing_image_id"]),
              "rank": str(rank), "overwrite": "true"}
    data, content_type = etsy_push._multipart(
        fields, os.path.basename(img_path), content, ctype)
    req = urllib.request.Request(
        base, data=data, method="POST",
        headers=_headers(cfg, token, {"Content-Type": content_type}))
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            res = json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"Etsy API {e.code}: {e.read().decode('utf-8', 'replace')}")
    print(f"OK — hero now listing_image_id={res.get('listing_image_id')} "
          f"rank={res.get('rank')}  ({len(content)//1024}K uploaded)")


if __name__ == "__main__":
    main()
