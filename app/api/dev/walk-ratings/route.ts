import { NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

// Sources of walk records. Mirrors WALKS_FILES in walks-for-station/route.ts.
const WALKS_FILES = [
  "data/rambler-walks.json",
  "data/leicester-ramblers-walks.json",
  "data/heart-rail-trails-walks.json",
  "data/abbey-line-walks.json",
  "data/manual-walks.json",
]

type WalkVariant = { startStation?: string | null; rating?: number | null }
type WalkEntry = { walks?: WalkVariant[] }

// Returns a map of coordKey → derived station rating (1..4). Stations
// without an entry in the response are unrated.
//
// Derivation rules (per spec — see CLAUDE conversation for context):
//   • max(walk ratings) when at least one walk has a numeric rating
//   • 2 when the station has walks but every walk is unrated
//     (deliberately idiosyncratic — "we know there's something here")
//   • absent (treated as null) when the station has no walks at all
//
// The response is keyed by coordKey so the client can drop it straight
// into the existing per-feature lookup. CRS → coordKey is resolved via
// public/stations.json.
export async function GET() {
  // Load the station list to resolve CRS → coordKey.
  const { data: stations } = await readDataFile<{
    features: Array<{
      geometry?: { coordinates?: [number, number] }
      properties?: { "ref:crs"?: string; coordKey?: string }
    }>
  }>("public/stations.json")

  // Build CRS → coordKey index. coordKey is "lng,lat" (the same shape
  // the rest of the app uses).
  const crsToCoord = new Map<string, string>()
  for (const f of stations.features) {
    const crs = f.properties?.["ref:crs"]
    if (!crs) continue
    const ck = f.properties?.coordKey
      ?? (f.geometry?.coordinates ? `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}` : null)
    if (ck) crsToCoord.set(crs, ck)
  }

  // Two passes per CRS: track the max numeric rating seen, AND whether
  // we ever saw any walk at all (for the "all unrated → 2" rule).
  type Tally = { max: number | null; sawAnyWalk: boolean }
  const byCrs = new Map<string, Tally>()

  for (const file of WALKS_FILES) {
    let entries: Record<string, WalkEntry>
    try {
      const { data } = await readDataFile<Record<string, WalkEntry>>(file)
      entries = data
    } catch {
      continue
    }
    for (const entry of Object.values(entries)) {
      if (!Array.isArray(entry.walks)) continue
      for (const v of entry.walks) {
        const crs = v.startStation
        if (!crs) continue
        const tally = byCrs.get(crs) ?? { max: null, sawAnyWalk: false }
        tally.sawAnyWalk = true
        if (typeof v.rating === "number") {
          const r = Math.round(v.rating)
          if (r >= 1 && r <= 4) {
            tally.max = tally.max == null ? r : Math.max(tally.max, r)
          }
        }
        byCrs.set(crs, tally)
      }
    }
  }

  // Project to coordKey and apply the "all unrated → 2" fallback.
  const out: Record<string, 1 | 2 | 3 | 4> = {}
  for (const [crs, tally] of byCrs) {
    const ck = crsToCoord.get(crs)
    if (!ck) continue
    let rating: 1 | 2 | 3 | 4
    if (tally.max != null) rating = tally.max as 1 | 2 | 3 | 4
    else if (tally.sawAnyWalk) rating = 2
    else continue
    out[ck] = rating
  }

  return NextResponse.json(out)
}
