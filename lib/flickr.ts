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
const SEARCH_TAGS =
  "landscape, landmark"
    // "countryside,landscape,view,greenery,hills,woods,forest,meadow,meadows,village,stately home,castle,church,bridleway,byway,path,trek"
// ex-tags trail, valley, hike,walk
// Tags that disqualify a photo if present — applied client-side to the gallery.
// Note: the Flickr API has no native tag-exclusion parameter, so we request the
// `tags` extra and filter after fetching. The count (used for dot sizing) is
// unfiltered — it's a relative signal and the noise is acceptable.
const EXCLUDE_TAGS = new Set([
  "people", "girls", "boys", "children", "portrait", "portraits", "portrait",
  "countryfashion", "countryoutfit", "countrystyle",
  "train", "tank", "railway", "trains", "railways", "station",
  "engine", "locomotive",
  "berries",
  "bus", "buses", "airbus", "airport", "airways", "airliner", "flight",
  "crow", "bird", "garden",
  "motorbike", "motorcycle",
  "paddleboarding",
  "object",
  "ducks", "wildlife", "swan", "swans", "mallard",
  "baby", "squirrel",
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
    tags: SEARCH_TAGS,
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
export async function fetchFlickrPhotos(
  lat: number,
  lng: number,
  targetCount = 30
): Promise<FlickrPhoto[]> {
  const apiKey = getApiKey()
  if (!apiKey) return []

  const cacheKey = `photos:${lat.toFixed(3)},${lng.toFixed(3)}`
  const cached = photoCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.photos

  // Fetch more than needed since some will be filtered out client-side
  const fetchCount = Math.min(targetCount * 2, 100)

  const params = new URLSearchParams({
    method: "flickr.photos.search",
    api_key: apiKey,
    lat: String(lat),
    lon: String(lng),
    radius: "7",
    radius_units: "km",
    tags: SEARCH_TAGS,
    tag_mode: "any",
    // `tags` extra returns the photo's tag string — needed for exclusion filtering
    extras: "url_m,url_l,date_taken,owner_name,geo,tags",
    sort: "relevance",
    per_page: String(fetchCount),
    format: "json",
    nojsoncallback: "1",
  })

  try {
    const res = await fetch(`${FLICKR_BASE}?${params}`)
    const data = await res.json()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const photos: FlickrPhoto[] = (data?.photos?.photo ?? [])
      // Filter out photos that carry any excluded tag
      .filter((p: any) => !hasExcludedTag(p.tags ?? ""))
      .slice(0, targetCount)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((p: any) => ({
        id: p.id,
        title: p.title || "Untitled",
        ownerName: p.ownername ?? "Unknown",
        thumbnailUrl:
          p.url_m ??
          `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_m.jpg`,
        largeUrl: p.url_l ?? null,
        flickrUrl: `https://www.flickr.com/photos/${p.owner}/${p.id}`,
        dateTaken: p.datetaken ?? null,
      }))

    photoCache.set(cacheKey, { photos, timestamp: Date.now() })
    return photos
  } catch {
    return []
  }
}
