# Bynari Insight (Linux) — a work in progress, built in the open

**Open-source listing tools for people who sell. Early days: the engine works; the app around it is still being built.**

Bynari is a free, open-source, Linux project — and, honestly, a codebase rather than a finished download.
The goal: read an item's photos, draft a clean listing datasheet, validate it against eBay's own category
rules, and — only when *you* say go — publish it to *your* eBay account, with your catalog and your keys
staying on your own machine. No subscription, no account with us, no middleman holding your data.

## Honest status

- The **listing engine works.** It has built and published real eBay listings end to end — category from
  eBay's Taxonomy API, photos to EPS, a draft you publish on your own trigger.
- The **desktop app (`app.py`) is unfinished** and not yet reliable to click through.
- The **browser tool** loads but its end-to-end workflow isn't verified.
- There is **no packaged one-click download yet.** Running it means running from source (below).

If you're a developer who wants to read the code, run the engine, or build on it — welcome. If you're a
seller waiting for something you can install and use, it isn't ready yet. This README will say so until it is.

## What works today

- **The listing engine** — build → validate → draft → publish, taxonomy-checked, on your own keys.
- **Bring your own keys** — it lists as *you*, through your own eBay developer keys and OAuth. Nothing
  publishes on its own; every listing goes live only when you pull the trigger.
- **Category from eBay's Taxonomy API** — not from a sold comp — so it won't silently publish into the
  wrong category and drop half its item specifics.
- **Local-first** — your items live in a local SQLite database on a drive *you* choose. MIT-licensed,
  all here, yours to read, run, and change.

## Run it from source (Linux, for developers)

```
python3 -m venv .venv && . .venv/bin/activate
pip install pywebview[qt] Pillow
python3 app.py
```

### Connect your eBay account (one-time — you bring your own keys)

Bynari needs three things from your own eBay developer account: an **App ID (Client ID)**, a
**Cert ID (Client Secret)**, and a **Refresh token**.

1. Make a free developer account at **developer.ebay.com**.
2. Create a **Production** keyset → that's your App ID and Cert ID.
3. Add an **OAuth redirect URI (RuName)** to the keyset.
4. Run the **user consent flow** once to mint your **refresh token** (grant the Sell/Inventory scopes).

Then open the connect screen and paste them in:

```
BYNARI_PAGE=onboarding.html python3 app.py
```

The engine's publish path is exercised end to end; the GUI wrapping it is still rough — expect to read code.

## Build your own Cassini database

Bynari fills the item specifics eBay's search rewards, per category. That data lives in a local SQLite file
you build yourself from eBay's public APIs — Bynari does not ship a populated one. See
[`docs/BUILD-YOUR-CASSINI.md`](docs/BUILD-YOUR-CASSINI.md) and [`schema/cassini.schema.sql`](schema/cassini.schema.sql).

## Contact / help

Open an issue — it's early and rough, so questions, bug reports, and "this didn't work" are all welcome.

## Building on Bynari — other platforms welcome

This project is Linux desktop. If you want to bring the same idea to a phone, a tablet, another marketplace,
or something I haven't thought of — you're free to; it's MIT. I'd also like to help, and I'd genuinely
like to hear from you. **Open an issue or reach out** — the whole point is more sellers getting free tools
that put them back in control.

## Who's behind it

Bynari is built by **Tom Adelstein** — O'Reilly author (*Linux System Administration*), co-founder of
Bynari, Inc. (1998), and a working eBay seller. He runs the **US Watch Masters** store on eBay and started
this to survive the same algorithm shift it aims to fix.

## License

MIT © 2026 Tom Adelstein. See [LICENSE](LICENSE).
