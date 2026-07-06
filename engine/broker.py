"""
Shared broker client for the Bynari desktop app.

Wraps four endpoints on api.tadelstein.com. No catalog endpoint exists;
do not add one.

    item.php?item=<itemNumber>                        Browse-API listing fetch
    item_aspects.php?category_id=<id>                 Required/recommended item-specifics schema
    category_suggestions.php?q=<text>                 Taxonomy: ranked category guesses
    item_summary_search.php?q=<kw>&category_id=<id>   Browse comp search (live 2026-05-30)

Lifted from bynari-tabs/tab-listing-producer/broker.py on 2026-05-30
when the listing-producer v1 was re-engineered into the desktop app
per BYN-desktop-architecture_2026-05-30. Carries forward the
hardenings proved there:

    - extract_item_id strips ?var=<variantId> before digit extraction
      (Rev F sec 10.4 bug fix); handles /itm/<slug>/<id> share URLs;
      enforces a 9-15 digit length window.
    - fetch_item raises InvalidItemError for both bad-id forms:
      HTTP 404 and HTTP 200 with {"error": "invalid item id"}.
    - normalize_item trusts the direct categoryId field first
      (authoritative per Rev F sec 10.2) and falls back to splitting
      categoryIdPath only if absent.
"""

import re
from urllib.parse import urlparse

import requests


BASE = "https://api.tadelstein.com"
TIMEOUT = 15
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Bynari-Desktop/0.1",
}


# --------------------------------------------------------------------
# Exceptions
# --------------------------------------------------------------------

class BrokerError(Exception):
    """Transport, HTTP 5xx, or unparseable response from the broker."""


class InvalidItemError(Exception):
    """The broker says this item id is not a valid eBay listing
    (HTTP 404 or HTTP 200 with body {"error": "invalid item id"})."""


# --------------------------------------------------------------------
# Input parsing
# --------------------------------------------------------------------

def extract_item_id(text):
    """Accepts a bare item number (9-15 digits) or an eBay listing URL.

    Returns (item_id, status) where status is one of:
        "ok"          item_id is the listing's itemNumber
        "not_ebay"    input is a URL on a non-eBay domain
        "not_listing" input is an eBay URL with no /itm/<id> segment
        "invalid"     input is neither a valid item number nor a URL
    """
    if not text:
        return None, "invalid"
    text = text.strip()

    if text.isdigit():
        if 9 <= len(text) <= 15:
            return text, "ok"
        return None, "invalid"

    try:
        parsed = urlparse(text)
    except Exception:
        return None, "invalid"
    if not parsed.scheme or not parsed.netloc:
        return None, "invalid"
    if "ebay" not in parsed.netloc:
        return None, "not_ebay"

    # Rev F sec 10.4: a ?var=<variantId> query suffix used to poison
    # naive digit-extraction (the variant id was returned as the item
    # id). urlparse routes the query string into parsed.query, so
    # matching on parsed.path alone keeps variant ids out. The length
    # window is the second line of defense.
    # The optional /[^/?]+/ group catches eBay's /itm/<slug>/<id>
    # share-URL format alongside the plain /itm/<id> form.
    m = re.search(r"/itm/(?:[^/?]+/)?(\d+)", parsed.path)
    if m and 9 <= len(m.group(1)) <= 15:
        return m.group(1), "ok"
    return None, "not_listing"


def parse_input_list(text):
    """Split a free-form blob of comps (one per line, commas, or both)
    into a list of valid item ids plus a list of (raw, status) errors
    for entries that did not parse.
    """
    if not text:
        return [], []
    ok_ids = []
    errors = []
    seen = set()
    for entry in re.split(r"[,\n]+", text):
        entry = entry.strip()
        if not entry:
            continue
        item_id, status = extract_item_id(entry)
        if status == "ok":
            if item_id not in seen:
                ok_ids.append(item_id)
                seen.add(item_id)
        else:
            errors.append((entry, status))
    return ok_ids, errors


