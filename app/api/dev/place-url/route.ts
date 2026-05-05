import { NextRequest, NextResponse } from "next/server"
import { GOOGLE_TO_SPOT_TYPES, type SpotTypeValue } from "@/lib/spot-types"

// Batch resolve venue URLs via Google Places API (New) — "Search Text"
// endpoint with Essentials-tier field mask so each call costs the
// minimum possible. Used by the walk editor's "Pull URLs" button.
//
// Input:  { spots: [{ name, lat, lng }, ...] }   (parallel positions)
// Output: { results: [{ url, formattedAddress, businessStatus } | null, ...] }
//
// One result per input, same index. null when:
//  - the spot has no usable name
//  - Places returns no match
//  - the API call fails (logged server-side; client sees null and
//    leaves the row unchanged)
//
// Field mask is intentionally restricted to id / formattedAddress /
// businessStatus — all "Essentials" tier. Adding website, rating,
// opening hours etc. would bump the call into the more expensive Pro
// tier; we deliberately don't.

const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText"
// Pro-tier field mask — includes places.websiteUri so we can prefer
// the venue's own homepage over the Google Maps fallback. Pro is
// roughly 4× the Essentials cost (~$0.20 per walk Pull URLs click for
// a typical 5-10 spot walk, vs ~$0.05 on Essentials). Worth it: lots
// of pubs/cafes still publish a useful homepage with menus and hours.
//
// addressComponents + types are Essentials-tier (already covered by
// Pro), so requesting them on top of websiteUri doesn't bump the
// per-call cost. We use addressComponents to extract just the
// village/town for the location field, and types to auto-fill the
// row's spot-type tags.
const PLACES_FIELD_MASK = "places.id,places.businessStatus,places.websiteUri,places.addressComponents,places.types"
// Hard search radius around the Komoot waypoint coord — applied as
// `locationRestriction` (NOT `locationBias`), so Places refuses to
// return matches outside the circle. With a soft bias, generic pub
// names like "The Two Brewers" sometimes resolved to a same-named
// venue 50+ km away when Komoot's local one was a weaker text-match.
// 500m gives Komoot's pin a bit of slack while still ruling out
// wrong-county matches; an empty result is much better than a
// confidently-wrong URL pointing at a different venue.
const LOCATION_RESTRICTION_METRES = 1500

type Spot = { name: string; lat: number; lng: number }
type Result = {
  /** Canonical Google Maps place URL (place_id-based, never a search URL). */
  url: string
  /** The smallest available place name — village / suburb / town,
   *  derived from the venue's addressComponents. NEVER the full
   *  street address; the admin's `location` field is meant for a
   *  short prose-friendly placename like "Sandridge". */
  location?: string
  businessStatus?: string
  /** Canonical SpotTypeValue tags derived from Google's `types[]`.
   *  Empty array when no Google type maps to our vocabulary —
   *  callers treat empty + undefined identically. */
  types?: SpotTypeValue[]
} | null

