/**
 * BIDPULSE crawler — outbid.lol deal ranking
 * -----------------------------------------------------------------------------
 * outbid.lol ships its ENTIRE board in the page's embedded payload: every
 * listing with amountCents (lifetime paid) and clickCount (lifetime clicks).
 * One fetch, no scraping heuristics. We rank by cost per click — who actually
 * got the best deal buying rank.
 *
 * Run:  node crawler.js  ->  writes listings.json (+ history.json for events)
 * Cron: every 5 minutes, one request. Exits non-zero on failure so the deploy
 * keeps serving the last good data instead of publishing junk.
 *
 * Definitions (keep the page's copy in sync):
 *   paid   = amountCents/100 — lifetime total the listing has paid
 *   clicks = clickCount — lifetime clicks as reported by outbid.lol
 *            (this is NOT the "clicks" shown on their rows, which reset per bid)
 *   cpc    = paid / clicks, the whole product
 */

import { writeFile, readFile } from "node:fs/promises";

const SOURCE = "https://outbid.lol";
const UA = "BidpulseBot/1.0 (+https://bidpulse.dev) - reads outbid.lol every 5 min";
const TIMEOUT_MS = 20000;
const MIN_LISTINGS = 30; // ~50 full records on a healthy page; fewer means a partial/changed page

/* JSON string un-escaper for values captured out of the embedded payload */
const unesc = (s) =>
  s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, " ")
    .replace(/\\(["\\/])/g, "$1")
    .trim();

async function fetchListings() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SOURCE, {
      headers: { "user-agent": UA, accept: "text/html" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (res.status === 429 || res.headers.get("x-vercel-mitigated") === "challenge") {
      const err = new Error("rate-limited (HTTP " + res.status + ") — outbid.lol is challenging automated readers");
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();

    // The payload carries two shapes (both escaped, both duplicated):
    //  1. FULL records for the top ~50 spenders — the only ones with clickCount
    //  2. a COMPACT list of the whole board: just identityKey + amountCents
    // Deal-ranking needs clicks, so it covers shape 1; shape 2 gives the true
    // board size, totals, and board ranks.
    const FULL =
      /\\?"identityKey\\?":\\?"(.+?)\\?",\\?"sourceUrl\\?":\\?"(.*?)\\?",\\?"displayName\\?":\\?"(.*?)\\?",\\?"imageUrl\\?":.*?,\\?"description\\?":\\?"(.*?)\\?",\\?"amountCents\\?":(\d+),[\s\S]{0,300}?\\?"createdAt\\?":\\?"\$D(.*?)\\?",\\?"clickCount\\?":(\d+)/g;
    const COMPACT = /\{\\?"identityKey\\?":\\?"(.+?)\\?",\\?"amountCents\\?":(\d+)\}/g;

    const full = new Map();
    for (const m of html.matchAll(FULL)) {
      const key = unesc(m[1]);
      if (full.has(key)) continue;
      const paid = Number(m[5]) / 100;
      const clicks = Number(m[7]);
      full.set(key, {
        k: key,
        n: key.replace(/^[a-z]+:/, ""), // "website:joni.ai" -> "joni.ai"
        dn: unesc(m[3]),
        u: unesc(m[2]),
        d: unesc(m[4]).slice(0, 220),
        paid,
        clicks,
        cpc: clicks > 0 && paid > 0 ? Number((paid / clicks).toFixed(4)) : null,
        addedAt: unesc(m[6]),
      });
    }

    const board = new Map(); // every listing on the board: key -> paid
    for (const m of html.matchAll(COMPACT)) {
      const key = unesc(m[1]);
      if (!board.has(key)) board.set(key, Number(m[2]) / 100);
    }
    for (const [k, l] of full) if (!board.has(k)) board.set(k, l.paid);

    return { full: [...full.values()], board };
  } finally {
    clearTimeout(timer);
  }
}

async function loadHistory() {
  try {
    return JSON.parse(await readFile("history.json", "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const { full: listings, board } = await fetchListings();
  if (listings.length < MIN_LISTINGS || board.size < 100)
    throw new Error(`only ${listings.length} full / ${board.size} board listings parsed — page layout changed?`);

  // board rank = position among ALL listings by lifetime paid
  const paidDesc = [...board.values()].sort((a, b) => b - a);
  listings.sort((a, b) => b.paid - a.paid);
  listings.forEach((l) => (l.rank = paidDesc.findIndex((p) => p <= l.paid) + 1));
  const boardTotal = Number(paidDesc.reduce((s, p) => s + p, 0).toFixed(2));

  const now = Date.now();
  const history = await loadHistory();

  // bid events: a rise in a listing's paid total between crawls is a bid
  const events = [];
  for (const l of listings) {
    const h = (history[l.k] ||= []);
    const prev = h[h.length - 1];
    if (prev && l.paid > prev.paid) {
      events.push({ t: now, n: l.n, a: Number((l.paid - prev.paid).toFixed(2)) });
    }
    h.push({ t: now, paid: l.paid, clicks: l.clicks });
    history[l.k] = h.filter((p) => now - p.t < 48 * 3600 * 1000);
  }
  // carry earlier events forward (history holds points, not events)
  let prevEvents = [];
  try {
    prevEvents = JSON.parse(await readFile("listings.json", "utf8")).events ?? [];
  } catch {}
  const allEvents = [...prevEvents.filter((e) => now - e.t < 48 * 3600 * 1000), ...events]
    .sort((a, b) => a.t - b.t);

  await writeFile(
    "listings.json",
    JSON.stringify(
      { updatedAt: now, source: SOURCE, boardCount: board.size, boardTotal, count: listings.length, listings, events: allEvents },
      null, 1
    )
  );
  await writeFile("history.json", JSON.stringify(history));
  console.log(`[ok] ${listings.length} listings, ${events.length} new bid(s) this crawl`);
}

main().catch((err) => {
  if (err.rateLimited) {
    // Not a defect: back off politely and let the workflow re-deploy the last
    // good data unchanged. The page shows how old its figures are.
    console.warn("[skip]", err.message, "— keeping last good data");
    process.exit(0);
  }
  console.error("[fail]", err.message);
  process.exit(1); // failed crawl must not deploy — last good data stays live
});
