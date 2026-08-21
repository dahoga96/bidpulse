/**
 * POST /api/submit — fully automatic board submissions.
 *
 * Flow: validate the URL → fetch the page and require real bid figures →
 * reject duplicates → commit the new entry to boards.config.json on GitHub.
 * That commit triggers the crawl-and-deploy workflow, so an accepted board
 * is live on the site within a couple of minutes, with a git audit trail
 * (revert the commit to remove a board).
 *
 * Needs one Pages secret: BOARD_SUBMIT_TOKEN — a fine-grained GitHub PAT
 * with Contents read/write on this repo only. The deploy workflow syncs it
 * from the GitHub Actions secret of the same name. Until it exists, this
 * endpoint answers 503 and the form tells the submitter to try later.
 */

const REPO = "dahoga96/bidpulse";
const CONFIG_PATH = "boards.config.json";
const MAX_CATEGORY = 60;
const UA = "BidpulseBot/1.0 (+https://bidpulse.pages.dev) - submission check";

const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };

const b64encode = (str) => {
  let bin = "";
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64decode = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

export async function onRequestPost({ request, env }) {
  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  if (!env.BOARD_SUBMIT_TOKEN)
    return json(503, { error: "Submissions are temporarily offline. Try again later." });

  let data;
  try { data = await request.json(); } catch { return json(400, { error: "Bad request." }); }

  // honeypot field: bots fill it, humans never see it — pretend success
  if (data.website) return json(200, { ok: true });

  // category is rendered on the page later: keep it short, strip markup chars
  const cat = String(data.cat || "").replace(/[<>&"']/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_CATEGORY);
  if (!cat) return json(400, { error: "Say what the board ranks." });

  let url;
  try { url = new URL(String(data.url || "").trim()); } catch { return json(400, { error: "That does not look like a URL." }); }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return json(400, { error: "http(s) URLs only." });
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!host.includes(".") || /^[\d.:]+$/.test(host) || host === "localhost" || host.endsWith(".local"))
    return json(400, { error: "Public websites only." });

  // the page must actually look like a bid board: visible money figures
  let text;
  try {
    const res = await fetch(url.href, {
      headers: { "user-agent": UA, accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return json(400, { error: `Could not read that page (HTTP ${res.status}).` });
    text = strip(await res.text());
  } catch {
    return json(400, { error: "Could not reach that page." });
  }
  if (!/[$€£]\s?\d/.test(text.slice(0, 6000)))
    return json(400, { error: "We could not find any bid figures on that page, so we cannot track it yet." });

  const gh = (path, init = {}) =>
    fetch(`https://api.github.com/repos/${REPO}/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${env.BOARD_SUBMIT_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "bidpulse-submit",
        ...(init.headers || {}),
      },
    });

  // read-modify-write with one retry in case two submissions land at once
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await gh(`contents/${CONFIG_PATH}`);
    if (!cur.ok) return json(502, { error: "Submission store unavailable — try again in a minute." });
    const file = await cur.json();
    const boards = JSON.parse(b64decode(file.content));

    if (boards.some((b) => hostOf(b.u) === host || b.n === host))
      return json(409, { error: "That board is already tracked." });

    boards.push({ n: host, u: url.origin, c: cat, addedAt: new Date().toISOString() });

    const put = await gh(`contents/${CONFIG_PATH}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Add board: ${host} (via site submission)`,
        content: b64encode(JSON.stringify(boards, null, 2) + "\n"),
        sha: file.sha,
      }),
    });
    if (put.ok)
      return json(200, { ok: true, message: "Validated and added. It appears on the site within a few minutes." });
    if (put.status !== 409) return json(502, { error: "Could not save the submission — try again in a minute." });
  }
  return json(502, { error: "Busy right now — try again in a minute." });
}
