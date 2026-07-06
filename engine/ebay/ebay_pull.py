#!/usr/bin/env python3
"""ebay_pull.py — recover a seller's own eBay listings via Trading API GetItem.

Runs as the TOKEN OWNER — the keyset for your own selling account
(ebay_credentials.json). GetItem returns the
full listing (title, description, item specifics, condition, price, photos) for
an item number, including ENDED listings within eBay's ~90-day window.

Auth: OAuth. We refresh the access token from the stored refresh_token, then pass
it to the XML Trading API via the X-EBAY-API-IAF-TOKEN header (the documented way
to use an OAuth token with ws/api.dll — no RequesterCredentials block).

Usage:
  python3 ebay_pull.py --item 298089439840                 # pull one, print it
  python3 ebay_pull.py --item 298089439840 --raw           # also dump raw XML
  python3 ebay_pull.py --all                               # pull every library.db listing -> DB + JSON
  python3 ebay_pull.py --all --dry-run                     # pull, print, write nothing
  python3 ebay_pull.py --creds /path/to/creds.json --item ...   # override keyset
"""
import argparse
import json
import os
import sqlite3
import sys
import urllib.parse
import urllib.request
import urllib.error
import base64
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "library.db")
DEFAULT_CREDS = os.path.join(HERE, "ebay_credentials.json")  # your keyset; override with --creds

TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
TRADING_URL = "https://api.ebay.com/ws/api.dll"
COMPAT = "967"
NS = {"e": "urn:ebay:apis:eBLBaseComponents"}


