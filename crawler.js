/**
 * BIDPULSE crawler
 * -----------------------------------------------------------------------------
 * Reads each board's public leaderboard page and extracts:
 *   - the #1 listing's total bid
 *   - the click count reported next to it (most boards show this)
 *   - the timestamp of the most recent bid ("3 minutes ago", "1 hour ago")
 *
 * Everything here is public HTML that the boards render for anyone.
 * Nothing behind a login, no API keys, no accounts.
 *
 * Run:  node crawler.js  ->  writes boards.json
 * Cron: every 15 minutes. Serve boards.json statically; the page fetches it.
 *
 * NOTE ON FRAGILITY: these are hand-built sites that change hourly. The generic
 * extractor below gets most of them. When it fails, add a targeted selector to
 * OVERRIDES rather than making the generic pass cleverer — that path leads to
 * silent wrong numbers, which is the one thing this product cannot ship.
 */

import { writeFile, readFile } from "node:fs/promises";

const UA = "BidpulseBot/1.0 (+https://bidpulse.pages.dev/bot) - reads public leaderboards, 1 req/board/15min";
const TIMEOUT_MS = 12000;
const CONCURRENCY = 4;          // be a good citizen
const DELAY_MS = 400;

const BOARDS = [
  { n: "outbid.lol",        u: "https://outbid.lol",         c: "Startups & websites" },
  { n: "topseos.lol",       u: "https://topseos.lol",        c: "SEO agencies & tools" },
  { n: "xbid.lol",          u: "https://xbid.lol",           c: "X accounts" },
  { n: "topapp.lol",        u: "https://topapp.lol",         c: "iOS apps" },
  { n: "aithrone.lol",      u: "https://aithrone.lol",       c: "AI startups" },
  { n: "coinup.lol",        u: "https://coinup.lol",         c: "Crypto coins (BTC)" },
  { n: "uprank.lol",        u: "https://www.uprank.lol",     c: "Websites" },
  { n: "bidup.lol",         u: "https://bidup.lol",          c: "Websites" },
  { n: "puremoney.lol",     u: "https://puremoney.lol",      c: "Websites" },
  { n: "outbid.to",         u: "https://www.outbid.to",      c: "Websites" },
  { n: "eu-outbid.lol",     u: "https://www.eu-outbid.lol",  c: "European startups" },
  { n: "topnewsletters.lol",u: "https://topnewsletters.lol", c: "Newsletters" },
  { n: "overbid.lol",       u: "https://www.overbid.lol",    c: "People" },
  { n: "hotseat.fyi",       u: "https://hotseat.fyi",        c: "People & agents" },
  { n: "xme.lol",           u: "https://xme.lol",            c: "X profiles" },
  { n: "launcharena.dev",   u: "https://launcharena.dev",    c: "AI startups" },
  { n: "outbids.lol",       u: "https://outbids.lol",        c: "Websites" },
  { n: "bidboard.lol",      u: "https://www.bidboard.lol",   c: "Websites" },
  { n: "bidtop.lol",        u: "https://bidtop.lol",         c: "Websites" },
  { n: "outbidme.lol",      u: "https://outbidme.lol",       c: "People" },
  { n: "outoutbid.lol",     u: "https://outoutbid.lol",      c: "Boards (directory)" },
  { n: "biddirectory.lol",  u: "https://biddirectory.lol",   c: "Boards (directory)" },
];

/* Per-board fixes. Keep these dumb and explicit. */
const OVERRIDES = {
  // "coinup.lol": { currency: "BTC", parse: (html) => ({ top: ..., clicks: ... }) },
};

/* ------------------------------------------------------------------ */
/* extraction                                                          */
/* ------------------------------------------------------------------ */

const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Highest dollar figure that looks like a bid, not a marketing number. */
function extractTopBid(text) {
  // $10,002 / $13 / €2 — take the largest in the first ~1200 chars of board content,
  // because the #1 row is always near the top of the leaderboard.
  const head = text.slice(0, 2500);
  const matches = [...head.matchAll(/[$€£]\s?([\d][\d,]{0,9})(?!\s*(?:k|m|bn|million|billion|\/|%))/gi)]
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => n > 0 && n < 1_000_000);
  if (!matches.length) return null;
  return Math.max(...matches);
}

/** "9391 clicks" / "7 clicks" / "0 clicks" */
function extractTopClicks(text) {
  const m = text.slice(0, 2500).match(/([\d][\d,]{0,8})\s*clicks?\b/i);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** "3 minutes ago" / "just now" / "1 hour ago" / "2 days ago" -> hours */
function extractLastBidHours(text) {
  const head = text.slice(0, 3000);
  if (/\bjust now\b/i.test(head)) return 0;
  const m = head.match(/\b(\d+)\s*(second|minute|min|hour|hr|day)s?\s*ago\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("sec")) return n / 3600;
  if (unit.startsWith("min")) return n / 60;
  if (unit.startsWith("day")) return n * 24;
  return n;
}

/** Cheapest listing on the board = entry price. */
function extractEntry(text) {
  const nums = [...text.slice(0, 6000).matchAll(/[$€£]\s?(\d{1,5})\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0);
  return nums.length ? Math.min(...nums) : null;
}

/* ------------------------------------------------------------------ */
/* fetching                                                            */
/* ------------------------------------------------------------------ */

async function fetchBoard(board) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(board.u, {
      headers: { "user-agent": UA, accept: "text/html" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    const text = strip(html);

    if (OVERRIDES[board.n]?.parse) {
      return { ...board, ...OVERRIDES[board.n].parse(html, text), ok: true, checkedAt: Date.now() };
    }

    const top = extractTopBid(text);
    const clicks = extractTopClicks(text);
    const last = extractLastBidHours(text);
    const entry = extractEntry(text);

    return {
      ...board,
      top,
      entry,
      clicks,
      last,
      cpc: top && clicks ? Number((top / clicks).toFixed(2)) : null,
      ok: top !== null,
      checkedAt: Date.now(),
    };
  } catch (err) {
    return { ...board, ok: false, error: String(err.message || err), checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
        await sleep(DELAY_MS);
      }
    })
  );
  return out;
}

/* ------------------------------------------------------------------ */
/* history — needed for the pulse sparklines                           */
/* ------------------------------------------------------------------ */

async function loadHistory() {
  try {
    return JSON.parse(await readFile("history.json", "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const history = await loadHistory();
  const results = await pool(BOARDS, CONCURRENCY, fetchBoard);
  const now = Date.now();

  for (const r of results) {
    const h = (history[r.n] ||= []);
    h.push({ t: now, top: r.top ?? null, clicks: r.clicks ?? null });
    // keep 48h at 15-min resolution
    history[r.n] = h.filter((p) => now - p.t < 48 * 3600 * 1000);

    // series = bid deltas per bucket, which is what "activity" actually means
    const pts = history[r.n];
    r.series = pts.slice(-24).map((p, i, arr) => {
      const prev = arr[i - 1];
      return prev && p.top != null && prev.top != null ? Math.max(0, p.top - prev.top) : 0;
    });
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.warn(`[warn] ${failed.length} board(s) failed to parse:`);
    failed.forEach((f) => console.warn("  -", f.n, f.error || "no bid figure found"));
  }

  await writeFile("boards.json", JSON.stringify({ updatedAt: now, boards: results }, null, 2));
  await writeFile("history.json", JSON.stringify(history));
  console.log(`[ok] wrote ${results.length} boards, ${results.length - failed.length} parsed cleanly`);
}

main();
