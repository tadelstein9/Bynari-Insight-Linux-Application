"""
Bynari v4 — datasheet builder (the plumbing).

Given an item's identified facts + a few eBay comp item numbers, this:
  1. harvests each comp through the live broker (api.tadelstein.com),
  2. takes PRICE (median) and CATEGORY (mode) from the comps,
  3. adds only comp specifics that ≥2 comps agree on AND that the item
     hasn't already pinned (consensus fills gaps, never overrides truth),
  4. composes title / condition / description from the item's own facts,
  5. lists the item's photos,
and writes preview/items/<slug>.json — which the listing form loads and
fills itself. No human paste step.

Run:  ./.venv/bin/python build_datasheet.py
"""
import glob
import json
import os
import statistics
import sys

from engine import broker

HERE = os.path.dirname(os.path.abspath(__file__))
# Where item photos live, as <PHOTO_DIR>/<slug>/. Override with BYNARI_PHOTO_DIR;
# defaults to ~/Bynari-Library/photos so the tool runs on any machine.
PHOTO_DIR = os.environ.get(
    "BYNARI_PHOTO_DIR", os.path.expanduser("~/Bynari-Library/photos")
)

# ----------------------------------------------------------------------
# The item — identified facts (stands in for the vision/identify step).
# These are AUTHORITATIVE: comp consensus may fill gaps but never override.
# ----------------------------------------------------------------------
SPECS = {
  "ladies-locket-489": {
    "slug": "ladies-locket-489",
    "comps": ["227257712153", "198226637010", "178181680745"],
    "main_photo": "20260613_115256.jpg",       # the dial / face
    "condition_label": "Pre-owned",
    "untested": True,
    "watch_only": True,
    # ordered, authoritative item specifics
    "facts": [
        ("Brand", "Arnex"),
        ("Department", "Women"),
        ("Type", "Pocket Watch"),
        ("Movement", "Quartz (Battery)"),
        ("Closure", "Full Hunter"),
        ("Case Material", "Base Metal"),
        ("Case Finish", "Gold-Tone"),
        ("Case Shape", "Octagon"),
        ("Dial Color", "Yellow Gold"),
        ("Indices", "Arabic Numerals"),
        ("Theme", "Floral"),
        ("Display", "Analog"),
        ("Country/Region of Manufacture", "Switzerland"),
        ("Vintage", "Yes"),
        ("Model", "489"),
    ],
    # comp specifics we'll accept by consensus (≥2 comps) if not already pinned
    "consensus_allow": {"Features", "Water Resistance", "Style", "Caseback"},
  },
  "ladies-346": {
    "slug": "ladies-346",
    "comps": ["127901513265"],
    "main_photo": "20260613_144432.jpg",   # the open Kent dial
    "condition_label": "Pre-owned",
    "untested": False,
    "watch_only": True,
    "title": "Vintage Arnex Running Pendant Watch Swiss 17 Jewel Black Enamel Gold Floral",
    "condition": "Vintage Arnex pendant watch with a black enamel cover decorated in gold floral. The cover opens to a clean dial signed Kent with a Swiss 17-jewel mechanical movement. Gold-tone base-metal case with light wear consistent with age. Wound by hand it runs; sold as the watch only.",
    "description": "A vintage Arnex pendant watch with a striking black enamel cover in gold foliate scrolls. The hinged cover opens to reveal a clean dial signed Kent, driven by a 17-jewel Swiss mechanical movement marked Incabloc. Wound by hand, it is running. The gold-tone base-metal case carries a decorative bail for the chain of your choice. A lovely mid-century enamel necklace watch to wear or add to a vintage collection.",
    "facts": [
        ("Brand", "Arnex"),
        ("Department", "Women"),
        ("Type", "Necklace Watch"),
        ("Movement", "Mechanical (Manual Wind)"),
        ("Number of Jewels", "17 Jewels"),
        ("Closure", "Full Hunter"),
        ("Case Material", "Base Metal"),
        ("Case Finish", "Gold-Tone"),
        ("Case Shape", "Round"),
        ("Dial Color", "Silver"),
        ("Indices", "Arabic Numerals"),
        ("Theme", "Floral"),
        ("Display", "Analog"),
        ("Country/Region of Manufacture", "Switzerland"),
        ("Vintage", "Yes"),
    ],
    "consensus_allow": {"Features", "Water Resistance", "Style", "Year Manufactured"},
  },
}
ITEM = SPECS[sys.argv[1] if len(sys.argv) > 1 else "ladies-locket-489"]

# ----------------------------------------------------------------------
# Harvest the comps
# ----------------------------------------------------------------------
def harvest(comp_ids):
    rows = []
    for iid in comp_ids:
        try:
            rows.append(broker.normalize_item(broker.fetch_item(iid)))
            print(f"  harvested {iid}")
        except Exception as e:
            print(f"  skip {iid}: {type(e).__name__}: {e}")
    return rows


def price_from(comps):
    vals = []
    for c in comps:
        try:
            vals.append(float(c["price"]))
        except (TypeError, ValueError):
            pass
    if not vals:
        return ""
    return f"{statistics.median(vals):.2f}"


def category_from(comps):
    cats = [(c["categoryId"], c["categoryPath"]) for c in comps if c.get("categoryId")]
    if not cats:
        return "", ""
    # mode by id
    best = max(set(c[0] for c in cats), key=lambda cid: sum(1 for c in cats if c[0] == cid))
    path = next((p for cid, p in cats if cid == best), "")
    return best, path.replace("|", " > ")


