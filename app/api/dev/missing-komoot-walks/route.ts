import { NextResponse } from "next/server"
import puppeteer from "puppeteer"
import { loadAllWalks } from "@/lib/walk-payload"

// Scrapes the user's Komoot "planned hikes" public page, lazy-loads
// to the bottom, collects every /tour/<id> URL, and returns the diff
// against walks already tracked in data/walks.json (compared by tour
// id — query params and slugs vary). Used by the walks-manager
// "Missing walks" button.
//
// Admin-only — gated by middleware higher up. Slow (~10–30s) because
// Puppeteer has to spin up Chromium and scroll until idle. Returns
// JSON: { missing: string[], scrapedCount: number, knownCount: number }.

const KOMOOT_ROUTES_URL =
  "https://www.komoot.com/user/199541480003/routes?type=planned&sport=hike&visibility=PUBLIC&include_ebike=false"

// Match the numeric tour id out of a Komoot URL. Tour links may carry
// a slug suffix (`/tour/123-walk-name`) or query params; the id is
// the only stable comparator across sources.
const TOUR_ID_RE = /\/tour\/(\d+)/

function extractTourId(url: string | null | undefined): string | null {
  if (!url) return null
  const m = TOUR_ID_RE.exec(url)
  return m ? m[1] : null
}

// Scrape every tour URL from the routes page. Lazy-loading: scroll to
// the bottom in a loop, waiting for the anchor count to stabilise
// across two consecutive ticks (Komoot streams in batches as you
// scroll, so we can't rely on a single "scrollHeight stopped growing"
// signal — the count flap is the reliable end signal).
async function scrapeKomootTourUrls(): Promise<string[]> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  })
  try {
    const page = await browser.newPage()
    // Realistic UA so we don't get the bot-blocked variant of the page.
    // Komoot serves a different DOM to obvious headless clients.
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    )
    await page.setViewport({ width: 1280, height: 900 })
    await page.goto(KOMOOT_ROUTES_URL, { waitUntil: "networkidle2", timeout: 60_000 })

    // Lazy-scroll until the anchor count is the same two passes in a
    // row, with a hard cap on iterations (60 scrolls × 800 ms ≈ 50 s
    // worst case) so a malformed page can't hang the request forever.
    let lastCount = -1
    let stableTicks = 0
    const MAX_TICKS = 60
    for (let i = 0; i < MAX_TICKS; i++) {
      // eslint-disable-next-line no-await-in-loop
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 800))
      // eslint-disable-next-line no-await-in-loop
      const count = await page.evaluate(
        () => document.querySelectorAll('a[href*="/tour/"]').length,
      )
      if (count === lastCount) {
        stableTicks++
        // Two stable passes in a row + a non-zero count → assume done.
        // (Zero matches usually means we got a bot-blocked page; bail
        // immediately rather than spinning the full MAX_TICKS.)
        if (stableTicks >= 2) break
      } else {
        stableTicks = 0
        lastCount = count
      }
    }

    // Pull every tour URL from the DOM. Normalise to absolute URLs and
    // dedupe — the page often duplicates the same anchor in different
    // sections (card link + title link).
    const urls = await page.evaluate(() => {
      const out = new Set<string>()
      document.querySelectorAll('a[href*="/tour/"]').forEach((a) => {
        const href = (a as HTMLAnchorElement).href
        if (href) out.add(href)
      })
      return Array.from(out)
    })
    return urls
  } finally {
    await browser.close()
  }
}

export async function GET() {
  let scraped: string[]
  try {
    scraped = await scrapeKomootTourUrls()
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }

  // Build the set of tour ids the app already knows about. Walks may
  // store the URL in different forms (with/without slug or trailing
  // path) so we compare by the numeric id, not the raw string.
  const walks = await loadAllWalks()
  const known = new Set<string>()
  for (const w of walks) {
    const id = extractTourId(w.komootUrl)
    if (id) known.add(id)
  }

  // Reduce scraped urls to the ones whose tour id isn't already in
  // the known set. Preserve the first URL we saw for each missing id
  // so the admin gets a clickable link, not just a bare id.
  const missingByID = new Map<string, string>()
  for (const url of scraped) {
    const id = extractTourId(url)
    if (!id) continue
    if (known.has(id)) continue
    if (!missingByID.has(id)) missingByID.set(id, url)
  }

  return NextResponse.json({
    missing: Array.from(missingByID.values()),
    scrapedCount: scraped.length,
    knownCount: known.size,
  })
}
