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
 * Cron: every 5 minutes. Serve boards.json statically; the page fetches it.
 *
 * NOTE ON FRAGILITY: these are hand-built sites that change hourly. The generic
 * extractor below gets most of them. When it fails, add a targeted selector to
 * OVERRIDES rather than making the generic pass cleverer — that path leads to
 * silent wrong numbers, which is the one thing this product cannot ship.
 */

import { writeFile, readFile } from "node:fs/promises";

const UA = "BidpulseBot/1.0 (+https://bidpulse.pages.dev/bot) - reads public leaderboards, 1 req/board/5min";
const TIMEOUT_MS = 12000;
const CONCURRENCY = 4;          // be a good citizen
const DELAY_MS = 400;

/* The board list lives in boards.config.json so the submission endpoint
   (functions/api/submit.js) can append to it without touching code. */
const BOARDS = JSON.parse(await readFile("boards.config.json", "utf8"));

/* Per-board fixes. Keep these dumb and explicit.
   `src` fetches that URL instead of the board page (for boards that render
   client-side but expose a JSON API). `parse` gets the raw body and returns
   metric fields; throw on bad data and the board is marked unparsed. */
const OVERRIDES = {
  // outbid.lol's headline figure is the "claim this rank" price (current top
  // + $5 increment). The real #1 bid is in the leaderboard rows, which pair a
  // bold name with an amount.
  "outbid.lol": {
    parse: (html, text) => {
      const rows = [...html.matchAll(/font-bold">([^<]{1,60})<\/p><p[^>]*>\$\s?([\d,]+(?:\.\d{1,2})?)</g)]
        .map((m) => ({ name: m[1], amt: Number(m[2].replace(/,/g, "")) }));
      if (rows.length < 2) throw new Error("no leaderboard rows");
      const top = rows.reduce((m, r) => (r.amt > m.amt ? r : m));
      return {
        top: top.amt,
        leader: top.name,
        entry: extractEntry(text),
        clicks: extractTopClicks(text),
        last: extractLastBidHours(text),
      };
    },
  },
  // biddirectory.lol's biggest figure is the bid cap ("at most $100 above the
  // current top ($45–$144)"). The real #1 row is "🥇 … <n> clicks $44
  // Overtake for $45".
  "biddirectory.lol": {
    parse: (_html, text) => {
      const row = text.match(/🥇[\s\S]{0,300}?([\d,]+)\s*clicks\s*\$\s?([\d,]+(?:\.\d{1,2})?)\s*Overtake for/);
      if (!row) throw new Error("no 🥇 row");
      const lead = text.match(/🥇[\s\S]{0,120}?\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/i);
      return {
        top: Number(row[2].replace(/,/g, "")),
        clicks: Number(row[1].replace(/,/g, "")),
        leader: lead ? lead[1] : null,
        entry: null,
        last: extractLastBidHours(text),
      };
    },
  },
  // topnewsletters.lol's headline is the claim price; the real #1 row is
  // "<n> clicks $55 claim this inbox for $56".
  "topnewsletters.lol": {
    parse: (_html, text) => {
      const m = text.match(/([\d,]+)\s*clicks\s*\$\s?([\d,]+(?:\.\d{1,2})?)\s*claim this inbox for/i);
      if (!m) throw new Error("no #1 inbox row");
      return {
        top: Number(m[2].replace(/,/g, "")),
        clicks: Number(m[1].replace(/,/g, "")),
        leader: null,
        entry: null,
        last: extractLastBidHours(text),
      };
    },
  },
  // mostexpensivelink.com is a single-slot auction; the biggest figure on the
  // page is cumulative spend. Current value, owner, clicks and "owned for" are
  // all stated explicitly.
  "mostexpensivelink.com": {
    parse: (_html, text) => {
      const m = text.match(/Currently worth \$([\d,]+(?:\.\d{1,2})?)\s+(\S+)\s+Owner/i);
      if (!m) throw new Error("no 'Currently worth' figure");
      const clicks = text.match(/([\d,]+)\s*clicks so far/i);
      const owned = text.match(/owned for (\d+)\s*(minute|hour|day)s?/i);
      return {
        top: Number(m[1].replace(/,/g, "")),
        leader: m[2],
        entry: null,
        clicks: clicks ? Number(clicks[1].replace(/,/g, "")) : null,
        last: owned ? Number(owned[1]) * { minute: 1 / 60, hour: 1, day: 24 }[owned[2].toLowerCase()] : null,
      };
    },
  },
  // peerpush.com/outbid: hero copy carries big marketing numbers; the #1 row
  // is the first "<n> impressions $X active" entry.
  "peerpush.com": {
    parse: (_html, text) => {
      const m = text.match(/impressions \$([\d,]+(?:\.\d{1,2})?) active Outbid for/i);
      if (!m) throw new Error("no leaderboard row");
      return { top: Number(m[1].replace(/,/g, "")), entry: null, clicks: null, last: extractLastBidHours(text), leader: null };
    },
  },
  // warmap.lol (self-submitted) sells countries on a map; the only figure in
  // its HTML is a $50,000 "conquer the world" price tag, not a bid. Report
  // nothing rather than that number until it grows a parseable leaderboard.
  "warmap.lol": {
    parse: () => { throw new Error("map game — no parseable leaderboard yet"); },
  },
  // uprank.lol's biggest figure is "$635 on the board" — the sum of every
  // listing. The #1 row reads "Holding #1 <name> — … $66 Pay 207 Clicks".
  "uprank.lol": {
    parse: (_html, text) => {
      const m = text.match(/Holding #1\s+(.{1,80}?)\s+—[\s\S]{0,400}?\$\s?([\d,]+(?:\.\d{1,2})?)\s*Pay\s*([\d,]+)\s*Clicks/i);
      if (!m) throw new Error("no 'Holding #1' row");
      return {
        top: Number(m[2].replace(/,/g, "")),
        leader: m[1],
        clicks: Number(m[3].replace(/,/g, "")),
        entry: null,
        last: extractLastBidHours(text),
      };
    },
  },
  // xbid.lol shows preset bid-amount chips ($5/$25/$100) that the generic pass
  // mistakes for the top bid; the real figure is the explicit "#1 costs $X".
  "xbid.lol": {
    parse: (_html, text) => {
      const m = text.match(/#1 costs \$\s?([\d,]+(?:\.\d{1,2})?)/i);
      if (!m) throw new Error("no '#1 costs' figure");
      return {
        top: Number(m[1].replace(/,/g, "")),
        entry: null,
        clicks: extractTopClicks(text),
        last: extractLastBidHours(text),
        leader: null,
      };
    },
  },
  // xme.lol renders its page with JavaScript, so the HTML has no figures —
  // but its leaderboard is a public JSON API.
  "xme.lol": {
    src: "https://xme.lol/api/leaderboard",
    parse: (body) => {
      const entries = JSON.parse(body).entries;
      if (!entries?.length) throw new Error("empty leaderboard");
      const paid = entries.map((e) => e.total_paid_cents / 100);
      const top = Math.max(...paid);
      const leader = entries[paid.indexOf(top)];
      const pos = paid.filter((p) => p > 0);
      return {
        top,
        leader: "@" + (leader.display_handle || leader.handle),
        entry: pos.length ? Math.min(...pos) : null,
        clicks: leader.clicks ?? null,
        // the API has no bid timestamps; main() derives last-bid from our own
        // history when it sees the top bid increase between crawls
        last: null,
        cpc: leader.clicks ? Number((top / leader.clicks).toFixed(2)) : null,
      };
    },
  },
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

/** Money figures with their positions in the head of the page. */
function moneyMatches(text) {
  // $10,002 / $13.50 / €2 — the #1 row is always near the top of the leaderboard.
  return [...text.slice(0, 2500).matchAll(/[$€£]\s?([\d][\d,]{0,9}(?:\.\d{1,2})?)(?!\s*(?:k|m|bn|million|billion|\/|%))/gi)]
    .map((m) => ({ v: Number(m[1].replace(/,/g, "")), i: m.index }))
    .filter((x) => x.v > 0 && x.v < 1_000_000);
}

/** Highest dollar figure that looks like a bid, not a marketing number. */
function extractTopBid(text) {
  const ms = moneyMatches(text);
  return ms.length ? Math.max(...ms.map((x) => x.v)) : null;
}

/** Who holds #1: a domain or @handle sitting just before the top bid figure.
    Anything less explicit risks naming the wrong leader, so return null. */
function extractLeader(text, top, ownHost) {
  const own = ownHost.replace(/^www\./, "");
  const notOwn = (c) => c.toLowerCase().replace(/^www\./, "") !== own;
  const TOKEN = /@[A-Za-z0-9_]{2,15}\b|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;
  // 1) a domain or @handle sitting just before the top bid figure
  const hit = moneyMatches(text).find((x) => x.v === top);
  if (hit) {
    const before = (text.slice(Math.max(0, hit.i - 120), hit.i).match(TOKEN) || []).filter(notOwn);
    if (before.length) return before[before.length - 1];
  }
  // 2) an explicit "#1 <domain-or-handle>" — but only if a "#2" follows soon
  // after (real leaderboards come in sequence; marketing copy mentions #1 alone)
  const head = text.slice(0, 2500);
  for (const m of head.matchAll(/#\s?1\s+(@[A-Za-z0-9_]{2,15}\b|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b)/gi)) {
    if (notOwn(m[1]) && /#\s?2\b/.test(head.slice(m.index, m.index + 400))) return m[1];
  }
  return null;
}

/** "9391 clicks" / "7 clicks" / "0 clicks" */
function extractTopClicks(text) {
  const m = text.slice(0, 2500).match(/([\d][\d,]{0,8})\s*clicks?\b/i);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** "3 minutes ago" / "just now" / "1 hour ago" / "5h ago" / "2d ago" -> hours */
function extractLastBidHours(text) {
  const head = text.slice(0, 3000);
  if (/\bjust now\b/i.test(head)) return 0;
  const m = head.match(/\b(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d)s?\s*ago\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2][0].toLowerCase();
  return u === "s" ? n / 3600 : u === "m" ? n / 60 : u === "d" ? n * 24 : n;
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
    const o = OVERRIDES[board.n];
    const res = await fetch(o?.src ?? board.u, {
      headers: { "user-agent": UA, accept: "text/html, application/json" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();

    if (o?.parse) {
      const r = { ...board, ok: true, ...o.parse(html, strip(html)), checkedAt: Date.now() };
      if (r.cpc == null && r.top && r.clicks) r.cpc = Number((r.top / r.clicks).toFixed(2));
      return r;
    }
    const text = strip(html);

    const top = extractTopBid(text);
    const clicks = extractTopClicks(text);
    const last = extractLastBidHours(text);
    const entry = extractEntry(text);
    const leader = top ? extractLeader(text, top, new URL(board.u).hostname) : null;

    return {
      ...board,
      top,
      leader,
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

    // boards that publish no "x ago" text (e.g. API overrides): a rise in the
    // top bid between crawls IS a bid, so derive last-bid from our own history
    if (r.last == null && r.ok) {
      const pts = history[r.n];
      for (let i = pts.length - 1; i > 0; i--) {
        if (pts[i].top != null && pts[i - 1].top != null && pts[i].top > pts[i - 1].top) {
          r.last = (now - pts[i].t) / 3_600_000;
          break;
        }
      }
    }

    // series = bid deltas per bucket, which is what "activity" actually means
    const pts = history[r.n];
    r.series = pts.slice(-24).map((p, i, arr) => {
      const prev = arr[i - 1];
      return prev && p.top != null && prev.top != null ? Math.max(0, p.top - prev.top) : 0;
    });
  }

  // bid events for the activity chart: a rise in a board's top bid between
  // crawls is a bid — {t, n(board), a(mount)}, resolution = crawl interval
  const events = [];
  for (const r of results) {
    const pts = history[r.n] ?? [];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].top != null && pts[i - 1].top != null && pts[i].top > pts[i - 1].top) {
        events.push({ t: pts[i].t, n: r.n, a: Number((pts[i].top - pts[i - 1].top).toFixed(2)) });
      }
    }
  }
  events.sort((a, b) => a.t - b.t);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.warn(`[warn] ${failed.length} board(s) failed to parse:`);
    failed.forEach((f) => console.warn("  -", f.n, f.error || "no bid figure found"));
  }

  await writeFile("boards.json", JSON.stringify({ updatedAt: now, boards: results, events }, null, 2));
  await writeFile("history.json", JSON.stringify(history));
  console.log(`[ok] wrote ${results.length} boards, ${results.length - failed.length} parsed cleanly`);
}

main();
