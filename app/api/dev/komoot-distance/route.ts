import { NextRequest, NextResponse } from "next/server"

// Scrape tour data from a public komoot tour page.
//
// Komoot's HTML embeds a human-readable summary in the og:description /
// twitter:description meta tags shaped like:
//   "Distance: 15.5 km | Duration: 04:16 h"
// We parse that plus the embedded JSON for elevation, difficulty, and
// tour name — these live in the serialised tour object rather than meta
// tags.
//
// Returns { distanceKm, hours, uphillMetres, difficulty, name }. Errors:
//   400 — body missing/malformed
//   404 — page returned non-200 OR the meta string is missing
//   502 — fetch failed entirely (network, timeout)

const META_RE = /Distance:\s*([\d.]+)\s*km\s*\|\s*Duration:\s*(\d+):(\d+)\s*h/i
// Elevation gain from the embedded JSON tour object (first occurrence
// is the tour total; per-segment values follow but are typically 0).
const ELEVATION_UP_RE = /"elevation_up\\?":\s*([\d.]+)/
// Difficulty grade — searches for the "grade" key inside the tour's
// embedded JSON. Handles both plain ("grade":"X") and escaped
// (\"grade\":\"X\") JSON encoding.
const DIFFICULTY_RE = /\\?"grade\\?"\s*:\s*\\?"(EASY|MODERATE|HARD|DIFFICULT|EXPERT)/i
// Tour name from og:title — strip the trailing " | hike | Komoot" etc.
const OG_TITLE_RE = /<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i
const OG_TITLE_ALT_RE = /<meta\s+content="([^"]+)"\s+(?:property|name)="og:title"/i

// Decode the HTML entities komoot embeds in og:title attribute values
// (&#x27; → ', &amp; → &, etc.). Without this we'd persist literal
// "&#x27;" in the walk's name field and it would render as "&#x27;"
// in the public prose. &amp; is decoded LAST so we don't double-decode
// "&amp;quot;" into a literal quote.
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

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
      // Stop hanging on slow responses — komoot is normally <2s, but
      // 10s was tight enough to occasionally trip on transient blips.
      signal: AbortSignal.timeout(25_000),
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

  // Elevation gain — first "elevation_up" in the JSON blob is the
  // tour total. Round to 2dp for clean storage.
  const elevMatch = ELEVATION_UP_RE.exec(html)
  const uphillMetres = elevMatch
    ? Math.round(parseFloat(elevMatch[1]) * 100) / 100
    : null

  // Difficulty — mapped to our three-value enum.
  const diffMatch = DIFFICULTY_RE.exec(html)
  let difficulty: "easy" | "moderate" | "hard" | null = null
  if (diffMatch) {
    const grade = diffMatch[1].toUpperCase()
    if (grade === "EASY") difficulty = "easy"
    else if (grade === "MODERATE") difficulty = "moderate"
    else difficulty = "hard" // HARD, DIFFICULT, EXPERT → hard
  }

  // Tour name — from og:title, stripping the " | hike | Komoot" suffix.
  // Decode HTML entities first so apostrophes etc. land as actual
  // characters, not literal "&#x27;" in the walk's name field.
  const titleMatch = OG_TITLE_RE.exec(html) || OG_TITLE_ALT_RE.exec(html)
  const name = titleMatch
    ? decodeHtmlEntities(titleMatch[1]).replace(/\s*\|.*$/, "").trim()
    : null

  return NextResponse.json({ distanceKm, hours, uphillMetres, difficulty, name })
}
