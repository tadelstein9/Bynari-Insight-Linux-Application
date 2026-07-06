#!/usr/bin/env python3
"""ebay_sell.py — eBay Sell API write path (DRAFT-ONLY) on your own keyset.

`--check`  : read Sell-API readiness (scopes, business policies, locations). No writes.
`--list S` : build an eBay DRAFT for library item slug S:
               createOrReplaceInventoryItem (SKU) + createOffer (NO publishOffer = draft).
             Reads recovered data from photos/<slug>/ebay_getitem.json, clean copy +
             overrides from photos/<slug>/ebay_meta.json, policies/location from ebay_app.json.
             Nothing goes live — the offer sits unpublished in Seller Hub until you publish.

Usage:
  python3 ebay_sell.py --check
  python3 ebay_sell.py --list ebay-306887060328
  python3 ebay_sell.py --list ebay-306887060328 --dry-run
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error

import ebay_pull      # load_creds / refresh_access_token
import ebay_validate  # A7 pre-flight gate (Taxonomy + Metadata)

HERE = os.path.dirname(os.path.abspath(__file__))
SELL_BASE = "https://api.ebay.com"


def load_app():
    with open(os.path.join(HERE, "ebay_app.json"), encoding="utf-8-sig") as f:
        return json.load(f)


def _req(method, token, path, body=None):
    url = SELL_BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Content-Language": "en-US",
    })
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


# ---------- check ----------
def check(token):
    probes = [
        ("fulfillment policies", "/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US"),
        ("payment policies",     "/sell/account/v1/payment_policy?marketplace_id=EBAY_US"),
        ("return policies",      "/sell/account/v1/return_policy?marketplace_id=EBAY_US"),
        ("inventory locations",  "/sell/inventory/v1/location"),
        ("privileges",           "/sell/account/v1/privilege"),
    ]
    for label, path in probes:
        code, data = _req("GET", token, path)
        print(f"\n=== {label} [HTTP {code}] ===")
        print("  " + (json.dumps(data) if isinstance(data, dict) else str(data))[:500])


# ---------- write ----------
def load_item(slug):
    gp = os.path.join(HERE, "photos", slug, "ebay_getitem.json")
    gi = json.load(open(gp)) if os.path.exists(gp) else {}   # cold item: no pulled listing
    mp = os.path.join(HERE, "photos", slug, "ebay_meta.json")
    meta = json.load(open(mp)) if os.path.exists(mp) else {}
    return gi, meta


def build_inventory(gi, meta):
    specifics = dict(gi.get("specifics", {}))
    aspects = meta.get("aspects") or {k: [v] for k, v in specifics.items() if v}
    product = {
        "title": meta.get("title") or gi.get("title"),
        "description": meta.get("description") or gi.get("description"),
        "aspects": aspects,
        "imageUrls": meta.get("image_urls") or gi.get("pictures", [])[:24],
    }
    if specifics.get("Brand"):
        product["brand"] = specifics["Brand"]
    if specifics.get("MPN"):
        product["mpn"] = specifics["MPN"]
    vids = meta.get("video_ids")          # eBay Media API videoIds (see ebay_video.py)
    if vids:
        product["videoIds"] = vids if isinstance(vids, list) else [vids]
    qty = int(meta.get("quantity", gi.get("quantity") or 1))
    inv = {
        "availability": {"shipToLocationAvailability": {"quantity": qty}},
        "condition": meta.get("condition", "USED_EXCELLENT"),
        "product": product,
    }
    if meta.get("condition_description"):
        inv["conditionDescription"] = meta["condition_description"]
    return inv, qty


def build_offer(slug, gi, meta, app, qty):
    offer = {
        "sku": meta["sku"],
        "marketplaceId": app["marketplace_id"],
        "format": "FIXED_PRICE",
        "availableQuantity": qty,
        "categoryId": str(meta.get("category_id") or gi.get("category_id")),
        "listingDescription": meta.get("description") or gi.get("description"),
        "listingPolicies": {
            # meta overrides app per-item (e.g. an eBay Standard Envelope shipping policy
            # for a small flat item), falling back to the ebay_app.json defaults.
            "fulfillmentPolicyId": meta.get("fulfillment_policy_id", app["fulfillment_policy_id"]),
            "paymentPolicyId": meta.get("payment_policy_id", app["payment_policy_id"]),
            "returnPolicyId": meta.get("return_policy_id", app["return_policy_id"]),
            # Best Offer is a free negotiation/surfacing lever -- on by default (meta can disable).
            "bestOfferTerms": {"bestOfferEnabled": bool(meta.get("best_offer", True))},
        },
        "pricingSummary": {"price": {
            "value": str(meta.get("price") or gi.get("price")),
            "currency": gi.get("currency", "USD")}},
        "merchantLocationKey": app["merchant_location_key"],
    }
    # Optional eBay Store category. Path form "/Top" or "/Top/Sub"; the name must
    # match one of your store's custom categories (Trading API GetStore). Without
    # it, the item lands in the store's default "Other".
    sc = meta.get("store_category")
    if sc:
        offer["storeCategoryNames"] = [sc if sc.startswith("/") else "/" + sc]
    return offer


def list_item(token, slug, dry_run, force=False):
    gi, meta = load_item(slug)
    if not meta.get("sku"):
        sys.exit(f"{slug}: ebay_meta.json needs an sku")

    # A7 pre-flight -- refuse to send a listing eBay would silently botch
    # (wrong category, missing required aspect, invalid condition).
    problems = ebay_validate.validate(token, meta)
    if problems:
        print("PRE-FLIGHT FAILED:")
        for p in problems:
            print(f"   x {p}")
        if not force:
            sys.exit("  refusing to list. Fix ebay_meta.json, or re-run with --force to override.")
        print("  --force: proceeding despite pre-flight failures.")
    else:
        print("pre-flight OK: category, condition, and required aspects all valid.")

    app = load_app()
    inv, qty = build_inventory(gi, meta)
    offer = build_offer(slug, gi, meta, app, qty)

    print("=" * 66)
    print(f"  eBay DRAFT  —  {slug}   (offer stays UNPUBLISHED until you publish)")
    print("=" * 66)
    print(f"SKU        : {meta['sku']}")
    print(f"Title ({len(inv['product']['title'])}): {inv['product']['title']}")
    print(f"Condition  : {inv['condition']}   Qty: {qty}   Price: {offer['pricingSummary']['price']['value']}")
    print(f"Category   : {offer['categoryId']}")
    print(f"Images     : {len(inv['product']['imageUrls'])}")
    print(f"Aspects    : {len(inv['product']['aspects'])}")
    lp = offer["listingPolicies"]
    print(f"Policies   : fulfill {lp['fulfillmentPolicyId']} / pay {lp['paymentPolicyId']} / return {lp['returnPolicyId']}   loc {app['merchant_location_key']}")
    if dry_run:
        print("\n--dry-run: nothing sent.")
        return

    sku = urllib.parse.quote(meta["sku"], safe="")
    print("\n1) createOrReplaceInventoryItem …")
    code, data = _req("PUT", token, f"/sell/inventory/v1/inventory_item/{sku}", inv)
    if code not in (200, 201, 204):
        sys.exit(f"  inventory item FAILED [{code}]: {json.dumps(data)[:800]}")
    print(f"  ok [{code}]")

    print("2) createOffer (no publish = draft) …")
    code, data = _req("POST", token, "/sell/inventory/v1/offer", offer)
    if code in (200, 201):
        offer_id = data.get("offerId")
        print(f"  ok [{code}]  offerId={offer_id}")
    else:
        # offer already exists for this SKU (25002) -> reuse it and PUT updates (idempotent relist)
        errs = data.get("errors", []) if isinstance(data, dict) else []
        if not any(e.get("errorId") == 25002 for e in errs):
            sys.exit(f"  offer FAILED [{code}]: {json.dumps(data)[:800]}")
        skuq = urllib.parse.quote(meta["sku"], safe="")
        _, existing = _req("GET", token, f"/sell/inventory/v1/offer?sku={skuq}")
        offers = existing.get("offers", []) if isinstance(existing, dict) else []
        if not offers:
            sys.exit(f"  offer exists but could not fetch it: {json.dumps(data)[:400]}")
        offer_id = offers[0].get("offerId")
        code2, upd = _req("PUT", token, f"/sell/inventory/v1/offer/{offer_id}", offer)
        if code2 not in (200, 201, 204):
            sys.exit(f"  offer UPDATE FAILED [{code2}]: {json.dumps(upd)[:400]}")
        print(f"  offer existed -> reused & updated offerId={offer_id} [{code2}]")
    rec = {"slug": slug, "sku": meta["sku"], "offer_id": offer_id, "state": "UNPUBLISHED"}
    json.dump(rec, open(os.path.join(HERE, "photos", slug, "ebay_offer.json"), "w"), indent=2)
    print("\nDone. It is an UNPUBLISHED draft offer — review & publish in Seller Hub.")
    print("  Seller Hub → Listings → Drafts")


def publish_offer(token, slug):
    """Seller-triggered: flip an UNPUBLISHED offer live. This is the publish trigger --
    only run on the seller's explicit say-so (bring your own keys: the seller pulls it, the tool never auto-publishes)."""
    rec_path = os.path.join(HERE, "photos", slug, "ebay_offer.json")
    if not os.path.exists(rec_path):
        sys.exit(f"{slug}: no ebay_offer.json -- run --list first to create the draft")
    rec = json.load(open(rec_path))
    offer_id = rec["offer_id"]
    print(f"Publishing offer {offer_id} for {slug} …")
    code, data = _req("POST", token, f"/sell/inventory/v1/offer/{offer_id}/publish", {})
    if code not in (200, 201):
        sys.exit(f"  publish FAILED [{code}]: {json.dumps(data)[:800]}")
    listing_id = data.get("listingId")
    print(f"  ok [{code}]  LIVE listingId={listing_id}")
    print(f"  https://www.ebay.com/itm/{listing_id}")
    rec.update({"state": "PUBLISHED", "listing_id": listing_id})
    json.dump(rec, open(rec_path, "w"), indent=2)


