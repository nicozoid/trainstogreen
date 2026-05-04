// Loader for data/origin-routes.json. Post Phase 2a the file is keyed
// by station ID (CRS or 4-char synthetic) at both the outer level and
// inside each entry's directReachable. Phase 3c finished the runtime
// migration in components/map.tsx, so this module exports the canonical
// ID-keyed view.
//
// Phase 5b.i: also injects synthetic entries for every cluster anchor,
// aggregating its members' fastest journey per destination. Lets
// `originRoutes[CMAN]` (etc.) work transparently for cluster primaries
// — no consumer changes needed; cluster routing falls out of the same
// data shape primaries already use. CLON / CSTR don't get the synthetic
// entry overlaid (they're isPrimaryOrigin and have their own existing
// per-cluster routing via terminal-matrix); every other cluster anchor
// — friend-flagged (CMAN / CBIR / etc.) and destination-only (CEXE /
// CWND / etc.) — gets one when at least one member has RTT data.

import data from "@/data/origin-routes.json"
import clustersData from "./clusters-data.json"

export type DirectReachable = {
  name: string
  crs: string
  minMinutes: number
  services: number
  fastestCallingPoints: string[]
  fastestCallingPointTimes?: Array<number | null>
  upstreamCallingPoints?: {
    crs: string
    name: string
    coord: string
    minutesBeforeOrigin: number
  }[]
  serviceDepMinutes?: number[]
  serviceDurationsMinutes?: number[]
}

export type OriginEntry = {
  name: string
  crs: string
  directReachable: Record<string, DirectReachable>
  generatedAt: string
  sampledDates?: string[]
  v2FetchedDates?: string[]
}

export type OriginRoutes = Record<string, OriginEntry>

// Raw on-disk data — used internally for the cluster aggregation
// below. Consumers should use `originRoutesById` (the cluster-aware
// merged view) instead.
const RAW: OriginRoutes = data as unknown as OriginRoutes

// Cluster aggregation: for each cluster anchor without its own raw
// entry, build a synthetic entry whose directReachable map is the
// per-destination FASTEST of any member's journey. Mirrors how the
// friend-side cluster fallback picks the quickest member journey
// (lib/clusters.ts isJourneyBetter). Skips clusters whose anchor is
// already in RAW (CLON's synthetic origin-routes file aside, this is
// theoretical — clusters live as keys in clusters-data.json, not as
// stations in origin-routes.json).
type ClusterDef = { displayName: string; members: string[]; isPrimaryOrigin: boolean }
type RawClusters = { CLUSTERS: Record<string, ClusterDef> }
const CLUSTERS = (clustersData as RawClusters).CLUSTERS

function buildClusterEntry(anchorId: string, def: ClusterDef): OriginEntry | null {
  const aggregated: Record<string, DirectReachable> = {}
  let anyMemberHadData = false
  for (const memberId of def.members) {
    const memberRoutes = RAW[memberId]
    if (!memberRoutes?.directReachable) continue
    anyMemberHadData = true
    for (const [destId, entry] of Object.entries(memberRoutes.directReachable)) {
      const existing = aggregated[destId]
      // Per-destination fastest member: lower minMinutes wins.
      // Ties resolved by services count (higher is more frequent).
      if (!existing
        || entry.minMinutes < existing.minMinutes
        || (entry.minMinutes === existing.minMinutes && entry.services > existing.services)) {
        aggregated[destId] = entry
      }
    }
  }
  if (!anyMemberHadData) return null
  return {
    name: def.displayName,
    crs: anchorId,
    directReachable: aggregated,
    generatedAt: new Date().toISOString(),
  }
}

export const originRoutesById: OriginRoutes = (() => {
  const merged: OriginRoutes = { ...RAW }
  for (const [anchorId, def] of Object.entries(CLUSTERS)) {
    if (merged[anchorId]) continue          // raw entry takes precedence
    const synthEntry = buildClusterEntry(anchorId, def)
    if (synthEntry) merged[anchorId] = synthEntry
  }
  // Note: isPrimaryOrigin clusters (CLON / CSTR) get the aggregated
  // entry too. Their primary-side routing paths (PRIMARY_ORIGIN_CLUSTER
  // member iteration + terminal-matrix / TfL-hop stitching) are
  // separate and don't read this aggregated entry — but the friend-side
  // RTT-composition path (Phase 5b.ii) does, so picking CLON / CSTR as
  // friend works without a pre-built journey file.
  return merged
})()

// Every destination ID that appears in ANY primary's directReachable
// list. Used by the no-data message branching in photo-overlay to
// distinguish "we have NO journey data for this station anywhere"
// (likely a sparse Saturday-morning service or beyond fetch coverage)
// from "we have data elsewhere but not from your active primary"
// (try a different home). Computed once at module load.
export const ALL_RTT_DESTINATIONS: ReadonlySet<string> = (() => {
  const out = new Set<string>()
  for (const entry of Object.values(originRoutesById)) {
    for (const destId of Object.keys(entry.directReachable ?? {})) {
      out.add(destId)
    }
    // Origins themselves count as "reachable" — RTT-fetched primaries
    // know their own data even if no other primary lists them as a
    // destination.
  }
  for (const originId of Object.keys(originRoutesById)) out.add(originId)
  return out
})()