# --- auth ------------------------------------------------------------------
def load_creds(path):
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def refresh_access_token(creds):
    """Mint a fresh access token from the stored refresh_token. Returns the token."""
    basic = base64.b64encode(
        f"{creds['client_id']}:{creds['client_secret']}".encode()
    ).decode()
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": creds["refresh_token"],
        # no scope -> inherit the scopes originally granted to this refresh token
    }).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=body, method="POST",
        headers={"Authorization": f"Basic {basic}",
                 "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            tok = json.loads(r.read())
            return tok["access_token"]
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        sys.exit(f"\nTOKEN REFRESH FAILED ({e.code}).\n  {detail}\n"
                 "  If 'invalid_grant', your refresh token expired or eBay revoked it —\n"
                 "  run your OAuth consent flow again to mint a new one.")


# --- GetItem ---------------------------------------------------------------
def get_item(token, item_id):
    headers = {
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT,
        "X-EBAY-API-CALL-NAME": "GetItem",
        "X-EBAY-API-IAF-TOKEN": token,
        "Content-Type": "text/xml",
    }
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <ItemID>{item_id}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
</GetItemRequest>"""
    req = urllib.request.Request(TRADING_URL, data=xml.encode(), method="POST",
                                 headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.read().decode("utf-8", "replace")


def parse_item(xml_text):
    root = ET.fromstring(xml_text)
    ack = root.findtext(".//e:Ack", "", NS)
    errors = []
    for err in root.findall(".//e:Errors", NS):
        errors.append({
            "code": err.findtext("e:ErrorCode", "", NS),
            "severity": err.findtext("e:SeverityCode", "", NS),
            "short": err.findtext("e:ShortMessage", "", NS),
            "long": err.findtext("e:LongMessage", "", NS),
        })
    item = root.find(".//e:Item", NS)
    data = {"ack": ack, "errors": errors}
    if item is None:
        return data

    def t(path):
        return item.findtext(path, "", NS)

    specifics = {}
    for nv in item.findall(".//e:ItemSpecifics/e:NameValueList", NS):
        name = nv.findtext("e:Name", "", NS)
        vals = [v.text for v in nv.findall("e:Value", NS) if v.text]
        if name:
            specifics[name] = " | ".join(vals)

    pics = [p.text for p in item.findall(".//e:PictureDetails/e:PictureURL", NS) if p.text]

    price = t(".//e:SellingStatus/e:CurrentPrice") or t("e:StartPrice")
    currency = ""
    cp = item.find(".//e:SellingStatus/e:CurrentPrice", NS)
    if cp is None:
        cp = item.find("e:StartPrice", NS)
    if cp is not None:
        currency = cp.get("currencyID", "")

    data.update({
        "item_id": t("e:ItemID"),
        "title": t("e:Title"),
        "subtitle": t("e:SubTitle"),
        "description": t("e:Description"),
        "condition_id": t("e:ConditionID"),
        "condition_name": t("e:ConditionDisplayName"),
        "condition_desc": t("e:ConditionDescription"),
        "price": price,
        "currency": currency,
        "quantity": t("e:Quantity"),
        "listing_status": t(".//e:SellingStatus/e:ListingStatus"),
        "category_id": t(".//e:PrimaryCategory/e:CategoryID"),
        "category_name": t(".//e:PrimaryCategory/e:CategoryName"),
        "specifics": specifics,
        "pictures": pics,
    })
    return data


def print_item(d):
    print("=" * 70)
    if d["ack"] not in ("Success", "Warning"):
        print(f"  Ack={d['ack']}  — GetItem did not succeed")
        for e in d["errors"]:
            print(f"   [{e['severity']} {e['code']}] {e['short']}: {e['long']}")
        if "item_id" not in d:
            return
    print(f"  GetItem  Ack={d['ack']}")
    for e in d["errors"]:
        print(f"   note [{e['severity']} {e['code']}] {e['short']}")
    print("=" * 70)
    print(f"ItemID        : {d.get('item_id')}")
    print(f"Status        : {d.get('listing_status')}")
    print(f"Title         : {d.get('title')}")
    print(f"Price         : {d.get('price')} {d.get('currency')}")
    print(f"Condition     : {d.get('condition_name')} (id {d.get('condition_id')})")
    if d.get("condition_desc"):
        print(f"Condition note: {d['condition_desc']}")
    print(f"Category      : {d.get('category_id')}  {d.get('category_name')}")
    print(f"Pictures      : {len(d.get('pictures', []))}")
    print(f"Specifics     : {len(d.get('specifics', {}))}")
    for k, v in d.get("specifics", {}).items():
        print(f"   - {k}: {v}")
    desc = (d.get("description") or "").strip()
    print(f"Description    ({len(desc)} chars):")
    print("   " + (desc[:600].replace("\n", "\n   ") + (" …" if len(desc) > 600 else "")))


# --- DB write (for --all) --------------------------------------------------
def library_listings():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT i.id, i.slug, l.ebay_item_no FROM items i "
        "JOIN listings l ON l.item_id=i.id WHERE coalesce(l.ebay_item_no,'')<>''"
    ).fetchall()
    con.close()
    return [(r["id"], r["slug"], r["ebay_item_no"]) for r in rows]


def write_back(item_db_id, slug, d):
    con = sqlite3.connect(DB)
    con.execute(
        "UPDATE items SET description=?, condition=?, price=? WHERE id=?",
        (d.get("description"), d.get("condition_name"),
         float(d["price"]) if d.get("price") else None, item_db_id))
    con.commit()
    con.close()
    folder = os.path.join(HERE, "photos", slug)
    if os.path.isdir(folder):
        with open(os.path.join(folder, "ebay_getitem.json"), "w") as f:
            json.dump(d, f, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--item", help="single eBay item number to pull and print")
    ap.add_argument("--all", action="store_true", help="pull every listing in library.db")
    ap.add_argument("--dry-run", action="store_true", help="with --all: print, write nothing")
    ap.add_argument("--raw", action="store_true", help="also print raw XML")
    ap.add_argument("--creds", default=DEFAULT_CREDS, help="path to the keyset JSON")
    args = ap.parse_args()

    creds = load_creds(args.creds)
    print(f"Refreshing access token from {os.path.basename(args.creds)} …")
    token = refresh_access_token(creds)
    print("  token OK\n")

    if args.item:
        xml = get_item(token, args.item)
        if args.raw:
            print(xml)
        print_item(parse_item(xml))
        return

    if args.all:
        for db_id, slug, item_no in library_listings():
            d = parse_item(get_item(token, item_no))
            status = d.get("listing_status", "?")
            ok = d["ack"] in ("Success", "Warning") and d.get("title")
            print(f"[{'OK ' if ok else 'ERR'}] {item_no} {slug}  "
                  f"status={status}  specifics={len(d.get('specifics', {}))}  "
                  f"desc={len((d.get('description') or ''))}c")
            if ok and not args.dry_run:
                write_back(db_id, slug, d)
        if args.dry_run:
            print("\n--dry-run: nothing written to library.db")
        return

    ap.error("give --item <number> or --all")


if __name__ == "__main__":
    main()
