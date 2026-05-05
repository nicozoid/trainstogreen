import { NextRequest, NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"
import type { Place, PlaceRegistry } from "@/lib/places"

// Autocomplete for the editor's name field. Filters data/places.json
// by case-insensitive substring match on `name`, ranking prefix
// matches above mid-string matches; alphabetical within each tier.
//
// Each result returns the registry's full venue payload (small —
// each entry is ~200 bytes) so the editor can populate every field
// when the admin clicks a suggestion without a second round-trip.
//
// Query params:
//   q     — search string. Returns empty results when shorter than 2.
//   limit — max suggestions returned. Default 10, capped at 50.
const PLACES_FILE = "data/places.json"

type Hit = { placeId: string } & Place

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase()
  if (q.length < 2) return NextResponse.json({ results: [] })

  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? "10")
  const limit = Math.max(1, Math.min(50, Number.isFinite(limitRaw) ? limitRaw : 10))

  const { data } = await readDataFile<PlaceRegistry>(PLACES_FILE)

  // Two-tier rank — prefix matches first, then substring matches.
  // Within each tier we sort alphabetically by lowercase name so the
  // ordering is stable across requests. Phase 2 keeps this name-only
  // (no location fuzzy-matching) — a future polish can swap in a
  // smarter ranker.
  const prefix: Hit[] = []
  const sub: Hit[] = []
  for (const [placeId, place] of Object.entries(data)) {
    const name = (place.name ?? "").toLowerCase()
    if (!name) continue
    if (name.startsWith(q)) prefix.push({ placeId, ...place })
    else if (name.includes(q)) sub.push({ placeId, ...place })
  }
  const byName = (a: Hit, b: Hit) => (a.name.toLowerCase()).localeCompare(b.name.toLowerCase())
  prefix.sort(byName)
  sub.sort(byName)

  const results = [...prefix, ...sub].slice(0, limit)
  return NextResponse.json({ results })
}
