#!/usr/bin/env python3
"""etsy.py — Etsy Open API v3 auth + a thin read client. Stdlib only.

Your OWN shop, your OWN app keys, your OWN trigger. This module does two jobs:
  (1) hold an OAuth token for your shop (login + automatic refresh), and
  (2) read the few shop facts a draft needs — shop id, shipping profile,
      return policy, taxonomy node.

It never publishes. Creating the listing is etsy_push.py's job, and Etsy's
createDraftListing leaves it a DRAFT. Nothing goes live until you press Publish
in your own Etsy account.

Setup, once
-----------
  1. Log into Etsy -> https://www.etsy.com/developers/your-apps -> create an app.
     For your own shop you get "personal access" automatically (no review).
     Add a callback URL of exactly:  http://localhost:3003/callback
  2. cp etsy_app.json.template etsy_app.json   and paste in your keystring +
     shared secret.
  3. python3 etsy.py login       # opens a browser, you authorize YOUR shop
  4. python3 etsy.py whoami      # prints your user_id + shop_id
     python3 etsy.py profiles    # your shipping profiles (need one to publish)
     python3 etsy.py policies    # your return policies
     python3 etsy.py taxonomy knife    # find the taxonomy_id for the category

CLI:  login | whoami | profiles | policies | taxonomy <keyword>
"""
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import time
import urllib.parse
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
APP_CFG = os.path.join(HERE, "etsy_app.json")
TOKEN_CACHE = os.path.join(HERE, "etsy_token.json")

API_BASE = "https://api.etsy.com/v3/application"
TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token"
CONNECT_URL = "https://www.etsy.com/oauth/connect"
SCOPES = "listings_r listings_w shops_r"
REDIRECT_DEFAULT = "http://localhost:3003/callback"


# --- config ----------------------------------------------------------------
def load_app():
    if not os.path.exists(APP_CFG):
        sys.exit(f"missing {APP_CFG} — copy etsy_app.json.template and fill it in")
    cfg = json.load(open(APP_CFG))
    if not cfg.get("keystring") or "PASTE" in cfg.get("keystring", ""):
        sys.exit("etsy_app.json: paste your app keystring + shared_secret first")
    cfg.setdefault("redirect_uri", REDIRECT_DEFAULT)
    return cfg


# --- HTTP helpers ----------------------------------------------------------
def _request(method, url, headers=None, data=None):
    req = urllib.request.Request(url, data=data, method=method,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        sys.exit(f"Etsy API {e.code} on {method} {url}\n  {detail}")


def api_get(cfg, path, params=None):
    token = valid_token(cfg)
    url = f"{API_BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    return _request("GET", url, headers={
        # Etsy v3 wants keystring:shared_secret in x-api-key (not the keystring alone)
        "x-api-key": f"{cfg['keystring']}:{cfg['shared_secret']}",
        "Authorization": f"Bearer {token}",
    })


# --- OAuth: PKCE authorization-code flow -----------------------------------
def _pkce_pair():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    captured = {}

    def do_GET(self):
        q = urllib.parse.urlparse(self.path)
        if q.path != "/callback":
            self.send_response(404); self.end_headers(); return
        _CallbackHandler.captured = dict(urllib.parse.parse_qsl(q.query))
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<h2>Bynari: Etsy authorized.</h2>"
                         b"<p>You can close this tab and return to the terminal.</p>")

    def log_message(self, *a):  # keep the terminal quiet
        pass


def login(cfg):
    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(16)
    redirect = cfg["redirect_uri"]
    port = urllib.parse.urlparse(redirect).port or 3003

    auth_url = CONNECT_URL + "?" + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": cfg["keystring"],
        "redirect_uri": redirect,
        "scope": SCOPES,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })

    print("Opening your browser to authorize your Etsy shop...")
    print(f"  (if it doesn't open, paste this URL)\n  {auth_url}\n")
    webbrowser.open(auth_url)

    server = http.server.HTTPServer(("localhost", port), _CallbackHandler)
    server.handle_request()  # serves exactly one request, then returns
    got = _CallbackHandler.captured

    if got.get("state") != state:
        sys.exit("OAuth state mismatch — aborting (possible tampering).")
    if "code" not in got:
        sys.exit(f"no authorization code returned: {got}")

    tok = _request("POST", TOKEN_URL,
                   headers={"Content-Type": "application/x-www-form-urlencoded"},
                   data=urllib.parse.urlencode({
                       "grant_type": "authorization_code",
                       "client_id": cfg["keystring"],
                       "redirect_uri": redirect,
                       "code": got["code"],
                       "code_verifier": verifier,
                   }).encode())
    _save_token(tok)
    print("Authorized. Token cached at", TOKEN_CACHE)


