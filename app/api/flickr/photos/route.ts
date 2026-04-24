// Server-side proxy for Flickr photo search.
//
// Why this exists: some users (notably Safari + iCloud Private Relay) see empty
// photo results because Flickr rate-limits or blocks requests from the shared
// relay IPs. Calling Flickr from our own server side-steps that entirely — the
// browser hits this same-origin route (not proxied by Private Relay), and our
// server hits Flickr from a clean host IP.
//
// This route fetches photos for ONE algo at a time. The client decides which
// algo (default or fallback step) and orchestrates multi-algo fill when the
// default returns <12 photos.

import { NextRequest, NextResponse } from "next/server"
import type { FlickrPhoto } from "@/lib/flickr"
import { readDataFile } from "@/lib/github-data"
import { PRESET_DEFAULTS, type Presets } from "@/app/api/dev/flickr-presets/route"

const FLICKR_BASE = "https://www.flickr.com/services/rest/"
const PRESETS_FILE = "data/photo-flickr-presets.json"

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

// Hash a preset's content into a short cache-key fragment. Preset edits bust
// the cache naturally because the hash changes when tags/radius/sort change.
function hashPreset(p: { includeTags: string[]; excludeTags: string[]; radius: number; sort: string }): string {
  const s = `${p.includeTags.join(",")}|${p.excludeTags.join(",")}|${p.radius}|${p.sort}`
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h.toString(36)
}

export async function GET(req: NextRequest) {
  const apiKey = getApiKey()
  if (!apiKey) {
    return NextResponse.json({ photos: [] satisfies FlickrPhoto[] })
  }

  const { searchParams } = new URL(req.url)
  const lat = parseFloat(searchParams.get("lat") ?? "")
  const lng = parseFloat(searchParams.get("lng") ?? "")
  // Which algo to fetch for this call. Client decides — see fallback chain
  // in components/photo-overlay.tsx. One of: "landscapes" | "hikes" | "station" | "custom".
  const algoParam = searchParams.get("algo") as
    | "landscapes" | "hikes" | "station" | "custom" | null

  // Custom-only params (when algo === "custom"): full override of the preset.
  const customIncludeTags = searchParams.get("includeTags")
  const customExcludeTags = searchParams.get("excludeTags")
  const customRadius = searchParams.get("radius")
  const customSortParam = searchParams.get("sort")
  const customSort: "relevance" | "interestingness-desc" | null =
    customSortParam === "relevance" || customSortParam === "interestingness-desc" ? customSortParam : null

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "missing or invalid lat/lng" }, { status: 400 })
  }
  if (!algoParam) {
    return NextResponse.json({ error: "missing algo" }, { status: 400 })
  }

  const pagesToFetch = 2
  const PER_PAGE = 100

  // Resolve effective tags/radius/excludes/sort from the algo.
  let tags: string
  let radius: string
  let excludeSet: Set<string>
  let sort: "relevance" | "interestingness-desc"
  let modeKey: string // cache-key discriminator

  if (algoParam === "custom") {
    // Flickr's photos.search has a hard cap of 20 tags per query.
    const FLICKR_TAG_LIMIT = 20
    const rawIncludes = (customIncludeTags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
    if (rawIncludes.length > FLICKR_TAG_LIMIT) {
      console.warn(
        `[api/flickr/photos] custom algo for ${lat.toFixed(3)},${lng.toFixed(3)} ` +
        `has ${rawIncludes.length} include tags — truncating to ${FLICKR_TAG_LIMIT}`,
      )
    }
    tags = rawIncludes.slice(0, FLICKR_TAG_LIMIT).join(", ")
    radius = customRadius ?? "7"
    excludeSet = new Set((customExcludeTags ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))
    sort = customSort ?? "relevance"
    modeKey = `custom:${tags}:${radius}:${customExcludeTags ?? ""}:${sort}`
  } else {
    // Landscapes / hikes / station all pull from the shared preset file so
    // global edits (via /api/dev/flickr-presets) apply to every station.
    let presets: Presets
    try {
      const { data } = await readDataFile<Partial<Presets>>(PRESETS_FILE)
      presets = {
        landscapes: data.landscapes ?? PRESET_DEFAULTS.landscapes,
        hikes: data.hikes ?? PRESET_DEFAULTS.hikes,
        station: data.station ?? PRESET_DEFAULTS.station,
      }
    } catch {
      presets = PRESET_DEFAULTS
    }
    const preset = presets[algoParam]
    tags = preset.includeTags.join(", ")
    radius = String(preset.radius)
    excludeSet = new Set(preset.excludeTags.map((t) => t.toLowerCase()))
    sort = preset.sort
    // Hash the preset content so edits auto-invalidate the cache.
    modeKey = `${algoParam}:${hashPreset(preset)}`
  }

  // Optional cache-buster. When the client supplies a truthy `bust` param
  // (from the admin's "Refresh gallery" button), we skip the cache read but
  // still write the result under the normal key so subsequent requests benefit.
  // This avoids the race condition where a preset edit's POST hasn't finished
  // writing the JSON file by the time the auto-refetch runs.
  const bust = searchParams.get("bust")
  const cacheKey = `photos:v4:${lat.toFixed(3)},${lng.toFixed(3)}:${modeKey}:p${pagesToFetch}`
  if (!bust) {
    const cached = cache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return NextResponse.json({ photos: cached.photos })
    }
  }

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
      sort,
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