// Map Google Places' raw types[] into our canonical vocabulary.
// Tags not in GOOGLE_TO_SPOT_TYPES are silently dropped; the result
// is deduped while preserving the order Google returned them in.
function mapGoogleTypes(types?: string[]): SpotTypeValue[] {
  if (!types?.length) return []
  const out: SpotTypeValue[] = []
  const seen = new Set<SpotTypeValue>()
  for (const g of types) {
    const v = GOOGLE_TO_SPOT_TYPES[g]
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

// Pick the most-specific human-readable place name from a Place's
// addressComponents. Order of preference:
//   1. locality            — village or town centre, e.g. "Sandridge"
//   2. postal_town         — UK post-town (used when locality absent)
//   3. sublocality / sublocality_level_1 — neighbourhood / suburb
//   4. administrative_area_level_2 — county fallback
// Returns undefined when none of the above are present, which is rare
// for inhabited UK addresses but possible for very rural waypoints.
type AddressComponent = { longText?: string; shortText?: string; types?: string[] }
function pickLocation(components?: AddressComponent[]): string | undefined {
  if (!components?.length) return undefined
  const byType = (...wanted: string[]): string | undefined => {
    for (const w of wanted) {
      const hit = components.find((c) => c.types?.includes(w))
      if (hit?.longText) return hit.longText
    }
    return undefined
  }
  return (
    byType("locality") ??
    byType("postal_town") ??
    byType("sublocality", "sublocality_level_1") ??
    byType("administrative_area_level_2")
  )
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n)
}

async function resolveOne(spot: Spot, apiKey: string): Promise<Result> {
  const name = spot.name.trim()
  if (!name) return null
  // Convert the radius to a bounding-box rectangle. Places API's
  // locationRestriction (unlike locationBias) only accepts a
  // rectangle — circles aren't allowed there. We use ~111km per
  // degree of latitude, scaling longitude by cos(lat) so the box
  // stays a roughly-square circumscribing rectangle around the pin.
  // Slightly larger than a true inscribed-circle restriction, but
  // well within tolerance for "is this venue near the Komoot pin".
  const dLat = LOCATION_RESTRICTION_METRES / 111_000
  const dLng =
    LOCATION_RESTRICTION_METRES /
    (111_000 * Math.cos((spot.lat * Math.PI) / 180))
  const body = {
    textQuery: name,
    locationRestriction: {
      rectangle: {
        low: { latitude: spot.lat - dLat, longitude: spot.lng - dLng },
        high: { latitude: spot.lat + dLat, longitude: spot.lng + dLng },
      },
    },
    // Asking for one result keeps the response small and forces Places
    // to return its top-ranked match, which is what we want.
    pageSize: 1,
  }
  let res: Response
  try {
    res = await fetch(PLACES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    console.error("[place-url] fetch failed for", name, (e as Error).message)
    return null
  }
  if (!res.ok) {
    // Log non-200 status — useful for debugging quota / billing /
    // missing-API-enable issues without throwing the whole batch.
    const text = await res.text().catch(() => "")
    console.error("[place-url] HTTP", res.status, "for", name, text.slice(0, 300))
    return null
  }
  const json = (await res.json().catch(() => null)) as {
    places?: {
      id?: string
      businessStatus?: string
      websiteUri?: string
      addressComponents?: AddressComponent[]
      types?: string[]
    }[]
  } | null
  const top = json?.places?.[0]
  if (!top?.id) return null
  // Prefer the venue's own homepage when Google has it; fall back to
  // a place_id-based Maps URL otherwise. Lots of small pubs/cafes
  // don't publish a website, so the fallback keeps coverage close to
  // 100% — no row stays blank just because the venue isn't online.
  const url =
    top.websiteUri && top.websiteUri.trim()
      ? top.websiteUri.trim()
      : `https://www.google.com/maps/place/?q=place_id:${top.id}`
  return {
    url,
    location: pickLocation(top.addressComponents),
    businessStatus: top.businessStatus,
    types: mapGoogleTypes(top.types),
  }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY not set" }, { status: 500 })
  }

  let body: { spots?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!Array.isArray(body.spots)) {
    return NextResponse.json({ error: "expected { spots: [...] }" }, { status: 400 })
  }

  // Validate + normalise. Spots without a name OR without finite
  // coords → result placeholder of null (we still keep the index
  // alignment so the client can map results back to its rows).
  const normalised: (Spot | null)[] = body.spots.map((raw) => {
    if (!raw || typeof raw !== "object") return null
    const r = raw as Record<string, unknown>
    if (typeof r.name !== "string" || !r.name.trim()) return null
    if (!isFiniteNumber(r.lat) || !isFiniteNumber(r.lng)) return null
    return { name: r.name, lat: r.lat, lng: r.lng }
  })

  // Fan out in parallel. Places API allows 100 RPS per project — well
  // above any single-walk batch (typical: 5-15 spots). No throttling
  // needed.
  const results = await Promise.all(
    normalised.map((s) => (s ? resolveOne(s, apiKey) : Promise.resolve(null))),
  )

  return NextResponse.json({ results })
}
