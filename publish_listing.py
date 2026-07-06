#!/usr/bin/env python3
"""publish_listing.py — the bridge from a Bynari datasheet (listing.json) to a LIVE eBay
draft/listing, through the proven engine in engine/ebay/.

bring your own keys, always: the seller's own credentials, the seller's own business policies, the seller's
own trigger. The app never auto-publishes — go_live is only ever set on an explicit seller
action. Flow:

    listing dict  ->  engine ebay_meta  ->  pre-flight validate (Taxonomy + Metadata)
                  ->  createOffer (draft)  ->  [seller trigger] publishOffer

This is the write path v4 was missing: make_listing.py produced a *document*; this turns that
document into an actual eBay listing, taxonomy-validated so it can't publish the wrong category.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "engine", "ebay")
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import ebay_pull      # noqa: E402  (path set above)
import ebay_sell      # noqa: E402
import ebay_photos    # noqa: E402  (EPS upload: local files -> hosted URLs)
import ebay_taxonomy  # noqa: E402  (the right category, from eBay, not the comp)

# Business-policy keys build_offer needs; without them eBay can't create the offer.
_REQUIRED_POLICY = ("fulfillment_policy_id", "payment_policy_id",
                    "return_policy_id", "merchant_location_key")

# human condition text -> eBay condition enum. validate() checks the result against the
# category's allowed conditions, so a wrong guess fails loud instead of publishing wrong.
_COND = {
    "new": "NEW", "brand new": "NEW",
    "new with tags": "NEW_WITH_TAGS", "new without tags": "NEW_WITHOUT_TAGS",
    "new with defects": "NEW_WITH_DEFECTS", "new other": "NEW_OTHER", "open box": "NEW_OTHER",
    "certified refurbished": "CERTIFIED_REFURBISHED",
    "seller refurbished": "SELLER_REFURBISHED", "refurbished": "SELLER_REFURBISHED",
    "used": "USED_EXCELLENT", "pre-owned": "USED_EXCELLENT", "preowned": "USED_EXCELLENT",
    "excellent": "USED_EXCELLENT", "very good": "USED_VERY_GOOD", "good": "USED_GOOD",
    "acceptable": "USED_ACCEPTABLE",
    "for parts or not working": "FOR_PARTS_OR_NOT_WORKING",
    "for parts": "FOR_PARTS_OR_NOT_WORKING", "parts or repair": "FOR_PARTS_OR_NOT_WORKING",
    "parts/repair": "FOR_PARTS_OR_NOT_WORKING", "not working": "FOR_PARTS_OR_NOT_WORKING",
}


def _condition_enum(text):
    t = (text or "").strip()
    if t and "_" in t and t.upper() == t:        # already an enum like FOR_PARTS_OR_NOT_WORKING
        return t
    key = re.sub(r"\s+", " ", t.lower()).strip()
    if key in _COND:
        return _COND[key]
    for k, v in _COND.items():                   # loose contains match
        if k in key:
            return v
    return "USED_EXCELLENT"                       # safe default; validate() rejects if wrong


def _sku(listing):
    ref = listing.get("sku") or listing.get("item_ref") or listing.get("title") or "item"
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", str(ref)).strip("-").upper()
    return s[:50] or "ITEM"


def listing_to_meta(listing):
    """Map a Bynari listing.json to the engine's ebay_meta dict."""
    specifics = listing.get("specifics") or {}
    cat = listing.get("category") or {}
    price = listing.get("price") or listing.get("suggested_price")
    meta = {
        "sku": _sku(listing),
        "title": (listing.get("title") or "")[:80],
        "description": listing.get("description") or "",
        "price": price,
        "quantity": int(listing.get("quantity") or 1),
        "condition": _condition_enum(listing.get("condition")),
        "category_id": int(str(cat.get("id"))) if cat.get("id") else None,
        "aspects": {k: [str(v)] for k, v in specifics.items() if v not in (None, "")},
        "image_urls": listing.get("image_urls") or [],
    }
    if listing.get("condition_description"):
        meta["condition_description"] = listing["condition_description"]
    for k in ("fulfillment_policy_id", "payment_policy_id", "return_policy_id",
              "merchant_location_key", "store_category", "best_offer"):
        if listing.get(k) is not None:
            meta[k] = listing[k]
    return meta


def check(creds):
    """Sell-API readiness for the seller's keyset: token works, and how many business
    policies / locations exist. This is what the onboarding screen calls to confirm bring your own keys."""
    try:
        token = ebay_pull.refresh_access_token(creds)
    except Exception as e:
        return {"ok": False, "error": f"could not get a token from those credentials: {e}"}
    out = {"ok": True, "token": True}
    probes = {
        "fulfillment": ("/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US", "fulfillmentPolicies"),
        "payment": ("/sell/account/v1/payment_policy?marketplace_id=EBAY_US", "paymentPolicies"),
        "return": ("/sell/account/v1/return_policy?marketplace_id=EBAY_US", "returnPolicies"),
        "location": ("/sell/inventory/v1/location", "locations"),
    }
    for label, (path, key) in probes.items():
        _, data = ebay_sell._req("GET", token, path)
        out[label] = len(data.get(key, [])) if isinstance(data, dict) else 0
    return out


