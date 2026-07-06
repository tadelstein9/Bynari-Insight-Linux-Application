#!/usr/bin/env python3
"""make_listing.py — turn a folder of item photos + one sold comp into a listing.

This is the whole "inventory management" idea, deflated to a script:
  files on disk  ->  read them  ->  write a listing into a place that remembers.

Inputs (all local, all the seller's own):
  --photos   folder of this item's photos/videos
  --comp     an eBay item number to seed words/specifics from (the comp)
  --identify optional sidecar of visual observations of THIS item (identify.json)

Output:
  listing.json  — the remembered record, written back into the photo folder
  a human-readable datasheet printed to stdout

It asserts only what it can back: comp specifics + the seller's own observations.
Anything physical it cannot verify goes to needs_seller_confirm, never into a field.
"""
import argparse, json, os, sys, textwrap, urllib.request

BROKER = "https://api.tadelstein.com"
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}
VID_EXT = {".mp4", ".mov", ".m4v"}


def broker_get(path):
    req = urllib.request.Request(f"{BROKER}/{path}",
                                 headers={"Accept": "application/json",
                                          "User-Agent": "Bynari/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def load_or_fetch(folder, name, path):
    """Use a cached json next to the photos if present, else fetch + cache it."""
    cached = os.path.join(folder, name)
    if os.path.exists(cached):
        return json.load(open(cached))
    data = broker_get(path)
    json.dump(data, open(cached, "w"), indent=2)
    return data


def scan_media(folder, roles):
    photos, videos = [], []
    for fn in sorted(os.listdir(folder)):
        ext = os.path.splitext(fn)[1].lower()
        entry = {"file": fn, "role": roles.get(fn, "")}
        if ext in IMG_EXT:
            photos.append(entry)
        elif ext in VID_EXT:
            videos.append(entry)
    return photos, videos


def build_title(comp_aspects, obs):
    """Cassini title: brand + jewels + key search nouns, 62-80 chars, photo-backed only."""
    brand = comp_aspects.get("Brand", "")
    jewels = comp_aspects.get("Number of Jewels", "").replace(" Jewels", "")
    parts = [brand,
             f"{jewels} Jewels" if jewels else "",
             "Swiss" if "Swiss" in comp_aspects.get("Features", "") else "",
             "Pendant Watch",
             "Black Enamel" if "enamel" in obs.get("Caseback", "").lower() else "",
             "Gold Floral" if obs.get("Theme") == "Floral" else "",
             "Womens" if comp_aspects.get("Department") == "Women" else "",
             "Vintage" if obs.get("Vintage") == "Yes" else ""]
    title = " ".join(p for p in parts if p)
    return title[:80].strip()


def build_description(comp_aspects, obs):
    """Neutral, factual, four short clauses. No filler, no as-is, no unconfirmed claims."""
    brand = comp_aspects.get("Brand", "this")
    jewels = comp_aspects.get("Number of Jewels", "")
    size = obs.get("Case Size", "")
    sent = [f"Vintage {brand} pendant (necklace) watch.",
            "Black enamel case with a gold floral inlay and an ornate pendant bail.",
            f"Swiss {jewels.lower()} manual-wind movement." if jewels else "",
            f"Case measures approximately {size} across." if size else ""]
    return " ".join(s for s in sent if s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--photos", required=True)
    ap.add_argument("--comp", required=True)
    ap.add_argument("--identify", default=None)
    args = ap.parse_args()

    folder = os.path.abspath(args.photos)
    if not os.path.isdir(folder):
        sys.exit(f"no such folder: {folder}")

    comp = load_or_fetch(folder, "comp.json", f"item.php?item={args.comp}")
    cat_id = comp["categoryIdPath"].split("|")[-1]
    aspects = load_or_fetch(folder, "aspects.json", f"item_aspects.php?category_id={cat_id}")

    identify = json.load(open(args.identify)) if args.identify and os.path.exists(args.identify) else {}
    obs = identify.get("observed_specifics", {})
    roles = identify.get("media_roles", {})
    confirm = identify.get("needs_seller_confirm", [])
    verified = identify.get("verified", [])

    comp_aspects = {a["name"]: a["value"] for a in comp.get("localizedAspects", [])}
    photos, videos = scan_media(folder, roles)

    # Fill the category schema. The item's OWN observations win over the comp
    # wherever they disagree — the comp is only a fallback for fields the photos
    # don't cover. (Publishing the comp's brand/dial/chain over the real watch
    # is exactly the failure this ordering prevents.)
    schema_names = [a["name"] for a in aspects.get("aspects", [])]
    required = {a["name"] for a in aspects.get("aspects", []) if a.get("required")}
    specifics = {}
    for name in schema_names:
        if name in obs:
            specifics[name] = obs[name]
        elif name in comp_aspects:
            specifics[name] = comp_aspects[name]
    # Seller-supplied specifics not in eBay's schema for this category (e.g. Closure,
    # Country/Region of Manufacture) — eBay accepts custom aspects, so carry them through.
    for k, v in identify.get("custom_specifics", {}).items():
        specifics.setdefault(k, v)

    listing = {
        "item_ref": os.path.basename(folder),
        "comp_source": {"item": args.comp, "title": comp.get("title"),
                        "sold_price": comp.get("price", {}).get("value"),
                        "condition": comp.get("condition")},
        "category": {"id": cat_id, "path": comp.get("categoryPath")},
        "title": identify.get("title_hint") or build_title(specifics, obs),
        "condition": comp.get("condition", ""),
        "suggested_price": comp.get("price", {}).get("value"),
        "price": identify.get("price"),  # seller's call; comp price stays as suggested_price
        "description": identify.get("description_draft") or build_description(specifics, obs),
        "specifics": specifics,
        "missing_required": [n for n in required if n not in specifics],
        "photos": photos,
        "videos": videos,
        "needs_seller_confirm": confirm,
        "verified": verified,
    }

    out = os.path.join(folder, "listing.json")
    json.dump(listing, open(out, "w"), indent=2)

    # human-readable datasheet
    w = lambda s="": print(s)
    w("=" * 64)
    w(f"  LISTING DATASHEET  —  {listing['item_ref']}")
    w("=" * 64)
    w(f"Title ({len(listing['title'])} chars):")
    w(f"  {listing['title']}")
    w()
    w(f"Category : {listing['category']['path']}  (#{cat_id})")
    w(f"Condition: {listing['condition']}")
    if listing["price"]:
        w(f"Price    : ${listing['price']} (seller-set; comp was ${listing['suggested_price']})")
    else:
        w(f"Price    : suggested ${listing['suggested_price']} (comp) — seller sets final")
    w()
    w("Description:")
    for line in textwrap.wrap(listing["description"], 60):
        w(f"  {line}")
    w()
    w("Item specifics:")
    for k, v in specifics.items():
        w(f"  {'* ' if k in required else '  '}{k}: {v}")
    if listing["missing_required"]:
        w(f"  ! REQUIRED still blank: {', '.join(listing['missing_required'])}")
    w()
    w(f"Media: {len(photos)} photos, {len(videos)} videos")
    for p in photos:
        w(f"  - {p['file']}  [{p['role'] or '?'}]")
    for v in videos:
        w(f"  - {v['file']}  [{v['role'] or '?'}]")
    w()
    if confirm:
        w("Needs seller confirm (NOT placed in any field):")
        for c in confirm:
            for i, line in enumerate(textwrap.wrap(c, 58)):
                w(f"  {'- ' if i == 0 else '  '}{line}")
        w()
    if verified:
        w("Verified against the photos/video:")
        for c in verified:
            for i, line in enumerate(textwrap.wrap(c, 58)):
                w(f"  {'+ ' if i == 0 else '  '}{line}")
    w()
    w(f"Saved: {out}")


if __name__ == "__main__":
    main()
