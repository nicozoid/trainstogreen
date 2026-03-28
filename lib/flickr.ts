// Flickr API helpers — photo count (for dot sizing) and photo gallery data.
// Both functions fail silently (return 0 / []) when no API key is configured,
// so the rest of the app works without Flickr.

export type FlickrPhoto = {
  id: string
  title: string
  ownerName: string
  // Medium thumbnail (240px wide) — always present via url_m extra
  thumbnailUrl: string
  // Large version (1024px) — present if url_l extra was returned
  largeUrl: string | null
  // Link to the photo's page on flickr.com
  flickrUrl: string
  // ISO date string from "datetaken" extra, e.g. "2023-07-14 10:22:00"
  dateTaken: string | null
}

// ── Cache ──────────────────────────────────────────────────────────────────
const countCache = new Map<string, { count: number; timestamp: number }>()
const photoCache = new Map<string, { photos: FlickrPhoto[]; timestamp: number }>()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

const FLICKR_BASE = "https://www.flickr.com/services/rest/"

// ── Tag lists ──────────────────────────────────────────────────────────────
// Tags to search for — "any" mode means a photo needs only one of these.
// Two tiers: uncurated stations use conservative tags to avoid noise;
// curated stations (where an admin has approved/rejected at least one photo)
// use broader tags since photo quality is being actively managed.
const SEARCH_TAGS_DEFAULT = "landscape, landmark"
// Flickr allows max 20 tags per query — keep this at or under that limit
const SEARCH_TAGS_CURATED = "landscape, landmark, hike, trail, walk, way, castle, ruins, garden, park, nature reserve, nature, cottage, village, thatch, tudor, medieval, ruins, estate"
// Tags that disqualify a photo if present — applied client-side to the gallery.
// Note: the Flickr API has no native tag-exclusion parameter, so we request the
// `tags` extra and filter after fetching. The count (used for dot sizing) is
// unfiltered — it's a relative signal and the noise is acceptable.
const EXCLUDE_TAGS = new Set([
  "people", "girls", "boys", "children", "portrait", "portraits", "portrait",
  "countryfashion", "countryoutfit", "countrystyle",
  "train", "tank", "railway", "trains", "railways", "station",
  "engine", "locomotive",
  "bus", "buses", "airbus", "airport", "airways", "airliner", "flight",
  "motorbike", "motorcycle",
  "paddleboarding",
  "object",
  "baby", 
  "plane", "taps", "city", "town", "great western railways", "reading", "sexy", "midjourney"
])

function getApiKey(): string | null {
  // NEXT_PUBLIC_ prefix makes this available in browser bundles
  return process.env.NEXT_PUBLIC_FLICKR_API_KEY ?? null
}

// Returns true if any of the photo's space-separated tags are in EXCLUDE_TAGS
function hasExcludedTag(rawTags: string): boolean {
  return rawTags.split(" ").some((t) => EXCLUDE_TAGS.has(t.toLowerCase()))
}

// ── Photo count ────────────────────────────────────────────────────────────
// Returns the total number of public geotagged landscape photos near this location.
// Used to size station dots on the map — stored statically in stations.json via the
// fetch-flickr-counts.mjs script, so this function is only used for live lookups.
export async function fetchFlickrCount(lat: number, lng: number): Promise<number> {
  const apiKey = getApiKey()
  if (!apiKey) return 0

  // 3dp precision ≈ 111m — close enough for a 7km radius query
  const cacheKey = `count:${lat.toFixed(3)},${lng.toFixed(3)}`
  const cached = countCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.count

  const params = new URLSearchParams({
    method: "flickr.photos.search",
    api_key: apiKey,
    lat: String(lat),
    lon: String(lng),
    radius: "7",
    radius_units: "km",
    tags: SEARCH_TAGS_DEFAULT,
    tag_mode: "any",
    per_page: "1", // only need the total, not the photos
    format: "json",
    nojsoncallback: "1",
  })

  try {
    const res = await fetch(`${FLICKR_BASE}?${params}`)
    const data = await res.json()
    const count = parseInt(data?.photos?.total ?? "0", 10)
    countCache.set(cacheKey, { count, timestamp: Date.now() })
    return count
  } catch {
    return 0
  }
}

// ── Photo gallery ──────────────────────────────────────────────────────────
// Fetches photos for the overlay grid, requesting more than needed to account
// for client-side exclusion filtering. Only called when the user opens the panel.
//
// rejectedIds — photos the admin has rejected for this station; filtered out
// before returning so they never appear in the grid.
//
// Returns all valid photos so the caller can keep a buffer of extras for
// instant replacement when a photo is rejected.
// Rejection filtering is NOT done here — the caller filters at display time
// so the full buffer is always preserved for replacements.
//
// rejectedCount tells the function how many photos the admin has already
// rejected for this station, so it can fetch extra pages to compensate.
export async function fetchFlickrPhotos(
  lat: number,
  lng: number,
  hasCurations = false,
  rejectedCount = 0,
): Promise<FlickrPhoto[]> {
  const apiKey = getApiKey()
  if (!apiKey) { console.log('[flickr] no API key'); return [] }

  // Include hasCurations and page count in the cache key so re-fetches with
  // more pages don't serve a stale smaller result.
  const pagesToFetch = Math.min(Math.ceil((30 + rejectedCount) / 100), 5)
  const cacheKey = `photos:${lat.toFixed(3)},${lng.toFixed(3)}:${hasCurations ? "c" : "d"}:p${pagesToFetch}`
  const cached = photoCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[flickr] cache hit: ${cached.photos.length} photos`)
    return cached.photos
  }

  const PER_PAGE = 100
  const tags = hasCurations ? SEARCH_TAGS_CURATED : SEARCH_TAGS_DEFAULT

  // Build a single-page fetch helper
  const fetchPage = async (page: number) => {
    const params = new URLSearchParams({
      method: "flickr.photos.search",
      api_key: apiKey,
      lat: String(lat),
      lon: String(lng),
      radius: "7",
      radius_units: "km",
      tags,
      tag_mode: "any",
      // `tags` extra returns the photo's tag string — needed for exclusion filtering
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
    // Fetch all pages in parallel
    console.log(`[flickr] fetching ${pagesToFetch} page(s), hasCurations=${hasCurations}`)
    const pages = await Promise.all(
      Array.from({ length: pagesToFetch }, (_, i) => fetchPage(i + 1))
    )

    // Flatten all pages into one list, then filter and deduplicate
    const seen = new Set<string>()
    const photos: FlickrPhoto[] = []
    let rawCount = 0

    for (const data of pages) {
      const pagePhotos = data?.photos?.photo ?? []
      rawCount += pagePhotos.length
      if (pagePhotos.length === 0) console.log('[flickr] page returned 0 photos, response:', JSON.stringify(data).slice(0, 300))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of pagePhotos as any[]) {
        if (seen.has(p.id)) continue
        seen.add(p.id)
        if (hasExcludedTag(p.tags ?? "")) continue
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

    console.log(`[flickr] raw=${rawCount}, after filter=${photos.length}`)
    photoCache.set(cacheKey, { photos, timestamp: Date.now() })
    return photos
  } catch (err) {
    console.error('[flickr] fetch error:', err)
    return []
  }
}
