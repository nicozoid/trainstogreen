// Builds public/journeys/<slug>.json from RTT data (data/origin-routes.json),
// emitting the same shape the runtime friend-side filter expects (per-dest
// `{ durationMinutes, changes, legs }`). No Google Routes API spend.
//
// Coverage:
//   • 0-change journeys — straight from origin-routes[origin].directReachable
//   • 1-change journeys — composed via every junction J that appears in BOTH
//     origin's directReachable AND has its own origin-routes entry pointing to
//     dest. Picks the fastest J per dest. Adds a fixed interchange penalty
//     (default 5 min) to mirror the realistic minimum platform-change time.
//
// 0-change entries always win over 1-change for the same destination (faster
// AND simpler). Composed entries inherit the leg structure: leg-1 is
// origin→J, leg-2 is J→dest. No `polyline`, no `departureTime` — those
// are nice-to-have UI fields that the existing friend filter doesn't read,
// so we leave them out and keep the file slim.
//
// Usage:
//   node scripts/build-friend-journeys-from-rtt.mjs --origin-coord "-1.898694,52.4776459" --slug birmingham
//   node scripts/build-friend-journeys-from-rtt.mjs --origin-crs BHM --slug birmingham
//   node scripts/build-friend-journeys-from-rtt.mjs --origin-crs BHM --cluster-crs BMO,BSW --slug birmingham
//
// Flags:
//   --origin-coord "lng,lat"    Origin coord key in origin-routes.json
//   --origin-crs CRS            Alternative: CRS code (script resolves to coord)
//   --cluster-coords "a,b;c,d"  Additional cluster member coords whose direct
//                               reach also counts as 0-change for the parent
//                               (e.g. BMO/BSW for Birmingham). Semicolon-
//                               separated list of "lng,lat" pairs.
//   --cluster-crs A,B           Alternative: CRS list, comma-separated
//   --slug name                 Output filename: public/journeys/<slug>.json
//   --interchange-penalty mins  Minutes to add to 1-change durations (default 5)
//   --dry-run                   Print stats without writing the file
//
// Safe to re-run; output file is fully replaced each time.

import { readFileSync, writeFileSync } from "fs"
import path from "path"

function getFlag(name) {
  const idx = process.argv.indexOf(name)
  if (idx === -1 || idx + 1 >= process.argv.length) return null
  return process.argv[idx + 1]
}

const ORIGIN_COORD_FLAG = getFlag("--origin-coord")
const ORIGIN_CRS_FLAG = getFlag("--origin-crs")
const CLUSTER_COORDS_FLAG = getFlag("--cluster-coords")
const CLUSTER_CRS_FLAG = getFlag("--cluster-crs")
const SLUG = getFlag("--slug")
const INTERCHANGE_PENALTY = parseInt(getFlag("--interchange-penalty") ?? "5", 10)
const DRY_RUN = process.argv.includes("--dry-run")

if (!SLUG) {
  console.error("Error: --slug <name> is required")
  process.exit(1)
}
if (!ORIGIN_COORD_FLAG && !ORIGIN_CRS_FLAG) {
  console.error("Error: --origin-coord <lng,lat> or --origin-crs <CRS> is required")
  process.exit(1)
}

const repoRoot = path.resolve(process.cwd())
const originRoutesPath = path.join(repoRoot, "data", "origin-routes.json")
const stationsPath = path.join(repoRoot, "public", "stations.json")
const outputPath = path.join(repoRoot, "public", "journeys", `${SLUG}.json`)

const originRoutes = JSON.parse(readFileSync(originRoutesPath, "utf8"))

// Build a CRS → [lng, lat] lookup from stations.json. Used to turn each
// leg's fastestCallingPoints (a CRS list) into polylineCoords so the
// runtime can draw a route line on the map. Without this, friend
// journeys render with no polyline (the runtime falls through to a
// straight-line fallback only for primaries that have a routing diff).
const stations = JSON.parse(readFileSync(stationsPath, "utf8"))
const crsToCoord = {}
for (const f of stations.features ?? []) {
  const crs = f.properties?.["ref:crs"]
  if (!crs) continue
  const c = f.geometry?.coordinates
  if (!Array.isArray(c) || c.length !== 2) continue
  crsToCoord[crs] = [c[0], c[1]]
}

