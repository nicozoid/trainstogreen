import { NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"
import { ALL_CLUSTERS } from "@/lib/clusters"

// Sources of walk records. Mirrors WALKS_FILES in walks-for-station/route.ts.
const WALKS_FILES = [
  "data/rambler-walks.json",
  "data/leicester-ramblers-walks.json",
  "data/heart-rail-trails-walks.json",
  "data/abbey-line-walks.json",
  "data/manual-walks.json",
]

type WalkVariant = { startStation?: string | null; endStation?: string | null; rating?: number | null }
type WalkEntry = { walks?: WalkVariant[] }

// Returns a map of coordKey → derived station rating (1..4). Stations
// without an entry in the response are unrated.
//
// Derivation rules (per spec):
//   1. A station with NO walks at all is absent from the response
//      (treated as null / unrated by the client).
//   2. A station-with-walks is rated 2 by DEFAULT. Any walk that
//      deviates from 2 — up or down — takes priority over the default.
//   3. Upward deviation wins over downward deviation: when the
//      maximum walk rating is 3 or 4, that wins outright.
//   4. Below that, a single rated-1 walk overrides the default 2 —
//      "this station has at least one bad walk and no great walk".
//   5. Anything else (only rated-2 walks, or only unrated walks) lands
//      on the default 2.
//
// Concrete table:
//   walks       │ rating
//   ───────────────────
//   [2, 4]      │ 4   (upward deviation wins)
//   [1, 4]      │ 4   (upward beats downward)
//   [2, 3]      │ 3   (upward deviation)
//   [1, 2]      │ 1   (downward deviation, no upward)
//   [1]         │ 1
//   [2, 2, 2]   │ 2   (no deviation)
//   [unrated]   │ 2   (default for "we know there's something here")
//   (no walks)  │ unrated
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

  // Per CRS we track three signals:
  //   max          — highest numeric rating seen across this station's walks
  //   sawAnyWalk   — at least one walk record exists (drives the default-2 rule)
  //   sawRated1    — at least one walk has rating === 1 (drives the
  //                  downward-deviation rule)
  type Tally = { max: number | null; sawAnyWalk: boolean; sawRated1: boolean }
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
        // Each walk contributes to BOTH endpoints' tallies. A
        // rating-1 walk from BCU to LYT signals "below-average walks
        // on this corridor" for both Brockenhurst and Lymington Town.
        // Circular walks (start === end) only contribute once via the
        // dedup below.
        const endpoints = new Set<string>()
        if (v.startStation) endpoints.add(v.startStation)
        if (v.endStation) endpoints.add(v.endStation)
        for (const crs of endpoints) {
          const tally = byCrs.get(crs) ?? { max: null, sawAnyWalk: false, sawRated1: false }
          tally.sawAnyWalk = true
          if (typeof v.rating === "number") {
            const r = Math.round(v.rating)
            if (r >= 1 && r <= 4) {
              tally.max = tally.max == null ? r : Math.max(tally.max, r)
              if (r === 1) tally.sawRated1 = true
            }
          }
          byCrs.set(crs, tally)
        }
      }
    }
  }

  // Apply the derivation rules described above. Order matters: upward
  // deviation (max >= 3) wins outright; otherwise a rated-1 walk
  // overrides the default 2; otherwise default 2.
  const out: Record<string, 1 | 2 | 3 | 4> = {}
  for (const [crs, tally] of byCrs) {
    const ck = crsToCoord.get(crs)
    if (!ck) continue
    if (!tally.sawAnyWalk) continue
    let rating: 1 | 2 | 3 | 4
    if (tally.max != null && tally.max >= 3) rating = tally.max as 3 | 4
    else if (tally.sawRated1) rating = 1
    else rating = 2
    out[ck] = rating
  }

  // ── Synthetic ratings ──────────────────────────────────────────────
  // Each synthetic (Central London, Birmingham, …) "possesses" its
  // cluster members' walks. We aggregate every member's tallies into
  // a single per-synthetic tally, then apply the same derivation
  // rules. The synthetic's own coordKey isn't in stations.json (it's
  // the cluster's centroid, not a real station), so we look up its
  // members' coordKeys and recompute the synthetic's tally directly
  // from the member tallies — using the per-CRS Tally we already
  // computed, joined back via crsToCoord.
  const coordToCrs = new Map<string, string>()
  for (const [crs, ck] of crsToCoord) coordToCrs.set(ck, crs)

  // Iterate every cluster — destination-only ones (e.g. Windsor) also
  // need their rating aggregated from member walks so the synthetic's
  // diamond on the map carries the right rating tier.
  for (const [synthCoord, def] of Object.entries(ALL_CLUSTERS)) {
    const memberCoords = def.members
    let max: number | null = null
    let sawAnyWalk = false
    let sawRated1 = false
    for (const memberCoord of memberCoords) {
      const memberCrs = coordToCrs.get(memberCoord)
      if (!memberCrs) continue
      const memberTally = byCrs.get(memberCrs)
      if (!memberTally) continue
      if (memberTally.sawAnyWalk) sawAnyWalk = true
      if (memberTally.sawRated1) sawRated1 = true
      if (memberTally.max != null) {
        max = max == null ? memberTally.max : Math.max(max, memberTally.max)
      }
    }
    if (!sawAnyWalk) continue
    let rating: 1 | 2 | 3 | 4
    if (max != null && max >= 3) rating = max as 3 | 4
    else if (sawRated1) rating = 1
    else rating = 2
    out[synthCoord] = rating
  }

  return NextResponse.json(out)
}