def consensus_extras(comps, pinned_names, allow):
    """Specifics ≥2 comps agree on, in the allow-list, not already pinned."""
    tally = {}
    for c in comps:
        for name, val in (c.get("specs") or {}).items():
            if name in pinned_names or name not in allow:
                continue
            tally.setdefault(name, {}).setdefault(val, 0)
            tally[name][val] += 1
    out = []
    for name, vals in tally.items():
        val, n = max(vals.items(), key=lambda kv: kv[1])
        if n >= 2:
            out.append((name, val))
    return out


# ----------------------------------------------------------------------
# Compose the prose from the item's own facts (not from the comps)
# ----------------------------------------------------------------------
def compose(item, fact_map):
    brand = fact_map.get("Brand", "")
    theme = fact_map.get("Theme", "")
    finish = fact_map.get("Case Finish", "Gold-Tone").replace("-", " ")
    material = fact_map.get("Case Material", "").lower()
    dial = fact_map.get("Dial Color", "").lower()
    indices = fact_map.get("Indices", "").lower()

    title = " ".join([
        "Vintage", brand, "Pendant Pocket Watch", "Gold Tone",
        "Quartz", "Swiss Made", theme, "Hunter",
    ]).strip()

    tested = "sold untested, as the watch only" if item["untested"] else "in working order"
    condition = (
        f"Vintage {brand} ladies pendant pocket watch with a full hunter cover in a "
        f"{theme.lower()} design. The signed {dial} dial is clean with crisp {indices}. "
        f"{finish} {material} case; the cover shows wear consistent with age. "
        f"Quartz movement and battery are shown in the photos; {tested}."
    )
    description = (
        f"A vintage {brand} pendant pocket watch with a full hunter cover — a hinged "
        f"{theme.lower()} lid that opens to reveal a {dial} dial with black "
        f"{indices}, signed {brand}. The octagonal {finish.lower()} case has a "
        f"rope-twist edge and a bail at the top for the chain of your choice. It is "
        f"fitted with a Swiss quartz movement, shown in the photos. A charming necklace "
        f"watch to wear or add to a vintage collection."
    )
    return title[:80], condition, description


def write_datasheet_txt(sheet, folder):
    """Write the human-readable datasheet into the item's own SSD folder,
    right next to its photos — one folder = the item's complete record."""
    lines = []
    lines += ["TITLE", sheet["title"], ""]
    lines += [f"CONDITION ({sheet['condition_label']})", sheet["condition"], ""]
    lines += ["DESCRIPTION", sheet["description"], ""]
    lines += ["CATEGORY", sheet["category_path"], ""]
    lines += ["PRICE", f"${sheet['price']}", ""]
    lines += ["ITEM SPECIFICS"]
    for s in sheet["specifics"]:
        tag = "  (from comps)" if s.get("from") else ""
        lines.append(f"  {s['name']}: {s['value']}{tag}")
    path = os.path.join(folder, "datasheet.txt")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return path


def photos_for(item):
    folder = os.path.join(PHOTO_DIR, item["slug"])
    jpgs = sorted(os.path.basename(p) for p in glob.glob(os.path.join(folder, "*.jpg")))
    main = item["main_photo"]
    ordered = ([main] + [j for j in jpgs if j != main]) if main in jpgs else jpgs
    photos = [{"src": f"photos/{item['slug']}/{j}", "main": (j == ordered[0])} for j in ordered]
    vids = sorted(os.path.basename(p) for p in glob.glob(os.path.join(folder, "*.mp4")))
    video = f"photos/{item['slug']}/{vids[0]}" if vids else ""
    return photos, video


# ----------------------------------------------------------------------
def main():
    print(f"Harvesting {len(ITEM['comps'])} comps for {ITEM['slug']}…")
    comps = harvest(ITEM["comps"])

    fact_map = dict(ITEM["facts"])
    pinned = set(fact_map.keys())
    specifics = [{"name": n, "value": v} for n, v in ITEM["facts"]]
    for name, val in consensus_extras(comps, pinned, ITEM["consensus_allow"]):
        specifics.append({"name": name, "value": val, "from": "comp consensus"})

    cat_id, cat_path = category_from(comps)
    if ITEM.get("title"):
        title, condition, description = ITEM["title"][:80], ITEM["condition"], ITEM["description"]
    else:
        title, condition, description = compose(ITEM, fact_map)
    photos, video = photos_for(ITEM)

    sheet = {
        "slug": ITEM["slug"],
        "title": title,
        "condition_label": ITEM["condition_label"],
        "condition": condition,
        "description": description,
        "price": price_from(comps),
        "category_id": cat_id,
        "category_path": cat_path,
        "specifics": specifics,
        "photos": photos,
        "video": video,
        "comp_count": len(comps),
    }

    out = os.path.join(HERE, "preview", "items", f"{ITEM['slug']}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(sheet, f, indent=2)

    ssd_folder = os.path.join(PHOTO_DIR, ITEM["slug"])
    txt_path = write_datasheet_txt(sheet, ssd_folder)

    # maintain the item manifest the Inventory view reads
    idx_path = os.path.join(os.path.dirname(out), "index.json")
    try:
        idx = json.load(open(idx_path))
    except Exception:
        idx = []
    if ITEM["slug"] not in idx:
        idx.append(ITEM["slug"])
        json.dump(idx, open(idx_path, "w"), indent=2)

    print(f"\nWrote {out}")
    print(f"  datasheet→ {txt_path}")
    print(f"  title    : {title}  ({len(title)}/80)")
    print(f"  price    : ${sheet['price']}   (from {len(comps)} comps)")
    print(f"  category : {cat_id}  {cat_path}")
    print(f"  specifics: {len(specifics)} fields  ({len(specifics)-len(ITEM['facts'])} added by consensus)")
    print(f"  photos   : {len(photos)}{'  + video' if video else ''}")


if __name__ == "__main__":
    main()
