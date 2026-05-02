// Synthetic cluster topology — single source of truth for both client
// and server-side code. A "synthetic" is a logical place (Central
// London, Birmingham, Stratford, Windsor, …) that has no real station
// of its own; it aggregates several real National Rail stations as
// cluster members. The anchor coord is the synthetic's centroid (where
// its label/icon renders); members are real stations that render as
// satellite diamonds.
//
// SHAPE (clusters-data.json) post Phase 2e:
//   { CLUSTERS: { "<anchor ID>": { displayName, coord, members: [<station IDs>],
//     isPrimaryOrigin, isFriendOrigin }, … } }
//
// A cluster is a cluster first; its `isPrimaryOrigin` /
// `isFriendOrigin` flags decide whether it's also a selectable origin
// in the corresponding dropdown. A cluster with both flags false is
// destination-only — its diamonds still render and clicking opens the
// modal, but it doesn't appear in either origin dropdown.
//
// Many existing call sites in map.tsx still operate on coordKeys
// (primaryOrigin is a coordKey at runtime, etc.). To keep those
// working unchanged, this module exposes the LEGACY coord-keyed
// versions of every derived map. Phase 3 can swap consumers to the
// ID-keyed canonical exports below and drop the coord views.

import data from "./clusters-data.json"
import { getCoordKey } from "@/lib/station-registry"

// ── Cluster registry ─────────────────────────────────────────────────

// On-disk shape (ID-keyed, members are station IDs).
type RawClusterDef = {
  displayName: string
  coord: string
  members: string[]
  isPrimaryOrigin: boolean
  isFriendOrigin: boolean
}

// Legacy shape — same as the pre-Phase-2e ClusterDef. Members are
// coordKeys (translated from IDs at module load).
export type ClusterDef = {
  displayName: string
  members: string[]
  isPrimaryOrigin: boolean
  isFriendOrigin: boolean
}

const RAW_CLUSTERS: Record<string, RawClusterDef> =
  (data as { CLUSTERS: Record<string, RawClusterDef> }).CLUSTERS

// Translate one member ID list to coordKeys. Drops IDs the registry
// can't resolve (would only happen with stale data — the audit script
// catches such drift before it ships).
function memberIdsToCoords(memberIds: string[]): string[] {
  const out: string[] = []
  for (const id of memberIds) {
    const ck = getCoordKey(id)
    if (ck) out.push(ck)
  }
  return out
}

// The unified registry: every cluster keyed by anchor COORD (legacy).
// Iterate this when a code path needs to consider all clusters
// regardless of selectability (diamond rendering, virtual feature
// builder, click resolution).
export const ALL_CLUSTERS: Record<string, ClusterDef> = (() => {
  const out: Record<string, ClusterDef> = {}
  for (const def of Object.values(RAW_CLUSTERS)) {
    out[def.coord] = {
      displayName: def.displayName,
      members: memberIdsToCoords(def.members),
      isPrimaryOrigin: def.isPrimaryOrigin,
      isFriendOrigin: def.isFriendOrigin,
    }
  }
  return out
})()

// Helper: build an `{ anchorCoord: memberCoords[] }` map from clusters
// that pass a predicate. Used to derive the legacy primary/friend
// exports below without duplicating the filter logic.
function clustersWhere(predicate: (c: ClusterDef) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [anchorCoord, def] of Object.entries(ALL_CLUSTERS)) {
    if (predicate(def)) out[anchorCoord] = def.members
  }
  return out
}

// ── Legacy-shape exports (origin-flagged subsets) ────────────────────
// Same shape as before so existing call sites in map.tsx, build
// scripts, and API routes don't need to change. These are derived
// views of ALL_CLUSTERS; the source of truth is the registry above.

export const PRIMARY_ORIGIN_CLUSTER: Record<string, string[]> = clustersWhere((c) => c.isPrimaryOrigin)
export const FRIEND_ORIGIN_CLUSTER: Record<string, string[]> = clustersWhere((c) => c.isFriendOrigin)

// Display names for every cluster (whether or not it's an origin).
export const SYNTHETIC_DISPLAY_NAMES: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [anchorCoord, def] of Object.entries(ALL_CLUSTERS)) {
    out[anchorCoord] = def.displayName
  }
  return out
})()

// Every coord that's a member of any synthetic cluster, flattened to
// a Set for cheap membership tests.
export const ALL_CLUSTER_MEMBER_COORDS: Set<string> = new Set<string>(
  Object.values(ALL_CLUSTERS).flatMap((c) => c.members),
)

// Reverse lookup: member coordKey → its synthetic anchor coordKey.
export const MEMBER_TO_SYNTHETIC: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [anchorCoord, def] of Object.entries(ALL_CLUSTERS)) {
    for (const m of def.members) out[m] = anchorCoord
  }
  return out
})()

// Whether a given anchor is a primary-side or friend-side synthetic.
export const SYNTHETIC_KIND: Record<string, "primary" | "friend" | undefined> = (() => {
  const out: Record<string, "primary" | "friend" | undefined> = {}
  for (const [anchorCoord, def] of Object.entries(ALL_CLUSTERS)) {
    if (def.isPrimaryOrigin) out[anchorCoord] = "primary"
    else if (def.isFriendOrigin) out[anchorCoord] = "friend"
  }
  return out
})()

// All synthetic anchor coordKeys (every cluster, regardless of
// selectability), flat Set for membership tests.
export const ALL_SYNTHETIC_COORDS: Set<string> = new Set<string>(Object.keys(ALL_CLUSTERS))

// The Central London cluster's anchor coord. Hard-coded because the
// "London termini are individually selectable as primary" feature is
// scoped to this one cluster only — every other cluster keeps its
// "members aren't selectable on their own" rule.
export const CENTRAL_LONDON_ANCHOR = "-0.1269,51.5196"

// ── Route ranking ────────────────────────────────────────────────────
//
// Mirrors the candidate-comparison rule in lib/stitch-journey.ts: when
// picking the "top-ranked" of several alternative journeys (e.g. one
// per cluster member of a synthetic), we prefer FEWER CHANGES first
// and use SHORTER DURATION as the tiebreaker. Surfacing this here
// keeps synthetic ranking and stitch ranking in lockstep — change one
// rule, both follow.

export type RankableJourney = {
  durationMinutes?: number | null
  changes?: number | null
}

// Returns true when `a` is a strictly better journey than `b`.
// "null" duration/changes are treated as worst-case so a partially-
// populated journey never beats a fully-specified one.
export function isJourneyBetter(a: RankableJourney, b: RankableJourney): boolean {
  const aChanges = a.changes ?? Infinity
  const bChanges = b.changes ?? Infinity
  if (aChanges < bChanges) return true
  if (aChanges > bChanges) return false
  const aDur = a.durationMinutes ?? Infinity
  const bDur = b.durationMinutes ?? Infinity
  return aDur < bDur
}

// Picks the top-ranked journey from a list, returning its index (so
// callers can also recover the matching cluster-member coord). Returns
// -1 when the list is empty.
export function pickTopRankedIndex<T extends RankableJourney>(
  candidates: ReadonlyArray<T>,
): number {
  let bestIdx = -1
  for (let i = 0; i < candidates.length; i++) {
    if (bestIdx === -1 || isJourneyBetter(candidates[i], candidates[bestIdx])) {
      bestIdx = i
    }
  }
  return bestIdx
}
