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

// Compose a rail-following polyline for one direct journey, from a
// primary origin to a destination, both addressed by the canonical
// station ID (Phase 2a/3c). Looks up the journey's calling-points
// sequence in origin-routes.json and walks it through the segment
// library.
//
// Returns null when no calling-points sequence is available — the
// caller is expected to fall back to its existing polyline source.
export function composePolylineForJourney(
  originId: string,
  destId: string,
): ComposedPolyline | null {
  // Both origin and destination IDs can be cluster anchors (CLON for
  // Central London, CNWK for Newark, …). The hover layer surfaces the
  // cluster's virtual feature rather than its bare NR member, so a
  // direct originRoutes lookup on a cluster ID returns nothing. Expand
  // each side into a candidate list ([id, ...members]), then try every
  // pair until one resolves to a calling-points sequence in
  // origin-routes. First hit wins.
  const originCandidates = [originId, ...(clusterMembers.get(originId) ?? [])]
  const destCandidates = [destId, ...(clusterMembers.get(destId) ?? [])]
  let cp: string[] | undefined
  outer: for (const o of originCandidates) {
    const reach = originRoutesById[o]?.directReachable
    if (!reach) continue
    for (const d of destCandidates) {
      const candidate = reach[d]?.fastestCallingPoints
      if (Array.isArray(candidate) && candidate.length >= 2) {
        cp = candidate
        break outer
      }
    }
  }
  if (!Array.isArray(cp) || cp.length < 2) return null
  const result = composeFromCallingPoints(cp, { segments, crsToCoord })
  if (result.coords.length < 2) return null
  return {
    coords: result.coords,
    edgesResolved: result.edgesResolved,
    edgesFallback: result.edgesFallback,
    edgesMissing: result.edgesMissing,
  }
}

// Quality gate for the hybrid rule. Accept the composer's polyline as
// an upgrade over a baked polylineCoords ONLY when every edge resolved
// to a real Google-fetched segment. A single missing or fallback edge
// means the composer would draw a straight line for that hop — at
// which point the existing baked polyline (often built from RTT
// sibling-trim splices) is at least as good. Cheap, conservative,
// and easy to relax later if we want broader coverage.
export function isHighQualityComposition(c: ComposedPolyline): boolean {
  return c.edgesFallback === 0 && c.edgesMissing === 0 && c.edgesResolved >= 1
}