// Resolve a CRS list → coord list, dropping any unknown CRSes (a
// missing intermediate is preferable to an empty polyline). Returns
// undefined when fewer than 2 points survive — the runtime checks for
// length>1 before drawing.
function callingPointsToCoords(crsList) {
  if (!Array.isArray(crsList) || crsList.length < 2) return undefined
  const out = []
  for (const crs of crsList) {
    const c = crsToCoord[crs]
    if (c) out.push([c[0], c[1]])
  }
  return out.length > 1 ? out : undefined
}

// Resolve origin ID. Post Phase 2a/4 origin-routes is keyed by station
// ID directly, so the simplest path is --origin-crs. The legacy
// --origin-coord flag still works: if the value has a comma we look
// up the matching station via stations.json.
let originId = ORIGIN_CRS_FLAG
if (!originId && ORIGIN_COORD_FLAG) {
  if (ORIGIN_COORD_FLAG.includes(",")) {
    const f = stations.features.find((g) => {
      const [lng, lat] = g.geometry.coordinates
      return `${lng},${lat}` === ORIGIN_COORD_FLAG
    })
    originId = f?.properties?.["ref:crs"]
    if (!originId) {
      console.error(`Error: --origin-coord ${ORIGIN_COORD_FLAG} doesn't match a station with a CRS`)
      process.exit(1)
    }
  } else {
    // Already an ID
    originId = ORIGIN_COORD_FLAG
  }
}

const originEntry = originRoutes[originId]
if (!originEntry) {
  console.error(`Error: no origin-routes entry for ${originId}`)
  console.error("Run scripts/fetch-direct-reachable.mjs for that origin first.")
  process.exit(1)
}

const originName = originEntry.name
const originCrs = originEntry.crs
console.log(`Building friend journeys from ${originName} (${originCrs})`)
console.log(`Direct destinations from anchor: ${Object.keys(originEntry.directReachable).length}`)

// Resolve cluster member IDs (if any). Each cluster member's
// directReachable is also treated as 0-change for the parent — covers the
// Birmingham case where BMO/BSW reach Olton directly but BHM doesn't.
const clusterIds = []
if (CLUSTER_COORDS_FLAG) {
  for (const c of CLUSTER_COORDS_FLAG.split(";").map((s) => s.trim()).filter(Boolean)) {
    if (c.includes(",")) {
      const f = stations.features.find((g) => {
        const [lng, lat] = g.geometry.coordinates
        return `${lng},${lat}` === c
      })
      const id = f?.properties?.["ref:crs"]
      if (!id) { console.error(`Error: --cluster-coords ${c} doesn't match a station with a CRS`); process.exit(1) }
      clusterIds.push(id)
    } else {
      clusterIds.push(c)
    }
  }
}
if (CLUSTER_CRS_FLAG) {
  for (const crs of CLUSTER_CRS_FLAG.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!originRoutes[crs]) {
      console.error(`Error: no origin-routes entry with cluster CRS=${crs}`)
      process.exit(1)
    }
    clusterIds.push(crs)
  }
}

const directOriginIds = [originId, ...clusterIds]
if (clusterIds.length > 0) {
  console.log(`Cluster members: ${clusterIds.length} (${clusterIds.join(", ")})`)
}

// ---------------------------------------------------------------------------
// 0-change journeys — union of every direct-origin's (anchor + cluster
// members) directReachable. When the same destination appears under multiple
// cluster members, keep the fastest. The leg's `departureStation` reflects
// the cluster member that wins, so the modal can show "from Birmingham
// Moor Street" when that's the actual fastest leg.
// ---------------------------------------------------------------------------
const journeys = {}

for (const directCoord of directOriginIds) {
  const entry = originRoutes[directCoord]
  if (!entry?.directReachable) continue
  const sourceName = entry.name
  for (const [destCoord, dr] of Object.entries(entry.directReachable)) {
    if (directOriginIds.includes(destCoord)) continue // skip self & sibling cluster members
    const stopCount = Math.max(0, (dr.fastestCallingPoints?.length ?? 2) - 2)
    const existing = journeys[destCoord]
    if (existing && existing.durationMinutes <= dr.minMinutes) continue
    const polylineCoords = callingPointsToCoords(dr.fastestCallingPoints)
    journeys[destCoord] = {
      durationMinutes: dr.minMinutes,
      changes: 0,
      legs: [
        {
          vehicleType: "HEAVY_RAIL",
          departureStation: sourceName,
          arrivalStation: dr.name,
          stopCount,
        },
      ],
      ...(polylineCoords ? { polylineCoords } : {}),
    }
  }
}

