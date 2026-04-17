// Server-side proxy for Flickr photo search.
//
// Why this exists: some users (notably Safari + iCloud Private Relay) see empty
// photo results because Flickr rate-limits or blocks requests from the shared
// relay IPs. Calling Flickr from our own server side-steps that entirely — the
// browser hits this same-origin route (not proxied by Private Relay), and our
// server hits Flickr from a clean host IP.
//
// This route mirrors the logic previously in `lib/flickr.ts#fetchFlickrPhotos`:
// parallel page fetches, tag-based exclusion filter, dedup by photo id.

import { NextRequest, NextResponse } from "next/server"
import type { FlickrPhoto } from "@/lib/flickr"

const FLICKR_BASE = "https://www.flickr.com/services/rest/"

// ── Tag lists (kept in sync with lib/flickr.ts) ─────────────────────────────
const SEARCH_TAGS_DEFAULT = "landscape, landmark"
const SEARCH_TAGS_CURATED =
  "landscape, landmark, hike, trail, walk, way, castle, ruins, garden, park, nature reserve, nature, cottage, village, thatch, tudor, medieval, ruins, estate"
// Origin stations (e.g. Farringdon, Stratford) — urban imagery instead of rural.
// Radius is also tighter (1km vs 7km) since origins are city centres.
const SEARCH_TAGS_ORIGIN =
  "city, cityscape, landmark, crowd, traffic, urban, busy, crowded, commute"

// Destination (hiking) stations exclude anything urban/transit — these photos
// would drown out the countryside imagery we're actually looking for.
const EXCLUDE_TAGS_DESTINATION = new Set([
  "people", "girls", "boys", "children", "portrait", "portraits",
  "countryfashion", "countryoutfit", "countrystyle",
  "train", "tank", "railway", "trains", "railways", "station",
  "engine", "locomotive",
  "bus", "buses", "airbus", "airport", "airways", "airliner", "flight",
  "motorbike", "motorcycle",
  "paddleboarding",
  "object",
  "baby",
  "plane", "taps", "city", "town", "great western railways", "reading", "sexy", "midjourney",
  "protest", "demonstration", "demo", "march",
  "band", "music", "musicians",
])

// Origin stations are city-centre, so we DO want city/town/station/rail/transit
// imagery. Only the truly non-urban noise tags (people, fashion, random stuff)
// are kept in the exclude list.
const EXCLUDE_TAGS_ORIGIN = new Set([
  "portrait", "portraits",
  "countryfashion", "countryoutfit", "countrystyle",
  "paddleboarding",
  "baby",
  "taps", "reading", "sexy", "midjourney",
  "protest", "demonstration", "demo", "march",
  "band", "music", "musicians",
])

function hasExcludedTag(rawTags: string, excludeSet: Set<string>): boolean {
  return rawTags.split(" ").some((t) => excludeSet.has(t.toLowerCase()))
}

// Prefer a server-only key if present (FLICKR_API_KEY), fall back to the
// previously public one. This lets you drop NEXT_PUBLIC_ later without a code change.
function getApiKey(): string | null {
  return process.env.FLICKR_API_KEY ?? process.env.NEXT_PUBLIC_FLICKR_API_KEY ?? null
}

// ── In-memory cache, shared across users on the same server instance ───────
const cache = new Map<string, { photos: FlickrPhoto[]; timestamp: number }>()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  const apiKey = getApiKey()
  if (!apiKey) {
    return NextResponse.json({ photos: [] satisfies FlickrPhoto[] })
  }

  const { searchParams } = new URL(req.url)
  const lat = parseFloat(searchParams.get("lat") ?? "")
  const lng = parseFloat(searchParams.get("lng") ?? "")
  const hasCurations = searchParams.get("hasCurations") === "1"
  const isOrigin = searchParams.get("isOrigin") === "1"
  const rejectedCount = parseInt(searchParams.get("rejectedCount") ?? "0", 10) || 0

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "missing or invalid lat/lng" }, { status: 400 })
  }

  const pagesToFetch = Math.min(Math.ceil((30 + rejectedCount) / 100), 5)
  // Include origin mode in the cache key — different tags/radius produce a different photo set
  const mode = isOrigin ? "o" : hasCurations ? "c" : "d"
  const cacheKey = `photos:${lat.toFixed(3)},${lng.toFixed(3)}:${mode}:p${pagesToFetch}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return NextResponse.json({ photos: cached.photos })
  }

  const PER_PAGE = 100
  // Origin stations get an urban tag set; destination stations stay on the
  // rural/hiking sets. isOrigin takes priority over hasCurations.
  const tags = isOrigin
    ? SEARCH_TAGS_ORIGIN
    : hasCurations
      ? SEARCH_TAGS_CURATED
      : SEARCH_TAGS_DEFAULT
  // Origins: 1km — photos right at the station. Destinations: 7km — hiking region.
  const radius = isOrigin ? "1" : "7"
  // Different exclude list for origins — see tag-list definitions above.
  const excludeSet = isOrigin ? EXCLUDE_TAGS_ORIGIN : EXCLUDE_TAGS_DESTINATION

  const fetchPage = async (page: number) => {
    const params = new URLSearchParams({
      method: "flickr.photos.search",
      api_key: apiKey,
      lat: String(lat),
      lon: String(lng),
      radius,
      radius_units: "km",
      tags,
      tag_mode: "any",
      extras: "url_m,url_l,date_taken,owner_name,geo,tags",
      sort: "relevance",
      per_page: String(PER_PAGE),
      page: String(page),
      format: "json",
      nojsoncallback: "1",
    })
    const res = await fetch(`${FLICKR_BASE}?${params}`)
    return res.json()
  }

  try {
    const pages = await Promise.all(
      Array.from({ length: pagesToFetch }, (_, i) => fetchPage(i + 1)),
    )

    const seen = new Set<string>()
    const photos: FlickrPhoto[] = []

    for (const data of pages) {
      const pagePhotos = data?.photos?.photo ?? []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of pagePhotos as any[]) {
        if (seen.has(p.id)) continue
        seen.add(p.id)
        if (hasExcludedTag(p.tags ?? "", excludeSet)) continue
        photos.push({
          id: p.id,
          title: p.title || "Untitled",
          ownerName: p.ownername ?? "Unknown",
          thumbnailUrl:
            p.url_m ??
            `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_m.jpg`,
          largeUrl: p.url_l ?? null,
          flickrUrl: `https://www.flickr.com/photos/${p.owner}/${p.id}`,
          dateTaken: p.datetaken ?? null,
        })
      }
    }

    cache.set(cacheKey, { photos, timestamp: Date.now() })
    return NextResponse.json({ photos })
  } catch (err) {
    console.error("[api/flickr/photos] fetch error:", err)
    return NextResponse.json({ error: "upstream failure" }, { status: 502 })
  }
}
