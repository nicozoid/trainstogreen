// Thin wrapper around lib/compose-segment-polyline.ts that performs all
// the data-source plumbing (origin-routes lookup, CRS→coord map) needed
// at runtime, and exposes one entry point: composePolylineForJourney.
//
// Phase 2 of the polylines-from-segments work: the composer is invoked
// from components/map.tsx's preferGooglePolyline as a hybrid fallback.
// Encoded Google polylines (when present) still win — they're already
// real track. The composer wins over baked polylineCoords (CRS-chain
// straight lines) when it resolves all edges to real rail segments.

import segmentsData from "@/data/rail-segments.json"
import clustersData from "@/lib/clusters-data.json"
import { originRoutesById } from "@/lib/origin-routes"
import stationsData from "../public/stations.json"
import { resolveName, resolveAllNameCandidates, getStation } from "./station-registry"
import {
  composeFromCallingPoints,
  type RailSegments,
} from "./compose-segment-polyline"

// Cluster ID → ordered list of member IDs. Lets the composer resolve
// a hover on a cluster anchor (e.g. CNWK for Newark) to the underlying
// NR station whose journey origin-routes has data for. Members are
// tried in order — the first hit wins. Two members suffice for most
// clusters (e.g. CDOC = [DCW, DCH], where only DCH is reachable from
// Waterloo); larger clusters fall through similarly.
const clusterMembers = new Map<string, string[]>()
{
  const clusters = (clustersData as { CLUSTERS: Record<string, { members?: string[] }> }).CLUSTERS
  for (const [anchorId, def] of Object.entries(clusters)) {
    if (def.members && def.members.length > 0) {
      clusterMembers.set(anchorId, def.members)
    }
  }
}

// Build CRS → [lng, lat] once at module load. Calling-points sequences
// in origin-routes.json contain CRS codes (National Rail stations only),
// so this map only needs to cover features with a `ref:crs` property.
const crsToCoord = new Map<string, [number, number]>()
{
  const fc = stationsData as unknown as {
    features: Array<{
      geometry?: { coordinates?: number[] }
      properties?: { "ref:crs"?: string } | null
    }>
  }
  for (const f of fc.features) {
    const crs = f.properties?.["ref:crs"]
    const c = f.geometry?.coordinates
    if (!crs || !Array.isArray(c) || c.length < 2) continue
    if (!crsToCoord.has(crs)) {
      crsToCoord.set(crs, [c[0] as number, c[1] as number])
    }
  }
}

const segments = segmentsData as unknown as RailSegments

export type ComposedPolyline = {
  coords: [number, number][]
  edgesResolved: number
  edgesFallback: number
  edgesMissing: number
}

// One leg of a multi-leg journey, as it appears on JourneyInfo.legs at
// runtime + in the routing-diff JSON files. Names are the human-readable
// strings the routing pass produces; we resolve them through the
// station registry to CRS codes for segment lookups.
export type JourneyLeg = {
  vehicleType?: string
  departureStation?: string
  arrivalStation?: string
}

// Try a direct (origin → dest) calling-points lookup, expanding cluster
// anchors on both sides. Returns the calling-points sequence + the
// (origin, dest) IDs that actually matched, or null.
function tryDirectCallingPoints(
  originId: string,
  destId: string,
): string[] | null {
  const originCandidates = [originId, ...(clusterMembers.get(originId) ?? [])]
  const destCandidates = [destId, ...(clusterMembers.get(destId) ?? [])]
  for (const o of originCandidates) {
    const reach = originRoutesById[o]?.directReachable
    if (!reach) continue
    for (const d of destCandidates) {
      const candidate = reach[d]?.fastestCallingPoints
      if (Array.isArray(candidate) && candidate.length >= 2) return candidate
    }
  }
  return null
}

