# Bynari Insight (Linux) — working code for people who sell, built in the open

**These are working command-line tools, not an app.** There is no finished GUI. Run from a terminal,
they build and publish real listings on **eBay**, create **Etsy** drafts, and let you **cross-list**
between the two from one local catalog — on your own accounts, with your own keys, on your own trigger.

This is a codebase and a set of scripts, not a one-click download. It's for people comfortable running
Python. The desktop GUI that would wrap these (`app.py`) is unfinished and not yet reliable — the value
here is the tools underneath it, which work.

## Honest status

- **The eBay listing engine works** — it has built and published real eBay listings end to end
  (category from eBay's Taxonomy API, photos to EPS, a draft you publish on your trigger).
- **The Etsy tools work** — auth, and turning a catalog item + its photos into an Etsy *draft*
  (nothing goes live until you press Publish in your own Etsy account).
- **Cross-listing works** as a workflow — one item in your local catalog feeds both channels.
- **No GUI app, no packaged download.** You run these from the terminal.
- The `app.py` desktop shell is unfinished; ignore it unless you want to work on it.

## What the tools do

**eBay**
- `engine/ebay/` + `publish_listing.py` — the engine: build a datasheet → validate it against eBay's
  Taxonomy + Metadata (right category, allowed condition, required specifics) → create an unpublished
  draft on your account → publish when you say so.
- `build_datasheet.py` — turn photos + a sold comp into a titled, spec-filled datasheet.
- `make_ebay_csv.py`, `make_listing.py`, `make_mip_csv.py` — CSV / bulk-listing helpers.
- `store.py` — your local SQLite catalog (items, photos, templates, listing state).

**Etsy** (Open API v3, your own app + shop, stdlib only)
- `etsy.py` — OAuth login + token refresh, and reads the shop facts a draft needs (shop id, shipping
  profiles, return policies, taxonomy ids). Never publishes. `login | whoami | profiles | policies | taxonomy <kw>`.
- `etsy_push.py` — turn a catalog item + its photos into an Etsy **draft** (`createDraftListing` + image upload).
- `etsy_update.py`, `etsy_retag.py`, `etsy_video.py`, `etsy_replace_image.py`, `etsy_verify.py` — edit and
  check an existing draft (fields, tags, video, images).

**Cross-listing (Etsy ↔ eBay)**
One item lives once in your local catalog. Per-item sidecars carry the channel fields —
`etsy_meta.json` for Etsy, `ebay_meta.json` for eBay — so the same item can become an Etsy draft
(`etsy_push.py`) and an eBay listing (the engine) without re-entering it. That's the cross-list: shared
catalog, two channels, each published on your trigger.

## Run it from source (Linux)

```
python3 -m venv .venv && . .venv/bin/activate
pip install pywebview[qt] Pillow
```

Point the tools at your catalog folder (holds `library.db` + `photos/<slug>/`):

```
export BYNARI_LIB=/path/to/your/library
```

### Connect eBay (your own keys)

Bynari needs your own eBay developer **App ID**, **Cert ID**, and a **Refresh token** (from
developer.ebay.com — make a Production keyset, add a RuName, run the consent flow once for the
Sell/Inventory scopes). The engine's publish path is exercised end to end.

### Connect Etsy (your own app + shop)

1. Create an app at https://www.etsy.com/developers/your-apps — for your own shop you get personal
   access automatically. Set the callback to `http://localhost:3003/callback`.
2. `cp etsy_app.json.template etsy_app.json` and paste in your keystring + shared secret.
3. `python3 etsy.py login` → authorize your shop. `python3 etsy.py whoami` to confirm.
4. `python3 etsy.py profiles` / `policies` / `taxonomy <keyword>` to fill in the ids a draft needs.

Your `etsy_app.json` and `etsy_token.json` stay local and are git-ignored — they never leave your machine.

## Build your own Cassini database

Bynari fills the item specifics eBay's search rewards, per category. That data lives in a local SQLite
file you build yourself from eBay's public APIs — Bynari does not ship a populated one. See
[`docs/BUILD-YOUR-CASSINI.md`](docs/BUILD-YOUR-CASSINI.md) and [`schema/cassini.schema.sql`](schema/cassini.schema.sql).

## Contact / help

Open an issue — it's early and rough, so questions, bug reports, and "this didn't work" are all welcome.

## Building on Bynari — other platforms welcome

This project is Linux, terminal-first. If you want to bring the same idea to a phone, a tablet, another
marketplace, or a real GUI — you're free to; it's MIT. I'd also like to help, and I'd genuinely like to
hear from you. **Open an issue or reach out.**

## Who's behind it

Bynari is built by **Tom Adelstein** — O'Reilly author (*Linux System Administration*), co-founder of
Bynari, Inc. (1998), and a working eBay seller. He runs the **US Watch Masters** store on eBay and started
this to survive the same algorithm shift it aims to fix.

## License

MIT © 2026 Tom Adelstein. See [LICENSE](LICENSE).