def publish_meta(token, meta, app, dry_run=False, go_live=False):
    """App-callable publish: the SAME proven path as list_item, but dict-in / dict-out —
    no photos/<slug> file layout, no printing. bring your own keys: the caller passes the seller's token and
    the seller's business policies (app). go_live=False leaves an UNPUBLISHED draft; go_live=True
    publishes it (the seller's explicit trigger). Reuses build_inventory/build_offer/_req and the
    idempotent-relist (25002) handling exactly as the CLI does."""
    if not meta.get("sku"):
        return {"ok": False, "stage": "input", "problems": ["meta needs an sku"]}
    problems = ebay_validate.validate(token, meta)
    if problems and not meta.get("_force"):
        return {"ok": False, "stage": "preflight", "problems": problems}
    gi = {}
    inv, qty = build_inventory(gi, meta)
    offer = build_offer(meta["sku"], gi, meta, app, qty)
    summary = {
        "sku": meta["sku"],
        "title": inv["product"]["title"], "title_len": len(inv["product"]["title"] or ""),
        "condition": inv["condition"], "quantity": qty,
        "price": offer["pricingSummary"]["price"]["value"],
        "category_id": offer["categoryId"],
        "images": len(inv["product"]["imageUrls"]), "aspects": len(inv["product"]["aspects"]),
        "preflight": "OK" if not problems else "FORCED",
    }
    if dry_run:
        return {"ok": True, "dry_run": True, **summary}
    skuq = urllib.parse.quote(meta["sku"], safe="")
    code, data = _req("PUT", token, f"/sell/inventory/v1/inventory_item/{skuq}", inv)
    if code not in (200, 201, 204):
        return {"ok": False, "stage": "inventory_item", "http": code, "resp": data, **summary}
    code, data = _req("POST", token, "/sell/inventory/v1/offer", offer)
    if code in (200, 201):
        offer_id = data.get("offerId")
    else:
        errs = data.get("errors", []) if isinstance(data, dict) else []
        if not any(e.get("errorId") == 25002 for e in errs):
            return {"ok": False, "stage": "create_offer", "http": code, "resp": data, **summary}
        _, existing = _req("GET", token, f"/sell/inventory/v1/offer?sku={skuq}")
        offers = existing.get("offers", []) if isinstance(existing, dict) else []
        if not offers:
            return {"ok": False, "stage": "offer_lookup", "resp": data, **summary}
        offer_id = offers[0].get("offerId")
        code2, upd = _req("PUT", token, f"/sell/inventory/v1/offer/{offer_id}", offer)
        if code2 not in (200, 201, 204):
            return {"ok": False, "stage": "offer_update", "http": code2, "resp": upd, **summary}
    result = {"ok": True, "offer_id": offer_id, "status": "UNPUBLISHED", **summary}
    if go_live and offer_id:
        code, data = _req("POST", token, f"/sell/inventory/v1/offer/{offer_id}/publish", {})
        if code not in (200, 201):
            return {"ok": False, "stage": "publish", "http": code, "resp": data,
                    "offer_id": offer_id, **summary}
        result["status"] = "PUBLISHED"
        result["listing_id"] = data.get("listingId")
        result["url"] = f"https://www.ebay.com/itm/{data.get('listingId')}"
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--list", metavar="SLUG")
    ap.add_argument("--verify", metavar="SLUG")
    ap.add_argument("--publish", metavar="SLUG")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="list even if the pre-flight gate fails")
    ap.add_argument("--creds", default=ebay_pull.DEFAULT_CREDS)
    args = ap.parse_args()
    creds = ebay_pull.load_creds(args.creds)
    print(f"Refreshing token from {args.creds.split('/')[-1]} …")
    token = ebay_pull.refresh_access_token(creds)
    print("  token OK")
    if args.check:
        check(token)
    elif args.publish:
        publish_offer(token, args.publish)
    elif args.list:
        list_item(token, args.list, args.dry_run, args.force)
    elif args.verify:
        rec = json.load(open(os.path.join(HERE, "photos", args.verify, "ebay_offer.json")))
        code, data = _req("GET", token, f"/sell/inventory/v1/offer/{rec['offer_id']}")
        print(f"offer {rec['offer_id']} [HTTP {code}]")
        print(f"  status   : {data.get('status')}")
        print(f"  sku      : {data.get('sku')}   category: {data.get('categoryId')}")
        print(f"  price    : {(data.get('pricingSummary') or {}).get('price')}")
        print(f"  listingId: {data.get('listing', {}).get('listingId')} (blank = not yet published)")
        issues = data.get("listing", {}).get("listingStatus")
        print("  raw status block: " + json.dumps(data.get("listing", {}))[:300])
    else:
        ap.error("use --check or --list <slug>")


if __name__ == "__main__":
    main()