# --------------------------------------------------------------------
# HTTP wrapper
# --------------------------------------------------------------------

def _get(path, params):
    url = f"{BASE}/{path}"
    try:
        return requests.get(url, params=params, headers=HEADERS, timeout=TIMEOUT)
    except requests.exceptions.Timeout:
        raise BrokerError("Broker request timed out.")
    except requests.exceptions.RequestException as e:
        raise BrokerError(f"Network error talking to broker: {e}")


# --------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------

def fetch_item(item_id):
    """GET item.php?item=<item_id>; return the parsed Browse-API dict.

    Raises InvalidItemError on either bad-id signal:
        - HTTP 404 (or 400)
        - HTTP 200 with body {"error": "invalid item id"}
    Raises BrokerError on transport failure, 5xx, or unparseable body.
    """
    r = _get("item.php", {"item": item_id})

    if r.status_code in (400, 404):
        raise InvalidItemError(f"Item {item_id}: not found on eBay.")
    if r.status_code >= 500:
        raise BrokerError(f"Broker error fetching item {item_id} (HTTP {r.status_code}).")

    try:
        data = r.json()
    except ValueError:
        snippet = (r.text or "")[:200]
        raise BrokerError(f"Unparseable item.php response. First 200 chars: {snippet}")

    if isinstance(data, dict) and "error" in data and "itemId" not in data:
        raise InvalidItemError(f"Item {item_id}: {data.get('error', 'unknown error')}.")

    return data


def fetch_item_aspects(category_id):
    """GET item_aspects.php?category_id=<id>; return the parsed dict.

    Response shape: {"aspects": [{"name", "required", "mode",
    "dataType", "allowedValues", "allowedValueCount"}, ...]}.
    """
    r = _get("item_aspects.php", {"category_id": str(category_id)})
    if r.status_code >= 400:
        raise BrokerError(
            f"item_aspects error for category {category_id} (HTTP {r.status_code})."
        )
    try:
        return r.json()
    except ValueError:
        raise BrokerError("Unparseable item_aspects.php response.")


def fetch_category_suggestions(query):
    """GET category_suggestions.php?q=<text>; return the parsed dict.

    Response shape: {"categorySuggestions": [{"category", "categoryTreeNodeAncestors"}, ...]}.
    Ancestors are leaf-first; reverse for root-to-leaf breadcrumbs.
    """
    r = _get("category_suggestions.php", {"q": query})
    if r.status_code >= 400:
        raise BrokerError(f"category_suggestions error (HTTP {r.status_code}).")
    try:
        return r.json()
    except ValueError:
        raise BrokerError("Unparseable category_suggestions.php response.")


def fetch_comp_search(keywords, category_id=None, limit=25):
    """GET item_summary_search.php; return the parsed Browse search response.

    Inputs:
        keywords    — required, ≤350 chars
        category_id — optional but strongly recommended for comp harvest
                      (once the user has confirmed a category in Tab 2)
        limit       — clamped to 1–50; default 25

    Response shape (passed through from eBay):
        {"href", "total", "limit", "offset",
         "itemSummaries": [{"itemId", "title", "price{value,currency}",
                            "condition", "conditionId", "itemWebUrl",
                            "categories": [{"categoryId","categoryName"}],
                            "epid", ...}],
         "next", "prev", ...}
    """
    if not keywords or not keywords.strip():
        raise ValueError("keywords required")
    if len(keywords) > 350:
        raise ValueError("keywords too long (max 350 chars)")

    limit = max(1, min(int(limit), 50))
    params = {"q": keywords.strip(), "limit": str(limit)}
    if category_id:
        params["category_id"] = str(category_id)

    r = _get("item_summary_search.php", params)
    if r.status_code in (400, 404):
        try:
            msg = (r.json() or {}).get("error", f"HTTP {r.status_code}")
        except ValueError:
            msg = f"HTTP {r.status_code}"
        raise BrokerError(f"Comp search rejected: {msg}")
    if r.status_code >= 500:
        raise BrokerError(f"Comp search server error (HTTP {r.status_code}).")
    try:
        return r.json()
    except ValueError:
        raise BrokerError("Unparseable item_summary_search.php response.")