def list_policies(creds):
    """Fetch the seller's business policies + inventory locations (id + human label) so the
    onboarding screen can offer them as dropdowns instead of asking for raw IDs. bring your own keys, read-only."""
    try:
        token = ebay_pull.refresh_access_token(creds)
    except Exception as e:
        return {"ok": False, "error": f"could not get a token: {e}"}

    def rows(path, key, id_key, label_of):
        _, data = ebay_sell._req("GET", token, path)
        items = data.get(key, []) if isinstance(data, dict) else []
        return [{"id": it.get(id_key), "label": label_of(it) or it.get(id_key)} for it in items]

    def loc_label(it):
        addr = (it.get("location") or {}).get("address") or {}
        city = addr.get("city")
        return f"{city} ({it.get('merchantLocationKey')})" if city else it.get("merchantLocationKey")

    return {
        "ok": True,
        "fulfillment": rows("/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US",
                            "fulfillmentPolicies", "fulfillmentPolicyId", lambda r: r.get("name")),
        "payment": rows("/sell/account/v1/payment_policy?marketplace_id=EBAY_US",
                        "paymentPolicies", "paymentPolicyId", lambda r: r.get("name")),
        "return": rows("/sell/account/v1/return_policy?marketplace_id=EBAY_US",
                       "returnPolicies", "returnPolicyId", lambda r: r.get("name")),
        "location": rows("/sell/inventory/v1/location", "locations",
                         "merchantLocationKey", loc_label),
    }


def _fallback_query(listing):
    """When the datasheet has no title yet, build a category query from the specifics."""
    s = listing.get("specifics") or {}
    return " ".join(str(s.get(k, "")) for k in ("Brand", "Type", "Model")).strip()


def resolve_category(token, query, k=3):
    """Ask eBay's Taxonomy for the right leaf category for this item — never the comp's.
    Returns the ranked suggestions (top first); [] if the query is empty or nothing matches."""
    q = (query or "").strip()
    if not q:
        return []
    try:
        return ebay_taxonomy.suggest(token, q)[:k]
    except (Exception, SystemExit):
        return []


def upload_photos(token, paths):
    """Upload local image files to eBay EPS, return hosted URLs (the Sell API wants URLs, not
    bytes). Skips anything that fails rather than aborting the whole batch."""
    urls = []
    for p in (paths or []):
        if not (p and os.path.isfile(p)):
            continue
        try:
            urls.append(ebay_photos.upload_one(token, p))
        except (Exception, SystemExit):
            continue
    return urls


def publish(listing, creds, policies, dry_run=True, go_live=False, force=False,
            use_taxonomy=True, photo_paths=None):
    """A Bynari datasheet -> a live eBay draft (or published, if go_live). bring your own keys; go_live is the
    seller's explicit trigger only.

    M1b: the category comes from the Taxonomy API (not the comp — the silent-miscategory fix),
    and local photos upload to EPS before the item is sent."""
    meta = listing_to_meta(listing)
    if not meta.get("price"):
        return {"ok": False, "stage": "input", "problems": ["listing has no price set"]}
    if force:
        meta["_force"] = True

    # policies must be present before we bother the network
    app = dict(policies or {})
    app.setdefault("marketplace_id", "EBAY_US")
    for k in _REQUIRED_POLICY:                   # per-listing override wins over account default
        if meta.get(k):
            app[k] = meta[k]
    missing = [k for k in _REQUIRED_POLICY if not app.get(k)]
    if missing:
        return {"ok": False, "stage": "policies",
                "problems": [f"connect your eBay business policies first (missing: {', '.join(missing)})"]}

    try:
        token = ebay_pull.refresh_access_token(creds)
    except Exception as e:
        return {"ok": False, "stage": "auth", "problems": [f"credential/token error: {e}"]}

    # --- category: from the Taxonomy API, not the comp (the 6498 fix) ---
    cat_info = {}
    if use_taxonomy:
        hits = resolve_category(token, meta.get("title") or _fallback_query(listing))
        if hits:
            top = hits[0]
            original = meta.get("category_id")
            meta["category_id"] = int(top["id"])
            cat_info = {"category_path": top["path"], "category_suggestions": hits}
            if original and int(original) != int(top["id"]):
                cat_info["category_changed"] = {"from": int(original), "to": int(top["id"])}
    if not meta.get("category_id"):
        return {"ok": False, "stage": "input",
                "problems": ["no category — Taxonomy returned nothing and the listing set none"],
                **cat_info}

    # --- photos -> EPS (only when actually sending; validate/dry-run needs no images) ---
    paths = photo_paths or listing.get("photo_paths")
    if not meta.get("image_urls") and paths and not dry_run:
        urls = upload_photos(token, paths)
        if not urls:
            return {"ok": False, "stage": "photo_upload",
                    "problems": ["no photos uploaded — check the file paths / eBay EPS"],
                    **cat_info}
        meta["image_urls"] = urls

    result = ebay_sell.publish_meta(token, meta, app, dry_run=dry_run, go_live=go_live)
    result.update(cat_info)
    return result