// Compose a polyline from a journey's legs[] when the direct lookup
// can't bridge origin to destination in one hop (e.g. CLON → BEU
// requires changing at Southampton). Each rail leg's calling points
// are looked up in origin-routes — origin-routes covers 344 origins,
// not just London terminals, so most non-London hubs (Southampton,
// Birmingham, Doncaster, …) have data we can use.
//
// Per-leg behaviour:
//   - HEAVY_RAIL: resolve dep/arr names → CRS via the registry, look
//     up calling points, compose via the segment library.
//   - non-rail (SUBWAY, WALK, OTHER, …): emit a 2-point straight line
//     between the dep/arr station coords. Counts as a fallback edge
//     since the segment library has no data for tube/walk hops, but
//     they're typically short and visually fine.
//
// Each leg's coords get concatenated; duplicate join points (last point
// of leg N == first point of leg N+1) are dropped. Edge tallies are
// summed across legs so isHighQualityComposition's majority rule still
// applies.
function composeFromLegs(legs: JourneyLeg[]): ComposedPolyline | null {
  const out: [number, number][] = []
  let totalResolved = 0
  let totalFallback = 0
  let totalMissing = 0

  for (const leg of legs) {
    const depName = leg.departureStation
    const arrName = leg.arrivalStation
    if (!depName || !arrName) continue
    let depId = resolveName(depName)
    let arrId = resolveName(arrName)
    let legCoords: [number, number][] = []

    if (leg.vehicleType === "HEAVY_RAIL") {
      // Try the primary resolution first.
      let cp = depId && arrId ? tryDirectCallingPoints(depId, arrId) : null
      // Homonym fallback — when the leg's name resolves to a station
      // that origin-routes has no path from/to, try every other
      // station with the same normalised name. Catches the
      // Newport-Wales-vs-Essex case (resolveName picks NWE; the
      // calling-points lookup needs NWP because we're routing from
      // PAD via the Welsh ECML). First (depAlt, arrAlt) pair that
      // yields a path wins.
      if (!cp || cp.length < 2) {
        const depAlts = resolveAllNameCandidates(depName)
        const arrAlts = resolveAllNameCandidates(arrName)
        const depCands = depAlts.length > 0 ? depAlts : depId ? [depId] : []
        const arrCands = arrAlts.length > 0 ? arrAlts : arrId ? [arrId] : []
        outer: for (const o of depCands) {
          for (const d of arrCands) {
            const candidate = tryDirectCallingPoints(o, d)
            if (candidate && candidate.length >= 2) {
              cp = candidate
              depId = o
              arrId = d
              break outer
            }
          }
        }
      }
      if (cp && cp.length >= 2) {
        const result = composeFromCallingPoints(cp, { segments, crsToCoord })
        legCoords = result.coords
        totalResolved += result.edgesResolved
        totalFallback += result.edgesFallback
        totalMissing += result.edgesMissing
      }
    }

    // Fallback to a 2-point straight line between station coords. Used
    // for non-rail legs and rail legs where origin-routes has no data.
    if (legCoords.length < 2) {
      const depCoord = depId ? getStation(depId)?.coord : null
      const arrCoord = arrId ? getStation(arrId)?.coord : null
      if (depCoord && arrCoord) {
        legCoords = [depCoord, arrCoord]
        totalFallback += 1
      } else {
        // Can't even draw a straight line; skip the leg but count it
        // as missing so the quality gate is honest about coverage.
        totalMissing += 1
        continue
      }
    }

    // Concatenate, dropping the duplicate join point when this is not
    // the first leg.
    const skipFirst = out.length > 0
    for (let k = skipFirst ? 1 : 0; k < legCoords.length; k++) {
      out.push(legCoords[k])
    }
  }

  if (out.length < 2) return null
  return {
    coords: out,
    edgesResolved: totalResolved,
    edgesFallback: totalFallback,
    edgesMissing: totalMissing,
  }
}

// Compose a rail-following polyline for one journey, from primary
// origin to destination (both addressed by canonical station ID).
//
// Resolution order:
//   1. Try a direct (origin → dest) calling-points lookup, expanding
//      cluster anchors on both sides. Single-leg journeys + cluster-
//      destination journeys land here.
//   2. If that fails AND legs are provided, compose leg-by-leg via
//      origin-routes. Each rail leg's dep/arr names are resolved to
//      CRS and composed independently, then concatenated. Catches
//      multi-leg journeys (CLON → SOU → BEU and similar — the bulk
//      of 2-leg failures from the strict-gate audit).
//
// Returns null when neither path produces a usable result — the caller
// is expected to fall back to its existing polyline source.
export function composePolylineForJourney(
  originId: string,
  destId: string,
  legs?: JourneyLeg[],
): ComposedPolyline | null {
  const cp = tryDirectCallingPoints(originId, destId)
  if (cp) {
    const result = composeFromCallingPoints(cp, { segments, crsToCoord })
    if (result.coords.length >= 2) {
      return {
        coords: result.coords,
        edgesResolved: result.edgesResolved,
        edgesFallback: result.edgesFallback,
        edgesMissing: result.edgesMissing,
      }
    }
  }
  if (legs && legs.length > 0) return composeFromLegs(legs)
  return null
}

// Quality gate for the hybrid rule. Accept the composer's polyline as
// an upgrade over a baked polylineCoords when MOST edges resolved to a
// real Google-fetched segment — i.e. at least as many resolved as
// unresolved. Rationale: most missing-segment cases are very short hops
// that the segment library never covered (CTK→BFR over the river,
// Thameslink-core inter-platform stretches, …) and they fall back to a
// 2-point straight line that's visually invisible against the rest of
// the curvy journey. Strict zero-fallback gating threw out ~70 CLON
// journeys whose composition was overwhelmingly track-following but
// happened to include one short straight piece. The "majority real
// edges" rule keeps the visual win while still rejecting compositions
// that are mostly straight lines (where the existing baked polyline
// might be at least as good).
export function isHighQualityComposition(c: ComposedPolyline): boolean {
  if (c.edgesResolved < 1) return false
  return c.edgesResolved >= c.edgesFallback + c.edgesMissing
}