def _save_token(tok):
    tok["expires_at"] = time.time() + int(tok.get("expires_in", 3600))
    json.dump(tok, open(TOKEN_CACHE, "w"), indent=2)


def valid_token(cfg):
    """Return a live access token, refreshing it if it is near expiry."""
    if not os.path.exists(TOKEN_CACHE):
        sys.exit("not logged in — run: python3 etsy.py login")
    tok = json.load(open(TOKEN_CACHE))
    if tok.get("expires_at", 0) - time.time() > 60:
        return tok["access_token"]
    # refresh
    new = _request("POST", TOKEN_URL,
                   headers={"Content-Type": "application/x-www-form-urlencoded"},
                   data=urllib.parse.urlencode({
                       "grant_type": "refresh_token",
                       "client_id": cfg["keystring"],
                       "refresh_token": tok["refresh_token"],
                   }).encode())
    new.setdefault("refresh_token", tok["refresh_token"])
    _save_token(new)
    return new["access_token"]


# --- shop reads ------------------------------------------------------------
def whoami(cfg):
    me = api_get(cfg, "/users/me")
    print(json.dumps(me, indent=2))
    return me


def shop_id(cfg):
    return whoami_quiet(cfg).get("shop_id")


def whoami_quiet(cfg):
    return api_get(cfg, "/users/me")


def profiles(cfg):
    sid = whoami_quiet(cfg)["shop_id"]
    data = api_get(cfg, f"/shops/{sid}/shipping-profiles")
    for p in data.get("results", []):
        print(f"  shipping_profile_id={p['shipping_profile_id']}  {p.get('title')}")
    if not data.get("results"):
        print("  (no shipping profiles — create one in your shop; a listing needs it to publish)")


def policies(cfg):
    sid = whoami_quiet(cfg)["shop_id"]
    data = api_get(cfg, f"/shops/{sid}/policies/return")
    for p in data.get("results", []):
        print(f"  return_policy_id={p['return_policy_id']}  "
              f"accepts_returns={p.get('accepts_returns')} "
              f"accepts_exchanges={p.get('accepts_exchanges')}")
    if not data.get("results"):
        print("  (no return policies found)")


def listing(cfg, listing_id):
    data = api_get(cfg, f"/listings/{listing_id}",
                   {"includes": "Inventory,Shipping,Videos"})
    print(json.dumps(data, indent=2))
    return data


def readiness(cfg):
    sid = whoami_quiet(cfg)["shop_id"]
    data = api_get(cfg, f"/shops/{sid}/readiness-state-definitions")
    for r in data.get("results", []):
        print(f"  readiness_state_id={r.get('readiness_state_id')}  "
              f"min={r.get('min_processing_days')}  max={r.get('max_processing_days')}")
    if not data.get("results"):
        print("  (no readiness state definitions — none set on the shop)")
    return data


def taxonomy(cfg, keyword):
    data = api_get(cfg, "/seller-taxonomy/nodes")
    kw = keyword.lower()
    hits = [n for n in data.get("results", []) if kw in n.get("name", "").lower()]

    def walk(node, trail):
        path = trail + [node["name"]]
        if kw in node["name"].lower():
            print(f"  taxonomy_id={node['id']:<8} {' > '.join(path)}")
        for child in node.get("children", []) or []:
            walk(child, path)

    for top in data.get("results", []):
        walk(top, [])
    if not hits:
        print(f"  (no taxonomy node name contained '{keyword}' at top level; "
              f"deeper matches printed above if any)")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    cfg = load_app()
    if cmd == "login":
        login(cfg)
    elif cmd == "whoami":
        whoami(cfg)
    elif cmd == "profiles":
        profiles(cfg)
    elif cmd == "policies":
        policies(cfg)
    elif cmd == "readiness":
        readiness(cfg)
    elif cmd == "listing":
        listing(cfg, sys.argv[2])
    elif cmd == "taxonomy":
        if len(sys.argv) < 3:
            sys.exit("usage: python3 etsy.py taxonomy <keyword>")
        taxonomy(cfg, sys.argv[2])
    else:
        sys.exit(f"unknown command: {cmd}\n{__doc__}")


if __name__ == "__main__":
    main()
