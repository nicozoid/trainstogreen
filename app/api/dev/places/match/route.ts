import { NextRequest, NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"
import type { Place, PlaceRegistry } from "@/lib/places"

// Phase 3 places-registry — auto-link Komoot waypoints to existing
// registry entries when they're "obviously the same venue". Used by
// the editor's Pull-data flow: before minting brand-new places for
// each Komoot waypoint, the editor POSTs the candidate name+coords
// here and gets back placeIds for any close matches.
//
// Match rule: case-insensitive normalised-name equality + haversine
// distance ≤ 200 m. Loose enough for GPS jitter / different mappers
// placing the pin on different parts of the same building, tight
// enough that two same-named venues 1 km apart don't collide.
//
// First match wins, ordered by placeId alphabetically so the result
// is stable across requests. Future merge UI handles deduplication
// when the registry has multiple entries for the same real venue.
//
// Body: { candidates: Array<{ name, lat, lng }> }
// Response: { matches: Array<{ placeId, place } | null> } — parallel
// to the input array. null when no candidate met both criteria.
const PLACES_FILE = "data/places.json"
const MATCH_RADIUS_KM = 0.2

type Candidate = { name: string; lat: number; lng: number }

// Normalise a venue name for fuzzy comparison. Mirrors the
// `normName` helper in components/walks-admin-panel.tsx so the
// in-walk dedup rule and the cross-registry match rule agree on
// what "same name" means.
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/['‘’ʼ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

// Haversine distance in km. Cheap enough to call once per
// (candidate × registry-entry-with-matching-name) pair.
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

export async function POST(req: NextRequest) {
  let body: { candidates?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const raw = body.candidates
  if (!Array.isArray(raw)) {
    return NextResponse.json({ error: "expected { candidates: Array<{name,lat,lng}> }" }, { status: 400 })
  }
  // Validate + normalise each candidate. Keep null placeholders for
  // invalid entries so the response stays parallel-indexed with the
  // input — caller correlates by index.
  const candidates: (Candidate | null)[] = raw.map((c) => {
    if (!c || typeof c !== "object") return null
    const r = c as Record<string, unknown>
    if (typeof r.name !== "string" || !r.name.trim()) return null
    if (typeof r.lat !== "number" || !Number.isFinite(r.lat)) return null
    if (typeof r.lng !== "number" || !Number.isFinite(r.lng)) return null
    return { name: r.name, lat: r.lat, lng: r.lng }
  })

  const { data: places } = await readDataFile<PlaceRegistry>(PLACES_FILE)

  // Pre-bucket the registry by normalised name. Iterating the whole
  // registry per candidate would be O(C × R); bucketing collapses
  // it to O(R + C × matches-per-name), which matters once the
  // registry crosses ~10K entries.
  const byName = new Map<string, Array<[string, Place]>>()
  for (const [placeId, place] of Object.entries(places)) {
    if (typeof place.lat !== "number" || !Number.isFinite(place.lat)) continue
    if (typeof place.lng !== "number" || !Number.isFinite(place.lng)) continue
    const key = normName(place.name)
    if (!key) continue
    let bucket = byName.get(key)
    if (!bucket) {
      bucket = []
      byName.set(key, bucket)
    }
    bucket.push([placeId, place])
  }
  // Stabilise — alphabetical by placeId so first-match-wins is
  // deterministic when several registry entries share the same name
  // and sit within radius (e.g. the Phase 1 conservative migration
  // produced "lower-red-lion-st-albans" and "-2" / "-3" suffixes).
  for (const bucket of byName.values()) bucket.sort(([a], [b]) => a.localeCompare(b))

  const matches = candidates.map((c) => {
    if (!c) return null
    const bucket = byName.get(normName(c.name))
    if (!bucket) return null
    for (const [placeId, place] of bucket) {
      const km = haversineKm(c.lat, c.lng, place.lat as number, place.lng as number)
      if (km <= MATCH_RADIUS_KM) return { placeId, place }
    }
    return null
  })

  return NextResponse.json({ matches })
}
