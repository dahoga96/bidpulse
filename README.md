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

```bash
npx vercel deploy --prod
```

Static, so Cloudflare Pages / Netlify work identically. Then run the crawler on a
schedule — GitHub Actions is simplest:

```yaml
# .github/workflows/crawl.yml
on:
  schedule: [{ cron: "*/15 * * * *" }]
  workflow_dispatch:
jobs:
  crawl:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node crawler.js
      - run: |
          git config user.name  "bidpulse-bot"
          git config user.email "bot@users.noreply.github.com"
          git add boards.json history.json
          git commit -m "crawl $(date -u +%FT%TZ)" || exit 0
          git push
```

Note this needs `history.json` committed, so drop it from `.gitignore` if you go this
route. Cleaner alternative once there's traffic: run the crawler on a small worker and
write `boards.json` to object storage.

## Crawling manners

One request per board per 15 minutes, 4 concurrent, 400ms apart, honest user-agent
with a contact URL. All public HTML, nothing behind a login. Keep it that way —
you're publishing critical numbers about these people and the first counter-attack
will be "they're hammering my server."

Outbound links are `rel="nofollow"`. Leave them that way. Selling dofollow links is a
different and much worse business, and it would destroy the neutrality this depends on.

## License

Private. Not affiliated with any board listed.