# --------------------------------------------------------------------
# Response normalization
# --------------------------------------------------------------------

def normalize_item(api_data):
    """Reshape a Browse-API item.php response into the shape downstream
    aggregation expects. Extends the cassini-pro translator with the
    fields the build brief sec 3.4 calls for (conditionId, brand, mpn,
    returnTerms, shippingOptions).
    """
    specs = {}
    for aspect in api_data.get("localizedAspects") or []:
        name = (aspect.get("name") or "").strip()
        value = (aspect.get("value") or "").strip()
        if name and value:
            specs[name] = value

    # categoryId is the authoritative value (Rev F sec 10.2) and feeds
    # item_aspects, so trust the direct field first; fall back to
    # splitting categoryIdPath only when the direct field is missing.
    cat_id = api_data.get("categoryId", "") or ""
    if not cat_id:
        cat_id_path = api_data.get("categoryIdPath", "") or ""
        cat_id = cat_id_path.split("|")[-1] if cat_id_path else ""

    raw_item_id = api_data.get("itemId", "") or ""
    if "|" in raw_item_id:
        parts = raw_item_id.split("|")
        item_id_clean = parts[1] if len(parts) >= 2 else ""
    else:
        item_id_clean = raw_item_id

    price = api_data.get("price") or {}

    return {
        "title": api_data.get("title", "") or "",
        "itemId": item_id_clean,
        "url": api_data.get("itemWebUrl", "") or "",
        "categoryId": cat_id,
        "categoryPath": api_data.get("categoryPath", "") or "",
        "condition": api_data.get("condition", "") or "",
        "conditionId": api_data.get("conditionId", "") or "",
        "brand": api_data.get("brand", "") or "",
        "mpn": api_data.get("mpn", "") or "",
        "price": price.get("value", "") or "",
        "currency": price.get("currency", "") or "",
        "specs": specs,
        "returnTerms": api_data.get("returnTerms") or {},
        "shippingOptions": api_data.get("shippingOptions") or [],
    }


def normalize_search_response(api_data):
    """Flatten an item_summary_search response into a list of comp dicts
    the UI / harvest loop can consume directly.

    Each comp: {itemId (legacy, v1|… envelope stripped — feed straight
    back to fetch_item), title, price, currency, condition, conditionId,
    url, categoryId (first), epid}.
    """
    out = []
    for s in api_data.get("itemSummaries") or []:
        iid = s.get("itemId", "") or ""
        if "|" in iid:
            parts = iid.split("|")
            legacy = parts[1] if len(parts) >= 2 else iid
        else:
            legacy = iid
        price = s.get("price") or {}
        cats = s.get("categories") or []
        cat_id = ""
        if cats and isinstance(cats[0], dict):
            cat_id = cats[0].get("categoryId", "") or ""
        out.append({
            "itemId": legacy,
            "title": s.get("title", "") or "",
            "price": price.get("value", "") or "",
            "currency": price.get("currency", "") or "",
            "condition": s.get("condition", "") or "",
            "conditionId": s.get("conditionId", "") or "",
            "url": s.get("itemWebUrl", "") or "",
            "categoryId": cat_id,
            "epid": s.get("epid", "") or "",
        })
    return out


def breadcrumb_from_suggestion(suggestion):
    """Build a root-to-leaf breadcrumb from a categorySuggestion entry.

    eBay returns ancestors leaf-first; this reverses them so the
    output reads like a path the seller can recognize.
    """
    category = suggestion.get("category") or {}
    name = category.get("categoryName", "")
    ancestors = suggestion.get("categoryTreeNodeAncestors") or []
    path = [a.get("categoryName", "") for a in reversed(ancestors)]
    if name:
        path.append(name)
    return " > ".join(p for p in path if p)
