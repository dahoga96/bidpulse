# BIDPULSE

Every outbid.lol listing with click data, ranked by **what a click actually cost** —
lifetime dollars over lifetime clicks. The leaderboard ranks by who paid the most;
this ranks by who got the best deal.

Live at **https://bidpulse.dev**.

---

## Run it

```bash
npm run dev        # serve on http://localhost:3000
npm run crawl      # read outbid.lol, write listings.json + history.json
```

No dependencies to install. `dev` uses `npx serve` on demand, and the crawler is
plain Node 20+ (`fetch` is built in).

Do not open `index.html` with `file://` — the page fetches `listings.json`, which
CORS blocks on the file protocol; you'll silently get sample data.

## How it fits together

```
crawler.js  →  listings.json  ← the page fetches this on load and every 5 min
            →  history.json   ← 48h of per-listing paid totals; feeds bid events
index.html  →  everything else; single file, no build step
```

outbid.lol ships its entire board in the page's embedded payload. Two shapes:

- **full records** (top ~50 spenders): paid total, lifetime click count, name,
  URL, description — these are the only listings that can be deal-ranked
- **compact records** (the whole board): key + paid total — used for the true
  board size, total, and each ranked listing's board position

`$ / click` = lifetime `amountCents/100` over lifetime `clickCount`. That is NOT
the "clicks" counter displayed on outbid.lol's rows (that one resets per bid).
The page says so; keep the copy and the definition in sync.

A rise in a listing's paid total between crawls is a bid — those become the
"Latest bids" feed.

`index.html` starts with `SAMPLE = true` and a small fallback array. On boot it
tries `listings.json`; if that loads, it removes the red banner. If the fetch
fails, the banner stays up. **The banner is a safety feature** — the one asset
this product has is being right about other people's numbers.

The crawler exits non-zero when the page reads wrong (too few records = layout
change), which aborts the deploy so the last good data stays live.

## Deploy

Cloudflare Pages, via `.github/workflows/crawl-and-deploy.yml`. Every 5 minutes
(and on every push to main) the workflow crawls outbid.lol — one request — and
publishes `index.html + _headers + listings.json + history.json` with a wrangler
**direct upload** (not Cloudflare's git integration: 288 deploys/day would blow
the 500 builds/month cap; direct uploads don't count). The repo is public so
Actions minutes are free.

Secrets (Settings → Secrets and variables → Actions):

1. `CLOUDFLARE_API_TOKEN` — **Cloudflare Pages: Edit** permission.
2. `CLOUDFLARE_ACCOUNT_ID` — dashboard right sidebar.

The public domain is **https://bidpulse.dev**; `bidpulse.pages.dev` stays as an
alias and the workflow's state-restore step deliberately uses it. GitHub disables
cron workflows after 60 days without a push — if the site goes stale, check the
Actions tab for the re-enable button.

## Manners

One request to outbid.lol per 5 minutes, honest user-agent with a contact URL,
public page only. Outbound links are `rel="nofollow"`. Not affiliated with
outbid.lol; if a figure is disputed, re-read the page and publish the correction.

## History

This started as a multi-board rate card tracking ~30 pay-to-rank boards
(see git history up to `91573c9`). Pivoted 2026-08-22 to a single-board deal
ranking: outbid.lol publishes complete per-listing data, which makes $/click
comparisons apples-to-apples in a way cross-board numbers never were.

## License

Private. Not affiliated with any site listed.
