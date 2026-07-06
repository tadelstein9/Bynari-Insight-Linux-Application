# Bynari

**Turn a few photos into a real eBay listing — on your account, with your keys, on your trigger.**

Bynari is a **free**, open-source, **Linux** desktop tool for people who sell. It reads your item's
photos, drafts a clean listing datasheet, validates it against eBay's own category rules, and — when
*you* say go — publishes it to *your* eBay account. Your catalog and your keys stay on your machine.
No subscription. No account with us. No middleman holding your data.

> **Free · We help you set it up · Contact us anytime.**

## Why it's different

- **You own the catalog.** Your items live in a local SQLite database on a drive *you* choose — not on
  someone's server. Move it to a USB SSD and it moves with you.
- **Bring your own keys.** Bynari lists as *you*, through your own eBay developer keys and OAuth.
  It never publishes on its own; every listing goes live only when you pull the trigger.
- **It can't miscategorize you.** The category comes from eBay's own Taxonomy API — not from a sold comp —
  so a listing can't silently publish into the wrong category and drop half its item specifics.
- **Local-first, no lock-in.** MIT-licensed, all here, yours to read, run, and change.

## What it does

1. **Build the datasheet** — photos + a sold comp become a titled, described, spec-filled listing.
2. **Check it** — a pre-flight against eBay's Taxonomy + Metadata: right category, an allowed condition,
   every required specific present. It refuses to send a listing eBay would silently botch.
3. **Draft, then publish** — create an unpublished draft on your account, review it, and publish when ready.

## Run it (Linux)

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

**Stuck on the OAuth step? We help — that's what we're here for. Reach out.**

## The seller cockpit

```
BYNARI_PAGE=cockpit.html python3 app.py
```

Pick an item, review the datasheet, **Check** it, **Create draft**, then **Publish**. Nothing goes
public until you press Publish.

## Status

The listing engine — build → validate → draft → publish, taxonomy-checked, on your own keys — works today. The
onboarding and cockpit screens are reachable via `BYNARI_PAGE` while they're wired into the main app
navigation, and a packaged one-click Linux download is on the way.

## Contact / help

Open an issue on this repo — we help sellers get set up and unstuck.

## Building on Bynari — other platforms welcome

This tool is Linux desktop. If you want to bring the same idea to a phone, a tablet, another marketplace,
or something I haven't thought of — you're free to; it's MIT. I'd also like to help, and I'd genuinely
like to hear from you. **Open an issue or reach out** — the whole point is more sellers getting free
tools that put them back in control.

## Who's behind it

Bynari is built by **Tom Adelstein** — O'Reilly author (*Linux System Administration*), co-founder of
Bynari, Inc. (1998), and a working eBay seller. He runs the **US Watch Masters** store on eBay and built
this tool to survive the same algorithm shift it fixes.

## License

MIT © 2026 Tom Adelstein. See [LICENSE](LICENSE).
