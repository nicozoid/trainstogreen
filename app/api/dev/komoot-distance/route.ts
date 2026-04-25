import { NextRequest, NextResponse } from "next/server"

// Scrape distance + duration from a public komoot tour page.
//
// Komoot's HTML embeds a human-readable summary in the og:description /
// twitter:description meta tags shaped like:
//   "Distance: 15.5 km | Duration: 04:16 h"
// We parse that single string rather than the JSON blob lower down the
// page — the meta line is short, deterministic, and shows up first.
//
// Returns { distanceKm, hours }. Errors:
//   400 — body missing/malformed
//   404 — page returned non-200 OR the meta string is missing
//   502 — fetch failed entirely (network, timeout)

const META_RE = /Distance:\s*([\d.]+)\s*km\s*\|\s*Duration:\s*(\d+):(\d+)\s*h/i

export async function POST(req: NextRequest) {
  let body: { url?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const url = body.url?.trim()
  if (!url || !/^https?:\/\/(www\.)?komoot\.(com|de)\/tour\//i.test(url)) {
    return NextResponse.json(
      { error: "expected a komoot.com/tour/… or komoot.de/tour/… URL" },
      { status: 400 },
    )
  }

  let html: string
  try {
    const res = await fetch(url, {
      // Komoot serves a 403 unless the request looks like a real browser.
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      // Stop hanging on slow responses — komoot is normally fast.
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      return NextResponse.json(
        { error: `komoot returned HTTP ${res.status} (the tour may be private or removed)` },
        { status: 404 },
      )
    }
    html = await res.text()
  } catch (e) {
    return NextResponse.json(
      { error: `fetch failed: ${(e as Error).message}` },
      { status: 502 },
    )
  }

  const m = META_RE.exec(html)
  if (!m) {
    return NextResponse.json(
      { error: "couldn't find distance/duration on the page (private tour?)" },
      { status: 404 },
    )
  }
  const distanceKm = parseFloat(m[1])
  const hh = parseInt(m[2], 10)
  const mm = parseInt(m[3], 10)
  // Round hours to 2 decimal places so the value matches the rest of
  // the dataset (e.g. 5.25, 4.27) rather than 4.266666666….
  const hours = Math.round((hh + mm / 60) * 100) / 100

  return NextResponse.json({ distanceKm, hours })
}