console.log(`0-change journeys: ${Object.keys(journeys).length}`)

// ---------------------------------------------------------------------------
// 1-change journeys — compose via every junction J that has
//   • origin → J in origin's directReachable
//   • J → dest in J's own origin-routes entry
// Pick the fastest junction per destination. Skip if 0-change already exists.
// ---------------------------------------------------------------------------

let consideredJunctions = 0
const seenJunctions = new Set()

// Iterate over every cluster member as a potential "start" for the
// 1-change leg. Same dedupe rules as before — fastest total wins, and
// 0-change always beats 1-change on tie.
for (const startCoord of directOriginIds) {
  const startEntry = originRoutes[startCoord]
  if (!startEntry?.directReachable) continue
  const startName = startEntry.name

  for (const [junctionCoord, junctionLeg] of Object.entries(startEntry.directReachable)) {
    if (directOriginIds.includes(junctionCoord)) continue
    const junctionEntry = originRoutes[junctionCoord]
    if (!junctionEntry?.directReachable) continue
    if (!seenJunctions.has(junctionCoord)) {
      seenJunctions.add(junctionCoord)
      consideredJunctions++
    }

    const startToJunctionMins = junctionLeg.minMinutes
    const junctionName = junctionEntry.name

    for (const [destCoord, jd] of Object.entries(junctionEntry.directReachable)) {
      if (directOriginIds.includes(destCoord) || destCoord === junctionCoord) continue
      const totalMinutes = startToJunctionMins + INTERCHANGE_PENALTY + jd.minMinutes
      const existing = journeys[destCoord]
      if (existing && existing.changes === 0) continue
      if (existing && existing.durationMinutes <= totalMinutes) continue

      const leg1Stops = Math.max(0, (junctionLeg.fastestCallingPoints?.length ?? 2) - 2)
      const leg2Stops = Math.max(0, (jd.fastestCallingPoints?.length ?? 2) - 2)

      // Concatenate leg1 + leg2 polylines. The junction coord is the
      // last point of leg1 and the first of leg2 — drop the duplicate
      // when stitching so we don't render a redundant point at the
      // change station.
      const leg1Coords = callingPointsToCoords(junctionLeg.fastestCallingPoints)
      const leg2Coords = callingPointsToCoords(jd.fastestCallingPoints)
      let polylineCoords
      if (leg1Coords && leg2Coords) {
        polylineCoords = [...leg1Coords, ...leg2Coords.slice(1)]
      } else {
        polylineCoords = leg1Coords ?? leg2Coords
      }

      journeys[destCoord] = {
        durationMinutes: totalMinutes,
        changes: 1,
        legs: [
          {
            vehicleType: "HEAVY_RAIL",
            departureStation: startName,
            arrivalStation: junctionName,
            stopCount: leg1Stops,
          },
          {
            vehicleType: "HEAVY_RAIL",
            departureStation: junctionName,
            arrivalStation: jd.name,
            stopCount: leg2Stops,
          },
        ],
        ...(polylineCoords ? { polylineCoords } : {}),
      }
    }
  }
}

const totalAfterCompose = Object.keys(journeys).length
const finalDirectCount = Object.values(journeys).filter((j) => j.changes === 0).length
const finalChange1Count = Object.values(journeys).filter((j) => j.changes === 1).length

console.log(`Considered ${consideredJunctions} junctions for 1-change composition`)
console.log(`1-change journeys (after dedupe vs direct): ${finalChange1Count}`)
console.log(`Total destinations: ${totalAfterCompose}`)
console.log(`  0-change: ${finalDirectCount}`)
console.log(`  1-change: ${finalChange1Count}`)

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
const payload = {
  origin: originId,
  journeys,
}

if (DRY_RUN) {
  console.log("\n--dry-run: not writing")
  process.exit(0)
}

writeFileSync(outputPath, JSON.stringify(payload))
console.log(`\nWrote ${outputPath}`)
console.log(`Size: ${(JSON.stringify(payload).length / 1024).toFixed(0)} KB`)
