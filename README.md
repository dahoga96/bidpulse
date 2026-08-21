# BIDPULSE

Live rate card for pay-to-rank leaderboards. The only page that tells a buyer what a
slot actually costs per click, and which boards stopped taking bids hours ago.

Two directories already exist (outoutbid.lol, biddirectory.lol) and both are just
lists. This is not a list — it's the derived data. `$ / click` is the whole product.

---

## Run it

```bash
npm run dev        # serve on http://localhost:3000
npm run crawl      # read every board, write boards.json + history.json
```

No dependencies to install. `dev` uses `npx serve` on demand, and the crawler is
plain Node 20+ (`fetch` is built in).

Do not open `index.html` with `file://`. The page fetches `boards.json`, which
CORS blocks on the file protocol — you'll silently get sample data. Use `npm run dev`
or the Live Server extension.

## How it fits together

```
crawler.js  →  boards.json   ← the page fetches this on load and every 15 min
            →  history.json  ← 48h of bid deltas, feeds the pulse sparklines
index.html  →  everything else; single file, no build step
```

`index.html` starts with `SAMPLE = true` and a hardcoded `FALLBACK` array. On boot it
tries `boards.json`; if that loads with real parsed boards, it flips `SAMPLE` to false
and removes the red banner. If the fetch fails, the banner stays up.

**That banner is a safety feature. Don't remove it manually.** The one asset this
product has is being right about other people's numbers. Ship a wrong price once and
the operators pile on and you're done.

## Before launch

- [ ] `npm run crawl` and read `boards.json` by hand. Every figure, against the live page.
- [ ] Fix parse failures via `OVERRIDES` in crawler.js — explicit selectors, not a
      cleverer regex. A silently wrong number is worse than a `—`.
- [ ] Wire the submit form (`#submitForm`) to a real endpoint. Currently it just
      shows an acknowledgement.
- [ ] Set the sponsor slot price and payment link in `SPONSOR`.
- [ ] Put a real bot URL in the crawler's `UA` string.
- [ ] Publish a corrections policy and honour it the first time an operator is right.

## Deploy

Cloudflare Pages, via `.github/workflows/crawl-and-deploy.yml`. Every 15 minutes
(and on every push to main) the workflow crawls all boards and publishes
`index.html + _headers + boards.json + history.json` with a wrangler **direct
upload** — deliberately not Cloudflare's git integration, because 96 deploys a
day is ~2,900 builds/month against Pages' 500/month free build cap. Direct
uploads don't count against it.

One-time setup, in the GitHub repo under Settings → Secrets and variables → Actions:

1. `CLOUDFLARE_API_TOKEN` — create at dash.cloudflare.com → My Profile →
   API Tokens, with the **Cloudflare Pages: Edit** permission.
2. `CLOUDFLARE_ACCOUNT_ID` — shown in the dashboard's right sidebar.

The first workflow run creates the Pages project itself and the site appears at
`https://bidpulse.pages.dev`. If that name is taken, change `PROJECT_NAME` once
at the top of the workflow.

Two things to know about the setup:

- `history.json` is never committed; each run re-downloads it from the live site,
  appends the new crawl, and republishes it. If a run is skipped the sparklines
  just get a gap, nothing breaks.
- GitHub disables cron workflows after 60 days without a repo push. If the site
  goes quiet, that's the first thing to check (Actions tab shows a re-enable
  button).

## Crawling manners

One request per board per 15 minutes, 4 concurrent, 400ms apart, honest user-agent
with a contact URL. All public HTML, nothing behind a login. Keep it that way —
you're publishing critical numbers about these people and the first counter-attack
will be "they're hammering my server."

Outbound links are `rel="nofollow"`. Leave them that way. Selling dofollow links is a
different and much worse business, and it would destroy the neutrality this depends on.

## License

Private. Not affiliated with any board listed.
